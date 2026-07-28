# Contributing to the hvir compatibility fork

This fork exists to carry a small set of ghostty-web compatibility and reliability changes that
hvir needs while those changes are validated. It does not aim to become a separate terminal
project. Prefer upstream behavior, APIs, and architecture whenever a change can serve the wider
ghostty-web community.

## Start with an issue

Substantive work starts with a maintainer-authored issue in this fork. The issue and pull-request
trackers are intentionally locked against open-ended conversation; new and reopened tracker
items are automatically locked. If you are not already coordinating a contribution with the
maintainers, use [Discussions](https://github.com/jarmak-personal/ghostty-web/discussions) to ask a
question, report a problem, or propose an idea.

Before creating a planning issue, search the
[fork issues](https://github.com/jarmak-personal/ghostty-web/issues) and
[upstream issues](https://github.com/coder/ghostty-web/issues). The issue should state the observed
problem, affected environment, desired outcome, acceptance criteria, and whether the result
appears hvir-specific or generally useful upstream.

The public [Ghostty-Web HVIR Fork project](https://github.com/users/jarmak-personal/projects/2)
uses its native auto-add workflow for new fork issues. Issues are the planning records; pull
requests link to them rather than serving as a second backlog.

Until hvir 0.2.0, accepted fork work is limited to polishing and stabilizing the existing terminal
integration. Use Discussions or a clearly disposable exploratory branch for possible low-level
hvir integrations; exploration does not imply that a feature belongs on `hvir-main` during this
stabilization window.

For an ordinary change:

1. Update `hvir-main` from `origin/hvir-main`.
2. Create a focused branch named for the governing issue.
3. Implement and run the full checks from `AGENTS.md`.
4. Open a pull request to `hvir-main` with a Conventional Commit title and `Closes #N`.
5. Record whether the result is fork-only, an upstream candidate, or already represented
   upstream.

Small typo fixes and automated dependency updates may be maintainer exceptions. Avoid combining
fork integration policy with a generally useful terminal fix; that makes upstream review harder.

## Branch model

- `hvir-main` is the protected default and the only fork integration branch.
- Feature and fix branches start from `hvir-main` and merge back through pull requests.
- `origin/main` is the original fork point. Do not sync or develop against it: upstream workflows
  on that branch include npm publication intended for `coder/ghostty-web`.
- A local `upstream` remote is the clean source for upstream updates and upstream contribution
  branches.

Add and verify the remote once:

```sh
git remote add upstream https://github.com/coder/ghostty-web.git
git fetch upstream main --tags
git remote -v
```

If `upstream` already exists, verify its URL rather than adding it again.

## Sync from upstream

Sync upstream into a dedicated branch; never push upstream's `main` directly to this fork:

```sh
git fetch upstream main --tags
git switch hvir-main
git pull --ff-only origin hvir-main
git switch -c sync/upstream-YYYYMMDD
git merge --no-ff upstream/main
```

Resolve conflicts by preserving the smallest fork patch set. Do not restore upstream's npm publish
or Release Please workflows. Preserve the fork-only hvir artifact release workflow instead. Update
`fork.json` to the exact `upstream/main` commit, run all checks, and open a pull request to
`hvir-main`. Merge an upstream sync PR with a merge commit so Git retains the upstream ancestry;
ordinary fork PRs may be squashed.

## Contribute a fix upstream

An upstream pull request must contain only the generally useful change. Start its branch from the
actual upstream branch, not `hvir-main`:

```sh
git fetch upstream main
git switch -c upstream/short-description upstream/main
# Cherry-pick only clean, general commits or re-implement the focused change.
git push -u origin upstream/short-description
gh pr create \
  --repo coder/ghostty-web \
  --base main \
  --head jarmak-personal:upstream/short-description
```

Follow upstream's current contribution guidance and checks. Link the upstream pull request from
the fork issue. Keep the validated fork patch until hvir has tested a version that contains the
upstream result; upstream merge is not by itself proof that the fork patch can be removed.

## Package for hvir

The fork does not publish to npm. Its narrow GitHub Release channel persists package artifacts for
hvir without claiming the upstream package name in a registry. From a clean checkout with the
required Zig and Bun versions, run:

```sh
bun run fmt && bun run lint && bun run typecheck && bun test
bun run pack:hvir
```

The pack command builds Ghostty WASM and the library, then writes a tarball, SHA-256 checksum, and
provenance JSON under `artifacts/`. The filename includes the source commit. CI performs the same
packaging check on pull requests and `hvir-main` and retains its candidate artifact for 14 days.
Pull-request artifacts may identify GitHub's synthetic test merge and are never release inputs.

To persist an accepted post-merge artifact, create the next immutable tag using
`hvir-v<package-version>-<revision>`, for example `hvir-v0.4.0-1`, at the exact `hvir-main` commit
and push the tag. `.github/workflows/release-hvir-artifact.yml` repeats the quality gates, builds
the package with pinned Bun and Zig versions, and attaches the tarball, checksum, and provenance
through GitHub CLI's draft-then-publish immutable release path. The workflow refuses to run unless
repository release immutability is enabled, and it rejects tags outside `hvir-main`, package-version
mismatches, unexpected assets, and replacement of a different existing payload. It can be
dispatched manually with an existing tag to verify an already published payload or retry before a
release exists.

hvir consumes the tarball through its exact GitHub Release URL. `package-lock.json` records the URL
and integrity hash, so normal `npm ci` and Electron packaging need neither Ghostty's source tree nor
the fork's Bun and Zig toolchain. The package is JavaScript, declarations, and WASM; it does not
require independent Apple signing. hvir's normal application signing seals it as a bundled
resource in the final macOS app.

A future registry publication would require a distinct package name and an explicit maintenance
decision. It must never target the upstream-owned `ghostty-web` package.
