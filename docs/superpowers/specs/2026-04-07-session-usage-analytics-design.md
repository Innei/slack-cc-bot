# Session Usage Analytics — Design Spec

## Goal

Persist per-conversation usage metrics (cost, tokens, cache hit rate, model, duration, user) into the SQLite database so they can be analyzed retroactively.

## Current State

- `SessionUsageInfo` and `ModelUsageInfo` types already capture full usage data from the Claude SDK `ResultMessage`.
- `ActivitySink` receives a `usage-info` event and stores `sessionUsageInfo` in a local variable, then displays it in Slack via `postSessionUsageInfo()`.
- **The data is never persisted** — it is lost after the process exits.
- The `sessions` table tracks session lifecycle (threadTs PK, channelId, state timestamps, workspace info) but has no analytics columns.

## Design Decision

**Approach: New `session_analytics` table with FK to `sessions`.**

Rationale: Separation of concerns — session lifecycle management and usage analytics are independent concerns. A dedicated table keeps the sessions table lean, allows analytics fields to evolve independently, and makes it straightforward to add per-turn granularity later.

## Schema

### New table: `session_analytics`

| Column                        | SQLite Type | Drizzle Type | Nullable           | Description                                   |
| ----------------------------- | ----------- | ------------ | ------------------ | --------------------------------------------- |
| `id`                          | TEXT        | `text`       | NO (PK)            | UUID, auto-generated                          |
| `thread_ts`                   | TEXT        | `text`       | NO (FK → sessions) | References the session                        |
| `user_id`                     | TEXT        | `text`       | YES                | Slack user ID that triggered the conversation |
| `total_cost_usd`              | REAL        | `real`       | YES                | Total cost in USD for the session             |
| `duration_ms`                 | INTEGER     | `integer`    | YES                | Execution duration in milliseconds            |
| `input_tokens`                | INTEGER     | `integer`    | YES                | Total input tokens (includes cache)           |
| `output_tokens`               | INTEGER     | `integer`    | YES                | Total output tokens                           |
| `cache_read_input_tokens`     | INTEGER     | `integer`    | YES                | Tokens served from cache                      |
| `cache_creation_input_tokens` | INTEGER     | `integer`    | YES                | Tokens written to cache                       |
| `model_usage_json`            | TEXT        | `text`       | YES                | Per-model usage breakdown as JSON array       |
| `created_at`                  | TEXT        | `text`       | NO                 | Row creation timestamp                        |

Own `id` PK (UUID) decouples the analytics row identity from the session reference. `thread_ts` is a dedicated FK column pointing to `sessions.thread_ts`. This follows the same pattern as the `memories` table (own `id` PK + optional `thread_ts` FK).

All analytics columns are nullable because they are only populated after execution completes.

### model_usage_json Format

```json
[
  {
    "model": "claude-sonnet-4-20250514",
    "inputTokens": 15200,
    "outputTokens": 3400,
    "cacheReadInputTokens": 28000,
    "cacheCreationInputTokens": 5000,
    "cacheHitRate": 64.8,
    "costUSD": 0.0142
  }
]
```

This is the serialized `ModelUsageInfo[]` array, enabling per-model analysis without additional tables.

## Data Flow

```
Claude SDK ResultMessage
  → buildUsageInfo() → SessionUsageInfo
  → sink.onEvent({ type: 'usage-info', usage })
  → ActivitySink stores sessionUsageInfo (existing)
  → lifecycle 'completed' event fires (existing)
  → [NEW] SessionAnalyticsStore.upsert() writes to session_analytics table
```

## Files Changed

### 1. `src/db/schema.ts`

Add `sessionAnalytics` table definition with `sqliteTable('session_analytics', ...)`.

### 2. `drizzle/` — new migration file

`CREATE TABLE session_analytics (...)` with FK reference to `sessions(thread_ts)`.

### 3. `src/analytics/` — new module

- **`src/analytics/types.ts`** — `SessionAnalyticsRecord` interface and `SessionAnalyticsStore` interface.
- **`src/analytics/sqlite-analytics-store.ts`** — SQLite implementation with a single `upsert(threadTs, data)` method. Aggregates token totals from `modelUsage[]`, serializes to JSON, and writes the row.

### 4. `src/application.ts`

Instantiate `SqliteAnalyticsStore` and inject it into the handler dependency graph.

### 5. `src/slack/ingress/activity-sink.ts`

- Add `analyticsStore` to `ActivitySinkOptions`.
- On lifecycle `completed` event, if `sessionUsageInfo` is available, call `analyticsStore.upsert()` to persist the analytics data. This is a fire-and-forget write (catch and log errors, never block the main flow).

### 6. `src/slack/ingress/app-mention-handler.ts`

- No changes needed — `userId` flows through `ActivitySinkOptions.userId` which is already set.

## Out of Scope

- No new Slash commands or UI for querying analytics.
- No per-turn (per-API-call) granularity — session-level summary only.
- No Home Tab dashboard.
- No automatic cleanup or retention policy.
