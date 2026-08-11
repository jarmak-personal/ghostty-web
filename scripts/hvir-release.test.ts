import { describe, expect, test } from 'bun:test';

import {
  type AssetIdentity,
  type CompatibilityTagRecord,
  parseCompatibilityTag,
  planPublication,
  pollRemoteState,
  type RemoteRelease,
  selectReleaseFromPages,
  selectReleasePlan,
  validateSnapshot,
} from './hvir-release';

const source = 'a'.repeat(40);
const previous = 'b'.repeat(40);

function tag(
  name: string,
  commit = previous,
  sourcePackageVersion = '0.4.0',
  retained = true
): CompatibilityTagRecord {
  return { commit, name, retained, sourcePackageVersion };
}

function asset(name: string, digestCharacter: string, size = 100): AssetIdentity {
  return {
    digest: `sha256:${digestCharacter.repeat(64)}`,
    name,
    size,
    state: 'uploaded',
  };
}

const expectedAssets = [asset('package.tgz', '1'), asset('package.tgz.sha256', '2', 80)];

function release(overrides: Partial<RemoteRelease> = {}): RemoteRelease {
  return {
    assets: expectedAssets,
    draft: false,
    immutable: true,
    prerelease: false,
    tag_name: 'hvir-v0.4.0-2',
    ...overrides,
  };
}

describe('remote state polling', () => {
  test('returns immediately when the first read is ready', async () => {
    const sleeps: number[] = [];
    const value = await pollRemoteState(
      () => 'ready',
      (result) => result === 'ready',
      {
        delays: [1, 2],
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
      }
    );

    expect(value).toBe('ready');
    expect(sleeps).toEqual([]);
  });

  test('backs off across transient reads until the remote state is ready', async () => {
    const values = [undefined, undefined, source];
    const sleeps: number[] = [];
    const value = await pollRemoteState(
      () => values.shift(),
      (result) => result !== undefined,
      {
        delays: [1, 2, 4],
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
      }
    );

    expect(value).toBe(source);
    expect(sleeps).toEqual([1, 2]);
  });

  test('waits for a published release to become immutable', async () => {
    const releases = [release({ immutable: false }), release()];
    const value = await pollRemoteState(
      () => releases.shift(),
      (result) => result !== undefined && !result.draft && result.immutable,
      { delays: [1], sleep: async () => {} }
    );

    expect(value?.immutable).toBeTrue();
  });

  test('returns the final observation when the retry budget is exhausted', async () => {
    let reads = 0;
    const value = await pollRemoteState(
      () => ++reads,
      () => false,
      { delays: [1, 2], sleep: async () => {} }
    );

    expect(value).toBe(3);
    expect(reads).toBe(3);
  });
});

describe('hvir release tag planning', () => {
  test('parses only canonical compatibility tags', () => {
    expect(parseCompatibilityTag('hvir-v0.4.0-12')).toEqual({
      packageVersion: '0.4.0',
      revision: 12,
    });
    expect(parseCompatibilityTag('hvir-v0.4-1')).toBeUndefined();
    expect(parseCompatibilityTag('hvir-v0.4.0-0')).toBeUndefined();
    expect(parseCompatibilityTag('hvir-v0.4.0-1;echo pwned')).toBeUndefined();
  });

  test('selects the next revision from validated tags for the package version', () => {
    expect(
      selectReleasePlan('0.4.0', source, [
        tag('hvir-v0.4.0-1'),
        tag('hvir-v0.4.0-3'),
        tag('hvir-v0.3.0-20', previous, '0.3.0'),
        tag('hvir-v0.4.0-99', previous, '0.3.0'),
        tag('hvir-v0.4.0-100', previous, '0.4.0', false),
        tag('hvir-v0.4.0-4', previous, '0.4.0', false),
        tag('release-v0.4.0-200'),
      ])
    ).toEqual({
      packageVersion: '0.4.0',
      resume: false,
      revision: 5,
      tag: 'hvir-v0.4.0-5',
    });
  });

  test('serialized attempts resume the tag allocated by the first attempt', () => {
    const first = selectReleasePlan('0.4.0', source, [tag('hvir-v0.4.0-1')]);
    expect(first.tag).toBe('hvir-v0.4.0-2');

    const retry = selectReleasePlan('0.4.0', source, [
      tag('hvir-v0.4.0-1'),
      tag(first.tag, source),
    ]);
    expect(retry).toEqual({ ...first, resume: true });
  });

  test('refuses ambiguous existing tags for the same source', () => {
    expect(() =>
      selectReleasePlan('0.4.0', source, [
        tag('hvir-v0.4.0-1', source),
        tag('hvir-v0.4.0-2', source),
      ])
    ).toThrow('multiple valid hvir release tags');
  });
});

describe('hvir source snapshot validation', () => {
  test('keeps the dispatch source when hvir-main advances around it', () => {
    expect(() => validateSnapshot(source, source, true)).not.toThrow();
  });

  test('rejects a changed checkout or source removed from branch history', () => {
    expect(() => validateSnapshot(source, previous, true)).toThrow('does not match');
    expect(() => validateSnapshot(source, source, false)).toThrow('not retained');
  });
});

describe('hvir publication retry planning', () => {
  test('creates a release only when no release exists', () => {
    expect(planPublication(undefined, expectedAssets)).toEqual({
      action: 'create',
      discardAssetIds: [],
      missingAssets: ['package.tgz', 'package.tgz.sha256'],
    });
  });

  test('resumes an exact partial draft without overwriting existing assets', () => {
    expect(
      planPublication(
        release({ assets: [expectedAssets[0]], draft: true, immutable: false }),
        expectedAssets
      )
    ).toEqual({
      action: 'resume-draft',
      discardAssetIds: [],
      missingAssets: ['package.tgz.sha256'],
    });
  });

  test('verifies an already-published byte-identical immutable release', () => {
    expect(planPublication(release(), expectedAssets)).toEqual({
      action: 'verify-published',
      discardAssetIds: [],
      missingAssets: [],
    });
  });

  test('discards an interrupted draft asset before uploading the missing candidate', () => {
    expect(
      planPublication(
        release({
          assets: [
            { ...expectedAssets[0], digest: null, id: 42, size: 0, state: 'starter' },
            expectedAssets[1],
          ],
          draft: true,
          immutable: false,
        }),
        expectedAssets
      )
    ).toEqual({
      action: 'resume-draft',
      discardAssetIds: [42],
      missingAssets: ['package.tgz'],
    });
  });

  test('rejects mismatched, incomplete, prerelease, and extra release assets', () => {
    expect(() =>
      planPublication(
        release({ assets: [asset('package.tgz', '9'), expectedAssets[1]] }),
        expectedAssets
      )
    ).toThrow('not byte-identical');
    expect(() => planPublication(release({ assets: [expectedAssets[0]] }), expectedAssets)).toThrow(
      'missing assets'
    );
    expect(() => planPublication(release({ prerelease: true }), expectedAssets)).toThrow(
      'prerelease'
    );
    expect(() =>
      planPublication(
        release({ assets: [...expectedAssets, asset('unexpected.txt', '3')] }),
        expectedAssets
      )
    ).toThrow('unexpected assets');
  });
});

describe('hvir release discovery', () => {
  test('finds a draft by tag across paginated authenticated release listings', () => {
    const draft = release({ draft: true, immutable: false });
    const unrelated = release({ tag_name: 'hvir-v0.4.0-1' });
    expect(selectReleaseFromPages([[unrelated], [draft]], draft.tag_name)).toBe(draft);
  });

  test('prefers a published release and rejects ambiguous duplicate drafts', () => {
    const published = release();
    const draft = release({ draft: true, immutable: false });
    expect(selectReleaseFromPages([[draft, published]], published.tag_name)).toBe(published);
    expect(() =>
      selectReleaseFromPages([[draft, { ...draft, assets: [] }]], draft.tag_name)
    ).toThrow('Multiple draft releases');
  });
});
