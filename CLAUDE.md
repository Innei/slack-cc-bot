# CLAUDE.md

Project conventions and guidelines for AI-assisted development on **kagura**.

## Repository layout (monorepo)

```
apps/
├── bot/       # Slack bot + embedded Hono HTTP API
│   ├── src/
│   │   ├── index.ts                    # Bot entry point
│   │   ├── application.ts              # Composition root
│   │   ├── server/                     # Hono HTTP API (consumed by web-ui)
│   │   │   ├── http-server.ts
│   │   │   ├── types.ts
│   │   │   └── routes/
│   │   ├── env/server.ts               # Validated env schema
│   │   ├── logger/                     # Structured logging + redaction
│   │   ├── db/                         # SQLite + Drizzle schema
│   │   ├── session/                    # Session persistence
│   │   ├── memory/                     # Cross-thread memory store
│   │   ├── analytics/                  # Per-session usage analytics
│   │   ├── workspace/                  # Repo discovery + resolution
│   │   ├── slack/                      # Slack Bolt handlers, rendering, ingress/egress
│   │   ├── agent/                      # Agent executor wrapper + MCP tools
│   │   └── schemas/                    # Zod schemas
│   ├── tests/                          # Vitest unit tests
│   ├── drizzle/                        # Drizzle migrations
│   ├── drizzle.config.ts
│   ├── nodemon.json
│   ├── package.json                    # @kagura/bot
│   ├── tsconfig.json
│   ├── tsconfig.tests.json
│   ├── tsdown.config.ts
│   └── vitest.config.ts
└── web-ui/    # Vite 8 + React dashboard (Vercel design system)
    ├── src/
    │   ├── main.tsx
    │   ├── router.tsx                  # React Router routeObject definitions
    │   ├── layouts/RootLayout.tsx
    │   ├── components/                 # Reusable UI primitives (Card, Badge, Button, ...)
    │   ├── pages/                      # Overview, Sessions, Memory, Workspaces, Settings
    │   ├── lib/                        # api client, React Query hooks, formatting, types
    │   ├── stores/                     # Zustand (UI prefs), Jotai (transient filters)
    │   └── styles/globals.css          # Tailwind v4 + Vercel tokens
    ├── package.json                    # @kagura/web-ui
    ├── tsconfig.json
    └── vite.config.ts
packages/
└── live-cli/                           # Standalone E2E CLI (commander + @clack/prompts)
```

Root scripts (in `/package.json`) delegate to the right workspace via pnpm `-F`.

## Build & Run

All commands are available at the monorepo root.

| Command                 | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| `pnpm dev`              | Bot (Slack + HTTP API) with hot reload       |
| `pnpm dev:web`          | Web UI with Vite dev server (proxies `/api`) |
| `pnpm build`            | Compile the bot                              |
| `pnpm build:web`        | Build the web UI                             |
| `pnpm test`             | Run bot unit tests (Vitest)                  |
| `pnpm test:watch`       | Watch mode for unit tests                    |
| `pnpm typecheck`        | Type-check every workspace (`pnpm -r`)       |
| `pnpm e2e`              | Run all live Slack E2E                       |
| `pnpm e2e -- <id>`      | Run specific scenario by id                  |
| `pnpm e2e -- -i`        | Interactive scenario picker                  |
| `pnpm e2e -- -l`        | List all discovered cases                    |
| `pnpm e2e -- -s <term>` | Search/filter by keyword                     |
| `pnpm e2e:list`         | List all discovered cases                    |
| `pnpm db:generate`      | Generate Drizzle migrations (bot)            |
| `pnpm db:migrate`       | Apply migrations (bot)                       |
| `pnpm db:studio`        | Open Drizzle Studio (bot)                    |

## Development workflow

Every feature or bugfix in the bot **must** include:

1. **Implementation** — source code under `apps/bot/src/`.
2. **Unit tests** — in `apps/bot/tests/*.test.ts`, using Vitest. Mock external dependencies (Slack client, Claude SDK). Test handler logic with in-memory stores.
3. **Live E2E test** — in `apps/bot/src/e2e/live/run-*.ts`. These run against a real Slack workspace with Socket Mode. Follow the existing polling + assertion pattern.

Always run `pnpm build` and `pnpm test` before considering a task complete.

For web UI work, run `pnpm build:web` (or `pnpm -F @kagura/web-ui typecheck`) to verify types compile.

## Code conventions

- **TypeScript strict mode**, ESM-only (`"type": "module"` in every package.json).
- **Dependency injection** via function parameters — no global singletons.
- **Zod** for all external input validation (Slack events, tool calls, env vars).
- **No default exports** — use named exports everywhere.
- Store interfaces live in `*/types.ts`; SQLite implementations are separate files.
- Slash command handlers go in `apps/bot/src/slack/commands/`.
- Ingress handlers (mentions, thread replies, assistant) go in `apps/bot/src/slack/ingress/`.
- Interaction handlers (shortcuts, modals, buttons) go in `apps/bot/src/slack/interactions/`.
- Hono HTTP routes live in `apps/bot/src/server/routes/`; types in `apps/bot/src/server/types.ts`.
- Web UI uses route-object definitions in `apps/web-ui/src/router.tsx`, React Query for requests, Zustand for persisted UI state, and Jotai for transient filters. Follow the Vercel design guideline (`apps/web-ui/README.md`).

## Slash commands

Slash commands are registered in `apps/bot/src/slack/commands/register.ts` and auto-synced to the Slack App manifest on startup when `SLACK_APP_ID` is set along with either `SLACK_CONFIG_REFRESH_TOKEN` or `SLACK_CONFIG_TOKEN`.

Token management: Slack config tokens expire every 12 hours. Set `SLACK_CONFIG_REFRESH_TOKEN` (from the Slack App settings page) and the bot will automatically rotate tokens on each startup, persisting the new refresh token to `data/slack-config-tokens.json`.

To add a new slash command:

1. Create `apps/bot/src/slack/commands/<name>-command.ts` with a `handle<Name>Command(text, deps)` function.
2. Add it to the `COMMANDS` array in `register.ts`.
3. Add the manifest entry in `manifest-sync.ts` `DESIRED_COMMANDS`.
4. Write unit tests in `apps/bot/tests/slash-commands.test.ts`.
5. Run `pnpm build && pnpm test`.

## HTTP API

The bot exposes a small Hono HTTP API on `HTTP_PORT` (default `4000`). The web dashboard consumes it.

Primary endpoints:

- `GET /api/health`, `GET /api/version`
- `GET /api/analytics/overview`, `/api/analytics/models`, `/api/analytics/sessions?limit=N`
- `GET /api/sessions?limit=N`, `/api/sessions/:threadTs`
- `GET /api/memory?repoId=X&q=Y&category=Z&limit=N`, `/api/memory/context?repoId=X`, `/api/memory/recent`
- `GET /api/workspaces`

When adding data to the dashboard, add the route in `apps/bot/src/server/routes/`, then the query hook in `apps/web-ui/src/lib/queries.ts` and the matching page component.

## Testing patterns

### Unit tests (`apps/bot/tests/`)

- Use `vi.mock()` for external modules (`@anthropic-ai/claude-agent-sdk`).
- Create in-memory store implementations (see `createMemorySessionStore()`, `createMemoryStore()` in existing tests).
- Use `createSlackClientFixture()` pattern for mock Slack clients that capture calls.
- Test file names: `apps/bot/tests/<feature>.test.ts`.

### Live E2E tests (`apps/bot/src/e2e/live/`)

- Each scenario is a standalone `run-*.ts` file that exports a `scenario` object with `id`, `title`, `description`, `keywords`, and `run`.
- The CLI lives in `packages/live-cli/` and is built with `commander` + `@clack/prompts`. It auto-discovers scenarios (defaulting to `apps/bot/src/e2e/live` when invoked from the monorepo root, or `src/e2e/live` when invoked from the bot workspace) and supports serial all-run, interactive multi-select, keyword search, and direct id-based execution.
- Uses `SlackApiClient` to post real messages and poll for replies.
- Follows the pattern: start app → post trigger message → poll until assertions pass or timeout → write result JSON → assert.
- Run a specific scenario: `pnpm e2e -- <scenario-id>`.
- List all scenarios: `pnpm e2e:list` or `pnpm e2e -- --list`.
