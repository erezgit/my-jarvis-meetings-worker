import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import type { BotStartBody, Env } from "../lib/types";
import { fetchTenantConfig, getTenantStub } from "../do";
import { createVexaBot, parseVexaMeetingUrl } from "../lib/vexa-bot";
import { startVexaPollingForBot } from "../do-meeting";

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

  let out;
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
  } catch (err) {
    console.error(
      `[meeting/bot] slug=${slug} create failed:`,
      err instanceof Error ? err.message : err,
    );
    return json(
      { ok: false, error: err instanceof Error ? err.message : "vexa create failed" },
      502,
    );
  }
  console.log(
    `[meeting/bot] slug=${slug} platform=${parsed.platform} native_id=${parsed.nativeMeetingId} bot=${out.bot_id}`,
  );

  // Spin up a MeetingDO that polls Vexa for transcripts and mirrors them into
  // Neon. Failure to arm polling is logged but not fatal — bot creation
  // already succeeded.
  try {
    await startVexaPollingForBot(env.MEETING_DO, {
      tenant_slug: slug,
      bot_id: out.bot_id,
      meeting_url: body.meeting_url,
      platform: parsed.platform,
      native_meeting_id: parsed.nativeMeetingId,
      title: typeof body.title === "string" ? body.title : undefined,
    });
  } catch (err) {
    console.error(
      `[meeting/bot] start-polling failed slug=${slug} bot=${out.bot_id}:`,
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
