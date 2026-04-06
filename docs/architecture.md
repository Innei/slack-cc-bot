# Architecture

## Composition root

The application follows a **composition root** pattern — `application.ts` assembles the entire dependency graph:

```
Logger -> Database -> SessionStore -> SlackApp -> AgentExecutor
```

All modules receive dependencies via function parameters (no global singletons).

## Agent provider system

The bot uses a pluggable **agent provider registry** that allows multiple AI backends. The default provider wraps the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) and exposes a custom MCP server (`slack-ui`) with tools for controlling the Slack assistant thread UI (`publish_state`), saving memories (`save_memory`), and recalling memories (`recall_memory`).

Providers can be switched per-thread using the `/provider` slash command, enabling A/B testing or different agent configurations for different conversations.

## Reply rendering

Replies are rendered as Slack block content instead of raw mrkdwn text, so formatting survives the round trip from the agent to Slack. During execution, the bot keeps a compact progress message in the thread, clears the thinking state after the first reply, and uses Slack's native typing indicator while the final text is still being generated.

## Workspace routing

New threads try to infer the target repository from the incoming Slack message. Mention a repo name such as `slack-cc-bot`, a relative repo path such as `team/slack-cc-bot`, or an absolute path under `REPO_ROOT_DIR`.

If the bot cannot determine the workspace confidently and you want to bind one manually, use the Slack Message Action on the relevant message:

1. Run the `workspace_message_action` message action.
2. Accept the detected repo, or choose a repo/path manually in the modal.
3. Decide whether to take over the current thread or start a new thread/session.

Once a thread is bound, follow-up replies reuse the same workspace. If you switch the workspace for that thread, the bot starts a fresh session instead of resuming the old one with the wrong `cwd`.

## Memory model

The bot keeps three layers of memory:

- **Preferences** — persistent instructions such as naming, language, tone, or standing rules
- **Global memories** — facts that should apply across workspaces
- **Workspace memories** — repo-specific context and decisions

Preference memories are injected ahead of other memories so they take priority in future turns. After each conversation, a lightweight extractor can promote implicit preferences that appeared in the exchange, which helps the bot remember things like preferred language, nicknames, or durable working rules even across restarts.

## Online presence

A **PresenceKeeper** calls `users.setPresence("auto")` on startup and every 5 minutes to keep the bot's green dot active. On graceful shutdown it sets presence to `"away"`.

## Project structure

```
src/
├── index.ts                    # Entry point
├── application.ts              # Composition root (wires all dependencies)
├── env/server.ts               # Validated environment schema
├── logger/                     # Structured logging with redaction
├── db/                         # SQLite database + Drizzle schema
├── session/                    # Session persistence (SQLite-backed)
├── memory/                     # Cross-thread memory store
├── workspace/                  # Repo discovery and workspace resolution
├── agent/
│   ├── registry.ts             # Agent provider registry
│   ├── types.ts                # Shared agent interfaces
│   ├── shared/                 # Shared utilities (memory extractor)
│   └── providers/
│       └── claude-code/        # Claude Agent SDK provider
│           ├── adapter.ts      # Provider adapter implementation
│           ├── mcp-server.ts   # Custom MCP server (slack-ui)
│           ├── prompts.ts      # System prompt construction
│           ├── messages.ts     # Message conversion
│           ├── multimodal-prompt.ts  # Image content handling
│           └── tools/          # MCP tool definitions
├── slack/
│   ├── app.ts                  # @slack/bolt initialization
│   ├── presence-keeper.ts      # Online presence heartbeat
│   ├── commands/               # Slash command handlers + manifest sync
│   ├── ingress/                # @mention / thread / assistant / home tab
│   ├── interactions/           # Message Action + modal + stop shortcut
│   ├── context/                # Thread history loading & normalization
│   ├── execution/              # Thread execution registry (stop control)
│   └── render/                 # Streaming output & UI state rendering
└── schemas/                    # Zod schemas for Slack events & tools
```

> [!NOTE]
> Detailed specifications for each subsystem are available in [`docs/specs/`](specs/).
