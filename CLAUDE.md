# CLAUDE.md

Project conventions and guidelines for AI-assisted development on **slack-cc-bot**.

## Monorepo Structure

This is a pnpm workspace monorepo with the following packages:

| Package                  | Path                | Description                         |
| ------------------------ | ------------------- | ----------------------------------- |
| `@slack-cc-bot/bot`      | `apps/bot`          | Slack bot (Bolt + Claude Agent SDK) |
| `@slack-cc-bot/web-ui`   | `apps/web-ui`       | Web dashboard (Vite + React)        |
| `@slack-cc-bot/live-cli` | `packages/live-cli` | E2E test CLI runner                 |

## Build & Run

| Command                 | Purpose                         |
| ----------------------- | ------------------------------- |
| `pnpm build`            | Build all packages              |
| `pnpm build:bot`        | Build bot only                  |
| `pnpm build:web`        | Build web UI only               |
| `pnpm dev`              | Bot development with hot reload |
| `pnpm dev:web`          | Web UI dev server (port 3100)   |
| `pnpm test`             | Run bot unit tests (Vitest)     |
| `pnpm test:watch`       | Watch mode for bot unit tests   |
| `pnpm typecheck`        | Type-check all packages         |
| `pnpm e2e`              | Run all live Slack E2E          |
| `pnpm e2e -- <id>`      | Run specific scenario by id     |
| `pnpm e2e -- -i`        | Interactive scenario picker     |
| `pnpm e2e -- -l`        | List all discovered cases       |
| `pnpm e2e -- -s <term>` | Search/filter by keyword        |
| `pnpm e2e:list`         | List all discovered cases       |

## Development workflow

Every feature or bugfix **must** include:

1. **Implementation** — source code under the relevant `apps/` or `packages/` directory.
2. **Unit tests** — in `apps/bot/tests/*.test.ts` (bot) using Vitest. Mock external dependencies (Slack client, Claude SDK). Test handler logic with in-memory stores.
3. **Live E2E test** — in `apps/bot/src/e2e/live/run-*.ts`. These run against a real Slack workspace with Socket Mode. Follow the existing polling + assertion pattern.

Always run `pnpm build` and `pnpm test` before considering a task complete.

## Code conventions

- **TypeScript strict mode**, ESM-only (`"type": "module"` in package.json).
- **Dependency injection** via function parameters — no global singletons.
- **Zod** for all external input validation (Slack events, tool calls, env vars).
- **No default exports** — use named exports everywhere.
- Store interfaces live in `*/types.ts`; SQLite implementations are separate files.

### Bot (`apps/bot`)

- Slash command handlers go in `src/slack/commands/`.
- Ingress handlers (mentions, thread replies, assistant) go in `src/slack/ingress/`.
- Interaction handlers (shortcuts, modals, buttons) go in `src/slack/interactions/`.

### Web UI (`apps/web-ui`)

- Built with Vite, React, TailwindCSS, React Router, Zustand, Jotai, Motion, Lucide.
- Follows Vercel design system: Geist font, shadow-as-border, achromatic palette.
- Pages in `src/pages/`, reusable components in `src/components/`, layouts in `src/layouts/`.
- State: Zustand for global stores, Jotai for atomic UI state.

## Slash commands

Slash commands are registered in `apps/bot/src/slack/commands/register.ts` and auto-synced to the Slack App manifest on startup when `SLACK_APP_ID` is set along with either `SLACK_CONFIG_REFRESH_TOKEN` or `SLACK_CONFIG_TOKEN`.

Token management: Slack config tokens expire every 12 hours. Set `SLACK_CONFIG_REFRESH_TOKEN` (from the Slack App settings page) and the bot will automatically rotate tokens on each startup, persisting the new refresh token to `data/slack-config-tokens.json`.

To add a new slash command:

1. Create `apps/bot/src/slack/commands/<name>-command.ts` with a `handle<Name>Command(text, deps)` function.
2. Add it to the `COMMANDS` array in `register.ts`.
3. Add the manifest entry in `manifest-sync.ts` `DESIRED_COMMANDS`.
4. Write unit tests in `apps/bot/tests/slash-commands.test.ts`.
5. Run `pnpm build && pnpm test`.

## Project structure

```
apps/
├── bot/                          # Slack bot application
│   ├── src/
│   │   ├── index.ts              # Entry point
│   │   ├── application.ts        # Composition root
│   │   ├── env/server.ts         # Validated env schema
│   │   ├── logger/               # Structured logging + redaction
│   │   ├── db/                   # SQLite + Drizzle schema
│   │   ├── session/              # Session persistence
│   │   ├── memory/               # Cross-thread memory store
│   │   ├── workspace/            # Repo discovery + resolution
│   │   ├── slack/
│   │   │   ├── app.ts            # Bolt initialization + handler registration
│   │   │   ├── commands/         # Slash command handlers
│   │   │   ├── ingress/          # @mention / thread / assistant handlers
│   │   │   ├── interactions/     # Message Action + modal handlers
│   │   │   ├── context/          # Thread history loading
│   │   │   └── render/           # Streaming output + UI state
│   │   ├── claude/
│   │   │   ├── executor/         # Agent SDK wrapper + MCP server
│   │   │   └── tools/            # MCP tool definitions
│   │   └── schemas/              # Zod schemas
│   ├── tests/                    # Unit tests (Vitest)
│   └── drizzle/                  # Database migrations
│
├── web-ui/                       # Web dashboard
│   ├── src/
│   │   ├── main.tsx              # Entry point
│   │   ├── app.tsx               # Router + routes
│   │   ├── components/           # Reusable UI components
│   │   ├── layouts/              # Page layouts
│   │   ├── pages/                # Route pages
│   │   ├── stores/               # Zustand + Jotai state
│   │   ├── styles/               # CSS (Tailwind + Geist)
│   │   └── lib/                  # Utilities
│   └── index.html                # HTML entry
│
packages/
└── live-cli/                     # Standalone E2E CLI
    └── src/
        ├── cli.ts                # Entry point
        ├── discovery.ts          # Scenario discovery + filtering
        ├── prompt.ts             # Interactive multi-select
        ├── runner.ts             # Serial execution + summary
        └── types.ts              # LiveE2EScenario interface
```

## Testing patterns

### Unit tests (`apps/bot/tests/`)

- Use `vi.mock()` for external modules (`@anthropic-ai/claude-agent-sdk`).
- Create in-memory store implementations (see `createMemorySessionStore()`, `createMemoryStore()` in existing tests).
- Use `createSlackClientFixture()` pattern for mock Slack clients that capture calls.
- Test file names: `apps/bot/tests/<feature>.test.ts`.

### Live E2E tests (`apps/bot/src/e2e/live/`)

- Each scenario is a standalone `run-*.ts` file that exports a `scenario` object with `id`, `title`, `description`, `keywords`, and `run`.
- The CLI lives in `packages/live-cli/` and is built with `commander` + `@clack/prompts`. It auto-discovers scenarios from `apps/bot/src/e2e/live/` and supports serial all-run, interactive multi-select, keyword search, and direct id-based execution.
- Uses `SlackApiClient` to post real messages and poll for replies.
- Follows the pattern: start app → post trigger message → poll until assertions pass or timeout → write result JSON → assert.
- Run a specific scenario: `pnpm e2e -- <scenario-id>`.
- List all scenarios: `pnpm e2e:list` or `pnpm e2e -- --list`.
