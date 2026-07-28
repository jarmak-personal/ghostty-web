import { describe, expect, test } from 'bun:test';

import { createProvenance } from './pack-hvir';

describe('createProvenance', () => {
  test('records the complete source and build toolchain identity', () => {
    expect(
      createProvenance({
        artifact: 'ghostty-web-0.4.0-hvir-g0123456789ab.tgz',
        buildPlatform: 'linux-x64',
        forkMetadata: {
          upstreamRepository: 'https://github.com/coder/ghostty-web.git',
          upstreamBranch: 'main',
          upstreamCommit: '1'.repeat(40),
        },
        ghosttyCommit: '2'.repeat(40),
        packageMetadata: {
          name: 'ghostty-web',
          version: '0.4.0',
        },
        sha256: '3'.repeat(64),
        sourceCommit: '4'.repeat(40),
        toolchain: {
          bun: '1.3.14',
          node: 'v24.18.0',
          npm: '11.16.0',
          zig: '0.15.2',
        },
      })
    ).toEqual({
      schemaVersion: 1,
      package: 'ghostty-web',
      packageVersion: '0.4.0',
      artifact: 'ghostty-web-0.4.0-hvir-g0123456789ab.tgz',
      sha256: '3'.repeat(64),
      sourceRepository: 'https://github.com/jarmak-personal/ghostty-web.git',
      sourceCommit: '4'.repeat(40),
      upstreamRepository: 'https://github.com/coder/ghostty-web.git',
      upstreamBranch: 'main',
      upstreamCommit: '1'.repeat(40),
      ghosttyCommit: '2'.repeat(40),
      buildPlatform: 'linux-x64',
      toolchain: {
        bun: '1.3.14',
        node: 'v24.18.0',
        npm: '11.16.0',
        zig: '0.15.2',
      },
    });
  });
});
