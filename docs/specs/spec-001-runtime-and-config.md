# SPEC-001: Runtime and Configuration

## 1. Scope

| Item                | Definition                                        |
| ------------------- | ------------------------------------------------- |
| Service type        | Local Slack agent service running on a macOS host |
| Language            | TypeScript                                        |
| Compiler            | `tsc`                                             |
| Runtime             | Node.js ESM                                       |
| Configuration model | `@t3-oss/env-core` with Zod validation            |
| Logging backend     | `@innei/pretty-logger-core`                       |

- This specification defines the process baseline, build chain, configuration contract, and logging conventions.
- It does not define Slack event semantics or Claude execution semantics in detail; those are delegated to later specifications.

## 2. Goals and Non-Goals

| Category      | In Scope                             | Out of Scope                                |
| ------------- | ------------------------------------ | ------------------------------------------- |
| Build         | Deterministic TypeScript compilation | Bundling, packaging, or binary distribution |
| Runtime       | Direct Node.js process execution     | Container orchestration                     |
| Configuration | Strict env validation                | Dynamic config hot reload                   |
| Logging       | Structured subsystem tagging         | External log shipping pipelines             |

## 3. Runtime Topology

```text
[.env / process.env]
        |
        v
[T3 Env Bootstrap]
        |
        v
[Logger Factory]
        |
        v
[Application Composition Root]
        |
        +--> [Slack App]
        |
        +--> [Claude Executor]
        |
        +--> [Session Store]
```

- The composition root owns lifecycle startup and shutdown.
- No module may read raw `process.env` after env bootstrap.
- The logger must be available before any network-facing subsystem starts.

## 4. Compiler and Module Contract

| Concern                   | Requirement                        |
| ------------------------- | ---------------------------------- |
| Module mode               | `NodeNext`                         |
| Module resolution         | `NodeNext`                         |
| Target                    | `ES2022` or newer                  |
| Strictness                | `strict: true`                     |
| Optionality rules         | `exactOptionalPropertyTypes: true` |
| Collection indexing rules | `noUncheckedIndexedAccess: true`   |
| Execution mode            | `node dist/index.js`               |

- `tsc` is the single source of JavaScript build output.
- The runtime module system must remain compatible with direct Node.js execution.
- Type looseness is explicitly disallowed at external boundaries.

## 5. Configuration Contract

| Variable               | Required | Purpose                           | Validation Rule             |
| ---------------------- | -------- | --------------------------------- | --------------------------- | ---- | ----------- |
| `NODE_ENV`             | No       | Runtime mode                      | `development                | test | production` |
| `PORT`                 | No       | Reserved process port             | Positive integer            |
| `SLACK_BOT_TOKEN`      | Yes      | Slack Web API authentication      | Non-empty string            |
| `SLACK_APP_TOKEN`      | Yes      | Slack Socket Mode authentication  | Non-empty string            |
| `SLACK_SIGNING_SECRET` | Yes      | Slack app integrity configuration | Non-empty string            |
| `SLACK_REACTION_NAME`  | No       | Initial acknowledgement reaction  | Non-empty string            |
| `CLAUDE_MODEL`         | No       | Optional model override           | Non-empty string if present |
| `LOG_LEVEL`            | No       | Logger verbosity                  | Enumerated string           |
| `LOG_TO_FILE`          | No       | Enable file reporter              | Boolean                     |
| `LOG_DIR`              | No       | File log directory                | Non-empty string            |

- `runtimeEnvStrict` must be used to force explicit variable mapping.
- Empty strings must be converted to `undefined` prior to validation.
- Configuration validation failure is a startup-fatal condition.

## 6. Configuration Access Rules

| Rule            | Requirement                           |
| --------------- | ------------------------------------- |
| Access point    | Import the typed `env` object only    |
| Validation time | Process startup                       |
| Secret handling | Secrets must not be logged verbatim   |
| Defaults        | May be applied only in the env schema |

- Modules must not call `process.env` directly.
- Configuration-derived decisions must remain reproducible from the schema.

## 7. Logging Contract

| Tag              | Responsibility                                                |
| ---------------- | ------------------------------------------------------------- |
| `bootstrap`      | Process lifecycle, startup, shutdown, fatal failure           |
| `env`            | Safe configuration diagnostics                                |
| `slack:ingress`  | Event intake and deduplication                                |
| `slack:context`  | Thread replay and normalization                               |
| `slack:render`   | Reactions, bootstrap replies, stream lifecycle, thread status |
| `claude:session` | Claude session lifecycle                                      |
| `claude:stream`  | Streaming output handling                                     |
| `session`        | Thread/session persistence                                    |

```text
[Root Logger]
      |
      +--> withTag("bootstrap")
      +--> withTag("slack:ingress")
      +--> withTag("slack:render")
      +--> withTag("claude:session")
      +--> withTag("session")
```

- Subsystem loggers must derive from a single root logger.
- File logging is environment-driven and optional.
- Console wrapping is not enabled by default.

## 8. Startup and Shutdown Semantics

| Phase                     | Requirement                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| Startup order             | Validate env -> create logger -> compose services -> start Slack |
| Fatal startup failure     | Exit non-zero                                                    |
| Graceful shutdown signals | `SIGINT`, `SIGTERM`                                              |
| Shutdown order            | Stop Slack app -> flush logs if applicable -> exit               |

- Partial startup is not an acceptable steady state.
- Shutdown must be idempotent.

## 9. Acceptance Criteria

| Criterion                             | Evidence                                                    |
| ------------------------------------- | ----------------------------------------------------------- |
| The project compiles with `tsc`       | Successful `pnpm run build`                                 |
| Invalid env values fail early         | Startup-time schema rejection                               |
| The logger can be tagged by subsystem | Tagged logger instances are created in the composition root |
| No module requires raw env access     | Imports resolve through the env module                      |
