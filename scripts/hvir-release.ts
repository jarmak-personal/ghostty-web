import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const COMPATIBILITY_TAG = /^hvir-v([0-9]+\.[0-9]+\.[0-9]+)-([1-9][0-9]*)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface ParsedCompatibilityTag {
  packageVersion: string;
  revision: number;
}

export interface CompatibilityTagRecord {
  commit: string;
  name: string;
  retained: boolean;
  sourcePackageVersion?: string;
}

export interface ReleasePlan {
  packageVersion: string;
  resume: boolean;
  revision: number;
  tag: string;
}

export interface AssetIdentity {
  digest: string | null;
  name: string;
  size: number;
  state?: string;
}

export interface RemoteRelease {
  assets: AssetIdentity[];
  draft: boolean;
  immutable: boolean;
  prerelease: boolean;
  tag_name: string;
}

export interface PublicationPlan {
  action: 'create' | 'resume-draft' | 'verify-published';
  missingAssets: string[];
}

interface PackageMetadata {
  name: string;
  version: string;
}

interface ForkMetadata {
  upstreamCommit: string;
}

interface ExpectedAsset extends AssetIdentity {
  digest: string;
  path: string;
}

function execute(command: string, args: string[], allowFailure = false): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const commandResult = {
    exitCode: result.exitCode,
    stderr: result.stderr.toString().trim(),
    stdout: result.stdout.toString().trim(),
  };

  if (!allowFailure && commandResult.exitCode !== 0) {
    const diagnostic = commandResult.stderr || commandResult.stdout;
    throw new Error(`${command} ${args.join(' ')} failed: ${diagnostic}`);
  }

  return commandResult;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requireCommit(name: string, value: string): void {
  if (!COMMIT_SHA.test(value)) {
    throw new Error(`${name} must be a full lowercase Git commit SHA, received '${value}'.`);
  }
}

export function parseCompatibilityTag(name: string): ParsedCompatibilityTag | undefined {
  const match = COMPATIBILITY_TAG.exec(name);
  if (!match) return undefined;

  return {
    packageVersion: match[1],
    revision: Number(match[2]),
  };
}

function validatedTag(record: CompatibilityTagRecord) {
  const parsed = parseCompatibilityTag(record.name);
  if (
    !parsed ||
    !COMMIT_SHA.test(record.commit) ||
    !record.retained ||
    record.sourcePackageVersion !== parsed.packageVersion
  ) {
    return undefined;
  }

  return { ...record, ...parsed };
}

export function selectReleasePlan(
  packageVersion: string,
  sourceCommit: string,
  records: CompatibilityTagRecord[]
): ReleasePlan {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(packageVersion)) {
    throw new Error(`Package version '${packageVersion}' cannot be used in an hvir release tag.`);
  }
  requireCommit('Source commit', sourceCommit);

  const relevant = records
    .map(validatedTag)
    .filter((record) => record?.packageVersion === packageVersion);
  const sourceTags = relevant.filter((record) => record?.commit === sourceCommit);

  if (sourceTags.length > 1) {
    throw new Error(
      `Source ${sourceCommit} already has multiple valid hvir release tags: ${sourceTags
        .map((record) => record!.name)
        .join(', ')}`
    );
  }

  const existing = sourceTags[0];
  if (existing) {
    return {
      packageVersion,
      resume: true,
      revision: existing.revision,
      tag: existing.name,
    };
  }

  const revision =
    relevant.reduce((highest, record) => Math.max(highest, record?.revision ?? 0), 0) + 1;
  return {
    packageVersion,
    resume: false,
    revision,
    tag: `hvir-v${packageVersion}-${revision}`,
  };
}

export function validateSnapshot(
  sourceCommit: string,
  checkoutCommit: string,
  retainedInHvirMain: boolean
): void {
  requireCommit('Source commit', sourceCommit);
  requireCommit('Checkout commit', checkoutCommit);
  if (checkoutCommit !== sourceCommit) {
    throw new Error(
      `Checkout ${checkoutCommit} does not match snapshotted source ${sourceCommit}.`
    );
  }
  if (!retainedInHvirMain) {
    throw new Error(`Snapshotted source ${sourceCommit} is not retained in hvir-main history.`);
  }
}

export function planPublication(
  release: RemoteRelease | undefined,
  expectedAssets: AssetIdentity[]
): PublicationPlan {
  if (!release)
    return { action: 'create', missingAssets: expectedAssets.map((asset) => asset.name) };
  if (release.prerelease) {
    throw new Error(`Release ${release.tag_name} is a prerelease and cannot be used.`);
  }

  const expected = new Map(expectedAssets.map((asset) => [asset.name, asset]));
  if (expected.size !== expectedAssets.length) {
    throw new Error('Expected release assets contain duplicate names.');
  }

  const actual = new Map<string, AssetIdentity>();
  for (const asset of release.assets) {
    if (actual.has(asset.name)) {
      throw new Error(`Release ${release.tag_name} contains duplicate asset ${asset.name}.`);
    }
    actual.set(asset.name, asset);
  }

  const unexpected = [...actual.keys()].filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Release ${release.tag_name} contains unexpected assets: ${unexpected.join(', ')}`
    );
  }

  for (const [name, asset] of actual) {
    const wanted = expected.get(name)!;
    if (
      asset.state !== 'uploaded' ||
      asset.digest !== wanted.digest ||
      asset.size !== wanted.size
    ) {
      throw new Error(`Release ${release.tag_name} asset ${name} is not byte-identical.`);
    }
  }

  const missingAssets = [...expected.keys()].filter((name) => !actual.has(name));
  if (!release.draft) {
    if (!release.immutable) {
      throw new Error(`Published release ${release.tag_name} is not immutable.`);
    }
    if (missingAssets.length > 0) {
      throw new Error(
        `Published release ${release.tag_name} is missing assets: ${missingAssets.join(', ')}`
      );
    }
    return { action: 'verify-published', missingAssets: [] };
  }

  if (release.immutable) {
    throw new Error(`Draft release ${release.tag_name} unexpectedly reports itself as immutable.`);
  }
  return { action: 'resume-draft', missingAssets };
}

function git(args: string[], allowFailure = false): CommandResult {
  return execute('git', args, allowFailure);
}

function readPackageVersionAtCommit(commit: string): string | undefined {
  const result = git(['show', `${commit}:package.json`], true);
  if (result.exitCode !== 0) return undefined;

  try {
    const metadata = JSON.parse(result.stdout) as Partial<PackageMetadata>;
    return typeof metadata.version === 'string' ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

function collectCompatibilityTags(): CompatibilityTagRecord[] {
  const names = git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags'])
    .stdout.split('\n')
    .filter(Boolean);
  const records: CompatibilityTagRecord[] = [];

  for (const name of names) {
    if (!parseCompatibilityTag(name)) continue;
    const commitResult = git(['rev-parse', '--verify', `${name}^{commit}`], true);
    if (commitResult.exitCode !== 0 || !COMMIT_SHA.test(commitResult.stdout)) {
      records.push({ commit: '', name, retained: false });
      continue;
    }

    const commit = commitResult.stdout;
    records.push({
      commit,
      name,
      retained:
        git(['merge-base', '--is-ancestor', commit, 'origin/hvir-main'], true).exitCode === 0,
      sourcePackageVersion: readPackageVersionAtCommit(commit),
    });
  }

  return records;
}

async function writeOutputs(values: Record<string, string>): Promise<void> {
  const output = requiredEnvironment('GITHUB_OUTPUT');
  const lines = Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  await appendFile(output, `${lines}\n`);
}

function validateRepositorySnapshot(sourceCommit: string): void {
  const checkoutCommit = git(['rev-parse', 'HEAD']).stdout;
  const retained =
    git(['merge-base', '--is-ancestor', sourceCommit, 'origin/hvir-main'], true).exitCode === 0;
  validateSnapshot(sourceCommit, checkoutCommit, retained);
}

async function planCommand(): Promise<void> {
  const sourceCommit = requiredEnvironment('SOURCE_COMMIT');
  validateRepositorySnapshot(sourceCommit);

  const packageMetadata = JSON.parse(await readFile('package.json', 'utf8')) as PackageMetadata;
  const plan = selectReleasePlan(packageMetadata.version, sourceCommit, collectCompatibilityTags());

  await writeOutputs({
    package_version: plan.packageVersion,
    resume: String(plan.resume),
    revision: String(plan.revision),
    source_commit: sourceCommit,
    tag: plan.tag,
  });
  console.log(
    plan.resume
      ? `Resuming ${plan.tag} for source ${sourceCommit}.`
      : `Allocated ${plan.tag} for source ${sourceCommit}.`
  );
}

function getRemoteTagCommit(repository: string, tag: string): string | undefined {
  const result = execute('gh', ['api', `repos/${repository}/git/ref/tags/${tag}`], true);
  if (result.exitCode !== 0) {
    if (result.stderr.includes('HTTP 404')) return undefined;
    throw new Error(`Unable to inspect remote tag ${tag}: ${result.stderr || result.stdout}`);
  }

  let object = (JSON.parse(result.stdout) as { object: { sha: string; type: string } }).object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) {
    const tagObject = JSON.parse(
      execute('gh', ['api', `repos/${repository}/git/tags/${object.sha}`]).stdout
    ) as { object: { sha: string; type: string } };
    object = tagObject.object;
  }
  if (object.type !== 'commit' || !COMMIT_SHA.test(object.sha)) {
    throw new Error(`Remote tag ${tag} does not resolve to a commit.`);
  }
  return object.sha;
}

function createRemoteTag(repository: string, tag: string, sourceCommit: string): void {
  execute('gh', [
    'api',
    '--method',
    'POST',
    `repos/${repository}/git/refs`,
    '-f',
    `ref=refs/tags/${tag}`,
    '-f',
    `sha=${sourceCommit}`,
  ]);
}

function getRelease(repository: string, tag: string): RemoteRelease | undefined {
  const result = execute('gh', ['api', `repos/${repository}/releases/tags/${tag}`], true);
  if (result.exitCode !== 0) {
    if (result.stderr.includes('HTTP 404')) return undefined;
    throw new Error(`Unable to inspect release ${tag}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as RemoteRelease;
}

async function expectedAsset(path: string): Promise<ExpectedAsset> {
  const bytes = await readFile(path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    digest: `sha256:${digest}`,
    name: basename(path),
    path,
    size: (await stat(path)).size,
    state: 'uploaded',
  };
}

async function createReleaseNotes(
  repository: string,
  artifactName: string,
  sourceCommit: string
): Promise<string> {
  const ghosttyCommit = git(['-C', 'ghostty', 'rev-parse', 'HEAD']).stdout;
  const forkMetadata = JSON.parse(await readFile('fork.json', 'utf8')) as ForkMetadata;
  const directory = await mkdtemp(join(tmpdir(), 'ghostty-web-hvir-release-'));
  const path = join(directory, 'notes.md');
  await writeFile(
    path,
    `Persistent package artifact for hvir's ghostty-web compatibility fork.\n\n` +
      `- Fork source: [${sourceCommit}](https://github.com/${repository}/commit/${sourceCommit})\n` +
      `- Ghostty source: [${ghosttyCommit}](https://github.com/ghostty-org/ghostty/commit/${ghosttyCommit})\n` +
      `- Upstream ghostty-web baseline: [${forkMetadata.upstreamCommit}](https://github.com/coder/ghostty-web/commit/${forkMetadata.upstreamCommit})\n` +
      `- Package: \`${artifactName}\`\n\n` +
      `This release does not publish the upstream-owned npm package. hvir consumes the tarball by its exact release URL and npm lockfile integrity.\n`
  );
  return path;
}

async function publishCommand(): Promise<void> {
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const sourceCommit = requiredEnvironment('SOURCE_COMMIT');
  const tag = requiredEnvironment('TAG');
  const packageVersion = requiredEnvironment('PACKAGE_VERSION');
  const parsedTag = parseCompatibilityTag(tag);
  if (!parsedTag || parsedTag.packageVersion !== packageVersion) {
    throw new Error(`Release tag ${tag} does not match package version ${packageVersion}.`);
  }

  git(['fetch', 'origin', 'hvir-main:refs/remotes/origin/hvir-main', '--tags']);
  validateRepositorySnapshot(sourceCommit);
  const currentPlan = selectReleasePlan(packageVersion, sourceCommit, collectCompatibilityTags());
  if (currentPlan.tag !== tag) {
    throw new Error(`Release allocation changed from ${tag} to ${currentPlan.tag}; retry the run.`);
  }

  const remoteTagCommit = getRemoteTagCommit(repository, tag);
  if (remoteTagCommit && remoteTagCommit !== sourceCommit) {
    throw new Error(`Remote tag ${tag} resolves to ${remoteTagCommit}, not ${sourceCommit}.`);
  }
  if (!remoteTagCommit) {
    createRemoteTag(repository, tag, sourceCommit);
  }
  if (getRemoteTagCommit(repository, tag) !== sourceCommit) {
    throw new Error(`Remote tag ${tag} was not created at ${sourceCommit}.`);
  }

  const assets = await Promise.all([
    expectedAsset(requiredEnvironment('ARTIFACT')),
    expectedAsset(requiredEnvironment('CHECKSUM')),
    expectedAsset(requiredEnvironment('PROVENANCE')),
  ]);
  const assetByName = new Map(assets.map((asset) => [asset.name, asset]));
  const initialPlan = planPublication(getRelease(repository, tag), assets);
  const notesPath = await createReleaseNotes(repository, assets[0].name, sourceCommit);
  let publishedNow = false;

  if (initialPlan.action === 'create') {
    execute('gh', [
      'release',
      'create',
      tag,
      ...assets.map((asset) => asset.path),
      '--repo',
      repository,
      '--verify-tag',
      '--title',
      `hvir ghostty-web artifact ${tag.slice('hvir-v'.length)}`,
      '--notes-file',
      notesPath,
      '--latest',
    ]);
    publishedNow = true;
  } else if (initialPlan.action === 'resume-draft') {
    if (initialPlan.missingAssets.length > 0) {
      execute('gh', [
        'release',
        'upload',
        tag,
        ...initialPlan.missingAssets.map((name) => assetByName.get(name)!.path),
        '--repo',
        repository,
      ]);
    }
    const completedDraft = planPublication(getRelease(repository, tag), assets);
    if (completedDraft.action !== 'resume-draft' || completedDraft.missingAssets.length !== 0) {
      throw new Error(`Draft release ${tag} does not contain the complete reproducible payload.`);
    }
    execute('gh', [
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--title',
      `hvir ghostty-web artifact ${tag.slice('hvir-v'.length)}`,
      '--notes-file',
      notesPath,
      '--draft=false',
      '--latest',
    ]);
    publishedNow = true;
  }

  const finalPlan = planPublication(getRelease(repository, tag), assets);
  if (finalPlan.action !== 'verify-published') {
    throw new Error(`Release ${tag} was not published immutably.`);
  }
  const verification = execute('gh', ['release', 'verify', tag, '--repo', repository]);
  if (verification.stdout) console.log(verification.stdout);

  if (publishedNow) {
    const latest = JSON.parse(
      execute('gh', ['api', `repos/${repository}/releases/latest`]).stdout
    ) as { tag_name: string };
    if (latest.tag_name !== tag) {
      throw new Error(`Published release ${tag} did not become the repository's latest release.`);
    }
    console.log(`Published immutable release ${tag} from ${sourceCommit}.`);
  } else {
    console.log(`Verified existing immutable release ${tag} from ${sourceCommit}.`);
  }
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case 'plan':
      await planCommand();
      break;
    case 'publish':
      await publishCommand();
      break;
    default:
      throw new Error('Usage: bun run scripts/hvir-release.ts <plan|publish>');
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
