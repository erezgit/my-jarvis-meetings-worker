import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import type { Env, LeaveBody } from "../lib/types";
import { fetchTenantConfig, getTenantStub } from "../do";

/**
 * POST /recall/leave
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Body: { bot_id }
 *
 * Forwards to `POST /api/v1/bot/<bot_id>/leave_call/`. Recall's response is
 * propagated verbatim.
 */
export async function handleRecallLeave(
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

  const url = `https://eu-central-1.recall.ai/api/v1/bot/${encodeURIComponent(body.bot_id)}/leave_call/`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${env.RECALL_API_KEY}`,
    },
  });

  const text = await r.text();
  console.log(
    `[recall/leave] slug=${slug} bot=${body.bot_id} status=${r.status}`,
  );
  return new Response(text, {
    status: r.status,
    headers: {
      "Content-Type":
        r.headers.get("Content-Type") ?? "application/json",
    },
  });
}
