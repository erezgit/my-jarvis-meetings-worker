import type {
  DurableObjectState,
  DurableObjectStub,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { insertTranscriptSegment } from "./lib/neon";
import type { Env, TenantConfig, TranscriptSegment } from "./lib/types";

/**
 * MeetingTenantDO — one instance per tenant slug, accessed via
 * `env.MEETING_TENANT.idFromName(slug)`.
 *
 * Storage:
 *   "config" → { database_url, recall_webhook_secret, tenant_key }
 *
 * Internal HTTP surface (called via `stub.fetch("https://do/<path>", ...)`):
 *   POST /_internal/set-config         body: TenantConfig          -> 200 {ok:true}
 *   GET  /_internal/get-config                                     -> 200 TenantConfig | 404
 *   POST /_internal/insert-transcript  body: TranscriptSegment     -> 200 {ok, inserted}
 *
 * Direct external HTTP returns 410 — the DO is namespace-only.
 */
export class MeetingTenantDO {
  private state: DurableObjectState;

  // Hot-path cache. `getConfig` reads from storage once and pins it for the
  // lifetime of this DO instance; `setConfig` invalidates. Cuts a storage hit
  // off every webhook/bot/play/leave call.
  private cachedConfig: TenantConfig | null = null;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === "/_internal/set-config" && method === "POST") {
      const body = (await request.json()) as TenantConfig;
      if (
        typeof body?.database_url !== "string" ||
        typeof body?.recall_webhook_secret !== "string" ||
        typeof body?.tenant_key !== "string"
      ) {
        return jsonResponse({ ok: false, error: "invalid config" }, 400);
      }
      const cfg: TenantConfig = {
        database_url: body.database_url,
        recall_webhook_secret: body.recall_webhook_secret,
        tenant_key: body.tenant_key,
      };
      await this.state.storage.put("config", cfg);
      this.cachedConfig = cfg;
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/_internal/get-config" && method === "GET") {
      const cfg = await this.loadConfig();
      if (!cfg) return jsonResponse({ ok: false, error: "no config" }, 404);
      return jsonResponse(cfg);
    }

    if (url.pathname === "/_internal/insert-transcript" && method === "POST") {
      const cfg = await this.loadConfig();
      if (!cfg) return jsonResponse({ ok: false, error: "no config" }, 404);
      const seg = (await request.json()) as TranscriptSegment;
      const inserted = await insertTranscriptSegment(cfg.database_url, seg);
      return jsonResponse({ ok: true, inserted });
    }

    return new Response(
      "meeting-tenant-do — access via internal namespace only",
      { status: 410 },
    );
  }

  private async loadConfig(): Promise<TenantConfig | null> {
    if (this.cachedConfig) return this.cachedConfig;
    const cfg = (await this.state.storage.get<TenantConfig>("config")) ?? null;
    this.cachedConfig = cfg;
    return cfg;
  }
}

/* --------------------------------------------------------------------------
 * Helpers used by route handlers — keep all DO interaction in one place so
 * each route reads as plain control flow.
 * ------------------------------------------------------------------------ */

/** Build a stub for the given tenant slug. */
export function getTenantStub(
  ns: DurableObjectNamespace,
  slug: string,
): DurableObjectStub {
  const id = ns.idFromName(slug);
  return ns.get(id);
}

/** Fetch and return the tenant's config, or null if not registered. */
export async function fetchTenantConfig(
  stub: DurableObjectStub,
  slug: string,
): Promise<TenantConfig | null> {
  const r = await stub.fetch(internalUrl("/_internal/get-config", slug), {
    method: "GET",
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(`MeetingTenantDO get-config failed: ${r.status}`);
  }
  return (await r.json()) as TenantConfig;
}

/** Persist or replace the tenant's config. */
export async function setTenantConfig(
  stub: DurableObjectStub,
  slug: string,
  cfg: TenantConfig,
): Promise<void> {
  const r = await stub.fetch(internalUrl("/_internal/set-config", slug), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) {
    throw new Error(`MeetingTenantDO set-config failed: ${r.status}`);
  }
}

/**
 * Persist a transcript segment via the DO. Returns whether the row was
 * inserted (false means no matching `meetings.bot_id` row was found).
 */
export async function insertTranscriptViaDO(
  stub: DurableObjectStub,
  slug: string,
  seg: TranscriptSegment,
): Promise<boolean> {
  const r = await stub.fetch(internalUrl("/_internal/insert-transcript", slug), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(seg),
  });
  if (!r.ok) {
    throw new Error(`MeetingTenantDO insert-transcript failed: ${r.status}`);
  }
  const body = (await r.json()) as { ok: boolean; inserted: boolean };
  return Boolean(body.inserted);
}

/* --------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------ */

/**
 * Internal URLs include the slug as host so `wrangler tail` traces the right
 * DO without us having to log it on every call.
 */
function internalUrl(path: string, slug: string): string {
  const safe = encodeURIComponent(slug);
  return `https://meeting-tenant-${safe}.do${path}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
