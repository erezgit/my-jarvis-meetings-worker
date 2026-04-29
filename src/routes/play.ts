import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import type { Env, PlayBody } from "../lib/types";
import { fetchTenantConfig, getTenantStub } from "../do";

/**
 * POST /recall/play
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Body: { bot_id, b64_audio, kind? }   kind defaults to "mp3"
 *
 * Forwards to `POST /api/v1/bot/<bot_id>/output_audio/` with the platform-
 * wide RECALL_API_KEY. Recall's response is propagated verbatim.
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
