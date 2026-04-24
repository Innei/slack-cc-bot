# Slack Skill —— 人工 Quickstart

一个只读的 Slack Web API 封装，对外是一个 Python CLI（`slack.py`）。**零依赖**（只用 stdlib `urllib`，不需要 `pip install`）。

- 给 AI 读的 usage → [`SKILL.md`](./SKILL.md)
- 完整设计 spec → [`docs/specs/slack-skill.md`](../docs/specs/slack-skill.md)
- 本文件是**给人看的**上手文档。

## 能干什么

九个只读子命令，全部返回结构化 JSON：

| 子命令 | 干啥 |
|---|---|
| `get` | 按 permalink / channel+ts 读单条消息 |
| `replies` | 按 permalink 读整个 thread（root + 所有回复） |
| `history` | 频道最近消息，支持条数或时间窗口（`--limit 1d`） |
| `search` | 全域搜索消息（`search.messages`，**要 xoxp**） |
| `files_download` | 按 file id / permalink 下载附件（自带 Bearer 认证） |
| `channels` / `users` / `resolve` | 从本地 cache 查 id / 名字 / 邮箱 |
| `cache_refresh` | 刷新本地 users / channels / subteams 字典 |

三个读消息类命令（`get` / `replies` / `history`）都支持 `--download-files [--types ...]`，读消息同时把里面的附件一并下到本地。

**明确不做**：发消息、加 reaction、mark-read，或任何写操作。HTTP 客户端层有**硬编码只读方法白名单**（见 `client.py`），就算 token 带了 `chat:write` scope 也发不出去。

## 安装

不需要装东西，skill 是源码内置的。你只需要：

- Python ≥ 3.9
- 一个 Slack token（见下）

配置 env：

```bash
cp slack/.env.example slack/.env
# 编辑 slack/.env，至少填 SLACK_BOT_TOKEN
```

`slack/.env` 和项目根 `$PWD/.env` 都会自动加载；shell 里已 export 的同名变量会覆盖文件里的值。

## Token 和 scope

两种 token，按需配：

| 变量 | 格式 | 哪些命令需要 | 所需 scope |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` | 除 `search` 以外全部 | `channels:history` `groups:history` `im:history` `mpim:history` `channels:read` `groups:read` `im:read` `mpim:read` `users:read` `users:read.email` `files:read` |
| `SLACK_USER_TOKEN` | `xoxp-...` | `search` | 同上一套 history / read，再加 `search:read` |

两个都没有的话，`SLACK_TOKEN` 作为兜底会被尝试。全部环境变量的注释见 [`.env.example`](./.env.example)。

Token 来源：<https://api.slack.com/apps> → 你的 App → **OAuth & Permissions**。

## 使用

唯一入口是 `slack/scripts/slack.py`：

```bash
python3 slack/scripts/slack.py --help
python3 slack/scripts/slack.py <子命令> --help
```

常用示例：

```bash
# 读单条消息
python3 slack/scripts/slack.py get --url "https://acme.slack.com/archives/C0.../p1712345678901234"

# 读整个 thread，落盘避免吃 stdout
python3 slack/scripts/slack.py replies --url "<permalink>" --output /tmp/thread.json

# 频道最近一天，带 thread 回复，所有附件一并下载
python3 slack/scripts/slack.py history --channel '#eng' --limit 1d \
  --include-thread-replies --download-files --types all --output /tmp/today.json

# alice 是谁？（模糊查）
python3 slack/scripts/slack.py users --query alice

# 全域搜（需 xoxp）
python3 slack/scripts/slack.py search "deploy in:#eng from:@alice" --limit 50 \
  --output /tmp/hits.json

# 一键 id → 对象
python3 slack/scripts/slack.py resolve "@alice"
python3 slack/scripts/slack.py resolve "#eng-release"
```

### 大结果请 `--output <文件>`

所有可能返回多条消息的命令都支持 `--output <path>`。指定后 stdout 只剩一行 `saved: /path/to.json`。被 AI 调用时特别重要 —— stdout 会直接进 AI 的 context window，动辄塞爆。

### 本地 cache

`channels` / `users --query` / `resolve` 从 `$PWD/.agent-slack/cache/slack/` 读（用 `SLACK_SKILL_CACHE_DIR` 改路径）。首次使用会自动拉全量，之后每 3 天自动刷新一次（`SLACK_SKILL_CACHE_TTL` 秒数可改，`SLACK_SKILL_CACHE_NO_AUTO=1` 彻底关自动刷新）。

每次响应里都带 `cache_refresh: {...}` 段，告诉你这次有没有触发刷新。

### 报错

出错时 stderr 会有一行 `error: <code>`；已知的 Slack 错误码会紧跟一行 `hint: ...` 直接给下一步。退出码：

- `2` —— token 缺失 / argparse 参数错
- `3` —— 触发只读白名单（正常情况下不会发生）
- `4` —— 参数非法（例如格式错、channel 不在 `SLACK_SKILL_ALLOWED_CHANNELS` 白名单）
- `1` —— 其他（含 Slack API 返回的业务错误）

完整错误码 → 建议操作映射见 [`SKILL.md`](./SKILL.md) §8。

### Thread 回复 permalink 的坑

Slack UI 复制 thread 内某条回复的链接时，天然带 `?thread_ts=<root_ts>`。如果你是**自己从 ts 拼的** permalink，**一定要保留 `thread_ts` 这个 query param**，否则 Slack 查不到 reply，你会收到 `message_not_found`。

## 目录结构

```
slack/
├── SKILL.md           # 给 AI 的 usage（frontmatter + recipes）
├── README.md          # 本文件
├── .env.example       # 全部 env 变量，带完整注释
└── scripts/
    ├── slack.py       # sys.path shim → sk.cli.main
    └── sk/            # 按关注点拆分的 package
        ├── cli.py            # argparse + 错误 hint 映射
        ├── client.py         # urllib HTTP 客户端 + 只读白名单
        ├── config.py         # .env 加载 + token 路由
        ├── errors.py         # 自定义异常 + token 打码
        ├── cache.py          # 本地 JSON cache（users / channels / subteams）
        ├── channels.py       # 频道解析（#name → id）
        ├── files.py          # 附件下载（原子写 + 类别分类）
        ├── lookups.py        # 构造 id → 名字 的解析器
        ├── mentions.py       # <@U> 收集 + users.info 批量预取
        ├── message.py        # normalise_message() 统一消息形状
        ├── output.py         # emit()：stdout vs --output 文件
        ├── render.py         # Block Kit + markdown 渲染
        ├── shared.py         # --download-files 公共入口
        ├── timex.py          # --limit '1d' / '30m' 解析
        ├── urls.py           # permalink 解析
        └── cmd_*.py          # 每个子命令一个
```

## 开发须知

- 无运行期依赖，没有 build 步骤，直接改文件就行。
- `ast.parse` + `--help` 可以对每个模块做零网络调用的烟雾测试。
- 代码风格：stdlib typing、`from __future__ import annotations`、公共 helper 写 docstring。没配 lint，保持现有代码风格即可。
- **新增 Slack API 方法**必须加到 `client.py` 的 `READ_ONLY_METHODS` 白名单 —— 这是唯一放宽能力的口子，顺便 review 一下确实是只读。

## 使用范围

`winches-skills` 内部工具，不对外 license。
