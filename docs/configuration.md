# Configuration

## Environment variables

```bash
cp .env.example .env
```

### Required

| Variable               | Description                                  |
| ---------------------- | -------------------------------------------- |
| `SLACK_BOT_TOKEN`      | Bot user OAuth token (`xoxb-...`)            |
| `SLACK_APP_TOKEN`      | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Request verification secret                  |
| `REPO_ROOT_DIR`        | Root directory containing candidate repos    |

### Optional — automatic slash command registration

| Variable                     | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `SLACK_APP_ID`               | Your Slack App ID (from Basic Information)                      |
| `SLACK_CONFIG_REFRESH_TOKEN` | Configuration refresh token (`xoxe-...`) for automatic rotation |
| `SLACK_CONFIG_TOKEN`         | Configuration access token (fallback, expires every 12h)        |

See [`.env.example`](../.env.example) for all available options including `REPO_SCAN_DEPTH`, `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`, and logging configuration.

This repository does not require an `ANTHROPIC_API_KEY` environment variable to boot. Claude authentication follows your local Claude Agent SDK / runtime setup.

The bot scans `REPO_ROOT_DIR` recursively up to `REPO_SCAN_DEPTH`. When it can resolve a repo/path from the conversation, it binds the Slack thread to that concrete workspace path. When no repo is identified, it proceeds without a workspace instead of falling back to the bot process `cwd`.

## Slack app manifest

Create a new Slack app at <https://api.slack.com/apps> -> **From a manifest**, then paste the JSON below. Adjust `name` / `display_name` as needed.

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

## Automatic manifest sync

When `SLACK_APP_ID` is set along with `SLACK_CONFIG_REFRESH_TOKEN` (or `SLACK_CONFIG_TOKEN`), the bot automatically registers any missing slash commands and shortcuts to the Slack App manifest on startup via the [App Manifest API](https://api.slack.com/reference/manifests). No manual configuration in the Slack dashboard is needed.

**Token rotation:** Slack configuration tokens expire every 12 hours. If you provide `SLACK_CONFIG_REFRESH_TOKEN`, the bot calls [`tooling.tokens.rotate`](https://api.slack.com/methods/tooling.tokens.rotate) on each startup and persists the new token pair to `data/slack-config-tokens.json`. This means you only need to set the refresh token once.

To generate the tokens:

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Scroll to **"Your App Configuration Tokens"** (below your app list)
3. Click **Generate Token** -> select your workspace -> **Generate**
4. Copy the **Refresh Token** (`xoxe-...`) into `SLACK_CONFIG_REFRESH_TOKEN`
5. Copy the **App ID** from your app's Basic Information page into `SLACK_APP_ID`

## Docker deployment

### Prerequisites

- Docker Engine with the Docker Compose plugin
- A `.env` file with valid Slack credentials
- An absolute host directory containing the repositories you want the bot to scan

### Running with Docker Compose

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

## Database setup

No manual database bootstrap is required for normal usage. The app creates the SQLite tables it needs on startup.

If you are developing schema changes, use:

```bash
pnpm db:generate
pnpm db:migrate
```
