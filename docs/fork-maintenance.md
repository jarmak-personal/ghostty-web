# hvir fork maintenance

This document records the operational boundary around the hvir compatibility fork. Public
contribution steps live in [`CONTRIBUTING.md`](../CONTRIBUTING.md); upstream's release machinery is
documented in [`release.md`](release.md).

## Maintenance policy

The fork carries only changes needed to make ghostty-web a reliable swappable terminal pane for
hvir. A fork change should be one of:

- an hvir-specific compatibility adaptation that would not belong upstream;
- a generally useful bug fix being validated before an upstream proposal; or
- temporary release and contribution infrastructure that keeps those two paths safe.

Do not use the fork to accumulate unrelated features or silently diverge from ghostty-web's API.
Every retained patch needs a governing issue and an observable hvir reason.

## Current release posture

Through hvir 0.2.0, `hvir-main` is in a polish-and-stabilize phase. Changes should improve the
reliability, performance, diagnostics, packaging, or maintainability of behavior hvir already
ships. Potential low-level hvir integrations may be explored in Discussions or clearly disposable
branches, but feature experiments do not merge into `hvir-main` during this window unless the
maintainer explicitly changes the release scope.

## Upstream baseline

[`fork.json`](../fork.json) records the exact upstream commit last incorporated into `hvir-main`.
Update it only in an upstream-sync pull request. The packaging script verifies that the recorded
commit is an ancestor of the artifact source and includes it in artifact provenance.

`origin/main` is intentionally not a moving upstream mirror. Upstream's `main` contains automated
npm workflows for the upstream-owned package, so pushing it directly inside the fork creates an
avoidable publication hazard. Use a local `upstream/main` remote and merge it through a reviewed
sync pull request instead.

## Publication boundary

The upstream `publish.yml` and `release-please.yml` workflows are deliberately absent from
`hvir-main`. The underlying release scripts and configuration remain as inert upstream source to
reduce unnecessary divergence, but the fork has no executable registry or Release Please path.
Do not restore either workflow during an upstream sync. A delete/modify conflict involving those
paths is an intentional security review boundary, not a reason to accept the upstream file.

The hvir fork has no npm publishing credentials and no independent release stream. Its delivery
unit is the output of `bun run pack:hvir`:

- a normal npm-compatible tarball containing compiled JS, types, and `ghostty-vt.wasm`;
- a SHA-256 checksum; and
- provenance naming the fork commit, recorded upstream baseline, and Ghostty submodule commit.

hvir vendors an accepted artifact and refers to it with an exact local `file:` dependency. This
keeps the terminal dependency behind hvir's existing `TerminalPane` seam while avoiding install-
time source builds and mutable registry state.

Only promote artifacts produced by the post-merge `hvir-main` run. Pull-request runs validate the
package boundary, but their checkout can be GitHub's synthetic test merge rather than a retained
branch commit.

## One-time repository setup

After this infrastructure merges:

1. In Project 2's Workflows settings, enable the native `Auto-add to project` workflow for issues
   from `jarmak-personal/ghostty-web`.
2. Confirm a test issue is added to
   [Project 2](https://github.com/users/jarmak-personal/projects/2), then close it.
3. Require the `pr-title`, `fmt`, `lint`, `type check`, `test`, and `build` checks for pull requests
   to `hvir-main`, along with the CodeQL `Analyze JavaScript and TypeScript` check.
4. Keep merge commits available for upstream-sync pull requests; ordinary changes may use squash
   merges.
5. Keep Dependabot alerts and security updates enabled. Version updates for Bun dependencies and
   GitHub Actions are grouped weekly to limit fork churn.

The Project's built-in workflows may set new items to `Todo` and closed items to `Done`. Repository
labels remain the source of issue categorization; no custom Project field is required for this
small fork unless the planning model grows.

The issue chooser routes public reports and proposals to Discussions. Tracker issues and pull
requests are planning and delivery records, and the trusted default-branch workflow locks their
conversations on open, reopen, and unlock events.
