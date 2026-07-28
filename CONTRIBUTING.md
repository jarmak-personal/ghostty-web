# Contributing to the hvir compatibility fork

This fork exists to carry a small set of ghostty-web compatibility and reliability changes that
hvir needs while those changes are validated. It does not aim to become a separate terminal
project. Prefer upstream behavior, APIs, and architecture whenever a change can serve the wider
ghostty-web community.

## Start with an issue

Substantive work starts with an issue in this fork. Search both the
[fork issues](https://github.com/jarmak-personal/ghostty-web/issues) and
[upstream issues](https://github.com/coder/ghostty-web/issues) before opening one. The issue should
state the observed problem, affected environment, desired outcome, acceptance criteria, and
whether the result appears hvir-specific or generally useful upstream.

The repository automatically adds new issues to the public
[Ghostty-Web HVIR Fork project](https://github.com/users/jarmak-personal/projects/2). Issues are the
planning records; pull requests link to them rather than serving as a second backlog.

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

Resolve conflicts by preserving the smallest fork patch set and the repository guards that keep
upstream npm publishing inert outside `coder/ghostty-web`. Update `fork.json` to the exact
`upstream/main` commit, run all checks, and open a pull request to `hvir-main`. Merge an upstream
sync PR with a merge commit so Git retains the upstream ancestry; ordinary fork PRs may be
squashed.

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

The fork does not publish to npm or maintain a separate public release channel. From a clean
checkout with the required Zig and Bun versions, run:

```sh
bun run fmt && bun run lint && bun run typecheck && bun test
bun run pack:hvir
```

The pack command builds Ghostty WASM and the library, then writes a tarball, SHA-256 checksum, and
provenance JSON under `artifacts/`. The filename includes the source commit. CI performs the same
packaging check on pull requests and `hvir-main` and retains its candidate artifact for 14 days.
Promote only an artifact from the post-merge `hvir-main` run; pull-request artifacts may identify
GitHub's synthetic test merge rather than a retained branch commit.

After acceptance, commit the exact three files into hvir under `vendor/ghostty-web/` and use the
tarball through an exact `file:` dependency. Keep the checksum and provenance next to it. This
makes hvir installs reproducible without asking hvir contributors to build Ghostty or granting the
fork registry credentials.

Publishing can be reconsidered later if the fork gains external consumers. It requires a
distinct package name and an explicit maintenance decision; it must never target the
upstream-owned `ghostty-web` package.
