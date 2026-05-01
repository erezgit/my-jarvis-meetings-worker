import type { ExecutionContext } from "@cloudflare/workers-types";
import { json } from "../lib/auth";
import {
  fetchTenantConfig,
  getGoogleState,
  getTenantStub,
  setGoogleState,
} from "../do";
import {
  cancelMeetingDO,
  upsertMeetingDO,
} from "../do-meeting";
import {
  listEventsPage,
  normaliseEvent,
} from "../lib/google-calendar";
import type { RawCalendarEvent } from "../lib/google-calendar";
import { getTenantByChannelId } from "../lib/kv-routing";
import {
  getFreshAccessToken,
  persistCalendarEvent,
  runFullSync,
} from "./calendar-oauth";
import type { Env } from "../lib/types";

/* --------------------------------------------------------------------------
 * POST /calendar/notify
 *
 * Google's push receiver. No body — auth is via X-Goog-Channel-Token only.
 *
 * Headers:
 *   X-Goog-Channel-Id      → channel id we registered (KV lookup → tenant)
 *   X-Goog-Channel-Token   → per-channel secret we set (constant-time compare)
 *   X-Goog-Resource-State  → "sync" (registration handshake), "exists", "not_exists"
 *   X-Goog-Resource-Id     → opaque, not used here (we have it stored already)
 *   X-Goog-Message-Number  → monotonic seq, not used here
 *
 * Always 200 quickly to keep Google happy. Heavy work goes via ctx.waitUntil.
 * ------------------------------------------------------------------------ */
export async function handleCalendarNotify(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const channelId = request.headers.get("X-Goog-Channel-Id") ?? "";
  const channelToken = request.headers.get("X-Goog-Channel-Token") ?? "";
  const resourceState = request.headers.get("X-Goog-Resource-State") ?? "";

  if (!channelId) {
    // Some preflight or noise — just 200.
    return json({ ok: true, skipped: "no channel id" });
  }

  // 1) Reverse-lookup channel id → tenant via KV.
  const tenant = await getTenantByChannelId(env.CALENDAR_ROUTING, channelId);
  if (!tenant) {
    // Stale channel — registration may have rotated. Drop.
    console.warn(`[calendar/notify] unknown channel=${channelId}`);
    return json({ ok: true, skipped: "unknown channel" });
  }

  // 2) Pull tenant config + Google state.
  const stub = getTenantStub(env.MEETING_TENANT, tenant);
  const cfg = await fetchTenantConfig(stub, tenant);
  if (!cfg) return json({ ok: true, skipped: "no tenant config" });
  const gs = await getGoogleState(stub, tenant);

  // 3) Auth: constant-time compare X-Goog-Channel-Token vs stored secret.
  const expected = gs.google_channel_secret ?? "";
  if (!expected || !constantTimeEq(channelToken, expected)) {
    console.warn(`[calendar/notify] bad token tenant=${tenant} channel=${channelId}`);
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // 4) "sync" is the handshake — Google fires this once on registration.
  if (resourceState === "sync") {
    console.log(`[calendar/notify] sync handshake tenant=${tenant} channel=${channelId}`);
    return json({ ok: true, sync: true });
  }

  // Defer heavy work (token refresh, events.list, DO upserts) so we 200
  // immediately. Google retries on non-2xx; we don't want spurious retries
  // because Neon was slow.
  ctx.waitUntil(processDelta({ env, tenantSlug: tenant }));

  return json({ ok: true });
}

/* --------------------------------------------------------------------------
 * Internals — delta sync + full-resync fallback
 * ------------------------------------------------------------------------ */

async function processDelta(opts: {
  env: Env;
  tenantSlug: string;
}): Promise<void> {
  const { env, tenantSlug } = opts;
  const stub = getTenantStub(env.MEETING_TENANT, tenantSlug);
  const cfg = await fetchTenantConfig(stub, tenantSlug);
  if (!cfg) return;
  const gs = await getGoogleState(stub, tenantSlug);
  if (!gs.google_refresh_token) return;
  const accessToken = await getFreshAccessToken({
    env,
    refreshToken: gs.google_refresh_token,
  });

  const syncToken = gs.google_sync_token;
  if (!syncToken) {
    // No syncToken — fall back to a fresh full sync.
    await fullResync({ env, tenantSlug, accessToken });
    return;
  }

  // Walk paginated incremental sync. Each page may carry events; the LAST
  // page returns the new nextSyncToken (per Google docs).
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let touched = 0;

  for (let i = 0; i < 50; i++) {
    const r = await listEventsPage({ accessToken, syncToken, pageToken });
    if (r.status === 410) {
      // syncToken expired → full resync.
      console.warn(
        `[calendar/notify] syncToken 410 tenant=${tenantSlug} — full resync`,
      );
      await fullResync({ env, tenantSlug, accessToken });
      return;
    }
    if (!r.page) {
      throw new Error(`[calendar/notify] events.list returned no page`);
    }
    for (const raw of r.page.events) {
      await applyDeltaEvent({
        env,
        tenantSlug,
        cfgDatabaseUrl: cfg.database_url,
        raw: raw as RawCalendarEvent,
      });
      touched++;
    }
    if (r.page.nextPageToken) {
      pageToken = r.page.nextPageToken;
      continue;
    }
    nextSyncToken = r.page.nextSyncToken;
    break;
  }

  if (nextSyncToken) {
    await setGoogleState(stub, tenantSlug, {
      google_sync_token: nextSyncToken,
    });
  }
  console.log(
    `[calendar/notify] delta done tenant=${tenantSlug} events=${touched}`,
  );
}

async function fullResync(opts: {
  env: Env;
  tenantSlug: string;
  accessToken: string;
}): Promise<void> {
  const { env, tenantSlug, accessToken } = opts;
  const stub = getTenantStub(env.MEETING_TENANT, tenantSlug);
  const cfg = await fetchTenantConfig(stub, tenantSlug);
  if (!cfg) return;

  const result = await runFullSync({ accessToken });
  for (const ev of result.normalised) {
    if (ev.status === "cancelled") {
      // Cancel any DO we previously scheduled.
      try {
        await cancelMeetingDO(env.MEETING_DO, tenantSlug, ev.google_event_id);
      } catch (err) {
        console.error(`[full-resync] cancel failed:`, err);
      }
      try {
        await persistCalendarEvent(cfg.database_url, tenantSlug, ev);
      } catch (err) {
        console.error(`[full-resync] persist failed:`, err);
      }
      continue;
    }
    if (!ev.meeting_url) {
      // No meeting URL → nothing for Recall to join. Persist for the
      // dashboard list; don't spawn a DO.
      try {
        await persistCalendarEvent(cfg.database_url, tenantSlug, ev);
      } catch (err) {
        console.error(`[full-resync] persist (no url) failed:`, err);
      }
      continue;
    }
    try {
      await upsertMeetingDO(env.MEETING_DO, {
        tenant_slug: tenantSlug,
        google_event_id: ev.google_event_id,
        start_time_ms: ev.start_time_ms,
        end_time_ms: ev.end_time_ms,
        title: ev.title,
        meeting_url: ev.meeting_url,
      });
    } catch (err) {
      console.error(`[full-resync] DO upsert failed:`, err);
    }
    try {
      await persistCalendarEvent(cfg.database_url, tenantSlug, ev);
    } catch (err) {
      console.error(`[full-resync] persist failed:`, err);
    }
  }

  if (result.nextSyncToken) {
    await setGoogleState(stub, tenantSlug, {
      google_sync_token: result.nextSyncToken,
    });
  }
}

async function applyDeltaEvent(opts: {
  env: Env;
  tenantSlug: string;
  cfgDatabaseUrl: string;
  raw: RawCalendarEvent;
}): Promise<void> {
  const { env, tenantSlug, cfgDatabaseUrl, raw } = opts;

  // Cancellations from Google show up with status='cancelled' and may have a
  // truncated payload — only id + status guaranteed. Handle that branch
  // before normaliseEvent (which requires start.dateTime).
  if (raw.status === "cancelled" && typeof raw.id === "string") {
    try {
      await cancelMeetingDO(env.MEETING_DO, tenantSlug, raw.id);
    } catch (err) {
      console.error(`[delta] cancel failed:`, err);
    }
    try {
      const sql = (await import("@neondatabase/serverless")).neon(cfgDatabaseUrl);
      await sql`
        UPDATE calendar_events
        SET status = CASE WHEN status = 'dispatched' THEN status ELSE 'cancelled' END,
            updated_at = now()
        WHERE google_event_id = ${raw.id}
      `;
    } catch (err) {
      console.error(`[delta] persist cancel failed:`, err);
    }
    return;
  }

  const ev = normaliseEvent(raw);
  if (!ev) return;

  if (!ev.meeting_url) {
    try {
      await persistCalendarEvent(cfgDatabaseUrl, tenantSlug, ev);
    } catch (err) {
      console.error(`[delta] persist (no url) failed:`, err);
    }
    return;
  }
  try {
    await upsertMeetingDO(env.MEETING_DO, {
      tenant_slug: tenantSlug,
      google_event_id: ev.google_event_id,
      start_time_ms: ev.start_time_ms,
      end_time_ms: ev.end_time_ms,
      title: ev.title,
      meeting_url: ev.meeting_url,
    });
  } catch (err) {
    console.error(`[delta] DO upsert failed:`, err);
  }
  try {
    await persistCalendarEvent(cfgDatabaseUrl, tenantSlug, ev);
  } catch (err) {
    console.error(`[delta] persist failed:`, err);
  }
}

/* --------------------------------------------------------------------------
 * Tiny utils
 * ------------------------------------------------------------------------ */

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
