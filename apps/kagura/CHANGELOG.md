# Changelog

## 0.2.1

- **Fix**: `npm install -g @innei/kagura@0.2.0` failed with `@kagura/cli: Not Found` because workspace-only deps were incorrectly listed as runtime dependencies. All bundled deps (`@kagura/cli`, commander, @clack/prompts, open, picocolors) moved to devDependencies; tsdown bundles them into `dist/`. Runtime deps now only include the externals that cannot be bundled: `better-sqlite3` and `@anthropic-ai/claude-agent-sdk`.

## 0.2.0

- **New**: `kagura` CLI with interactive `init` wizard (Slack app creation via manifest prefill URL or config-token auto; Claude Code + Codex CLI onboarding).
- **New**: `kagura doctor`, `kagura manifest print|export|sync`, `kagura config path` subcommands.
- **New**: `kagura-app` bin for running the bot without the CLI router (useful for systemd / Docker).
- **Changed**: Default config directory is now `~/.config/kagura/` (dev-mode cwd detection preserves the old behavior inside the repo).
- **Changed**: Default `sessions.db`, `logs/`, and `slack-config-tokens.json` live under `~/.config/kagura/data` and `~/.config/kagura/logs`. User-set `SESSION_DB_PATH` / `LOG_DIR` still win.
- **Changed**: Repo layout split — `src/` is now `apps/kagura/src/`, CLI lives in `packages/cli/`.

## 0.1.0

- Initial npm publish.
