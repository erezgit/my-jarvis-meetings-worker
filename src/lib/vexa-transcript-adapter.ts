/**
 * Convert Vexa's WebSocket / relay transcript shape into our existing
 * TranscriptSegment shape so `insertTranscriptSegment()` (and everything
 * downstream — the dashboard, the agent's silent/note/speak loop) keeps
 * working unchanged after the cutover.
 *
 * Vexa segment (per docs.vexa.ai/api/interactive-bots, transcript.mutable
 * frames on the WebSocket):
 *   {
 *     text: string,
 *     speaker: string | null,
 *     absolute_start_time: ISO8601 string,
 *     absolute_end_time:   ISO8601 string,
 *     updated_at: ISO8601 string,
 *     // platform/native_meeting_id come on the parent envelope
 *   }
 *
 * Existing TranscriptSegment shape (lib/types.ts) — what Recall webhook
 * delivers:
 *   {
 *     bot_id, speaker_name, speaker_id, is_host,
 *     words, start_ts (relative seconds), end_ts, event_type, raw
 *   }
 *
 * Mapping rationale:
 *   - bot_id          ← caller passes our internal bot_id (looked up from
 *                       (platform, native_meeting_id) → meetings row)
 *   - speaker_name    ← Vexa.speaker (Vexa returns a display name string)
 *   - speaker_id      ← null (Vexa doesn't expose a stable id; speaker name
 *                       is the only handle. Acceptable per existing schema
 *                       which already allows null.)
 *   - is_host         ← null (Vexa doesn't expose host flag; null is fine)
 *   - words           ← Vexa.text (already a joined string)
 *   - start_ts/end_ts ← absolute_start_time/end_time minus meeting start.
 *                       Caller supplies meetingStartIso for the subtraction.
 *                       If null, we fall back to Date.parse delta from the
 *                       first segment we ever saw — see callers.
 *   - event_type      ← `"transcript.mutable"` (Vexa's frame name; matches
 *                       the spirit of Recall's `transcript.data` /
 *                       `transcript.partial_data`)
 *   - raw             ← original Vexa payload, untouched
 */

import type { TranscriptSegment } from "./types";

export interface VexaTranscriptInput {
  text?: unknown;
  speaker?: unknown;
  absolute_start_time?: unknown;
  absolute_end_time?: unknown;
  updated_at?: unknown;
}

export interface AdaptVexaSegmentOpts {
  /** Our internal `meetings.bot_id` for this Vexa session. */
  botId: string;
  /** Anchor for converting absolute timestamps into relative seconds. */
  meetingStartIso?: string | null;
  /** Vexa's frame event type. Defaults to `"transcript.mutable"`. */
  eventType?: string;
}

export function adaptVexaSegment(
  vexa: VexaTranscriptInput,
  opts: AdaptVexaSegmentOpts,
): TranscriptSegment {
  const text = typeof vexa.text === "string" ? vexa.text : "";
  const speakerName = typeof vexa.speaker === "string" ? vexa.speaker : null;

  const startTs = isoToRelativeSeconds(
    vexa.absolute_start_time,
    opts.meetingStartIso,
  );
  const endTs = isoToRelativeSeconds(
    vexa.absolute_end_time,
    opts.meetingStartIso,
  );

  return {
    bot_id: opts.botId,
    speaker_name: speakerName,
    speaker_id: null,
    is_host: null,
    words: text,
    start_ts: startTs,
    end_ts: endTs,
    event_type: opts.eventType ?? "transcript.mutable",
    raw: vexa,
  };
}

/** ISO 8601 absolute → relative seconds since meeting start. */
function isoToRelativeSeconds(
  iso: unknown,
  startIso: string | null | undefined,
): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  if (typeof startIso !== "string" || startIso.length === 0) {
    // Without a start anchor, we can't return a relative offset honestly.
    // null is acceptable per the schema and won't poison range queries.
    return null;
  }
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, (t - start) / 1000);
}
