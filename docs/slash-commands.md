# Slash commands & controls

## Slash commands

All responses are **ephemeral** (only visible to the invoking user).

| Command                | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `/usage`               | Show bot stats — session count, memory count, repos, uptime        |
| `/workspace`           | List all available workspaces                                      |
| `/workspace <name>`    | Look up a specific workspace (path, aliases, memory count)         |
| `/memory`              | Show help for memory subcommands                                   |
| `/memory list <repo>`  | List recent memories for a repo                                    |
| `/memory count <repo>` | Show total memory count for a repo                                 |
| `/memory clear <repo>` | Clear all memories for a repo                                      |
| `/session`             | Show total session count                                           |
| `/session <thread_ts>` | Inspect a specific session (workspace, Claude session, state)      |
| `/version`             | Show deployment info — git commit hash, commit date, deploy date   |
| `/provider`            | Show current agent provider status and available providers         |
| `/provider list`       | List all registered agent providers                                |
| `/provider <id>`       | Switch agent provider for the current thread (use inside a thread) |
| `/provider reset`      | Clear per-thread provider override, revert to default              |

## Stopping in-progress replies

Two mechanisms are available to cancel an active bot reply:

| Method               | How to use                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Emoji reaction**   | Add a :octagonal_sign: (`:octagonal_sign:`) or :no_entry_sign: (`:stop_sign:`) reaction to any message in the thread (the trigger message, the bot's progress message, or the thread root) |
| **Message shortcut** | Right-click (or `...` menu) on any message in the thread -> **Stop Reply**                                                                                                                 |

Both stop all active executions in the thread and finalize the bot's progress message as "stopped."

## Reaction lifecycle

The bot uses emoji reactions to signal processing state:

1. When a message is received, the bot adds an **acknowledgement reaction** (configurable via `SLACK_REACTION_NAME`) to indicate it is processing.
2. Once the acknowledgement reaction is removed, the bot starts generating the reply.
3. After the reply is complete, the bot adds a **completion reaction** (configurable via `SLACK_REACTION_DONE_NAME`) to indicate the turn is finished.
