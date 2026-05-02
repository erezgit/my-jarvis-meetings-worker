import {
  json,
  readBearer,
  readTenantHeader,
  tenantKeyMatches,
} from "../lib/auth";
import type { Env, VexaTranscriptBody } from "../lib/types";
import { fetchTenantConfig, getTenantStub, insertTranscriptViaDO } from "../do";
import { adaptVexaSegment } from "../lib/vexa-transcript-adapter";
import { findBotIdByNativeMeetingId } from "../lib/neon";

/**
 * POST /vexa/transcript
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Called by the small relay process running alongside Vexa on the bot host.
 * The relay subscribes to `wss://vexa-host/ws` and POSTs each segment here
 * (transcripts cannot be delivered to a stateless Worker via WebSocket
 * directly — see PRD R4 in MEMORY/WORK/20260501-203000_recall-vexa-whisper-swap).
 *
 * Request body (`VexaTranscriptBody`):
 *   {
 *     bot_id: string,                    // our internal meetings.bot_id
 *     segment: { text, speaker, absolute_start_time, absolute_end_time, ... },
 *     meeting_start_iso?: string         // anchor for relative-seconds math
 *   }
 *
 * Response: `{ ok: true, inserted: boolean }` — same shape as
 * /recall/webhook so dashboards/observers can treat both providers
 * identically.
 */
export async function handleVexaTranscript(
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

  let body: VexaTranscriptBody;
  try {
    body = (await request.json()) as VexaTranscriptBody;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  if (!body?.segment || typeof body.segment !== "object") {
    return json({ ok: false, error: "segment required" }, 400);
  }

  // Resolve bot_id — either from the body directly (relay tracks it) or by
  // looking up against `meetings.meeting_url` using Vexa's native id.
  let botId: string | null =
    typeof body.bot_id === "string" && body.bot_id.length > 0
      ? body.bot_id
      : null;

  if (!botId) {
    if (typeof body.native_meeting_id !== "string" || body.native_meeting_id.length === 0) {
      return json(
        { ok: false, error: "bot_id or native_meeting_id required" },
        400,
      );
    }
    botId = await findBotIdByNativeMeetingId(
      cfg.database_url,
      body.native_meeting_id,
    );
    if (!botId) {
      // No meeting row yet — a transcript arrived before we persisted the
      // bot. Drop it (Vexa's own DB still has the master copy via the
      // /transcripts pull endpoint if we ever need to backfill).
      console.log(
        `[vexa/transcript] no meeting row slug=${slug} native=${body.native_meeting_id} — dropped`,
      );
      return json({ ok: true, inserted: false, skipped: "no meeting row" });
    }
  }

  // Adapt Vexa shape → our existing TranscriptSegment shape so the rest of
  // the pipeline (DO insert, Neon row, dashboard) stays unchanged.
  const seg = adaptVexaSegment(body.segment, {
    botId,
    meetingStartIso: body.meeting_start_iso ?? null,
    eventType: "transcript.mutable",
  });

  // Skip empty-text frames — Vexa emits partial mutables that may be empty
  // mid-utterance, and we'd rather not pollute the transcript table.
  if (seg.words.length === 0) {
    return json({ ok: true, inserted: false, skipped: "empty text" });
  }

  let inserted = false;
  try {
    inserted = await insertTranscriptViaDO(stub, slug, seg);
  } catch (err) {
    console.error(
      `[vexa/transcript] insert failed slug=${slug} bot=${botId}:`,
      err,
    );
    // Mirror /recall/webhook behavior — return 200 with error in body so
    // the relay doesn't hammer us; the error is in `wrangler tail`.
    return json({ ok: true, inserted: false, error: "db insert failed" });
  }

  if (!inserted) {
    console.log(
      `[vexa/transcript] no meeting row slug=${slug} bot=${botId} — segment dropped`,
    );
  }

  return json({ ok: true, inserted });
}
