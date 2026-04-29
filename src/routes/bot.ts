import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import { hmacSha256Hex } from "../lib/hmac";
import type { BotStartBody, Env } from "../lib/types";
import { fetchTenantConfig, getTenantStub } from "../do";

const RECALL_BOT_URL = "https://eu-central-1.recall.ai/api/v1/bot/";

/**
 * POST /recall/bot
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Body: { meeting_url, title?, meeting_id? }
 *
 * Starts a Recall bot for the tenant. The realtime webhook URL we hand to
 * Recall is signed with the tenant's HMAC secret over the slug — Recall will
 * call back with that exact querystring and we re-verify on inbound.
 */
export async function handleRecallBot(
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

  // Sign the slug, attach as querystring on the webhook URL we hand Recall.
  const sig = await hmacSha256Hex(cfg.recall_webhook_secret, slug);
  const webhookUrl =
    `https://${env.WORKER_PUBLIC_HOST}/recall/webhook` +
    `?tenant=${encodeURIComponent(slug)}&sig=${sig}`;

  const recallBody = {
    meeting_url: body.meeting_url,
    bot_name: "Jarvis",
    recording_config: {
      transcript: {
        provider: {
          deepgram_streaming: { model: "nova-3", language: "en" },
        },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: webhookUrl,
          events: ["transcript.data", "transcript.partial_data"],
        },
      ],
    },
  };

  const r = await fetch(RECALL_BOT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${env.RECALL_API_KEY}`,
    },
    body: JSON.stringify(recallBody),
  });

  // Propagate Recall errors verbatim — the caller knows their domain.
  const text = await r.text();
  console.log(`[recall/bot] slug=${slug} status=${r.status}`);
  return new Response(text, {
    status: r.status,
    headers: {
      "Content-Type":
        r.headers.get("Content-Type") ?? "application/json",
    },
  });
}
