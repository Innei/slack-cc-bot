---
name: writing-live-e2e-tests
description: Use when writing or modifying live E2E test scenarios in src/e2e/live/ for the slack-cc-bot project. Triggers on tasks involving Slack bot integration testing, live scenario creation, or E2E test patterns with polling and assertions.
---

# Writing Live E2E Tests

## Overview

Live E2E tests run against a real Slack workspace via Socket Mode. Each test is a standalone `run-*.ts` file in `src/e2e/live/` that exports a `LiveE2EScenario` object. The CLI auto-discovers and runs them.

## Skeleton

Every scenario file follows this structure:

```typescript
import './load-e2e-env.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface MyResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    /* booleans for each assertion */
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  // 1. Guard env
  if (!env.SLACK_E2E_ENABLED) throw new Error('...');
  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) throw new Error('...');

  // 2. Setup
  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  // 3. Init result object with all matched: false
  const result: MyResult = {
    /* ... */
  };

  // 4. Start application
  const application = createApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    // 5. Post trigger message with runId marker
    // 6. Poll with deadline loop
    // 7. Assert via assertResult()
    // 8. Set result.passed = true AFTER assertion passes

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch(() => {});
    await application.stop().catch(() => {});
  }
  if (caughtError) throw caughtError;
}

// ALWAYS use env.SLACK_E2E_RESULT_PATH with .replace()
async function writeResult(result: MyResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(/result\.json$/, 'my-test-result.json');
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function assertResult(result: MyResult): void {
  const failures: string[] = [];
  // Push descriptive failure strings
  if (failures.length > 0) throw new Error(`E2E failed: ${failures.join('; ')}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'kebab-case-id',
  title: 'Human Readable Title',
  description: 'One sentence describing what is verified.',
  keywords: ['searchable', 'terms'],
  run: main,
};

runDirectly(scenario);
```

## Key Rules

| Rule                  | Detail                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Result path           | `env.SLACK_E2E_RESULT_PATH.replace(/result\.json$/, 'your-name-result.json')` — never hardcode |
| Marker pattern        | Include `runId` in prompts and assertions: `MARKER_NAME ${runId}`                              |
| Polling               | `while (Date.now() < deadline)` with `delay(1_000)` to `delay(3_000)` between iterations       |
| Two clients           | `triggerClient` (user token) posts prompts; `botClient` (bot token) polls replies              |
| Bot identity          | `botClient.authTest()` to get `user_id` for filtering replies                                  |
| Application lifecycle | `createApplication()` → `start()` → `delay(3_000)` → test → `stop()` in finally                |
| Separate helpers      | Extract `writeResult()` and `assertResult()` as functions                                      |
| Assert then pass      | Call `assertResult()` first, set `result.passed = true` only after it succeeds                 |

## Polling Pattern

```typescript
const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
while (Date.now() < deadline) {
  const replies = await botClient.conversationReplies({
    channel: env.SLACK_E2E_CHANNEL_ID,
    inclusive: true,
    limit: 50,
    ts: rootMessage.ts,
  });

  for (const message of replies.messages ?? []) {
    if (!message.ts || message.ts === rootMessage.ts) continue;
    if (message.user === botIdentity.user_id || message.bot_id) {
      const text = typeof message.text === 'string' ? message.text : '';
      if (text.includes(`MY_MARKER ${runId}`)) {
        result.matched.myCondition = true;
      }
    }
  }

  if (result.matched.myCondition) break;
  await delay(2_500);
}
```

## Advanced Patterns

### Anchor-then-prompt (file uploads, multi-step)

Post a non-mention anchor first, upload files or set up state, then post the mention prompt in-thread.

### Multi-phase tests

Phase 1 saves state → restart application → Phase 2 verifies persistence. Each phase gets its own root message and polling loop.

### Reaction lifecycle

Poll `getReactions()` for emoji presence/absence across phases (ack added → removed → done added).

### Database validation

Use `better-sqlite3` to query SQLite directly after bot processes, verify persistence of memory/session records.

### Status probe

`FileSlackStatusProbe` writes NDJSON records. Read the probe file to verify tool progress events.

## Common Mistakes

| Mistake                                     | Fix                                                |
| ------------------------------------------- | -------------------------------------------------- |
| Hardcoded result path                       | Use `env.SLACK_E2E_RESULT_PATH.replace(...)`       |
| Missing `runDirectly(scenario)` at end      | Required for direct `tsx` execution                |
| `assertResult` after `result.passed = true` | Assert FIRST, then set passed                      |
| Forgetting `application.stop()` in finally  | Always cleanup even on error                       |
| No runId in prompt/assertion                | Every marker must include runId for test isolation |
