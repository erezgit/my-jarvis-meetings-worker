import type {
  DurableObjectState,
  DurableObjectStub,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { insertTranscriptSegment } from "./lib/neon";
import type {
  ActiveMeeting,
  Env,
  GoogleStatePatch,
  TenantConfig,
  TranscriptSegment,
} from "./lib/types";

/**
 * MeetingTenantDO — one instance per tenant slug, accessed via
 * `env.MEETING_TENANT.idFromName(slug)`.
 *
 * Storage:
 *   "config" → TenantConfig (tenant + Vexa fields + optional Google fields)
 *
 * Internal HTTP surface (called via `stub.fetch("https://do/<path>", ...)`):
 *   POST /_internal/set-config           body: TenantConfig            -> 200 {ok:true}
 *   GET  /_internal/get-config                                         -> 200 TenantConfig | 404
 *   POST /_internal/insert-transcript    body: TranscriptSegment       -> 200 {ok, inserted}
 *   POST /_internal/set-google-state     body: GoogleStatePatch        -> 200 {ok:true}
 *   GET  /_internal/get-google-state                                   -> 200 GoogleStatePatch | 404
 *   POST /_internal/clear-google-state                                 -> 200 {ok:true}
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
        typeof body?.tenant_key !== "string"
      ) {
        return jsonResponse({ ok: false, error: "invalid config" }, 400);
      }
      // Preserve any existing Google fields — set-config only replaces the
      // tenant + Vexa fields. Calendar (re)connect uses /set-google-state.
      const existing = await this.loadConfig();
      const cfg: TenantConfig = {
        ...(existing ?? {}),
        database_url: body.database_url,
        tenant_key: body.tenant_key,
        ...(body.vexa_api_url !== undefined
          ? { vexa_api_url: body.vexa_api_url }
          : {}),
        ...(body.vexa_api_key !== undefined
          ? { vexa_api_key: body.vexa_api_key }
          : {}),
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

    if (url.pathname === "/_internal/set-google-state" && method === "POST") {
      const existing = await this.loadConfig();
      if (!existing) {
        return jsonResponse(
          { ok: false, error: "tenant not registered" },
          404,
        );
      }
      const patch = (await request.json()) as GoogleStatePatch;
      const merged: TenantConfig = {
        ...existing,
        ...stripUndefined(patch),
      };
      await this.state.storage.put("config", merged);
      this.cachedConfig = merged;
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/_internal/get-google-state" && method === "GET") {
      const cfg = await this.loadConfig();
      if (!cfg) return jsonResponse({ ok: false, error: "no config" }, 404);
      const out: GoogleStatePatch = {
        google_refresh_token: cfg.google_refresh_token,
        google_oauth_email: cfg.google_oauth_email,
        google_channel_id: cfg.google_channel_id,
        google_channel_secret: cfg.google_channel_secret,
        google_channel_resource_id: cfg.google_channel_resource_id,
        google_channel_expiration_ms: cfg.google_channel_expiration_ms,
        google_sync_token: cfg.google_sync_token,
      };
      return jsonResponse(out);
    }

    if (
      url.pathname === "/_internal/clear-google-state" &&
      method === "POST"
    ) {
      const existing = await this.loadConfig();
      if (!existing) {
        return jsonResponse(
          { ok: false, error: "tenant not registered" },
          404,
        );
      }
      const cleared: TenantConfig = {
        database_url: existing.database_url,
        tenant_key: existing.tenant_key,
        ...(existing.vexa_api_url !== undefined
          ? { vexa_api_url: existing.vexa_api_url }
          : {}),
        ...(existing.vexa_api_key !== undefined
          ? { vexa_api_key: existing.vexa_api_key }
          : {}),
      };
      await this.state.storage.put("config", cleared);
      this.cachedConfig = cleared;
      return jsonResponse({ ok: true });
    }

    // ---- Active-meeting pointer (single live meeting per tenant) ----------
    if (url.pathname === "/_internal/get-active-meeting" && method === "GET") {
      const am =
        (await this.state.storage.get<ActiveMeeting>("active_meeting")) ?? null;
      if (!am) return jsonResponse({ ok: false, error: "none" }, 404);
      return jsonResponse(am);
    }

    if (url.pathname === "/_internal/set-active-meeting" && method === "POST") {
      const am = (await request.json()) as ActiveMeeting;
      if (
        typeof am?.event_id !== "string" ||
        typeof am?.bot_id !== "string" ||
        typeof am?.platform !== "string" ||
        typeof am?.native_meeting_id !== "string"
      ) {
        return jsonResponse({ ok: false, error: "invalid active-meeting" }, 400);
      }
      await this.state.storage.put("active_meeting", am);
      return jsonResponse({ ok: true });
    }

    if (
      url.pathname === "/_internal/clear-active-meeting" &&
      method === "POST"
    ) {
      // Optional body { bot_id } — only clear if it still points at this bot,
      // so a meeting ending late doesn't wipe a newer meeting's pointer.
      let onlyBotId: string | null = null;
      try {
        const b = (await request.json()) as { bot_id?: string };
        if (typeof b?.bot_id === "string") onlyBotId = b.bot_id;
      } catch {
        /* no body — unconditional clear */
      }
      const am =
        (await this.state.storage.get<ActiveMeeting>("active_meeting")) ?? null;
      if (am && (onlyBotId === null || am.bot_id === onlyBotId)) {
        await this.state.storage.delete("active_meeting");
      }
      return jsonResponse({ ok: true, cleared: Boolean(am) });
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

/** Persist or replace the tenant's config (tenant + Vexa fields — Google
 * fields are preserved across this call). */
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

/** Merge a Google state patch into the tenant config. */
export async function setGoogleState(
  stub: DurableObjectStub,
  slug: string,
  patch: GoogleStatePatch,
): Promise<void> {
  const r = await stub.fetch(internalUrl("/_internal/set-google-state", slug), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    throw new Error(`MeetingTenantDO set-google-state failed: ${r.status}`);
  }
}

/** Read Google state. Returns an empty object if the tenant has no Google fields set. */
export async function getGoogleState(
  stub: DurableObjectStub,
  slug: string,
): Promise<GoogleStatePatch> {
  const r = await stub.fetch(internalUrl("/_internal/get-google-state", slug), {
    method: "GET",
  });
  if (r.status === 404) return {};
  if (!r.ok) {
    throw new Error(`MeetingTenantDO get-google-state failed: ${r.status}`);
  }
  return (await r.json()) as GoogleStatePatch;
}

/** Clear all Google fields (disconnect). */
export async function clearGoogleState(
  stub: DurableObjectStub,
  slug: string,
): Promise<void> {
  const r = await stub.fetch(
    internalUrl("/_internal/clear-google-state", slug),
    { method: "POST" },
  );
  if (!r.ok) {
    throw new Error(`MeetingTenantDO clear-google-state failed: ${r.status}`);
  }
}

/** Read the tenant's currently-active meeting pointer, or null. */
export async function getActiveMeeting(
  stub: DurableObjectStub,
  slug: string,
): Promise<ActiveMeeting | null> {
  const r = await stub.fetch(internalUrl("/_internal/get-active-meeting", slug), {
    method: "GET",
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(`MeetingTenantDO get-active-meeting failed: ${r.status}`);
  }
  return (await r.json()) as ActiveMeeting;
}

/** Set the tenant's currently-active meeting pointer. */
export async function setActiveMeeting(
  stub: DurableObjectStub,
  slug: string,
  am: ActiveMeeting,
): Promise<void> {
  const r = await stub.fetch(internalUrl("/_internal/set-active-meeting", slug), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(am),
  });
  if (!r.ok) {
    throw new Error(`MeetingTenantDO set-active-meeting failed: ${r.status}`);
  }
}

/** Clear the active-meeting pointer. If `botId` is given, only clears when the
 * pointer still references that bot (avoids a late-ending meeting wiping a
 * newer one's pointer). */
export async function clearActiveMeeting(
  stub: DurableObjectStub,
  slug: string,
  botId?: string,
): Promise<void> {
  const r = await stub.fetch(
    internalUrl("/_internal/clear-active-meeting", slug),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botId ? { bot_id: botId } : {}),
    },
  );
  if (!r.ok) {
    throw new Error(`MeetingTenantDO clear-active-meeting failed: ${r.status}`);
  }
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

/** Drop keys whose value is `undefined` so they don't overwrite existing fields. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
