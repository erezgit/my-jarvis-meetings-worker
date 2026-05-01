import type { ExecutionContext } from "@cloudflare/workers-types";
import { json } from "../lib/auth";
import {
  buildAuthUrl,
  decodeIdTokenEmail,
  exchangeCode,
  refreshAccessToken,
} from "../lib/google-oauth";
import {
  listEventsPage,
  normaliseEvent,
  registerWatchChannel,
} from "../lib/google-calendar";
import type { RawCalendarEvent } from "../lib/google-calendar";
import { setChannelTenant } from "../lib/kv-routing";
import { upsertMeetingDO } from "../do-meeting";
import {
  fetchTenantConfig,
  getTenantStub,
  setGoogleState,
} from "../do";
import { neon } from "@neondatabase/serverless";
import type { Env, NormalisedCalendarEvent } from "../lib/types";

/* --------------------------------------------------------------------------
 * GET/POST /calendar/oauth/start?tenant=<slug>&return=<dashboard-url>
 *
 * Public — no auth. The Google consent screen IS the auth.
 * Returns 302 → Google. After consent Google redirects to /calendar/oauth/callback.
 *
 * The `state` param is base64url(JSON{tenant, return, csrf}). CSRF is stored
 * in KV (CALENDAR_ROUTING under prefix "csrf:") with TTL 600s.
 * ------------------------------------------------------------------------ */
export async function handleOAuthStart(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const tenant = (url.searchParams.get("tenant") ?? "").trim();
  if (!tenant) return json({ ok: false, error: "tenant required" }, 400);

  // Verify the tenant exists (no point starting OAuth for an unknown tenant).
  const stub = getTenantStub(env.MEETING_TENANT, tenant);
  const cfg = await fetchTenantConfig(stub, tenant);
  if (!cfg) return json({ ok: false, error: "unknown tenant" }, 404);

  if (!env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID.length === 0) {
    return json({ ok: false, error: "GOOGLE_OAUTH_CLIENT_ID not configured" }, 500);
  }

  const returnUrl = (url.searchParams.get("return") ?? "").trim();
  const csrf = randomHex(16);

  // CSRF lives in CALENDAR_ROUTING under a separate prefix to keep namespaces
  // disjoint. 10 min TTL is plenty — typical OAuth consent is < 1 min.
  await env.CALENDAR_ROUTING.put(`csrf:${csrf}`, "1", {
    expirationTtl: 600,
  });

  const stateJson = JSON.stringify({ tenant, return: returnUrl, csrf });
  const state = b64UrlEncodeStr(stateJson);

  const redirectUri = `https://${env.WORKER_PUBLIC_HOST}/calendar/oauth/callback`;
  const authUrl = buildAuthUrl({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    redirectUri,
    state,
  });

  return Response.redirect(authUrl, 302);
}

/* --------------------------------------------------------------------------
 * GET /calendar/oauth/callback?code=&state=&error=
 *
 * Public — no auth. Validates CSRF from state, exchanges code, registers
 * watch channel, kicks off initial full sync.
 * ------------------------------------------------------------------------ */
export async function handleOAuthCallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const errParam = url.searchParams.get("error");
  if (errParam) {
    return new Response(
      `<h1>Calendar connect failed</h1><p>${escapeHtml(errParam)}</p>`,
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  const code = (url.searchParams.get("code") ?? "").trim();
  const stateParam = (url.searchParams.get("state") ?? "").trim();
  if (!code || !stateParam) {
    return json({ ok: false, error: "missing code or state" }, 400);
  }

  let parsedState: { tenant: string; return: string; csrf: string };
  try {
    parsedState = JSON.parse(b64UrlDecodeToStr(stateParam)) as {
      tenant: string;
      return: string;
      csrf: string;
    };
  } catch {
    return json({ ok: false, error: "invalid state" }, 400);
  }
  const { tenant, return: returnUrl, csrf } = parsedState;
  if (!tenant || !csrf) {
    return json({ ok: false, error: "malformed state" }, 400);
  }

  // CSRF: must exist (set by /oauth/start) and we delete on read.
  const csrfKey = `csrf:${csrf}`;
  const csrfStored = await env.CALENDAR_ROUTING.get(csrfKey);
  if (!csrfStored) {
    return json({ ok: false, error: "csrf mismatch" }, 400);
  }
  await env.CALENDAR_ROUTING.delete(csrfKey);

  const tenantStub = getTenantStub(env.MEETING_TENANT, tenant);
  const cfg = await fetchTenantConfig(tenantStub, tenant);
  if (!cfg) return json({ ok: false, error: "unknown tenant" }, 404);

  const redirectUri = `https://${env.WORKER_PUBLIC_HOST}/calendar/oauth/callback`;

  // 1) Exchange code → tokens.
  const tokens = await exchangeCode({
    code,
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri,
  });

  const email = tokens.id_token ? decodeIdTokenEmail(tokens.id_token) : null;

  // 2) Generate channel id + secret. Channel ids must be unique across our
  // Google project; tenant slug + short uuid is plenty.
  const shortId = randomHex(6);
  const channelId = `ch-${tenant}-${shortId}`;
  const channelSecret = randomHex(32);

  const watchUrl = `https://${env.WORKER_PUBLIC_HOST}/calendar/notify`;
  const watch = await registerWatchChannel({
    accessToken: tokens.access_token,
    channelId,
    channelSecret,
    webhookUrl: watchUrl,
    ttlSeconds: 604800,
  });

  // 3) Persist Google state into the tenant DO. Order matters: KV BEFORE DO,
  // so that the inevitable "sync" push from Google (which arrives within
  // seconds) can find the tenant. The DO write commits the rest atomically.
  await setChannelTenant(env.CALENDAR_ROUTING, channelId, tenant);

  // 4) Initial full sync — paginate until nextSyncToken arrives. We do this
  // BEFORE storing the sync token so the token we persist actually represents
  // the state of the calendar after the full walk.
  const fullSync = await runFullSync({
    accessToken: tokens.access_token,
  });

  await setGoogleState(tenantStub, tenant, {
    google_refresh_token: tokens.refresh_token,
    google_oauth_email: email ?? undefined,
    google_channel_id: channelId,
    google_channel_secret: channelSecret,
    google_channel_resource_id: watch.resourceId,
    google_channel_expiration_ms: watch.expirationMs,
    google_sync_token: fullSync.nextSyncToken ?? undefined,
  });

  // 5) Spawn MeetingDOs for every event with a meeting URL. Best-effort —
  // any individual failure is logged and skipped; the reconcile cron will
  // catch any miss.
  ctx.waitUntil(
    Promise.all(
      fullSync.normalised
        .filter((ev) => ev.status !== "cancelled" && ev.meeting_url)
        .map(async (ev) => {
          try {
            await upsertMeetingDO(env.MEETING_DO, {
              tenant_slug: tenant,
              google_event_id: ev.google_event_id,
              start_time_ms: ev.start_time_ms,
              end_time_ms: ev.end_time_ms,
              title: ev.title,
              meeting_url: ev.meeting_url ?? "",
            });
            await persistCalendarEvent(cfg.database_url, tenant, ev);
          } catch (err) {
            console.error(
              `[oauth/callback] failed to schedule event=${ev.google_event_id}:`,
              err,
            );
          }
        }),
    ),
  );

  // 6) Redirect back to the dashboard if a return URL was provided.
  if (returnUrl) {
    let target: URL;
    try {
      target = new URL(returnUrl);
    } catch {
      return json({ ok: true, connected: true, email });
    }
    target.searchParams.set("connected", "1");
    if (email) target.searchParams.set("email", email);
    return Response.redirect(target.toString(), 302);
  }
  return json({ ok: true, connected: true, email });
}

/* --------------------------------------------------------------------------
 * Helpers used here + by /calendar/notify (re-exported)
 * ------------------------------------------------------------------------ */

export interface FullSyncResult {
  normalised: NormalisedCalendarEvent[];
  nextSyncToken: string | null;
  pages: number;
}

/** Walk events.list with pagination until we get a nextSyncToken. */
export async function runFullSync(opts: {
  accessToken: string;
}): Promise<FullSyncResult> {
  const out: NormalisedCalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let pages = 0;
  // Hard cap to prevent runaway loops.
  for (let i = 0; i < 50; i++) {
    pages++;
    const r = await listEventsPage({
      accessToken: opts.accessToken,
      pageToken,
      maxResults: 250,
    });
    if (r.status === 410 || !r.page) {
      throw new Error(`runFullSync: events.list returned 410 — cannot proceed`);
    }
    for (const raw of r.page.events) {
      const n = normaliseEvent(raw as RawCalendarEvent);
      if (n) out.push(n);
    }
    if (r.page.nextPageToken) {
      pageToken = r.page.nextPageToken;
      continue;
    }
    nextSyncToken = r.page.nextSyncToken;
    break;
  }
  return { normalised: out, nextSyncToken, pages };
}

/** Mint a fresh access token from the stored refresh token. */
export async function getFreshAccessToken(opts: {
  env: Env;
  refreshToken: string;
}): Promise<string> {
  const r = await refreshAccessToken({
    refreshToken: opts.refreshToken,
    clientId: opts.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: opts.env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
  return r.access_token;
}

/**
 * UPSERT a normalised event into the tenant's `calendar_events` table.
 * Schema assumed in PRD migration 006:
 *   calendar_events(google_event_id UNIQUE, title, start_time, end_time,
 *                   meeting_url, status, raw, ...)
 */
export async function persistCalendarEvent(
  databaseUrl: string,
  _tenantSlug: string,
  ev: NormalisedCalendarEvent,
): Promise<void> {
  const sql = neon(databaseUrl);
  const startIso = new Date(ev.start_time_ms).toISOString();
  const endIso = new Date(ev.end_time_ms).toISOString();
  await sql`
    INSERT INTO calendar_events (
      google_event_id, title, start_time, end_time, meeting_url,
      status, raw, created_at, updated_at
    ) VALUES (
      ${ev.google_event_id},
      ${ev.title},
      ${startIso},
      ${endIso},
      ${ev.meeting_url},
      ${ev.status === "cancelled" ? "cancelled" : "scheduled"},
      ${JSON.stringify(ev.raw)}::jsonb,
      now(),
      now()
    )
    ON CONFLICT (google_event_id) DO UPDATE SET
      title = EXCLUDED.title,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      meeting_url = EXCLUDED.meeting_url,
      status = CASE
        WHEN calendar_events.status = 'dispatched' THEN calendar_events.status
        ELSE EXCLUDED.status
      END,
      raw = EXCLUDED.raw,
      updated_at = now()
  `;
}

/* --------------------------------------------------------------------------
 * Tiny utils
 * ------------------------------------------------------------------------ */

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

function b64UrlEncodeStr(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecodeToStr(s: string): string {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
