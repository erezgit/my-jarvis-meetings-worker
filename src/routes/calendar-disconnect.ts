import { neon } from "@neondatabase/serverless";
import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import {
  clearGoogleState,
  fetchTenantConfig,
  getGoogleState,
  getTenantStub,
} from "../do";
import { cancelMeetingDO } from "../do-meeting";
import { stopChannel } from "../lib/google-calendar";
import { removeChannel } from "../lib/kv-routing";
import { getFreshAccessToken } from "./calendar-oauth";
import type { Env } from "../lib/types";

/* --------------------------------------------------------------------------
 * POST /calendar/disconnect
 *
 * Auth: Authorization: Bearer <tenant_key> + X-Tenant: <slug>
 *
 * 1. channels.stop on Google's side (best-effort)
 * 2. Remove KV reverse-lookup
 * 3. Cancel scheduled MeetingDOs (so future events don't auto-dispatch)
 * 4. Clear Google fields from MeetingTenantDO
 *
 * Historical `meeting_transcript` rows are preserved (per ISC-22).
 * Past `calendar_events` rows kept for audit.
 * ------------------------------------------------------------------------ */
export async function handleCalendarDisconnect(
  request: Request,
  env: Env,
): Promise<Response> {
  const slug = readTenantHeader(request);
  const bearer = readBearer(request);
  if (!slug || !bearer) return json({ ok: false, error: "missing auth" }, 401);

  const stub = getTenantStub(env.MEETING_TENANT, slug);
  const cfg = await fetchTenantConfig(stub, slug);
  if (!cfg) return json({ ok: false, error: "unknown tenant" }, 404);
  if (!tenantKeyMatches(bearer, cfg)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const gs = await getGoogleState(stub, slug);

  // 1) channels.stop — needs a fresh access token. If refresh fails (e.g. user
  // revoked), keep going; we still want to clear local state.
  if (
    gs.google_channel_id &&
    gs.google_channel_resource_id &&
    gs.google_refresh_token
  ) {
    try {
      const accessToken = await getFreshAccessToken({
        env,
        refreshToken: gs.google_refresh_token,
      });
      await stopChannel({
        accessToken,
        channelId: gs.google_channel_id,
        resourceId: gs.google_channel_resource_id,
      });
    } catch (err) {
      console.error(`[calendar/disconnect] channels.stop failed:`, err);
    }
  }

  // 2) Remove KV mapping.
  if (gs.google_channel_id) {
    try {
      await removeChannel(env.CALENDAR_ROUTING, gs.google_channel_id);
    } catch (err) {
      console.error(`[calendar/disconnect] kv remove failed:`, err);
    }
  }

  // 3) Cancel scheduled MeetingDOs. We iterate `calendar_events WHERE
  // status='scheduled' AND start_time > now()` from tenant Neon — that's the
  // only place where we know all the event ids for this tenant.
  let cancelled = 0;
  try {
    const sql = neon(cfg.database_url);
    const rows = (await sql`
      SELECT google_event_id FROM calendar_events
      WHERE status = 'scheduled' AND start_time > now()
    `) as Array<{ google_event_id: string }>;
    for (const row of rows) {
      try {
        await cancelMeetingDO(env.MEETING_DO, slug, row.google_event_id);
        cancelled++;
      } catch (err) {
        console.error(
          `[calendar/disconnect] cancel DO failed event=${row.google_event_id}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error(`[calendar/disconnect] neon query failed:`, err);
  }

  // 4) Clear Google fields from tenant DO.
  await clearGoogleState(stub, slug);

  return json({ ok: true, cancelled });
}
