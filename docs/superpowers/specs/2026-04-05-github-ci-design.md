# GitHub CI Design

## Summary

This design adds a minimal GitHub Actions CI workflow for `kagura`.
The workflow will validate the repository by installing dependencies with
`pnpm`, running `pnpm build`, and running `pnpm test` on both `push` to
`main` and all `pull_request` events.

## Goals

- Add an always-on CI check for the existing build and unit test commands.
- Keep the workflow small and easy to maintain.
- Use the repository's existing package manager configuration instead of
  pinning a separate `pnpm` version inside the workflow.
- Enable dependency caching to reduce repeated install time.

## Non-Goals

- Adding lint, typecheck, release, or deployment workflows.
- Building a multi-job matrix across multiple operating systems or Node versions.
- Running live Slack E2E scenarios in GitHub Actions.

## Workflow Shape

### Triggers

The workflow will run on:

- `push` to `main`
- all `pull_request` events

### Runtime

- Runner: `ubuntu-latest`
- Node setup: `actions/setup-node` with `node-version: lts/*`
- Package manager bootstrap: `corepack enable`

The workflow will not explicitly set a `pnpm` version.
`corepack` will resolve the version from the repository's `packageManager`
field in `package.json`.

### Cache strategy

The workflow will enable the built-in `pnpm` dependency cache provided by
`actions/setup-node`, keyed from `pnpm-lock.yaml`.

This keeps the configuration minimal while still reusing the pnpm store across
workflow runs when the lockfile is unchanged.

## Execution Steps

The job will run these steps in order:

1. Check out the repository.
2. Enable `corepack`.
3. Set up Node LTS with pnpm cache enabled.
4. Run `pnpm install --frozen-lockfile`.
5. Run `pnpm build`.
6. Run `pnpm test`.

## Error Handling

- Dependency resolution failures should fail the workflow during install.
- TypeScript or bundling regressions should fail the workflow during build.
- Unit test regressions should fail the workflow during the Vitest step.
- Cache misses are acceptable and should only affect runtime, not correctness.

## Files To Add

- `.github/workflows/ci.yml`
  - Define one `ci` workflow with one job covering install, build, and test.

## Testing And Verification

The work will be considered complete when:

- `.github/workflows/ci.yml` matches the approved design.
- `pnpm build` succeeds locally after the workflow file is added.
- `pnpm test` succeeds locally after the workflow file is added.

## Recommendation

Ship a single workflow with a single job now.
It matches the current repository needs, keeps maintenance low, and creates a
clear foundation for adding more CI checks later if the project grows.
