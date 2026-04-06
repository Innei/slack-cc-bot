# slack-cc-bot

Run [Anthropic Claude Agent SDK](https://docs.anthropic.com/en/docs/agents) natively in Slack — mention the bot in any channel or thread, route the session into the right repository, and get context-aware replies with Slack-native rich text, live status updates, and persistent memory.

![Node version](https://img.shields.io/badge/Node.js->=22-3c873a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue?style=flat-square&logo=typescript&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.33-f69220?style=flat-square)

## Overview

**slack-cc-bot** is a production-ready scaffold for running the Claude Agent SDK inside a Slack workspace via [Socket Mode](https://api.slack.com/apis/socket-mode). It handles the full lifecycle — ingress, thread context loading, workspace resolution, progress/typing UX, rich-text reply rendering, session resumption, and layered memory management — so you can focus on customizing the agent's behavior.

### How it works

1. A user `@mentions` the bot in a Slack channel/thread, or invokes the workspace Message Action on a Slack message
2. The bot resolves the target repository/workdir from the message text or manual selection
3. The bot fetches the full thread history and normalizes it into a prompt
4. Claude Agent SDK runs with the resolved `cwd`, emitting tool progress and response events
5. A custom MCP server (`slack-ui`) lets Claude update Slack's assistant UI status, including thinking/progress states
6. Slack shows a progress summary first, then switches to the native assistant typing indicator while the final answer is being generated
7. The final reply is posted as Slack rich text blocks, optionally annotated with the active workspace, and split safely if it exceeds Slack limits
8. Sessions plus global/workspace memories are persisted in SQLite for multi-turn continuity and preference recall

### Key features

- **Thread-aware context** — full conversation history passed to Claude on every turn
- **Slack-native reply UX** — progress status, retained tool-activity summary, and native assistant typing indicator while the final answer is generated
- **Rich text rendering** — markdown replies become Slack `rich_text` blocks with support for headings, lists, quotes, code blocks, and automatic long-message splitting
- **Session resumption** — conversations persist across bot restarts (SQLite + Drizzle ORM)
- **Layered memory** — separate persistent preferences, global memories, and workspace memories are injected back into future turns
- **Workspace-aware routing** — each Slack thread binds to a specific repo/workdir instead of the bot process `cwd`
- **Message Action fallback** — manually choose a repo/path when automatic detection is missing or ambiguous
- **Slash commands** — `/usage`, `/workspace`, `/memory`, `/session` for bot introspection and management
- **Stop controls** — react with 🛑 on any thread message or use the "Stop Reply" message shortcut to cancel in-progress replies
- **Auto-provisioning** — slash commands and shortcuts are automatically registered to the Slack App manifest on startup
- **UI state management** — Claude can set status text and loading indicators via a custom MCP tool
- **Strict validation** — all external inputs (env, Slack events, tool calls) validated with Zod
- **Secret redaction** in logs

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22.0.0
- [pnpm](https://pnpm.io/) >= 10.33.0
- A [Slack app](https://api.slack.com/apps) with **Socket Mode** and **Interactivity** enabled (see [Slack app manifest](#slack-app-manifest) below)
- A **Message Action** configured with callback ID `workspace_message_action` (add it in your Slack app configuration)

## Slack app manifest

Create a new Slack app at <https://api.slack.com/apps> → **From a manifest**, then paste the JSON below. Adjust `name` / `display_name` as needed.

<details>
<summary>Click to expand manifest</summary>

```json
{
  "display_information": {
    "name": "cc-001"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "cc-001",
      "always_online": false
    }
  },
  "oauth_config": {
    "scopes": {
      "user": [
        "canvases:read",
        "canvases:write",
        "channels:history",
        "chat:write",
        "groups:history",
        "im:history",
        "mpim:history",
        "search:read.files",
        "search:read.im",
        "search:read.mpim",
        "search:read.private",
        "search:read.public",
        "search:read.users",
        "users:read",
        "users:read.email"
      ],
      "user_optional": [
        "canvases:read",
        "canvases:write",
        "groups:history",
        "im:history",
        "mpim:history",
        "search:read.files",
        "search:read.im",
        "search:read.mpim",
        "search:read.private"
      ],
      "bot": [
        "commands",
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "im:history",
        "reactions:read",
        "reactions:write",
        "users:read",
        "users:write"
      ]
    },
    "pkce_enabled": false
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_mention", "message.channels", "message.im"]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

</details>

After creation, grab the **Bot Token** (`xoxb-...`), **App-Level Token** (`xapp-...`, with `connections:write`), and **Signing Secret** from the app settings page.

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

Fill in the required values:

| Variable               | Description                                  |
| ---------------------- | -------------------------------------------- |
| `SLACK_BOT_TOKEN`      | Bot user OAuth token (`xoxb-...`)            |
| `SLACK_APP_TOKEN`      | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Request verification secret                  |
| `REPO_ROOT_DIR`        | Root directory containing candidate repos    |

Optional — for automatic slash command registration:

| Variable                     | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `SLACK_APP_ID`               | Your Slack App ID (from Basic Information)                      |
| `SLACK_CONFIG_REFRESH_TOKEN` | Configuration refresh token (`xoxe-...`) for automatic rotation |
| `SLACK_CONFIG_TOKEN`         | Configuration access token (fallback, expires every 12h)        |

See [`.env.example`](.env.example) for all available options including `REPO_SCAN_DEPTH`, `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`, and logging configuration.

This repository does not require an `ANTHROPIC_API_KEY` environment variable to boot. Claude authentication follows your local Claude Agent SDK / runtime setup.

The bot scans `REPO_ROOT_DIR` recursively up to `REPO_SCAN_DEPTH`. When it can resolve a repo/path from the conversation, it binds the Slack thread to that concrete workspace path. When no repo is identified, it proceeds without a workspace instead of falling back to the bot process `cwd`.

When Slack app manifest sync is enabled, the bot can rotate Slack configuration tokens automatically on startup. Use `SLACK_CONFIG_REFRESH_TOKEN` for long-lived setup; `SLACK_CONFIG_TOKEN` remains available as a short-lived fallback.

#### Docker deployment prerequisites

- Docker Engine with the Docker Compose plugin
- A `.env` file with valid Slack credentials
- An absolute host directory containing the repositories you want the bot to scan

### 3. Database setup

No manual database bootstrap is required for normal usage. The app creates the SQLite tables it needs on startup.

If you are developing schema changes, use:

```bash
pnpm db:generate
pnpm db:migrate
```

### 4. Run

```bash
# Development (with hot reload)
pnpm dev

# Production
pnpm build && pnpm start
```

#### Run with Docker Compose

1. Copy `.env.example` to `.env` if you have not already.
2. Set `REPO_ROOT_DIR=/workspace`.
3. Set `HOST_REPO_ROOT` to the absolute host path that contains your repositories.
4. On Linux, if you expect the bot to edit bind-mounted repositories, set `HOST_UID_GID` to your host `uid:gid` value, for example `1000:1000` (you can inspect it with `id -u` and `id -g`).

To build the image directly:

```bash
docker build -t slack-cc-bot:local .
```

To start the bot with Compose:

```bash
docker compose up -d --build
```

- SQLite data is persisted in the `slack_cc_bot_data` volume at `/app/data`.
- If you enable `LOG_TO_FILE=true`, add a separate mount if you want log files to survive container replacement.
- Repositories from `HOST_REPO_ROOT` are mounted read-write into `/workspace`.
- No inbound port mapping is required because Slack Socket Mode uses outbound connections.

## Project structure

```
src/
├── index.ts                    # Entry point
├── application.ts              # Composition root (wires all dependencies)
├── env/server.ts               # Validated environment schema
├── logger/                     # Structured logging with redaction
├── db/                         # SQLite database + Drizzle schema
├── session/                    # Session persistence (SQLite-backed)
├── workspace/                  # Repo discovery and workspace resolution
├── slack/
│   ├── app.ts                  # @slack/bolt initialization
│   ├── commands/               # Slash command handlers + manifest sync
│   ├── ingress/                # @mention / thread / assistant ingress
│   ├── interactions/           # Message Action + modal handlers
│   ├── context/                # Thread history loading & normalization
│   └── render/                 # Streaming output & UI state rendering
├── claude/
│   ├── executor/               # Agent SDK wrapper + MCP server
│   └── tools/                  # publish_state tool definition
└── schemas/                    # Zod schemas for Slack events & Claude tools
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

## Architecture

The application follows a **composition root** pattern — `application.ts` assembles the entire dependency graph:

```
Logger → Database → SessionStore → SlackApp → ClaudeExecutor
```

All modules receive dependencies via function parameters (no global singletons). The Claude executor exposes a custom MCP server (`slack-ui`) with a single `publish_state` tool that lets the agent control Slack's assistant thread UI.

Replies are rendered as Slack block content instead of raw mrkdwn text, so formatting survives the round trip from Claude to Slack. During execution, the bot keeps a compact progress message in the thread, clears the thinking state after the first reply, and uses Slack's native typing indicator while the final text is still being produced.

## Workspace routing

New threads try to infer the target repository from the incoming Slack message. Mention a repo name such as `slack-cc-bot`, a relative repo path such as `team/slack-cc-bot`, or an absolute path under `REPO_ROOT_DIR`.

If the bot cannot determine the workspace confidently and you want to bind one manually, use the Slack Message Action on the relevant message:

1. Run the `workspace_message_action` message action.
2. Accept the detected repo, or choose a repo/path manually in the modal.
3. Decide whether to take over the current thread or start a new thread/session.

Once a thread is bound, follow-up replies reuse the same workspace. If you switch the workspace for that thread, the bot starts a fresh Claude session instead of resuming the old one with the wrong `cwd`.

## Memory model

The bot keeps three layers of memory:

- **Preferences** — persistent instructions such as naming, language, tone, or standing rules
- **Global memories** — facts that should apply across workspaces
- **Workspace memories** — repo-specific context and decisions

Preference memories are injected ahead of other memories so they take priority in future turns. After each conversation, a lightweight extractor can promote implicit preferences that appeared in the exchange, which helps the bot remember things like preferred language, nicknames, or durable working rules even across restarts.

> [!NOTE]
> Detailed specifications for each subsystem are available in [`docs/specs/`](docs/specs/).

## Slash commands

The bot registers four slash commands for introspection and management:

| Command                | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `/usage`               | Show bot stats — session count, memory count, repos, uptime   |
| `/workspace`           | List all available workspaces                                 |
| `/workspace <name>`    | Look up a specific workspace (path, aliases, memory count)    |
| `/memory`              | Show help for memory subcommands                              |
| `/memory list <repo>`  | List recent memories for a repo                               |
| `/memory count <repo>` | Show total memory count for a repo                            |
| `/memory clear <repo>` | Clear all memories for a repo                                 |
| `/session`             | Show total session count                                      |
| `/session <thread_ts>` | Inspect a specific session (workspace, Claude session, state) |

All responses are **ephemeral** (only visible to the invoking user).

### Stopping in-progress replies

Two mechanisms are available to cancel an active bot reply:

| Method               | How to use                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Emoji reaction**   | Add a 🛑 (`:octagonal_sign:`) or 🚫 (`:stop_sign:`) reaction to any message in the thread (the trigger message, the bot's progress message, or the thread root) |
| **Message shortcut** | Right-click (or `⋯` menu) on any message in the thread → **Stop Reply**                                                                                         |

Both stop all active executions in the thread and finalize the bot's progress message as "stopped."

### Automatic manifest sync

When `SLACK_APP_ID` is set along with `SLACK_CONFIG_REFRESH_TOKEN` (or `SLACK_CONFIG_TOKEN`), the bot automatically registers any missing slash commands and shortcuts to the Slack App manifest on startup via the [App Manifest API](https://api.slack.com/reference/manifests). No manual configuration in the Slack dashboard is needed.

**Token rotation:** Slack configuration tokens expire every 12 hours. If you provide `SLACK_CONFIG_REFRESH_TOKEN`, the bot calls [`tooling.tokens.rotate`](https://api.slack.com/methods/tooling.tokens.rotate) on each startup and persists the new token pair to `data/slack-config-tokens.json`. This means you only need to set the refresh token once.

To generate the tokens:

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Scroll to **"Your App Configuration Tokens"** (below your app list)
3. Click **Generate Token** → select your workspace → **Generate**
4. Copy the **Refresh Token** (`xoxe-...`) into `SLACK_CONFIG_REFRESH_TOKEN`
5. Copy the **App ID** from your app's Basic Information page into `SLACK_APP_ID`

## Live E2E

The repository includes a real Slack <-> Claude live E2E runner that starts the local Socket Mode app, posts a real `@mention` into a dedicated Slack channel, waits for the Claude-backed reply, and records every `assistant.threads.setStatus` payload to a local JSONL probe.

### Additional prerequisites

- A dedicated Slack test channel ID for `SLACK_E2E_CHANNEL_ID`
- A user token for `SLACK_E2E_TRIGGER_USER_TOKEN` that can post into that channel
- The existing bot token must already be installed in that channel and have the scopes listed above

Recommended safety setup:

- Use a dedicated Slack channel for live E2E traffic
- Use a dedicated test user/token for the trigger account
- Avoid reusing production channels because the runner posts real messages

### Environment

Copy the example and fill in real values:

```bash
cp .env.e2e.example .env.e2e
```

| Variable                       | Description                                        |
| ------------------------------ | -------------------------------------------------- |
| `SLACK_E2E_CHANNEL_ID`         | Dedicated Slack channel for E2E traffic            |
| `SLACK_E2E_TRIGGER_USER_TOKEN` | User token that can post into the test channel     |
| `SLACK_BOT_TOKEN`              | Bot token for the E2E Slack app (overrides `.env`) |
| `SLACK_APP_TOKEN`              | App token for the E2E Slack app (overrides `.env`) |
| `SLACK_SIGNING_SECRET`         | Signing secret for the E2E app (overrides `.env`)  |

See [`.env.e2e.example`](.env.e2e.example) for all available options. E2E configuration is kept in `.env.e2e` (separate from the main `.env`) and loaded with `override: true`, so the E2E bot tokens replace the main tokens only during E2E runs without ever touching `.env`.

### Run the live E2E

```bash
# Run all scenarios serially (default)
pnpm e2e

# Run a specific scenario by id
pnpm e2e -- slash-commands

# Interactive scenario picker
pnpm e2e -- --interactive

# List all discovered scenarios
pnpm e2e -- --list

# Search/filter scenarios by keyword
pnpm e2e -- --search workspace
```

The CLI auto-discovers `run.ts` and `run-*.ts` files under `src/e2e/live/` and runs them serially. Each scenario manages its own application lifecycle, cleanup, and result artifacts.

Recent scenarios cover rich text rendering, long reply splitting, workspace label attachment, clearing the thinking state after reply, retained progress summaries, and cross-session preference memory recall.

## License

[MIT](LICENSE) © [Innei](https://innei.in)
