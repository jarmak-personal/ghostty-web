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
  load(): Promise<GhosttyInstance>;
}

interface ArtifactModule {
  Ghostty: GhosttyConstructor;
  Terminal: unknown;
  init: unknown;
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

async function smokeArtifact(name: string, artifact: unknown): Promise<void> {
  assertArtifactModule(name, artifact);

  // Use the public default loader so the smoke test covers each bundle's
  // import.meta.url handling as well as the packaged WASM ABI.
  const ghostty = await artifact.Ghostty.load();
  const terminal = ghostty.createTerminal(2, 2);
  terminal.free();
}

const esmPath = resolve('dist/ghostty-web.js');
const cjsPath = resolve('dist/ghostty-web.umd.cjs');
const esmArtifact = await import(`${pathToFileURL(esmPath).href}?smoke=${Date.now()}`);
const cjsArtifact = createRequire(import.meta.url)(cjsPath) as unknown;

await smokeArtifact('ESM', esmArtifact);
await smokeArtifact('UMD/CommonJS', cjsArtifact);

console.log('Verified ESM and UMD/CommonJS build artifacts.');
