# Docker Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an open-source-friendly Docker deployment path with a production image, a default `docker compose` entrypoint, and matching documentation.

**Architecture:** The image will package only the bot runtime and compiled output. User repositories stay on the host and are bind-mounted into the container at `/workspace`, while SQLite state persists under `/app/data` through a dedicated volume.

**Tech Stack:** Docker, Docker Compose, Node.js 22, pnpm, TypeScript, SQLite

---

## Planned File Changes

- Create: `Dockerfile`
  - Multi-stage production image for the existing `pnpm build` + `pnpm start` workflow.
- Create: `compose.yaml`
  - Single-service deployment with `.env`, a host repo bind mount, and persistent app data.
- Create: `.dockerignore`
  - Trim the Docker build context and avoid copying local-only artifacts.
- Modify: `README.md`
  - Add Docker prerequisites, env expectations, build command, and compose usage.
- Modify: `.env.example`
  - Add the compose-only `HOST_REPO_ROOT` helper variable and clarify the Docker `REPO_ROOT_DIR` value.

## Chunk 1: Container Build Assets

### Task 1: Add a minimal Docker build context

**Files:**

- Create: `.dockerignore`

- [ ] **Step 1: Add ignore rules for local artifacts**

```gitignore
node_modules
dist
data
logs
artifacts
.git
.github
.cursor
.specstory
*.tsbuildinfo
.env
.env.e2e
```

- [ ] **Step 2: Keep repository files needed for install and build**

```gitignore
!package.json
!pnpm-lock.yaml
!pnpm-workspace.yaml
!tsconfig.json
!tsconfig.tests.json
!tsdown.config.ts
!src
!drizzle
!drizzle.config.ts
!README.md
```

### Task 2: Build a production image for the bot

**Files:**

- Create: `Dockerfile`

- [ ] **Step 1: Define a shared Node 22 + pnpm base**

```dockerfile
FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app
```

- [ ] **Step 2: Install dependencies once and reuse them for build**

```dockerfile
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm prune --prod
```

- [ ] **Step 3: Create the runtime image with only production artifacts**

```dockerfile
FROM base AS runtime

ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data

CMD ["pnpm", "start"]
```

- [ ] **Step 4: Verify the image builds locally**

Run: `docker build -t kagura:local .`

Expected: build completes successfully and the final stage is tagged as `kagura:local`

## Chunk 2: Compose Deployment

### Task 3: Add a default compose entrypoint

**Files:**

- Create: `compose.yaml`
- Modify: `.env.example`

- [ ] **Step 1: Add a compose file that matches the runtime contract**

```yaml
services:
  kagura:
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - .env
    restart: unless-stopped
    volumes:
      - type: bind
        source: ${HOST_REPO_ROOT:?set HOST_REPO_ROOT in .env}
        target: /workspace
      - type: volume
        source: slack_cc_bot_data
        target: /app/data

volumes:
  slack_cc_bot_data:
```

- [ ] **Step 2: Document the compose-only host repo variable in `.env.example`**

```dotenv
# Docker Compose helper: absolute host path containing candidate repositories.
# Example: /Users/yourname/git
HOST_REPO_ROOT=
```

- [ ] **Step 3: Clarify the container repo root in `.env.example` without breaking local usage**

```dotenv
# Local Node usage example:
# REPO_ROOT_DIR=~/git
#
# Docker Compose usage:
# REPO_ROOT_DIR=/workspace
REPO_ROOT_DIR=~/git
```

- [ ] **Step 4: Validate the compose file**

Run: `docker compose config`

Expected: compose renders a valid single-service configuration with the bind mount and named volume

## Chunk 3: Documentation

### Task 4: Document the Docker workflow for open-source users

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add Docker prerequisites near the setup section**

```md
### Docker deployment prerequisites

- Docker Engine with the Compose plugin
- A filled `.env` file with valid Slack and Anthropic credentials
- A host directory that contains the repositories you want the bot to scan
```

- [ ] **Step 2: Add the image build command**

````md
```bash
docker build -t kagura:local .
```
````

- [ ] **Step 3: Add the compose workflow with the required env values**

````md
1. Copy `.env.example` to `.env`
2. Set `REPO_ROOT_DIR=/workspace`
3. Set `HOST_REPO_ROOT` to the absolute host path that contains your repos
4. Start the bot:

```bash
docker compose up -d --build
```
````

- [ ] **Step 4: Explain persistence and why no port mapping is required**

```md
- The SQLite database is persisted in the `slack_cc_bot_data` Docker volume.
- Your repositories are mounted read-write into `/workspace`.
- No inbound port mapping is required for normal operation because Slack Socket Mode uses outbound connections.
```

## Chunk 4: Verification

### Task 5: Run repository verification after the Docker changes

**Files:**

- Verify only: repository root

- [ ] **Step 1: Confirm the TypeScript build still passes**

Run: `pnpm build`

Expected: the existing build completes without TypeScript or bundling errors

- [ ] **Step 2: Confirm the test suite still passes**

Run: `pnpm test`

Expected: all existing Vitest suites pass with no regressions from the Docker-related changes

- [ ] **Step 3: Re-check the Docker artifacts after docs and env edits**

Run: `docker build -t kagura:local . && docker compose config`

Expected: both commands succeed after the final file set is in place
