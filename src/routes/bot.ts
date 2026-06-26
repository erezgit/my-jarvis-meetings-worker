import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import type { BotStartBody, Env } from "../lib/types";
import {
  clearActiveMeeting,
  fetchTenantConfig,
  getActiveMeeting,
  getTenantStub,
  setActiveMeeting,
} from "../do";
import {
  createVexaBot,
  parseVexaMeetingUrl,
  vexaBotLeave,
} from "../lib/vexa-bot";
import { cancelMeetingDO, startVexaPollingForBot } from "../do-meeting";
import { markMeetingEnded } from "../lib/meeting-persistence";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /meeting/bot
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Body: { meeting_url, title?, meeting_id?, language?, passcode? }
 *
 * Detects platform from the meeting URL (Meet, Zoom, Teams), extracts the
 * Zoom passcode from `?pwd=` if present, then dispatches a Vexa bot on the
 * tenant's Vexa instance and arms a MeetingDO transcript-polling loop.
 */
export async function handleMeetingBot(
  request: Request,
  env: Env,
): Promise<Response> {
  const slug = readTenantHeader(request);
  const bearer = readBearer(request);
  if (!slug || !bearer) {
    return json({ ok: false, error: "missing auth" }, 401);
  }

  const stub = getTenantStub(env.MEETING_TENANT, slug);
  const cfg = await fetchTenantConfig(stub, slug);
  if (!cfg) return json({ ok: false, error: "unknown tenant" }, 404);
  if (!tenantKeyMatches(bearer, cfg)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: BotStartBody;
  try {
    body = (await request.json()) as BotStartBody;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  if (typeof body?.meeting_url !== "string" || body.meeting_url.length === 0) {
    return json({ ok: false, error: "meeting_url required" }, 400);
  }

  // Per-tenant Vexa config takes precedence; falls back to worker env for
  // tenants that haven't migrated to per-tenant Fly Vexa apps yet.
  const vexaUrl = cfg.vexa_api_url || env.VEXA_API_URL;
  const vexaKey = cfg.vexa_api_key || env.VEXA_API_KEY;
  if (!vexaUrl || vexaUrl.length === 0) {
    return json({ ok: false, error: "vexa_api_url not configured (cfg or env)" }, 500);
  }
  if (!vexaKey || vexaKey.length === 0) {
    return json({ ok: false, error: "vexa_api_key not configured (cfg or env)" }, 500);
  }

  let parsed;
  try {
    parsed = parseVexaMeetingUrl(body.meeting_url);
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : "unsupported meeting URL" },
      400,
    );
  }

  const language =
    typeof body?.language === "string" && body.language.length > 0
      ? body.language
      : "he";

  // Passcode resolution: URL-embedded `?pwd=` wins over the body field, since
  // a passcode baked into the share-link is the meeting host's authoritative
  // copy. Body field is the fallback when the user pastes a bare URL.
  const passcode =
    parsed.passcode ??
    (typeof body.passcode === "string" && body.passcode.length > 0
      ? body.passcode
      : undefined);

  // ONE BOT AT A TIME per tenant. The per-tenant Vexa instance allows a single
  // concurrent bot, and Vexa keys a meeting by its URL — so before starting a
  // new meeting we tear down the previous active one: leave its Vexa bot (frees
  // the slot), cancel its MeetingDO (stops the transcript poller), and mark its
  // Neon row ended. This is what makes start → stop the agent → start again on
  // any link reliably work, and prevents stale pollers stacking up (the 429
  // flood). Best-effort: failures here are logged, not fatal.
  try {
    const prev = await getActiveMeeting(stub, slug);
    if (prev && prev.bot_id !== "") {
      console.log(
        `[meeting/bot] slug=${slug} superseding previous bot=${prev.bot_id} (${prev.platform}/${prev.native_meeting_id})`,
      );
      try {
        await vexaBotLeave({
          apiUrl: vexaUrl,
          apiKey: vexaKey,
          platform: prev.platform,
          nativeMeetingId: prev.native_meeting_id,
        });
      } catch (err) {
        console.error(
          `[meeting/bot] supersede leave failed bot=${prev.bot_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      try {
        await cancelMeetingDO(env.MEETING_DO, slug, prev.event_id);
      } catch (err) {
        console.error(
          `[meeting/bot] supersede cancel-do failed bot=${prev.bot_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      try {
        await markMeetingEnded({
          databaseUrl: cfg.database_url,
          meetingId: prev.meeting_id_neon,
          botId: prev.bot_id,
        });
      } catch (err) {
        console.error(
          `[meeting/bot] supersede mark-ended failed bot=${prev.bot_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      try {
        await clearActiveMeeting(stub, slug, prev.bot_id);
      } catch (err) {
        console.error(
          `[meeting/bot] supersede clear-active failed bot=${prev.bot_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.error(
      `[meeting/bot] supersede step errored slug=${slug}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Create the bot, retrying on transient failure. The single concurrency slot
  // can take a moment to free after the supersede leave above, so a first
  // attempt may hit Vexa's "bot already running" / 5xx — retry with backoff
  // rather than surfacing a 502 to the user.
  let out;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      out = await createVexaBot({
        apiUrl: vexaUrl,
        apiKey: vexaKey,
        platform: parsed.platform,
        nativeMeetingId: parsed.nativeMeetingId,
        passcode,
        language,
        task: "transcribe",
        botName: "Jarvis",
      });
      break;
    } catch (err) {
      lastErr = err;
      console.error(
        `[meeting/bot] slug=${slug} create attempt ${attempt}/3 failed:`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < 3) await sleep(2500);
    }
  }
  if (!out) {
    return json(
      {
        ok: false,
        error:
          lastErr instanceof Error
            ? lastErr.message
            : "vexa create failed after retries",
      },
      502,
    );
  }
  console.log(
    `[meeting/bot] slug=${slug} platform=${parsed.platform} native_id=${parsed.nativeMeetingId} bot=${out.bot_id}`,
  );

  // Spin up a MeetingDO that polls Vexa for transcripts and mirrors them into
  // Neon. Failure to arm polling is logged but not fatal — bot creation
  // already succeeded.
  const meetingIdRaw =
    body.meeting_id != null && `${body.meeting_id}`.length > 0
      ? Number(body.meeting_id)
      : NaN;
  const meetingIdNeon = Number.isFinite(meetingIdRaw) ? meetingIdRaw : null;
  try {
    await startVexaPollingForBot(env.MEETING_DO, {
      tenant_slug: slug,
      bot_id: out.bot_id,
      meeting_url: body.meeting_url,
      platform: parsed.platform,
      native_meeting_id: parsed.nativeMeetingId,
      meeting_id_neon: meetingIdNeon,
      title: typeof body.title === "string" ? body.title : undefined,
    });
  } catch (err) {
    console.error(
      `[meeting/bot] start-polling failed slug=${slug} bot=${out.bot_id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Record this as the tenant's active meeting so the NEXT start supersedes it.
  try {
    await setActiveMeeting(stub, slug, {
      event_id: `manual-${out.bot_id}`,
      bot_id: out.bot_id,
      platform: parsed.platform,
      native_meeting_id: parsed.nativeMeetingId,
      meeting_id_neon: meetingIdNeon,
    });
  } catch (err) {
    console.error(
      `[meeting/bot] set-active-meeting failed slug=${slug} bot=${out.bot_id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return json({
    bot_id: out.bot_id,
    platform: parsed.platform,
    native_meeting_id: parsed.nativeMeetingId,
    raw: out.raw,
  });
}
