# Kagura CLI & onboarding

- **Date**: 2026-04-24
- **Status**: Design approved, pending implementation plan
- **Scope**: `@innei/kagura` published package; monorepo split; `kagura` / `kagura-app` bins; `init` / `doctor` / `manifest` / `config` subcommands; Slack app bootstrap (manifest prefill URL or config-token auto); multi-provider onboarding (Claude Code + Codex CLI) layered on top of the config split landed in `f2ad0cd`.

## Goals

1. Ship `@innei/kagura` as an installable global CLI. `npm i -g @innei/kagura && kagura` should take a user from nothing to a running Slack bot without hand-editing files.
2. Keep the existing runtime untouched where possible. The onboarding layer wraps the app; it does not rewrite it.
3. Segregate config by sensitivity: secrets in `.env`, tunables in `config.json`, data under a single well-known directory.
4. Leave an open seam for future providers. Codex CLI is already wired in runtime (`f2ad0cd`); the onboarding UI should accommodate it and anything that follows, without special-casing.

## Non-goals

- No GUI onboarding.
- No automatic creation of Slack App-Level Tokens (Slack exposes no public API for this; always a manual step).
- No wrapper over `claude login` / `codex login`. The CLI detects and points; it does not re-implement auth.
- No feature-flag / rollout infrastructure. This is developer-run software.

## Architecture

### Monorepo layout

```
kagura/                                       (repo root)
├── apps/
│   └── kagura/                               name: @innei/kagura  (published)
│       ├── package.json                      bin: { kagura, kagura-app }
│       ├── tsdown.config.ts                  entry: [src/index.ts, src/cli.ts]
│       ├── src/
│       │   ├── index.ts                      app entry (#! shebang)
│       │   ├── cli.ts                        thin shim: `import { runCli } from '@kagura/cli'`
│       │   ├── application.ts                (moved from root src/)
│       │   └── ...                           (slack/ agent/ db/ memory/ workspace/ env/ logger/ ...)
│       └── drizzle/                          (moved from root drizzle/)
├── packages/
│   ├── cli/                                  name: @kagura/cli    (workspace:*, unpublished)
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts                      export runCli(argv)
│   │       ├── router.ts                     detectConfig + dispatch
│   │       ├── commands/                     init / doctor / manifest / config
│   │       ├── slack/                        manifest-template / prefill-url / config-token
│   │       ├── config/                       paths / env-loader / env-writer / json-writer
│   │       ├── providers/                    types / registry / claude / codex
│   │       └── claude-auth.ts
│   └── live-cli/                             (existing; e2e runner)
├── pnpm-workspace.yaml
├── package.json                              root, private, workspace metadata only
└── tsconfig.base.json
```

Rationale for keeping `packages/cli` unpublished: the CLI code is tightly coupled to the app (shared env schema, manifest template, runtime provider registry). Publishing it separately doubles release friction with no user-visible benefit. Migrating to a public package later is a `package.json` edit if needed.

### Bin topology

```
npm i -g @innei/kagura
  ├─ bin/kagura        → dist/cli.js     router + subcommands + init wizard
  └─ bin/kagura-app    → dist/index.js   app entry (skips router entirely)
```

- Default `kagura` invocation calls `detectConfig()`. If complete, dynamically imports `./start-app.js` in-process (no fork; signals and cwd stay consistent). If incomplete, runs the init wizard, then continues in-process.
- `kagura-app` remains available as an escape hatch for systemd units, Docker entrypoints, or anyone who has externalized their own config checks.

### Config layout on disk

```
~/.config/kagura/                             prod default
├── .env                                      secrets only
├── config.json                               non-secret tunables
├── data/
│   ├── sessions.db
│   └── slack-config-tokens.json
└── logs/
```

Directory is resolved by `packages/cli/src/config/paths.ts`:

1. `$KAGURA_HOME` if set (escape hatch for Docker / tests).
2. Dev detection: cwd contains `.env` **or** `apps/kagura/` **or** a `package.json` whose `name` matches `@innei/kagura` / `kagura` → configDir = cwd. Preserves existing dev ergonomics.
3. Otherwise: `$XDG_CONFIG_HOME/kagura/` or `~/.config/kagura/`.

### File ownership

| Category                                            | Example keys                                                                                                                                                | File          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Secrets                                             | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `SLACK_CONFIG_(REFRESH_)TOKEN` | `.env`        |
| Slack app identity (non-secret but bound to tokens) | `SLACK_APP_ID`                                                                                                                                              | `.env`        |
| Provider selection                                  | `defaultProviderId`                                                                                                                                         | `config.json` |
| Provider tuning                                     | `claude.model`, `claude.permissionMode`, `claude.enableSkills`, `codex.model`, `codex.reasoningEffort`, `codex.sandbox`                                     | `config.json` |
| Paths & runtime                                     | `repoRootDir`, `repoScanDepth`, `sessionDbPath`, `logDir`, `logLevel`, `logToFile`                                                                          | `config.json` |

Precedence (established by `f2ad0cd`): `env > config.json > built-in default`. The onboarding layer respects this — writing to whichever file the value belongs to, without overriding existing env values.

## Components

### `packages/cli/src/config/paths.ts`

```ts
export interface KaguraPaths {
  configDir: string;
  envFile: string; // configDir/.env
  configJsonFile: string; // configDir/config.json
  dataDir: string;
  dbPath: string; // configDir/data/sessions.db
  logDir: string; // configDir/logs
  tokenStore: string; // configDir/data/slack-config-tokens.json
}
export function resolveKaguraPaths(): KaguraPaths;
```

### `packages/cli/src/config/env-loader.ts`, `env-writer.ts`, `json-writer.ts`

- `env-loader`: dotenv-driven read of `paths.envFile`; exposes `detectConfig(paths) → { ok: true } | { ok: false; missing: string[] }`. "Missing" = any of `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_SIGNING_SECRET` / `REPO_ROOT_DIR` absent after env + config.json merge.
- `env-writer`: order-preserving, comment-preserving upsert. Unknown lines survive. Secrets never logged.
- `json-writer`: deep-merge into `config.json`; preserves existing key order; 2-space indentation to match `config.example.json`.

### `packages/cli/src/slack/manifest-template.ts`

Hoisted from `src/slack/commands/manifest-sync.ts`. Exports:

```ts
export function buildManifest(opts: { appName: string; botDisplayName: string }): SlackManifest;
export const DESIRED_COMMANDS, DESIRED_SHORTCUTS, DESIRED_BOT_EVENTS, DESIRED_SCOPES;
```

Both init and `manifest-sync.ts` consume this. Snapshot-tested.

### `packages/cli/src/slack/prefill-url.ts`

```ts
export function buildPrefillUrl(
  manifest: SlackManifest,
): { kind: 'url'; url: string } | { kind: 'too-long'; manifestPath: string };
```

Under ~8KB: `https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded>`. Over: returns fallback, caller writes manifest to `paths.configDir/manifest.json` and prints paste-to-URL instructions.

### `packages/cli/src/slack/config-token.ts`

Wraps `apps.manifest.create`, `apps.manifest.update`, `apps.manifest.export`, `tooling.tokens.rotate`. Returns typed `Result<T, SlackError>`. The existing `manifest-sync.ts` logic is refactored to sit on top of these primitives.

### `packages/cli/src/providers/`

```ts
// types.ts
export type ProviderId = 'claude-code' | 'codex-cli'; // imported from apps/kagura/src/agent/types

export interface ProviderSetup {
  id: ProviderId;
  label: string;
  order: number;
  detect(): Promise<DetectResult>;
  prompt(ctx: PromptCtx): Promise<SetupPatch>;
  validate?(env: NodeJS.ProcessEnv, cfg: AppConfigJson): Promise<ValidateResult>;
}

export interface SetupPatch {
  env?: Record<string, string | undefined>; // → .env
  config?: DeepPartial<AppConfigJson>; // → config.json
}
```

Two implementations out of the gate: `claude.ts` and `codex.ts`. Registry is a plain array; adding a provider is one entry + one file.

### `packages/cli/src/commands/init.ts`

State machine described in the Flows section. Key invariants:

- Every answered step immediately upserts the relevant file. A mid-wizard Ctrl-C leaves partial-but-valid state; re-running `kagura init` picks up where it left off.
- For already-set secrets, show a masked preview (`xoxb-••••-7a2f`) and offer `keep / replace`.
- Every pasted token is validated against Slack (`auth.test` for bot/app tokens) or the provider API before being written.

### `packages/cli/src/commands/doctor.ts`

Read-only checks. Output modes: human (default), `--json` (machine-readable), `--deep` (includes live API calls to Slack + provider), `--fix` (suggests repairs, never mutates tokens).

### `packages/cli/src/router.ts`

```ts
export async function runCli(argv: string[]): Promise<number> {
  const program = new Command('kagura').version(VERSION).description(...);

  program.command('init').option('--full').action(runInit);
  program.command('doctor').option('--json').option('--deep').option('--fix').action(runDoctor);
  program.command('manifest')
    .addCommand(new Command('sync').option('--dry-run').action(runManifestSync))
    .addCommand(new Command('export').option('--out <file>').action(runManifestExport))
    .addCommand(new Command('print').option('--out <file>').action(runManifestPrint));
  program.command('config')
    .addCommand(new Command('path').option('--json').action(runConfigPath));

  program.action(async () => {
    const paths = resolveKaguraPaths();
    const status = detectConfig(paths);
    if (!status.ok) {
      console.error(`Missing: ${status.missing.join(', ')}. Launching init wizard.`);
      await runInit({});
    }
    await (await import('@innei/kagura/start-app')).startApp();
  });

  await program.parseAsync(argv);
  return process.exitCode ?? 0;
}
```

## Flows

### init — new Slack app, config token available (auto)

```
1. Select provider (claude-code | codex-cli)
2. Pick Slack path: "new app"
3. Detect config token (env or tokenStore) → present
4. POST apps.manifest.create with buildManifest()
5. Persist app_id + signing_secret → .env
6. open(https://api.slack.com/apps/<app_id>/install-on-team)
7. Prompt for Bot Token (xoxb-) → auth.test → write .env
8. Prompt for App-Level Token (xapp-) → validate scope → write .env
9. Provider.prompt() → write .env + config.json per SetupPatch
10. Prompt REPO_ROOT_DIR → write config.json
11. "Start app now?" → in-process dynamic import if yes
```

### init — new Slack app, no config token (manual)

```
1-2. Same
3. No config token detected; offer "paste one now" or "skip to manual"
4. Build manifest, generate prefill URL (or fallback to manifest.json paste)
5. open(url); instruct user: Create → Install → collect 4 values
6. Prompt App ID → Signing Secret → Bot Token → App-Level Token
   Each validated individually; wrong value can be re-entered.
7-10. Same as auto (steps 9-11).
```

### init — reuse existing Slack app

```
1. Select provider
2. Pick Slack path: "reuse"
3. Prompt App ID
4. If config token present: run manifest-sync to upgrade scopes/events
   If manual: print the diff the user must apply manually, then pause
5. Prompt the 3 remaining secrets (Bot Token, App-Level Token, Signing Secret)
6-10. Same as new-app tail.
```

### provider onboarding — claude-code

```
Q: auth mode
  ├─ oauth     → probe ~/.claude; if absent, instruct `claude login` (wizard continues, no env written)
  ├─ api-key   → .env: ANTHROPIC_API_KEY
  └─ base-url  → .env: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
[--full only] Q: CLAUDE_MODEL / CLAUDE_PERMISSION_MODE / CLAUDE_ENABLE_SKILLS
              → config.json.claude.*
```

### provider onboarding — codex-cli

```
Probe: `codex --version` on PATH (if missing, print install pointer; wizard continues)
Q: auth
  ├─ chatgpt-login  → probe codex auth state; if absent, instruct `codex login`
  └─ api-key         → .env: OPENAI_API_KEY
[--full only] Q: CODEX_MODEL / CODEX_REASONING_EFFORT / CODEX_CLI_SANDBOX
              → config.json.codex.*
```

## Data flow

```
kagura (cli.ts)
  └─ runCli(argv)
     ├─ resolveKaguraPaths()           paths.ts
     ├─ loadEnv(paths.envFile)         env-loader.ts   (dotenv)
     ├─ loadConfigJson(paths.cjf)      env-loader.ts   (JSON + zod)
     ├─ detectConfig(merged)           env-loader.ts
     └─ dispatch
        ├─ [missing] → runInit
        │   ├─ per-step writeEnv() / writeConfigJson()
        │   └─ provider.prompt(ctx)
        └─ [ok]     → dynamic import('./start-app.js')
                        └─ apps/kagura/src/index.ts (unchanged)
```

Runtime app loads env via existing `src/env/server.ts`. The only runtime change is that `loadAppConfig()` now resolves `APP_CONFIG_PATH` through `resolveKaguraPaths()` instead of `cwd`, and three cwd-hardcoded paths (logger dir, session DB, token store) default to `paths.*`.

## Error handling

- Pasted secret fails live validation → show error, stay on the same prompt, allow retry or abort.
- Slack API error with a known code → map to one-line hint (same vocabulary as the existing `manifest-sync` errors: `not_allowed_token_type`, `missing_scope`, `invalid_auth`, `ratelimited`).
- Config file unreadable / schema violation at runtime → app refuses to start with a clear path reference; `kagura doctor` surfaces the same diagnostic.
- Crashed halfway through init: next `kagura init` re-reads on-disk state and offers to resume; no orphan Slack apps get created because `apps.manifest.create` is the first write, and its response is persisted before any further step runs.
- Signal handling: router's dynamic-import launch keeps SIGINT/SIGTERM flowing to the app (no separate process group).

## Testing strategy

### Unit

| Target                    | Assertions                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `resolveKaguraPaths()`    | `KAGURA_HOME` wins, dev detection fires in cwd, prod falls back to `~/.config/kagura`, `XDG_CONFIG_HOME` honored |
| `detectConfig()`          | All 4-of-4 permutations of missing required keys; env and config.json sources merge correctly                    |
| env writer                | Order preserved; comments preserved; unknown lines preserved; existing keys updated not appended                 |
| json writer               | Deep merge; existing keys order preserved; 2-space indent                                                        |
| `buildManifest()`         | Name substitution; desired commands/events/scopes present; snapshot                                              |
| `buildPrefillUrl()`       | <8KB returns URL; >8KB returns fallback                                                                          |
| `claudeProvider.prompt()` | Each of 3 branches yields the correct `SetupPatch`                                                               |
| `codexProvider.prompt()`  | Both branches; `codex` absence → no env written                                                                  |
| Provider registry         | Stable order; duplicate id throws                                                                                |

### Integration (mocked `fetch` + mocked `@clack/prompts`)

| Scenario                       | Assertions                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| init new · auto · happy path   | `apps.manifest.create` called once; final `.env` + `config.json` contain all expected keys; `auth.test` passes |
| init new · manual · happy path | `open()` called once with prefill URL; 4 pastes each trigger one `auth.test`                                   |
| init reuse · auto              | `apps.manifest.export` then `apps.manifest.update` called in order                                             |
| init interrupted, re-entered   | Masked preview shown; "keep" skips prompt; "replace" overwrites                                                |
| `doctor --json`                | Schema complete; exit code tracks worst severity                                                               |

### E2E

`pnpm e2e` continues to run from `apps/kagura` cwd. The runner sets `process.chdir(repoRoot)` as a safety net so dev-mode cwd detection keeps working even when invoked from the root.

### Snapshots

`buildManifest({appName:'kagura', botDisplayName:'Kagura'})` produces a stable JSON snapshot — catches silent drift in desired scopes/events/commands.

## Dependencies

Runtime additions (all bundled into `dist/cli.js`; the published package's top-level `dependencies` keep the same two externals `better-sqlite3` and `@anthropic-ai/claude-agent-sdk`):

| Package          | Version | Purpose                                                         |
| ---------------- | ------- | --------------------------------------------------------------- |
| `commander`      | ^13     | argv parsing, subcommands, `--help` / `--version`               |
| `@clack/prompts` | ^0.11   | interactive wizard (select / text / password / spinner / outro) |
| `open`           | ^10     | cross-platform browser launch                                   |
| `picocolors`     | ^1      | ANSI colors (already transitively present via clack)            |

No new HTTP client. `commander` + `@clack/prompts` are already used by `packages/live-cli`; this extends their use rather than introducing a second CLI stack.

## Migration & rollout

### Breaking changes (documented in CHANGELOG 0.2.0)

- `.env` default location: `./` → `~/.config/kagura/` (dev-mode cwd detection preserves the old behavior when working inside the repo).
- `config.json` default location: `./` → `~/.config/kagura/` (same dev-mode exception).
- `sessions.db` / `logs/` / `slack-config-tokens.json` defaults now live under `~/.config/kagura/data` and `~/.config/kagura/logs`; user-provided `SESSION_DB_PATH` / `LOG_DIR` still win.
- `bin/kagura` now routes through a dispatcher. To get the old "just run the app" behavior, use `kagura-app`.
- Repo-internal: `src/` → `apps/kagura/src/`; `tsconfig` paths `~/*` remap to `apps/kagura/src/*`.

### Phased landing

```
P0  Monorepo move           git mv only; no new code. `pnpm build && pnpm test && pnpm e2e` green gate.
P1  Config layer             paths.ts + loader + writer + runtime cwd swaps.
P2  CLI skeleton              commander + clack + bin split; `kagura --help`, `kagura config path`, `kagura --version`.
P3  manifest template +       hoist DESIRED_*; existing manifest-sync swapped to template source. provider registry.
P4  doctor / manifest /       subcommands without init wizard yet.
    config subcommands
P5  init wizard               state machine, both Slack paths, both providers, `--full` flag.
P6  Release                   README usage section, docs update, bump to 0.2.0, `npm publish`.
```

Each phase is its own git commit, independently shippable.

## Risks / open items

- tsconfig `paths` rewiring touches every source file's resolved module graph. The P0 phase gate (`pnpm e2e`) is the only way to catch regressions confidently.
- `pnpm-lock.yaml` rewrite is large; PR review is noisy but unavoidable.
- Slack manifest prefill URL length: an un-minified manifest with full scope list sits around ~2-3KB — well within limits — but the <8KB threshold is worth keeping as a guard against future accretion.
- `codex --version` probe assumes a stable CLI; if Codex CLI ships without `--version`, the probe needs a fallback (`which codex`).
- Docs still reference `./data/sessions.db` etc. as built-in defaults; `docs/configuration.md` needs a pass in P6 to describe the new path resolution rules.
