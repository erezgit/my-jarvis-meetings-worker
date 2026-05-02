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
 * POST /recall/play
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Body: { bot_id, b64_audio, kind?, platform?, native_meeting_id? }
 *
 * Provider routing:
 *   - tenant.bot_provider === "recall" (default): forwards to
 *     `POST /api/v1/bot/<bot_id>/output_audio/` with RECALL_API_KEY.
 *   - tenant.bot_provider === "vexa": forwards to
 *     `POST /bots/<platform>/<native_meeting_id>/speak` on the Vexa instance
 *     with X-API-Key. `platform` and `native_meeting_id` MUST be supplied
 *     in the request body — the dashboard knows them from the meetings row.
 *
 * Provider response is propagated verbatim.
 */
export async function handleRecallPlay(
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

  const provider: "recall" | "vexa" = cfg.bot_provider ?? "recall";

  if (provider === "vexa") {
    if (!env.VEXA_API_URL || env.VEXA_API_URL.length === 0) {
      return json(
        { ok: false, error: "VEXA_API_URL not configured on this worker" },
        500,
      );
    }
    if (!env.VEXA_API_KEY || env.VEXA_API_KEY.length === 0) {
      return json(
        { ok: false, error: "VEXA_API_KEY not configured on this worker" },
        500,
      );
    }
    if (
      typeof body.platform !== "string" ||
      typeof body.native_meeting_id !== "string"
    ) {
      return json(
        {
          ok: false,
          error:
            "platform and native_meeting_id required when tenant bot_provider=vexa",
        },
        400,
      );
    }

    // Vexa speak default is PCM 24 kHz mono WAV. The kind field on the
    // legacy Recall body is reused as the format hint when present;
    // otherwise default to "wav" which matches Vexa docs.
    const format =
      body.kind === "mp3" || body.kind === "pcm" || body.kind === "opus"
        ? body.kind
        : "wav";

    const r = await vexaSpeak({
      apiUrl: env.VEXA_API_URL,
      apiKey: env.VEXA_API_KEY,
      platform: body.platform as "google_meet" | "zoom" | "teams",
      nativeMeetingId: body.native_meeting_id,
      audioBase64: body.b64_audio,
      format,
    });

    console.log(
      `[play.vexa] slug=${slug} bot=${body.bot_id} platform=${body.platform} status=${r.status}`,
    );
    return new Response(r.body, {
      status: r.status,
      headers: { "Content-Type": r.contentType },
    });
  }

  // Recall path — unchanged from pre-pivot. Kept verbatim for parallel-run.
  const kind = typeof body.kind === "string" && body.kind.length > 0 ? body.kind : "mp3";
  const url = `https://eu-central-1.recall.ai/api/v1/bot/${encodeURIComponent(body.bot_id)}/output_audio/`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${env.RECALL_API_KEY}`,
    },
    body: JSON.stringify({ kind, b64_data: body.b64_audio }),
  });

  const text = await r.text();
  console.log(
    `[recall/play] slug=${slug} bot=${body.bot_id} kind=${kind} status=${r.status}`,
  );
  return new Response(text, {
    status: r.status,
    headers: {
      "Content-Type":
        r.headers.get("Content-Type") ?? "application/json",
    },
  });
}
