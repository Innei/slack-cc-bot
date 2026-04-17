# @kagura/web-ui

Vite 8 + React + TailwindCSS dashboard for the Kagura bot. Talks to the Hono HTTP API
that runs alongside the bot (`apps/bot`, exposed on `HTTP_PORT`, default `4000`).

## Stack

- Vite 8 + React 19
- TailwindCSS v4
- React Router (route object definition in `src/router.tsx`)
- TanStack Query for data fetching
- Zustand for persisted UI preferences
- Jotai for transient UI filters
- motion (framer-motion) for micro-animations
- lucide-react for icons

## Develop

```bash
# Terminal 1 — start the bot (includes HTTP API on :4000)
pnpm dev

# Terminal 2 — start the web UI (proxies /api to :4000)
pnpm dev:web
```

Override the API target via `KAGURA_API_URL=http://host:port pnpm dev:web`.

## Build

```bash
pnpm build:web
```

Output is written to `apps/web-ui/dist/`.
