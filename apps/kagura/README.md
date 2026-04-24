<div align="center">

# 🎭 Kagura

_Every thread a stage, every response a dance_

[![npm](https://img.shields.io/npm/v/@innei/kagura?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/@innei/kagura)
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
```

## Features

**Conversation** — Thread-aware multimodal context (text + files + images), session resumption across restarts, layered memory (global / workspace / preferences).

**Slack UX** — Rich text rendering (headings, lists, code blocks, auto-splitting), live progress indicators, reaction lifecycle, native assistant typing.

**Workspace routing** — Each thread binds to a repo/workdir. Auto-detected from message text, or manually chosen via Message Action.

**Agent control** — Pluggable provider registry, stop via `stop`/`cancel` keyword, :octagonal_sign: reaction, or message shortcut, slash commands for introspection (`/usage`, `/workspace`, `/memory`, `/session`, `/version`, `/provider`).

**Operations** — Auto-provisioned manifest (commands + shortcuts), online-presence heartbeat, Home tab, Zod-validated inputs, secret redaction in logs.

## Install

```bash
npm install -g @innei/kagura
# or: pnpm add -g @innei/kagura
```

Requires Node.js ≥ 22. The package ships two bins: `kagura` (the CLI router + wizard) and `kagura-app` (the bot, bypassing the CLI).

## First run

```bash
kagura
```

`kagura` detects that no configuration exists and launches an interactive wizard:

1. **Select an AI provider** — `claude-code` (Anthropic Claude via [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)) or `codex-cli` (OpenAI Codex via the `codex` CLI).
2. **Set up your Slack app**
   - **Create a new one** — kagura opens `api.slack.com/apps?new_app=1&manifest_json=…` with the manifest already filled in; click Create → Install. If you have a Slack config token set, it can also call `apps.manifest.create` directly.
   - **Reuse an existing one** — paste the App ID and credentials.
   - **Skip for now** — a `.env` skeleton with commented placeholders is written so you can fill it in later.
3. **Paste tokens** — Bot Token (`xoxb-`), App-Level Token (`xapp-`), and Signing Secret. Each token is live-validated against Slack's `auth.test` before being written.
4. **Point at your repos** — `REPO_ROOT_DIR`, e.g. `~/git`.
5. **Start now** — the wizard offers to launch the bot inline once everything is in place.

Re-run `kagura init` at any time to reconfigure.

## Configuration layout

Everything lands under `~/.config/kagura/` by default. Override with `$KAGURA_HOME` (useful for Docker or multi-tenant installs). When invoked inside a kagura repo checkout, cwd wins so dev mode keeps working.

```
~/.config/kagura/
├── .env             # secrets: Slack tokens, API keys
├── config.json      # non-secret tunables: provider, model, paths, log level
├── data/
│   ├── sessions.db                 # Drizzle-managed SQLite
│   └── slack-config-tokens.json    # rotating Slack config tokens
└── logs/                           # daily logs (when LOG_TO_FILE=true)
```

**Precedence** when a key lives in more than one place: `environment > config.json > built-in default`. Put secrets in `.env` and everything else in `config.json`. See [docs/configuration.md](docs/configuration.md) for the full key reference.

Example `config.json`:

```json
{
  "codex": {
    "model": "gpt-5.5",
    "reasoningEffort": "medium",
    "sandbox": "danger-full-access"
  },
  "defaultProviderId": "codex-cli",
  "logLevel": "info",
  "repoRootDir": "~/git"
}
```

## Subcommands

| Command                          | What it does                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| `kagura`                         | Run the bot; launch init wizard if config is incomplete             |
| `kagura init`                    | Run the onboarding wizard unconditionally                           |
| `kagura doctor`                  | Diagnose config + connectivity; exit 0 / 1 / 2 by worst severity    |
| `kagura doctor --json`           | Machine-readable report (for CI / scripts)                          |
| `kagura manifest print`          | Print the kagura-desired Slack manifest (no API call)               |
| `kagura manifest export`         | Fetch the live manifest of your Slack app via config token          |
| `kagura manifest sync`           | Push the kagura-desired manifest into your Slack app                |
| `kagura manifest sync --dry-run` | Show what would change without writing                              |
| `kagura config path`             | Print `~/.config/kagura/` (useful for `$(kagura config path)/.env`) |
| `kagura config path --json`      | Emit `{ configDir, envFile, configJsonFile, dbPath, logDir, … }`    |
| `kagura --version`               | Print version + commit hash + commit date                           |
| `kagura --help`                  | Show help (works on every subcommand)                               |
| `kagura-app`                     | Run the bot directly, skipping config detection (systemd/Docker)    |

### Common recipes

```bash
# Diagnose why the bot won't start
kagura doctor

# Edit secrets or tunables by hand
$EDITOR "$(kagura config path)/.env"
$EDITOR "$(kagura config path)/config.json"

# Generate a manifest.json you can upload to Slack manually
kagura manifest print > manifest.json

# After changing desired scopes / commands, push to Slack
kagura manifest sync --dry-run
kagura manifest sync
```

### Prerequisites

- A Slack workspace where you can create apps.
- **Socket Mode** enabled on the app (the manifest template does this automatically).
- The AI CLI you picked logged in and ready:
  - Claude: run `claude login` first, or set `ANTHROPIC_API_KEY`.
  - Codex: run `codex login` first, or set `OPENAI_API_KEY`.

If something is off, `kagura doctor` will tell you which check failed.

## Getting started (development)

```bash
git clone https://github.com/Innei/kagura.git
cd kagura
pnpm install
cp .env.example .env # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, REPO_ROOT_DIR
pnpm dev             # or: pnpm build && pnpm start
```

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
