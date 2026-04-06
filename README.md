# slack-cc-bot

Run [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) natively in Slack — mention the bot in any channel or thread, route the session into the right repository, and get context-aware replies with Slack-native rich text, live status updates, and persistent memory.

![Node version](https://img.shields.io/badge/Node.js->=22-3c873a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.33-f69220?style=flat-square)

## Overview

**slack-cc-bot** is a production-ready scaffold for running the Claude Agent SDK inside a Slack workspace via [Socket Mode](https://api.slack.com/apis/socket-mode). It handles the full lifecycle — ingress, thread context loading, workspace resolution, progress/typing UX, rich-text reply rendering, session resumption, and layered memory management — so you can focus on customizing the agent's behavior.

### How it works

1. A user `@mentions` the bot in a Slack channel/thread, or invokes the workspace Message Action on a Slack message
2. The bot resolves the target repository/workdir from the message text or manual selection
3. The bot fetches the full thread history (including images) and normalizes it into a prompt
4. The agent provider runs with the resolved `cwd`, emitting tool progress and response events
5. A custom MCP server (`slack-ui`) lets the agent update Slack's assistant UI status, including thinking/progress states
6. Slack shows a progress summary first, then switches to the native assistant typing indicator while the final answer is being generated
7. The final reply is posted as Slack rich text blocks, optionally annotated with the active workspace, and split safely if it exceeds Slack limits
8. Sessions plus global/workspace memories are persisted in SQLite for multi-turn continuity and preference recall

### Key features

- **Thread-aware context** — full conversation history (text + images) passed to the agent on every turn
- **Image support** — images shared in Slack messages are downloaded and included as multimodal content
- **Slack-native reply UX** — progress status, retained tool-activity summary, and native assistant typing indicator while the final answer is generated
- **Rich text rendering** — markdown replies become Slack `rich_text` blocks with support for headings, lists, quotes, code blocks, and automatic long-message splitting
- **Reaction lifecycle** — acknowledgement reaction on receive, completion reaction on finish, configurable emoji names
- **Session resumption** — conversations persist across bot restarts (SQLite + Drizzle ORM)
- **Layered memory** — separate persistent preferences, global memories, and workspace memories are injected back into future turns
- **Workspace-aware routing** — each Slack thread binds to a specific repo/workdir instead of the bot process `cwd`
- **Message Action fallback** — manually choose a repo/path when automatic detection is missing or ambiguous
- **Pluggable agent providers** — provider registry with per-thread switching via `/provider`
- **Slash commands** — `/usage`, `/workspace`, `/memory`, `/session`, `/version`, `/provider` for bot introspection and management
- **Stop controls** — react with :octagonal_sign: on any thread message or use the "Stop Reply" message shortcut to cancel in-progress replies
- **Home tab** — app home view showing bot stats, available workspaces, and quick-start guide
- **Online presence** — periodic heartbeat keeps the bot's green dot active
- **Auto-provisioning** — slash commands and shortcuts are automatically registered to the Slack App manifest on startup
- **UI state management** — the agent can set status text and loading indicators via a custom MCP tool
- **Strict validation** — all external inputs (env, Slack events, tool calls) validated with Zod
- **Secret redaction** in logs

## Getting started

### 1. Clone and install

```bash
git clone https://github.com/Innei/slack-cc-bot.git
cd slack-cc-bot
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in the required values (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `REPO_ROOT_DIR`).

See [docs/configuration.md](docs/configuration.md) for the full environment variable reference, Slack app manifest, token rotation, and Docker deployment instructions.

### 3. Run

```bash
# Development (with hot reload)
pnpm dev

# Production
pnpm build && pnpm start
```

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

## Documentation

| Document                                            | Contents                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Configuration](docs/configuration.md)              | Environment variables, Slack manifest, token rotation, Docker                                    |
| [Slash commands & controls](docs/slash-commands.md) | All slash commands, stop controls, reaction lifecycle                                            |
| [Architecture](docs/architecture.md)                | Composition root, agent providers, rendering, workspace routing, memory model, project structure |
| [Live E2E testing](docs/e2e-testing.md)             | E2E setup, environment, running scenarios                                                        |
| [Specs](docs/specs/)                                | Detailed subsystem specifications                                                                |

## License

[MIT](LICENSE) © [Innei](https://innei.in)
