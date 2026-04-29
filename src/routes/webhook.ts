import { json } from "../lib/auth";
import { hmacSha256Hex, timingSafeEqualHex } from "../lib/hmac";
import type { Env, TranscriptSegment } from "../lib/types";
import {
  fetchTenantConfig,
  getTenantStub,
  insertTranscriptViaDO,
} from "../do";

/**
 * POST /recall/webhook?tenant=<slug>&sig=<hmac>
 *
 * Public — no bearer. Authenticated by HMAC-SHA256 over the slug using the
 * tenant's `recall_webhook_secret`.
 *
 * Recall's realtime payload (transcript.data / transcript.partial_data):
 *   {
 *     event: "transcript.data" | "transcript.partial_data",
 *     data: {
 *       bot:        { id: string },
 *       transcript: {
 *         words:    Array<{ text, start_time, end_time, ... }>,
 *         speaker?: { name?, id?, is_host? }
 *       },
 *       recording: { ... }
 *     }
 *   }
 *
 * We persist the words array verbatim — this Worker is a transport; the
 * dashboard owns rendering. Note: the *old* base joined words into a string
 * before insert; that's lossy and we're not doing it.
 */
export async function handleRecallWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("tenant") ?? "").trim();
  const sig = (url.searchParams.get("sig") ?? "").trim();
  if (!slug || !sig) {
    return json({ ok: false, error: "missing tenant or sig" }, 400);
  }

  const stub = getTenantStub(env.MEETING_TENANT, slug);
  const cfg = await fetchTenantConfig(stub, slug);
  if (!cfg) return json({ ok: false, error: "unknown tenant" }, 404);

  const expected = await hmacSha256Hex(cfg.recall_webhook_secret, slug);
  if (!timingSafeEqualHex(expected, sig)) {
    console.warn(`[recall/webhook] bad sig slug=${slug}`);
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: RecallWebhookPayload;
  try {
    payload = (await request.json()) as RecallWebhookPayload;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  const eventType = typeof payload?.event === "string" ? payload.event : "";
  const data = (payload?.data ?? {}) as RecallWebhookData;
  const botId = data?.bot?.id;
  if (typeof botId !== "string" || botId.length === 0) {
    console.warn(
      `[recall/webhook] missing bot_id slug=${slug} event=${eventType}`,
    );
    // Still 200 — telling Recall to retry won't fix a malformed payload.
    return json({ ok: true, skipped: "no bot_id" });
  }

  const transcript = data.transcript ?? {};
  const words = Array.isArray(transcript.words) ? transcript.words : [];
  const speaker = transcript.speaker ?? {};

  // Recall sends start/end on each word; surface the segment span.
  const startTs = numericOrNull(words[0]?.start_time);
  const endTs = numericOrNull(words[words.length - 1]?.end_time);

  // Join words into a single text line — matches the meeting_transcript.words
  // TEXT column. The full structured payload still lives in `raw` (jsonb).
  const wordsText = words
    .map((w) => (typeof w.text === "string" ? w.text : ""))
    .filter((s) => s.length > 0)
    .join(" ")
    .trim();

  const seg: TranscriptSegment = {
    bot_id: botId,
    speaker_name: typeof speaker.name === "string" ? speaker.name : null,
    speaker_id:
      typeof speaker.id === "string" || typeof speaker.id === "number"
        ? String(speaker.id)
        : null,
    is_host: typeof speaker.is_host === "boolean" ? speaker.is_host : null,
    words: wordsText,
    start_ts: startTs,
    end_ts: endTs,
    event_type: eventType,
    raw: payload,
  };

  let inserted = false;
  try {
    inserted = await insertTranscriptViaDO(stub, slug, seg);
  } catch (err) {
    console.error(
      `[recall/webhook] insert failed slug=${slug} bot=${botId}:`,
      err,
    );
    // Still 200 — Recall retries hammer us and we want a single source of
    // truth in `wrangler tail`. The error has already been logged.
    return json({ ok: true, inserted: false, error: "db insert failed" });
  }

  if (!inserted) {
    console.log(
      `[recall/webhook] no meeting row slug=${slug} bot=${botId} — segment dropped`,
    );
  }

  return json({ ok: true, inserted });
}

/* ----- payload shape (best-effort, defensive on the rest) -------------- */

interface RecallWebhookPayload {
  event?: string;
  data?: RecallWebhookData;
}

interface RecallWebhookData {
  bot?: { id?: string };
  transcript?: {
    words?: Array<{ text?: string; start_time?: unknown; end_time?: unknown }>;
    speaker?: { name?: string; id?: string | number; is_host?: boolean };
  };
  recording?: unknown;
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
