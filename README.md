<div align="center">

# 🎭 Kagura

_Every thread a stage, every response a dance_

[![Node version](https://img.shields.io/badge/Node.js->=22-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.33-f69220?style=flat-square)](https://pnpm.io)

</div>

> _In Japanese mythology, Ame-no-Uzume performed a divine dance before the closed doors of Amano-Iwato — the heavenly rock cave where Amaterasu had hidden herself, plunging the world into darkness. Her dance, accompanied by music and laughter, drew the sun goddess back into the world. This was the first **kagura** (神楽) — "the entertainment of the gods."_

**Kagura** brings that spirit to Slack. Run [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) natively in your workspace — `@mention` the bot, it routes the session into the right repository, and replies with Slack-native rich text, live progress, and persistent memory.

## Why

Running a Claude agent inside Slack requires gluing together thread context, workspace routing, streaming UX, session persistence, and memory — all adapted to Slack's API conventions. **kagura** handles that full lifecycle via [Socket Mode](https://api.slack.com/apis/socket-mode), so you can focus on the agent's behavior.

## How it works

```
@mention / Message Action
  → resolve target repo
  → load thread history (text + files + images)
  → run agent in repo cwd
  → stream progress → post rich-text reply and generated attachments
  → persist session & memory to SQLite
  → observe everything live in the web dashboard
```

## Features

**Conversation** — Thread-aware multimodal context (text + files + images), session resumption across restarts, layered memory (global / workspace / preferences).

**Slack UX** — Rich text rendering (headings, lists, code blocks, auto-splitting), live progress indicators, reaction lifecycle, native assistant typing.

**Workspace routing** — Each thread binds to a repo/workdir. Auto-detected from message text, or manually chosen via Message Action.

**Agent control** — Pluggable provider registry, stop via :octagonal_sign: reaction or message shortcut, slash commands for introspection (`/usage`, `/workspace`, `/memory`, `/session`, `/version`, `/provider`).

**Operations** — Auto-provisioned manifest (commands + shortcuts), online-presence heartbeat, Home tab, Zod-validated inputs, secret redaction in logs.

**Web dashboard** — Vite + React UI (`apps/web-ui`) fed by an embedded Hono HTTP API (`apps/bot/src/server`). Drill into sessions, inspect memory, and monitor cost and cache usage.

## Repository layout

This repository is a pnpm monorepo:

```
apps/
├── bot/       # Slack bot + embedded Hono HTTP API (was: ./src)
└── web-ui/    # Vite 8 + React dashboard
packages/
└── live-cli/  # E2E scenario runner
```

## Getting started

```bash
git clone https://github.com/Innei/kagura.git
cd kagura
pnpm install
cp .env.example .env # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, REPO_ROOT_DIR

# Terminal 1 — Slack bot + HTTP API (http://localhost:4000)
pnpm dev

# Terminal 2 — Web dashboard (http://localhost:5173)
pnpm dev:web
```

See [docs/configuration.md](docs/configuration.md) for the full environment variable reference, Slack app manifest, token rotation, and Docker deployment.

## Documentation

| Document                                            | Contents                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Configuration](docs/configuration.md)              | Environment variables, Slack manifest, token rotation, Docker                                    |
| [Architecture](docs/architecture.md)                | Composition root, agent providers, rendering, workspace routing, memory model, project structure |
| [Slash commands & controls](docs/slash-commands.md) | All slash commands, stop controls, reaction lifecycle                                            |
| [Live E2E testing](docs/e2e-testing.md)             | E2E setup, environment, running scenarios                                                        |
| [Web UI](apps/web-ui/README.md)                     | Dashboard tech stack and dev workflow                                                            |
| [Specs](docs/specs/)                                | Detailed subsystem specifications                                                                |

## Scripts (root-level)

All scripts are available at the monorepo root and forward to the right workspace.

| Command                       | Description                                 |
| ----------------------------- | ------------------------------------------- |
| `pnpm dev`                    | Run the bot (Slack + HTTP API) with nodemon |
| `pnpm dev:web`                | Run the web UI in Vite dev mode             |
| `pnpm build`                  | Compile the bot TypeScript                  |
| `pnpm build:web`              | Build the web UI for production             |
| `pnpm test`                   | Run Vitest test suite (bot)                 |
| `pnpm start`                  | Run the compiled bot                        |
| `pnpm typecheck`              | Type-check every workspace                  |
| `pnpm e2e`                    | Run all live Slack E2E cases                |
| `pnpm e2e -- <id>`            | Run a specific scenario by id               |
| `pnpm e2e -- --interactive`   | Interactive scenario picker                 |
| `pnpm e2e -- --list`          | List all discovered scenarios               |
| `pnpm e2e -- --search <term>` | Search/filter by keyword                    |
| `pnpm db:generate`            | Generate Drizzle migrations (bot)           |
| `pnpm db:migrate`             | Apply migrations (bot)                      |
| `pnpm db:studio`              | Open Drizzle Studio (bot)                   |

## License

MIT © Innei, Released under the MIT License.

> [Personal Website](https://innei.in/) · GitHub [@Innei](https://github.com/innei/)
