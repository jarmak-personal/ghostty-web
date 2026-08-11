import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const actionDirectory = join(import.meta.dir, '..', '.github', 'actions', 'setup-zig');
const verifier = join(actionDirectory, 'verify-archive.sh');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe('setup-zig action integrity', () => {
  test('pins one valid digest for every supported runner archive', async () => {
    const checksums = await readFile(join(actionDirectory, 'checksums.txt'), 'utf8');
    const entries = checksums
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split(' '));

    expect(entries).toEqual([
      [
        '0.15.2',
        'linux',
        'x86_64',
        '02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239',
      ],
      [
        '0.15.2',
        'macos',
        'aarch64',
        '3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b',
      ],
      [
        '0.15.2',
        'macos',
        'x86_64',
        '375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f',
      ],
    ]);
  });

  test('accepts an exact archive and rejects a tampered cache entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostty-web-zig-integrity-'));
    temporaryDirectories.push(directory);
    const archive = join(directory, 'zig.tar.xz');
    const original = Buffer.from('verified archive fixture');
    const expected = createHash('sha256').update(original).digest('hex');
    await writeFile(archive, original);

    const accepted = Bun.spawnSync(['bash', verifier, expected, archive]);
    expect(accepted.exitCode).toBe(0);

    await writeFile(archive, Buffer.from('tampered archive fixture'));
    const rejected = Bun.spawnSync(['bash', verifier, expected, archive]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('checksum mismatch');
  });

  test('binds the cache key to the pinned digest and verifies every restore', async () => {
    const action = await readFile(join(actionDirectory, 'action.yml'), 'utf8');

    expect(action).toContain('uses: actions/cache@v6');
    expect(action).toContain('${{ steps.archive.outputs.sha256 }}');
    expect(action).toContain('verify-archive.sh');
    expect(action.indexOf('verify-archive.sh')).toBeLessThan(action.indexOf('tar -xf'));
  });
});
