import { neon } from "@neondatabase/serverless";
import type { TranscriptSegment } from "./types";

/**
 * Resolve our internal `meetings.bot_id` from a Vexa native_meeting_id by
 * substring-matching against the stored meeting_url. Used when the relay
 * only has Vexa's identifiers (which it does — Vexa's WebSocket frames
 * carry platform + native_meeting_id, not our bot_id).
 *
 * Returns the most recently started meeting that matches, since native
 * meeting ids can be reused across days (especially Zoom recurring rooms).
 *
 * Indexed lookup would be faster — add `meetings.native_meeting_id` and a
 * unique-per-active-window index in a follow-up migration. For Erez's volume
 * the LIKE scan is fine.
 */
export async function findBotIdByNativeMeetingId(
  databaseUrl: string,
  nativeMeetingId: string,
): Promise<string | null> {
  if (!nativeMeetingId || nativeMeetingId.length < 4) return null;
  const sql = neon(databaseUrl);
  const rows = (await sql`
    SELECT bot_id FROM meetings
    WHERE meeting_url LIKE ${"%" + nativeMeetingId + "%"}
    ORDER BY started_at DESC NULLS LAST
    LIMIT 1
  `) as Array<{ bot_id: string }>;
  return rows.length > 0 ? rows[0].bot_id : null;
}

/**
 * Insert a single transcript segment into the tenant's Neon database.
 *
 * Resolves `meeting_id` by looking up `meetings.id WHERE bot_id = $1`. If no
 * matching row exists yet (race between bot start and first transcript event)
 * we skip the insert and return `false` — caller decides whether to log.
 */
export async function insertTranscriptSegment(
  databaseUrl: string,
  seg: TranscriptSegment,
): Promise<boolean> {
  const sql = neon(databaseUrl);

  const meetingRows = (await sql`
    SELECT id FROM meetings WHERE bot_id = ${seg.bot_id} LIMIT 1
  `) as Array<{ id: string }>;

  if (meetingRows.length === 0) {
    return false;
  }
  const meetingId = meetingRows[0].id;

  await sql`
    INSERT INTO meeting_transcript (
      meeting_id,
      bot_id,
      speaker_name,
      speaker_id,
      is_host,
      words,
      start_ts,
      end_ts,
      event_type,
      raw,
      created_at
    ) VALUES (
      ${meetingId},
      ${seg.bot_id},
      ${seg.speaker_name},
      ${seg.speaker_id},
      ${seg.is_host},
      ${seg.words},
      ${seg.start_ts},
      ${seg.end_ts},
      ${seg.event_type},
      ${JSON.stringify(seg.raw)}::jsonb,
      now()
    )
  `;

  return true;
}
