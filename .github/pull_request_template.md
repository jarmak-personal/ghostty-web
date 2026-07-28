## Governing issue

Closes #

## Outcome

Describe the observable result and why it belongs in the hvir compatibility fork.

## Upstream disposition

<!-- Choose one and explain: fork-only, upstream candidate, or already represented upstream. -->

## Fork hygiene

- [ ] The change is focused and does not introduce unrelated divergence from ghostty-web.
- [ ] Any upstream-sync conflict preserves the fork's npm publication guards.
- [ ] `fork.json` is updated if this pull request incorporates a new upstream baseline.

## Verification

Confirm `bun run fmt`, `bun run lint`, `bun run typecheck`, `bun test`, and `bun run build` passed.
Include targeted or manual evidence and identify any environment that was unavailable.
