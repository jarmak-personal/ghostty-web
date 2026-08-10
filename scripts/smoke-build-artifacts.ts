import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface GhosttyInstance {
  createTerminal(
    cols: number,
    rows: number
  ): {
    free(): void;
  };
}

interface GhosttyConstructor {
  load(wasmPath?: string | URL): Promise<GhosttyInstance>;
}

interface ArtifactModule {
  Ghostty: GhosttyConstructor;
  Terminal: unknown;
  init(options?: { wasmUrl?: string | URL }): Promise<void>;
}

function assertArtifactModule(
  name: string,
  candidate: unknown
): asserts candidate is ArtifactModule {
  const artifact = candidate as Partial<ArtifactModule> | undefined;
  if (
    typeof artifact?.Ghostty !== 'function' ||
    typeof artifact.Terminal !== 'function' ||
    typeof artifact.init !== 'function'
  ) {
    throw new Error(`${name} artifact does not expose the expected public API.`);
  }
}

async function smokeArtifact(name: string, artifact: unknown, wasmUrl: URL): Promise<void> {
  assertArtifactModule(name, artifact);

  // Use the public default loader so the smoke test covers each bundle's
  // import.meta.url handling as well as the packaged WASM ABI.
  const ghostty = await artifact.Ghostty.load();
  const terminal = ghostty.createTerminal(2, 2);
  terminal.free();

  // The top-level API must also accept an exact external URL.
  await artifact.init({ wasmUrl });
}

const esmPath = resolve('dist/ghostty-web.js');
const cjsPath = resolve('dist/ghostty-web.umd.cjs');
const wasmPath = resolve('dist/ghostty-vt.wasm');
const wasmUrl = pathToFileURL(wasmPath);

if ((await stat(wasmPath)).size === 0) {
  throw new Error('External WASM build artifact is empty.');
}

for (const bundlePath of [esmPath, cjsPath]) {
  const bundle = await readFile(bundlePath, 'utf8');
  if (bundle.includes('data:application/wasm')) {
    throw new Error(`${bundlePath} inlines the WASM binary instead of loading the external asset.`);
  }
  if (!bundle.includes('ghostty-vt.wasm')) {
    throw new Error(`${bundlePath} does not reference the external WASM build artifact.`);
  }
}

const esmArtifact = await import(`${pathToFileURL(esmPath).href}?smoke=${Date.now()}`);
const cjsArtifact = createRequire(import.meta.url)(cjsPath) as unknown;

await smokeArtifact('ESM', esmArtifact, wasmUrl);
await smokeArtifact('UMD/CommonJS', cjsArtifact, wasmUrl);

console.log('Verified ESM and UMD/CommonJS bundles with external WASM.');
