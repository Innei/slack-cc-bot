FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/pnpm/corepack
ENV PATH=$PNPM_HOME:$PATH

RUN mkdir -p "$COREPACK_HOME" \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot/package.json ./apps/bot/package.json
COPY packages/live-cli/package.json ./packages/live-cli/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @slack-cc-bot/bot build

FROM base AS prod-deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot/package.json ./apps/bot/package.json

RUN pnpm install --prod --frozen-lockfile --filter @slack-cc-bot/bot

FROM base AS runtime

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system app \
  && useradd --system --gid app --create-home app

COPY --from=build --chown=app:app /app/apps/bot/package.json ./package.json
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/apps/bot/dist ./dist

RUN mkdir -p /app/data && chown -R app:app /app/data /pnpm && chmod 0777 /app/data

USER app

CMD ["node", "dist/index.js"]
