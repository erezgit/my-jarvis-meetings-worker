# my-jarvis-meetings-worker

Multi-tenant Cloudflare Worker that fronts the [Recall.ai](https://recall.ai) bot
API for the MyJarvis platform. One Worker, many tenants — each tenant
(`erez`, `yaron`, …) gets its own `MeetingTenantDO` Durable Object instance
that holds its Neon `database_url`, Recall webhook secret, and bearer key.

## Architecture

```
Tenant client ──┐
                ├─ POST /recall/bot     (Bearer + X-Tenant)
                ├─ POST /recall/play    (Bearer + X-Tenant)
                ├─ POST /recall/leave   (Bearer + X-Tenant)
                │
Recall.ai ─────►  POST /recall/webhook?tenant=<slug>&sig=<hmac>
                │
Admin ─────────►  POST /admin/register  (Bearer ADMIN_TOKEN)
                │
Uptime ────────►  GET  /healthz
```

Each route resolves the tenant slug, fetches the per-tenant config from the
DO (`MeetingTenantDO.idFromName(slug)`), authenticates the caller against the
DO's stored `tenant_key` (or HMAC for the webhook), then forwards to Recall
with the platform-wide `RECALL_API_KEY`. Transcript events land in that
tenant's Neon `meeting_transcript` table via the DO.

## Routes

- `POST /admin/register` — register/replace tenant config (admin-only).
- `POST /recall/bot` — start a Recall bot for a meeting (per-tenant auth).
- `POST /recall/webhook?tenant=<slug>&sig=<sig>` — Recall transcript webhook.
- `POST /recall/play` — play b64-encoded audio through the bot.
- `POST /recall/leave` — kick the bot from the call.
- `GET  /healthz` — uptime probe.

See `src/routes/*.ts` for exact request/response shapes.

## Secrets / env

```bash
wrangler secret put RECALL_API_KEY
wrangler secret put ADMIN_TOKEN
```

`WORKER_PUBLIC_HOST` (used to build the webhook URL we hand to Recall) lives
in `wrangler.toml` `[vars]` since it's not sensitive.

## Local verification

```bash
npm install
npx tsc --noEmit
npx wrangler deploy --dry-run
```

No deploy until those three pass.
