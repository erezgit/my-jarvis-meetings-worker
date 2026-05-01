/**
 * Shared constants + Recall bot dispatch helper.
 *
 * Lives here (not in routes/bot.ts) so MeetingDO.alarm() can call Recall
 * without importing a route handler.
 */

/** Shortest valid silent MP3 — copied verbatim from old my-jarvis-base.
 * Recall requires *some* audio config at bot-creation time for the
 * /output_audio/ endpoint to be enabled later. */
export const SILENT_MP3_B64 =
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwBHAAAAAAD/+1DEAAAB8ANoAAAAIAAANIAAAAQAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7UMQfAAPAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

export const RECALL_BOT_URL = "https://eu-central-1.recall.ai/api/v1/bot/";

export interface RecallBotCreateOpts {
  apiKey: string;
  meetingUrl: string;
  /** Public webhook URL with `?tenant=&sig=` for transcript routing. */
  webhookUrl: string;
  /** Deepgram language. Defaults to "he". */
  language?: string;
  /** Recall metadata — echoed back on bot webhook events for routing. */
  metadata?: Record<string, string>;
  /** Stable idempotency key — Recall dedupes duplicate bot creations. */
  dedupeKey?: string;
}

export interface RecallBotCreateResult {
  bot_id: string;
  raw: unknown;
}

/** Create a Recall bot. Throws on non-2xx. */
export async function createRecallBot(
  opts: RecallBotCreateOpts,
): Promise<RecallBotCreateResult> {
  const language = opts.language && opts.language.length > 0 ? opts.language : "he";
  const body: Record<string, unknown> = {
    meeting_url: opts.meetingUrl,
    bot_name: "Jarvis",
    recording_config: {
      transcript: {
        provider: { deepgram_streaming: { model: "nova-3", language } },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: opts.webhookUrl,
          events: ["transcript.data"],
        },
      ],
    },
    automatic_audio_output: {
      in_call_recording: {
        data: { kind: "mp3", b64_data: SILENT_MP3_B64 },
      },
    },
  };
  if (opts.metadata) body.metadata = opts.metadata;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Token ${opts.apiKey}`,
  };
  if (opts.dedupeKey) {
    // Recall accepts an Idempotency-Key header on bot creation; duplicate
    // posts with the same key are no-ops.
    headers["Idempotency-Key"] = opts.dedupeKey;
  }

  const r = await fetch(RECALL_BOT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Recall bot create failed ${r.status}: ${text}`);
  }
  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Recall bot create returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (typeof parsed.id !== "string") {
    throw new Error(`Recall bot create response missing id: ${text.slice(0, 200)}`);
  }
  return { bot_id: parsed.id, raw: parsed };
}

/** Tell Recall to leave a call. Idempotent on Recall side; 404 is fine. */
export async function recallBotLeave(opts: {
  apiKey: string;
  botId: string;
}): Promise<void> {
  const url = `https://eu-central-1.recall.ai/api/v1/bot/${encodeURIComponent(
    opts.botId,
  )}/leave_call/`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${opts.apiKey}` },
  });
  if (!r.ok && r.status !== 404) {
    const text = await r.text();
    throw new Error(`Recall leave failed ${r.status}: ${text}`);
  }
}
