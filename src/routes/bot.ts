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

  // Deepgram model + language. Default to nova-3 + Hebrew — same combo the
  // old my-jarvis-base used; verified to work for Hebrew transcription.
  // (nova-2 + "he" did not produce transcript events in our last live test.)
  // Caller can override via body.language; model is fixed for now.
  const language =
    typeof body?.language === "string" && body.language.length > 0
      ? body.language
      : "he";

  const recallBody = {
    meeting_url: body.meeting_url,
    bot_name: "Jarvis",
    recording_config: {
      transcript: {
        provider: {
          deepgram_streaming: { model: "nova-3", language },
        },
      },
      // Only subscribe to `transcript.data` (finalised segments). The
      // `transcript.partial_data` event fires while a speaker is mid-utterance,
      // which would write duplicates as the words stream in. The dashboard
      // polls every 5 s — that's already "live enough" for v1.
      realtime_endpoints: [
        {
          type: "webhook",
          url: webhookUrl,
          events: ["transcript.data"],
        },
      ],
    },
    // Seed `automatic_audio_output` with a silent MP3 placeholder. Recall
    // requires *some* audio config at bot-creation time for the
    // /output_audio/ endpoint (used later to speak Jarvis's responses) to
    // be enabled. The b64 below is the shortest valid silent MP3 — copied
    // verbatim from the old my-jarvis-base.
    automatic_audio_output: {
      in_call_recording: {
        data: {
          kind: "mp3",
          b64_data:
            "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwBHAAAAAAD/+1DEAAAB8ANoAAAAIAAANIAAAAQAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7UMQfAAPAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
        },
      },
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

  const text = await r.text();
  console.log(`[recall/bot] slug=${slug} status=${r.status}`);

  // On success, normalise the Recall payload to a stable {bot_id, raw} shape
  // so dashboards don't depend on Recall's exact field names.
  // On error, propagate Recall's body verbatim — the caller knows their domain.
  if (r.status >= 200 && r.status < 300) {
    let recall: { id?: unknown };
    try {
      recall = JSON.parse(text);
    } catch {
      return json(
        { ok: false, error: "recall returned non-JSON success", raw: text.slice(0, 500) },
        502,
      );
    }
    const botId = typeof recall.id === "string" ? recall.id : null;
    if (!botId) {
      return json(
        { ok: false, error: "recall response missing id", raw: recall },
        502,
      );
    }
    return json({ bot_id: botId, raw: recall });
  }

  return new Response(text, {
    status: r.status,
    headers: {
      "Content-Type":
        r.headers.get("Content-Type") ?? "application/json",
    },
  });
}
