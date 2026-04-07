# Docker Deploy Design

## Summary

This design adds an open-source-friendly Docker deployment path for `kagura`.
The repository will ship a production `Dockerfile`, a default `compose.yaml`, a
`.dockerignore`, and README documentation that explains how to run the bot in a
container while mounting host repositories into the container.

## Goals

- Provide a standard production image build for the bot.
- Provide a one-command local/server deployment flow via `docker compose up -d`.
- Preserve the current runtime model: environment-driven config, Socket Mode,
  SQLite persistence, and workspace discovery under `REPO_ROOT_DIR`.
- Make the default deployment shape suitable for open-source users with minimal
  extra setup.

## Non-Goals

- Kubernetes manifests, Helm charts, or cloud-specific deployment files.
- Bundling user repositories into the image.
- Replacing SQLite with an external database.
- Adding a reverse proxy or public HTTP ingress requirement.

## Deployment Shape

### Container responsibility

The container image will package only the bot application and its runtime
dependencies. It will start the existing production entrypoint and rely on the
same environment variables documented for local execution.

### Repository access model

User repositories will remain on the host and be mounted into the container with
a bind mount. The default convention is:

- Host repo root: user-defined, for example `~/git`
- Container mount path: `/workspace`
- `REPO_ROOT_DIR=/workspace`

This keeps the image generic and matches the application's existing workspace
resolver behavior, which scans a configurable root directory for repositories.

### Persistent data model

SQLite data will be persisted outside the container lifecycle.

- The application database path inside the container will remain
  `./data/sessions.db`.
- `compose.yaml` will mount a persistent volume or host path to `/app/data`.
- Logs will not be persisted by default unless users opt in through
  `LOG_TO_FILE=true` and an additional mount.

## Files To Add Or Change

### New files

- `Dockerfile`
  - Multi-stage build for production.
  - Install dependencies with `pnpm`.
  - Build TypeScript output.
  - Ship only runtime artifacts needed for `pnpm start`.
- `compose.yaml`
  - Single service for the bot.
  - Load `.env`.
  - Mount host repositories into `/workspace`.
  - Persist `/app/data`.
  - Use a restart policy suitable for long-running service usage.
- `.dockerignore`
  - Exclude `node_modules`, logs, local data, build noise, git metadata, and
    other files not needed for image build context.

### Existing files

- `README.md`
  - Add Docker deployment prerequisites.
  - Add image build command.
  - Add `docker compose` usage example.
  - Document repository mount expectations and data persistence.
- `.env.example`
  - Keep current variables, but clarify the Docker-friendly `REPO_ROOT_DIR`
    value in documentation rather than hard-coding container-specific defaults.

## Runtime Flow

1. User copies `.env.example` to `.env` and fills in Slack and Anthropic
   credentials.
2. User updates `REPO_ROOT_DIR` to `/workspace` for container use.
3. User edits `compose.yaml` bind mount source if their host repo root is not
   the default example path.
4. `docker compose up -d` builds or pulls the image and starts the container.
5. The bot boots, validates env, opens the SQLite database under `/app/data`,
   and scans `/workspace` for repositories.
6. Slack Socket Mode traffic is handled the same way as the local Node process.

## Error Handling And Operational Expectations

- Missing required environment variables remain startup-fatal.
- Missing or empty host repo mount will not crash Docker itself, but workspace
  discovery will fail to find repositories; README should call this out clearly.
- SQLite directory creation remains handled by application startup, so the data
  mount only needs to be writable.
- The deployment docs should explain that Socket Mode means no inbound port
  exposure is required for normal operation.

## Testing And Verification

The implementation will be considered complete when all of the following hold:

- `pnpm build` succeeds after the Docker-related file additions.
- `pnpm test` succeeds after the Docker-related file additions.
- `docker build` succeeds for the production image.
- `docker compose config` validates the compose file structure.
- README examples match the checked-in file names and mount paths.

## Recommendation

Ship both the image and compose example now.
This gives open-source users a clean path for both quick local deployment and
custom infrastructure deployment without expanding scope into orchestration.
