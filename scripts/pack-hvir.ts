import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

interface ForkMetadata {
  upstreamRepository: string;
  upstreamBranch: string;
  upstreamCommit: string;
}

interface PackageMetadata {
  name: string;
  version: string;
}

interface PackResult {
  filename: string;
}

function run(command: string, args: string[]): string {
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });

  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${diagnostic}`);
  }

  return result.stdout.toString().trim();
}

async function requireFile(path: string): Promise<void> {
  const details = await stat(path).catch(() => undefined);
  if (!details?.isFile()) {
    throw new Error(`Expected build output ${path}. Run bun run build before packaging.`);
  }
}

async function main(): Promise<void> {
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    throw new Error('Refusing to package tracked changes. Commit the exact candidate first.');
  }

  const packageMetadata = JSON.parse(await readFile('package.json', 'utf8')) as PackageMetadata;
  const forkMetadata = JSON.parse(await readFile('fork.json', 'utf8')) as ForkMetadata;

  if (!/^[0-9a-f]{40}$/.test(forkMetadata.upstreamCommit)) {
    throw new Error('fork.json upstreamCommit must be a full Git commit SHA.');
  }

  run('git', ['merge-base', '--is-ancestor', forkMetadata.upstreamCommit, 'HEAD']);
  await requireFile('ghostty-vt.wasm');
  await requireFile('dist/ghostty-web.js');
  await requireFile('dist/index.d.ts');

  const sourceCommit = run('git', ['rev-parse', 'HEAD']);
  const shortCommit = sourceCommit.slice(0, 12);
  const ghosttyCommit = run('git', ['-C', 'ghostty', 'rev-parse', 'HEAD']);
  const outputDirectory = resolve(process.argv[2] ?? 'artifacts');
  await mkdir(outputDirectory, { recursive: true });

  const packOutput = run('npm', [
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    outputDirectory,
    '--json',
  ]);
  const packResults = JSON.parse(packOutput) as PackResult[];
  if (packResults.length !== 1 || !packResults[0]?.filename) {
    throw new Error(`Expected one npm pack result, received: ${packOutput}`);
  }

  const packedPath = join(outputDirectory, packResults[0].filename);
  const artifactName = `${packageMetadata.name}-${packageMetadata.version}-hvir-g${shortCommit}.tgz`;
  const artifactPath = join(outputDirectory, artifactName);
  await rename(packedPath, artifactPath);

  const entries = run('tar', ['-tzf', artifactPath]).split('\n');
  for (const required of [
    'package/dist/ghostty-web.js',
    'package/dist/index.d.ts',
    'package/ghostty-vt.wasm',
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`Packed artifact is missing ${required}.`);
    }
  }

  const bytes = await readFile(artifactPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const checksumPath = `${artifactPath}.sha256`;
  await writeFile(checksumPath, `${sha256}  ${basename(artifactPath)}\n`);

  const provenancePath = `${artifactPath}.provenance.json`;
  await writeFile(
    provenancePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        package: packageMetadata.name,
        packageVersion: packageMetadata.version,
        artifact: basename(artifactPath),
        sha256,
        sourceRepository: 'https://github.com/jarmak-personal/ghostty-web.git',
        sourceCommit,
        upstreamRepository: forkMetadata.upstreamRepository,
        upstreamBranch: forkMetadata.upstreamBranch,
        upstreamCommit: forkMetadata.upstreamCommit,
        ghosttyCommit,
      },
      null,
      2
    )}\n`
  );

  console.log(`Packed ${artifactPath}`);
  console.log(`Checksum ${checksumPath}`);
  console.log(`Provenance ${provenancePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
