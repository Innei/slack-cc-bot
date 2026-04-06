# slack-cc-bot

Run [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) natively in Slack — `@mention` the bot, it routes the session into the right repository, and replies with Slack-native rich text, live progress, and persistent memory.

![Node version](https://img.shields.io/badge/Node.js->=22-3c873a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.33-f69220?style=flat-square)

## Why

Running a Claude agent inside Slack requires gluing together thread context, workspace routing, streaming UX, session persistence, and memory — all adapted to Slack's API conventions. **slack-cc-bot** handles that full lifecycle via [Socket Mode](https://api.slack.com/apis/socket-mode), so you can focus on the agent's behavior.

## How it works

```
@mention / Message Action
  → resolve target repo
  → load thread history (text + images)
  → run agent in repo cwd
  → stream progress → post rich-text reply
  → persist session & memory to SQLite
```

## Features

**Conversation** — Thread-aware multimodal context (text + images), session resumption across restarts, layered memory (global / workspace / preferences).

**Slack UX** — Rich text rendering (headings, lists, code blocks, auto-splitting), live progress indicators, reaction lifecycle, native assistant typing.

**Workspace routing** — Each thread binds to a repo/workdir. Auto-detected from message text, or manually chosen via Message Action.

**Agent control** — Pluggable provider registry, stop via :octagonal_sign: reaction or message shortcut, slash commands for introspection (`/usage`, `/workspace`, `/memory`, `/session`, `/version`, `/provider`).

**Operations** — Auto-provisioned manifest (commands + shortcuts), online-presence heartbeat, Home tab, Zod-validated inputs, secret redaction in logs.

## Getting started

```bash
git clone https://github.com/Innei/slack-cc-bot.git
cd slack-cc-bot
pnpm install
cp .env.example .env # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, REPO_ROOT_DIR
pnpm dev             # or: pnpm build && pnpm start
```

See [docs/configuration.md](docs/configuration.md) for the full environment variable reference, Slack app manifest, token rotation, and Docker deployment.

## Documentation

| Document                                            | Contents                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Configuration](docs/configuration.md)              | Environment variables, Slack manifest, token rotation, Docker                                    |
| [Architecture](docs/architecture.md)                | Composition root, agent providers, rendering, workspace routing, memory model, project structure |
| [Slash commands & controls](docs/slash-commands.md) | All slash commands, stop controls, reaction lifecycle                                            |
| [Live E2E testing](docs/e2e-testing.md)             | E2E setup, environment, running scenarios                                                        |
| [Specs](docs/specs/)                                | Detailed subsystem specifications                                                                |

## Scripts

| Command                       | Description                   |
| ----------------------------- | ----------------------------- |
| `pnpm dev`                    | Run with nodemon + tsx        |
| `pnpm build`                  | Compile TypeScript            |
| `pnpm test`                   | Run Vitest test suite         |
| `pnpm start`                  | Run compiled output           |
| `pnpm typecheck`              | Type-check without emitting   |
| `pnpm e2e`                    | Run all live Slack E2E cases  |
| `pnpm e2e -- <id>`            | Run a specific scenario by id |
| `pnpm e2e -- --interactive`   | Interactive scenario picker   |
| `pnpm e2e -- --list`          | List all discovered scenarios |
| `pnpm e2e -- --search <term>` | Search/filter by keyword      |
| `pnpm db:generate`            | Generate Drizzle migrations   |
| `pnpm db:migrate`             | Apply migrations              |
| `pnpm db:studio`              | Open Drizzle Studio           |

## License

MIT © Innei, Released under the MIT License.

> [Personal Website](https://innei.in/) · GitHub [@Innei](https://github.com/innei/)
