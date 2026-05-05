import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import type { Env, LeaveBody } from "../lib/types";
import { fetchTenantConfig, getTenantStub } from "../do";
import { vexaBotLeave, parseVexaMeetingUrl } from "../lib/vexa-bot";

/**
 * POST /meeting/leave
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Body: { bot_id, platform?, native_meeting_id?, meeting_url? }
 *
 * Vexa's stop endpoint is keyed by `(platform, native_meeting_id)` — not by
 * bot_id. Either supply them directly (the dashboard has them on the
 * meetings row) or supply `meeting_url` and the Worker parses them out.
 */
export async function handleMeetingLeave(
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

  let body: LeaveBody;
  try {
    body = (await request.json()) as LeaveBody;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  if (typeof body?.bot_id !== "string" || body.bot_id.length === 0) {
    return json({ ok: false, error: "bot_id required" }, 400);
  }

  const vexaUrl = cfg.vexa_api_url || env.VEXA_API_URL;
  const vexaKey = cfg.vexa_api_key || env.VEXA_API_KEY;
  if (!vexaUrl || !vexaKey) {
    return json({ ok: false, error: "vexa not configured (cfg or env)" }, 500);
  }

  // Resolve (platform, native_meeting_id). Prefer body, fall back to URL parse.
  let platform = body.platform;
  let nativeId = body.native_meeting_id;
  if ((!platform || !nativeId) && typeof body.meeting_url === "string") {
    try {
      const parsed = parseVexaMeetingUrl(body.meeting_url);
      platform = platform ?? parsed.platform;
      nativeId = nativeId ?? parsed.nativeMeetingId;
    } catch {
      /* fall through to error */
    }
  }
  if (!platform || !nativeId) {
    return json(
      {
        ok: false,
        error: "leave needs platform + native_meeting_id (or meeting_url)",
      },
      400,
    );
  }

  try {
    await vexaBotLeave({
      apiUrl: vexaUrl,
      apiKey: vexaKey,
      platform,
      nativeMeetingId: nativeId,
    });
  } catch (err) {
    console.error(
      `[meeting/leave] slug=${slug} bot=${body.bot_id}:`,
      err instanceof Error ? err.message : err,
    );
    return json(
      { ok: false, error: err instanceof Error ? err.message : "vexa leave failed" },
      502,
    );
  }
  console.log(
    `[meeting/leave] slug=${slug} bot=${body.bot_id} platform=${platform} native=${nativeId} stopped`,
  );
  return json({ ok: true });
}
