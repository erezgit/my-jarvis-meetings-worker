import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import type { Env, PlayBody } from "../lib/types";
import { fetchTenantConfig, getTenantStub } from "../do";
import { vexaSpeak } from "../lib/vexa-bot";

/**
 * POST /meeting/play
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Body: { bot_id, b64_audio, kind?, platform, native_meeting_id }
 *
 * Forwards to `POST /bots/<platform>/<native_meeting_id>/speak` on the
 * tenant's Vexa instance with X-API-Key. `bot_id` is logged but not used in
 * addressing — Vexa keys speak by (platform, native_meeting_id). Vexa's
 * response is propagated verbatim.
 */
export async function handleMeetingPlay(
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

  let body: PlayBody;
  try {
    body = (await request.json()) as PlayBody;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  if (typeof body?.bot_id !== "string" || body.bot_id.length === 0) {
    return json({ ok: false, error: "bot_id required" }, 400);
  }
  if (typeof body?.b64_audio !== "string" || body.b64_audio.length === 0) {
    return json({ ok: false, error: "b64_audio required" }, 400);
  }
  if (
    typeof body.platform !== "string" ||
    typeof body.native_meeting_id !== "string"
  ) {
    return json(
      { ok: false, error: "platform and native_meeting_id required" },
      400,
    );
  }

  const vexaUrl = cfg.vexa_api_url || env.VEXA_API_URL;
  const vexaKey = cfg.vexa_api_key || env.VEXA_API_KEY;
  if (!vexaUrl || vexaUrl.length === 0) {
    return json({ ok: false, error: "vexa_api_url not configured (cfg or env)" }, 500);
  }
  if (!vexaKey || vexaKey.length === 0) {
    return json({ ok: false, error: "vexa_api_key not configured (cfg or env)" }, 500);
  }

  // Vexa speak default is PCM 24 kHz mono WAV.
  const format = body.kind ?? "wav";

  const r = await vexaSpeak({
    apiUrl: vexaUrl,
    apiKey: vexaKey,
    platform: body.platform,
    nativeMeetingId: body.native_meeting_id,
    audioBase64: body.b64_audio,
    format,
  });

  console.log(
    `[meeting/play] slug=${slug} bot=${body.bot_id} platform=${body.platform} status=${r.status}`,
  );
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": r.contentType },
  });
}
