---
name: slack
description: >-
  Use when AI encounters Slack permalinks (https://*.slack.com/archives/...),
  Slack IDs (C.../U.../D.../F...), thread 讨论上下文, 搜索 Slack 历史消息,
  按邮箱/handle 反查用户, 浏览频道最近动态, 下载 Slack 附件（截图/日志/CSV/PDF),
  或需要把 @handle / #name / ^subteam 解析成 ID 时.
---

# Slack Skill

只读 Slack Web API 的 9 个子命令封装，统一入口 `scripts/slack.py`。
**不写消息 / 不加 reaction / 不 mark-read** —— 这些动作由调用方 Bot 自己处理，client 层有硬编码白名单拦截。

---

## When to Use

**触发信号**（AI 看到任一信号即考虑调用）：

- `https://*.slack.com/archives/...` 链接
- `C[A-Z0-9]{8,}` / `U[A-Z0-9]{8,}` / `D[A-Z0-9]{8,}` / `F[A-Z0-9]{8,}` 风格 ID
- `p123456789012345` 风格的消息 ts
- 用户提到 "Slack" / "thread" / "频道" / "群里" / "@某人 在 Slack 说"
- Jira/PR 正文里的 Slack permalink（排查类任务需要 QA/RD 讨论上下文）

**术语对照**：

| 用户说法 | 含义 |
|---|---|
| slack / 消息 / DM / 频道 / thread / permalink | 本 skill |
| Slack URL `https://xxx.slack.com/archives/...` | `get` / `replies` / `files_download --url` 入参 |
| `@handle` / `@name` / `#channel` / `^subteam` | `resolve` / `users` / `channels` 入参 |
| `ts` / `thread_ts` | Slack 时间戳 ID（`1234567890.123456`） |

---

## Quick Reference

**入口**：

```
.agent-slack/skills/slack/scripts/slack.py
```

查找顺序：`./.agent-slack/skills/slack/scripts/slack.py` → `<git-root>/.agent-slack/skills/slack/scripts/slack.py` → `<git-root>/slack/scripts/slack.py`（仓库开发路径）→ `find . -path '*skills/slack/scripts/slack.py'`。

**所有调用** = `python3 <path> <subcommand> [flags]`；**禁止** `import sk.*` 绕过入口。

**子命令表**：

| 子命令 | 作用 | 典型入参 |
|---|---|---|
| `get` | 读单条消息 | `--url <permalink>` |
| `replies` | 读整个 thread | `--url <任一消息 permalink>` |
| `history` | 浏览频道最近消息 | `--channel <#name\|C...>` `--limit <n\|1d\|2h>` |
| `search` | 全域搜消息（xoxp 专属） | `<query 字符串，原生 modifier>` |
| `files_download` | 下附件 | `--file-id F...` 或 `--url <permalink>` |
| `channels` | 搜/列频道（走 cache） | `--query <name>` / `--type public` |
| `users` | 查人（ID/email/name） | `--id U...` / `--email ...` / `--query <name>` |
| `resolve` | 字符串 → 对象 | `resolve "#eng"` / `"@alice"` / `"^oncall"` / `U.../C.../F.../email` |
| `cache_refresh` | 刷本地 users/channels/subteams 字典 | — |

每条都支持 `--help`。大输出用 `--output <file>`（stdout 只打 `saved: <path>`）。

---

## Setup

| 项 | 说明 |
|---|---|
| Python | ≥ 3.9 |
| 依赖 | **无**（只用标准库 `urllib`，零 `pip install`） |
| 配置 | 复制 `slack/.env.example` → `slack/.env`，至少填 `SLACK_BOT_TOKEN` |

**Token 路由**（client 自动挑）：

| 操作 | Token 优先级 |
|---|---|
| 除 `search` 外全部 | `SLACK_BOT_TOKEN` → `SLACK_USER_TOKEN` → `SLACK_TOKEN` |
| `search` | `SLACK_USER_TOKEN` → `SLACK_TOKEN`（**必须 xoxp**，bot token 会被 Slack 拒） |

**Cache 自动刷新**（Chunk 4）：`channels` / `users --query` / `resolve "#name|@handle|^handle"` 在 cache 不存在或 > TTL 时会同步刷一次；单条 lookup（`users --id/--email`、`resolve U.../C.../email`）走 live API，不触发刷新。消息类命令（`get`/`replies`/`history`/`search`）**不会**自动刷新，避免高频放大成全量 `users.list`。

Cache 环境变量：`SLACK_SKILL_CACHE_TTL=<秒>`（默认 3 天）、`SLACK_SKILL_CACHE_NO_AUTO=1`（关自动刷新）、`SLACK_SKILL_CACHE_DIR=<path>`（覆盖默认 `$PWD/.agent-slack/cache/slack/`）。

---

## Recipes

所有响应形状：消息对象一律含 `ts` / `author` / `text_raw`（保留 `<@U>` `<#C>` 原始 token）/ `text_rendered`（`@name` `#channel` 还原，Block Kit 走 Markdown）/ `blocks_rendered` / `files` / `reactions` / `raw`（原始 payload）。**二次处理用 `text_raw`，喂 AI/人读用 `text_rendered`**。

### 读消息 / thread

```bash
# 单条
python3 slack/scripts/slack.py get --url "<permalink>"

# 整个 thread（permalink 任意一条即可）
python3 slack/scripts/slack.py replies --url "<permalink>" [--limit 20] [--output /tmp/t.json]
```

`replies --limit` 算的是 **回复数**，root 总是返回。

### 浏览频道

```bash
# 按条数
python3 slack/scripts/slack.py history --channel "#eng" --limit 20

# 按时间窗口（m/h/d/w）
python3 slack/scripts/slack.py history --channel "C08P..." --limit 1d

# 连 thread 回复一起抓（适合做"今天频道全景"）
python3 slack/scripts/slack.py history --channel "#eng" --limit 1d --include-thread-replies
```

`--limit` 两种语义：纯数字 = 条数；`<n>{m|h|d|w}` = 时间窗口（不限条数）。

### 查人 / 查频道 / 一键 resolve

```bash
python3 slack/scripts/slack.py channels --query release --sort popularity --limit 10
python3 slack/scripts/slack.py users --email alice@example.com
python3 slack/scripts/slack.py resolve "@alice"       # → user
python3 slack/scripts/slack.py resolve "#eng-release" # → channel
python3 slack/scripts/slack.py resolve "^oncall"      # → subteam
python3 slack/scripts/slack.py resolve U06GM8PAFEX    # → 直接 live lookup
```

`resolve` 返回 `{ kind: user|channel|subteam, resolved, candidates?, cache_refresh? }`；拿到 id 再喂 `history --channel <id>` / `replies --url ...`。

### 全域搜索（xoxp 专属）

```bash
# query 原样透传给 Slack，原生 modifier 全可用
python3 slack/scripts/slack.py search "deploy in:#eng from:@alice after:2026-01-01" --limit 50
python3 slack/scripts/slack.py search "incident-4712" --sort timestamp --sort-dir asc --limit 200
```

`--limit` 跨页自动翻（`--max-pages` 默认 5，Slack 单页上限 100）。返回的 matches 同样走 `render` + `preload_users`。

### 下载附件

Slack 的 `url_private` **需要 Bearer token**，AI 工具层没有 token → 不下载就看不见图/PDF/CSV。

```bash
# 读消息时顺便下（最常用）
python3 slack/scripts/slack.py get --url "<permalink>" --download-files [--types image,pdf]

# 只下单个文件
python3 slack/scripts/slack.py files_download --file-id F012ABC --types all --out /tmp/f/
```

每个 `files[i]` 会被填 `local_path` / `download_category` / `download_status`，顶层有 `downloads: { total_files, downloaded, skipped, errored, files_dir }`。

**`--types` 类别**：`text`（post/snippet/md/csv/log/**源码后缀** py/js/ts/go/java/rb/json/yaml/sql …）、`image`、`video`、`audio`、`pdf`、`archive`、`other`、`all`。`--download-files` 默认走 `SLACK_SKILL_DOWNLOAD_TYPES`，缺省是 `text`（AI 上下文友好）。

**幂等**：文件名 `{file_id}{ext}`；再跑一次 → `download_status: skipped:already_exists`。想重下手动 `rm`。

---

## Common Mistakes

命令层遇 Slack API 错会打 `error: <method>: <code> | <detail>` 到 stderr，已知 code **紧跟一行 `hint: ...`**。

| Slack error | 含义 | hint |
|---|---|---|
| `channel_not_found` | 频道 ID/名不存在或 token 无权 | `slack.py channels --query <name>` 找正确 id |
| `not_in_channel` | Bot 没加该私密频道 | Slack 里 `/invite @your-bot` |
| `user_not_found` | 用户不存在或 token 看不到 | `slack.py users --query <name>` 或传完整 `U0...` |
| `not_allowed_token_type` | 该接口只收 xoxp | `search` 必须配 `SLACK_USER_TOKEN` |
| `missing_scope` | scope 不足 | 对照 `.env.example` 补 scope → 重新 Install to Workspace |
| `invalid_auth` / `not_authed` | token 无效/过期/未配 | 检查 `.env`；xoxp 可能被 SSO 失效 |
| `ratelimited` | 速率限制 | skill 已自动 Retry-After；仍超限说明并发过大 |
| `message_not_found` | permalink 指向消息不存在/已删 | **thread 回复的 permalink 必须带 `?thread_ts=<root_ts>`**；Slack UI 复制出来的天然就有，自己拼 URL 容易漏 |
| `file_not_found` | file id 不存在或 token 看不到 | 用 `get`/`replies` 响应里的 `files[].id`（F 开头） |
| `thread_not_found` | 该消息不是 thread 首帖 / 还没回复 | 改用 `get`；或传某条回复的 permalink |

**退出码**：`2` = token 缺失 / argparse 错；`3` = 触发只读白名单（调用了非白名单方法）；`4` = 参数非法（格式错 / channel 不在 `SLACK_SKILL_ALLOWED_CHANNELS`）；`1` = 其他（含未识别的 Slack API error）。

**Bearer token 永不出现在任何日志/错误信息**（`sk/files.py` 走 `redact()`）。

---

## NEVER

- ❌ 发消息 / 改 reaction / mark-read —— 属于调用方 Bot 的职责
- ❌ `import sk.*` 或绕过 `slack.py` 入口
- ❌ token 写进命令行 argv —— 放 `.env` 或 shell env
- ❌ 拿 `text_rendered` 做正则提数 —— 用 `text_raw`
- ❌ 对超长 thread / `history --limit 1d` / 批量 `search` 直接 stdout —— 用 `--output <file>`，否则 AI 上下文爆炸
