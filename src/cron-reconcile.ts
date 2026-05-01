import { neon } from "@neondatabase/serverless";
import {
  fetchTenantConfig,
  getGoogleState,
  getTenantStub,
  setGoogleState,
} from "./do";
import { upsertMeetingDO } from "./do-meeting";
import {
  registerWatchChannel,
  stopChannel,
} from "./lib/google-calendar";
import {
  listAllChannelTenants,
  removeChannel,
  setChannelTenant,
} from "./lib/kv-routing";
import { getFreshAccessToken } from "./routes/calendar-oauth";
import type { Env } from "./lib/types";

/**
 * Cron reconciliation — runs every 5 min.
 *
 * Three jobs per tenant:
 *   1. CHANNEL RENEWAL: if google_channel_expiration_ms < now + 24h, register
 *      a new channel and stop the old one.
 *   2. MISSED DISPATCH: any calendar_events row with status='scheduled' and
 *      start_time < now - 60s and dispatched_at IS NULL → re-trigger MeetingDO.
 *   3. (TODO) sync token 410 recovery is handled inline in /calendar/notify.
 *
 * Tenant iteration: walk CALENDAR_ROUTING KV prefix → distinct tenant slugs.
 */
export async function reconcileAllTenants(env: Env): Promise<void> {
  let tenants: Set<string>;
  try {
    const pairs = await listAllChannelTenants(env.CALENDAR_ROUTING);
    tenants = new Set(pairs.map((p) => p.tenantSlug));
  } catch (err) {
    console.error(`[reconcile] listAllChannelTenants failed:`, err);
    return;
  }

  for (const slug of tenants) {
    try {
      await reconcileTenant(env, slug);
    } catch (err) {
      console.error(`[reconcile] tenant=${slug} failed:`, err);
    }
  }
}

async function reconcileTenant(env: Env, slug: string): Promise<void> {
  const stub = getTenantStub(env.MEETING_TENANT, slug);
  const cfg = await fetchTenantConfig(stub, slug);
  if (!cfg) return;
  const gs = await getGoogleState(stub, slug);
  if (!gs.google_refresh_token) return;

  const now = Date.now();
  const renewBefore = now + 24 * 60 * 60 * 1000;

  // ---- 1. Channel renewal ----------------------------------------------
  if (
    gs.google_channel_expiration_ms &&
    gs.google_channel_expiration_ms < renewBefore
  ) {
    console.log(
      `[reconcile] channel renewal due tenant=${slug} expires=${new Date(
        gs.google_channel_expiration_ms,
      ).toISOString()}`,
    );
    try {
      const accessToken = await getFreshAccessToken({
        env,
        refreshToken: gs.google_refresh_token,
      });
      // Register a NEW channel with a fresh id + secret.
      const newId = `ch-${slug}-${randomHex(6)}`;
      const newSecret = randomHex(32);
      const watchUrl = `https://${env.WORKER_PUBLIC_HOST}/calendar/notify`;
      const watch = await registerWatchChannel({
        accessToken,
        channelId: newId,
        channelSecret: newSecret,
        webhookUrl: watchUrl,
      });

      // Update KV first (so notifications routed to the new channel id find
      // the tenant), then DO state.
      await setChannelTenant(env.CALENDAR_ROUTING, newId, slug);
      await setGoogleState(stub, slug, {
        google_channel_id: newId,
        google_channel_secret: newSecret,
        google_channel_resource_id: watch.resourceId,
        google_channel_expiration_ms: watch.expirationMs,
      });

      // Stop the old channel + remove its KV entry — best-effort.
      if (gs.google_channel_id && gs.google_channel_resource_id) {
        try {
          await stopChannel({
            accessToken,
            channelId: gs.google_channel_id,
            resourceId: gs.google_channel_resource_id,
          });
        } catch (err) {
          console.error(`[reconcile] stop old channel failed:`, err);
        }
        try {
          await removeChannel(env.CALENDAR_ROUTING, gs.google_channel_id);
        } catch (err) {
          console.error(`[reconcile] kv remove old failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[reconcile] channel renewal failed tenant=${slug}:`, err);
    }
  }

  // ---- 2. Missed-dispatch reconcile ------------------------------------
  try {
    const sql = neon(cfg.database_url);
    const cutoff = new Date(now - 60_000).toISOString();
    const rows = (await sql`
      SELECT google_event_id, title, start_time, end_time, meeting_url
      FROM calendar_events
      WHERE status = 'scheduled'
        AND dispatched_at IS NULL
        AND meeting_url IS NOT NULL
        AND start_time < ${cutoff}
        AND start_time > ${new Date(now - 30 * 60_000).toISOString()}
      LIMIT 100
    `) as Array<{
      google_event_id: string;
      title: string;
      start_time: string;
      end_time: string;
      meeting_url: string;
    }>;

    for (const row of rows) {
      const startMs = Date.parse(row.start_time);
      const endMs = Date.parse(row.end_time);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      try {
        await upsertMeetingDO(env.MEETING_DO, {
          tenant_slug: slug,
          google_event_id: row.google_event_id,
          start_time_ms: startMs,
          end_time_ms: endMs,
          title: row.title,
          meeting_url: row.meeting_url,
        });
        console.log(
          `[reconcile] missed-dispatch retry tenant=${slug} event=${row.google_event_id}`,
        );
      } catch (err) {
        console.error(
          `[reconcile] missed-dispatch upsert failed event=${row.google_event_id}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error(`[reconcile] missed-dispatch query failed:`, err);
  }
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? "0" + h : h;
  }
  return out;
}
