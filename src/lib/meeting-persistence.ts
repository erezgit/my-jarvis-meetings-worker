import { neon } from "@neondatabase/serverless";
import type { NormalisedCalendarEvent } from "./types";

/**
 * Single source of truth for the calendar→meeting lifecycle in Neon.
 *
 * Two tables, one row each per logical meeting:
 *   meetings(id, title, meeting_url, bot_id?, status, started_at?, ended_at?)
 *     ↑ what the dashboard /api/meetings list reads
 *   calendar_events(id, tenant_id, google_event_id UNIQUE, …, meeting_id FK→meetings.id)
 *     ↑ Google calendar metadata + per-event sync state
 *
 * Lifecycle:
 *   calendar event arrives  → upsertCalendarMeeting   → meetings(status='scheduled')
 *                                                        + calendar_events(status='scheduled')
 *                                                        + linked via calendar_events.meeting_id
 *   bot dispatched at T-90s → markMeetingDispatched   → meetings(status='live', bot_id=…)
 *                                                        + calendar_events(status='dispatched')
 *   meeting cancelled       → markMeetingCancelled    → meetings(status='cancelled')
 *                                                        + calendar_events(status='cancelled')
 *   bot finished            → markMeetingEnded        → meetings(status='ended', ended_at=now())
 *
 * Idempotency:
 *   - upsertCalendarMeeting: ON CONFLICT (google_event_id) for calendar_events;
 *     SELECT-then-INSERT-or-UPDATE on meetings (no unique key to ON CONFLICT against).
 *   - markMeetingDispatched: UPDATE-only, guarded so we don't overwrite a row
 *     that already advanced past 'live' (e.g. ended → live regression).
 *   - markMeetingCancelled: UPDATE-only, guarded so we don't cancel an already-live row.
 */

export interface UpsertCalendarMeetingResult {
  /** id of the linked meetings row, or null if no row was created (e.g. cancelled / no URL). */
  meeting_id: number | null;
}

export async function upsertCalendarMeeting(opts: {
  databaseUrl: string;
  tenantSlug: string;
  ev: NormalisedCalendarEvent;
}): Promise<UpsertCalendarMeetingResult> {
  const sql = neon(opts.databaseUrl);
  const startIso = new Date(opts.ev.start_time_ms).toISOString();
  const endIso = new Date(opts.ev.end_time_ms).toISOString();
  const isCancelled = opts.ev.status === "cancelled";
  const eventStatus = isCancelled ? "cancelled" : "scheduled";

  // 1) Look up any existing linked meetings row for this calendar event.
  const linked = (await sql`
    SELECT meeting_id FROM calendar_events
    WHERE google_event_id = ${opts.ev.google_event_id}
  `) as Array<{ meeting_id: number | null }>;
  let meetingId: number | null = linked[0]?.meeting_id ?? null;

  // 2) Reconcile the meetings row.
  if (meetingId !== null) {
    // Existing meetings row — update title/url, but never regress status away
    // from 'live'/'ended' (those are bot-driven terminal-ish states).
    if (isCancelled) {
      await sql`
        UPDATE meetings
        SET status = CASE
              WHEN status IN ('live', 'ended') THEN status
              ELSE 'cancelled'
            END,
            ended_at = CASE WHEN status IN ('live', 'ended') THEN ended_at ELSE now() END
        WHERE id = ${meetingId}
      `;
    } else {
      await sql`
        UPDATE meetings
        SET title = ${opts.ev.title},
            meeting_url = ${opts.ev.meeting_url ?? ""}
        WHERE id = ${meetingId}
      `;
    }
  } else if (!isCancelled && opts.ev.meeting_url) {
    // No existing row, event has a meet URL → create a scheduled meetings row.
    const inserted = (await sql`
      INSERT INTO meetings (title, meeting_url, status, started_at)
      VALUES (
        ${opts.ev.title},
        ${opts.ev.meeting_url},
        'scheduled',
        ${startIso}
      )
      RETURNING id
    `) as Array<{ id: number }>;
    meetingId = inserted[0]?.id ?? null;
  }
  // If cancelled & no existing meetings row → nothing to do on the meetings table.
  // If no URL & no existing row → nothing to do (calendar event without a meet link).

  // 3) Upsert calendar_events with the link.
  await sql`
    INSERT INTO calendar_events (
      tenant_id, google_event_id, title, start_time, end_time, meeting_url,
      status, meeting_id, raw, synced_at, created_at, updated_at
    ) VALUES (
      ${opts.tenantSlug},
      ${opts.ev.google_event_id},
      ${opts.ev.title},
      ${startIso},
      ${endIso},
      ${opts.ev.meeting_url},
      ${eventStatus},
      ${meetingId},
      ${JSON.stringify(opts.ev.raw)}::jsonb,
      now(),
      now(),
      now()
    )
    ON CONFLICT (google_event_id) DO UPDATE SET
      title = EXCLUDED.title,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      meeting_url = EXCLUDED.meeting_url,
      status = CASE
        WHEN calendar_events.status = 'dispatched' THEN calendar_events.status
        ELSE EXCLUDED.status
      END,
      meeting_id = COALESCE(calendar_events.meeting_id, EXCLUDED.meeting_id),
      raw = EXCLUDED.raw,
      synced_at = now(),
      updated_at = now()
  `;

  return { meeting_id: meetingId };
}

/**
 * Mark a meeting as dispatched — bot creation API call has succeeded; the bot
 * is starting up but is NOT yet in the meeting. Called from MeetingDO.alarm()
 * after createVexaBot/createRecallBot returns.
 *
 * Status semantics:
 *   - meetings.status stays at 'scheduled' (unchanged) — the user hasn't seen
 *     the bot in the meeting yet. We only attach bot_id so downstream queries
 *     can correlate. The flip to 'live' happens via markMeetingLive when Vexa
 *     reports status='active' (bot in meeting and recording).
 *   - calendar_events.status flips to 'dispatched' — that table tracks the
 *     calendar/dispatch lifecycle, not the bot's recording state.
 */
export async function markMeetingDispatched(opts: {
  databaseUrl: string;
  meetingId: number | null;
  googleEventId: string;
  botId: string;
  dispatchedAtMs: number;
}): Promise<void> {
  const sql = neon(opts.databaseUrl);
  const dispatchedIso = new Date(opts.dispatchedAtMs).toISOString();

  if (opts.meetingId !== null) {
    await sql`
      UPDATE meetings
      SET bot_id = ${opts.botId}
      WHERE id = ${opts.meetingId}
        AND status NOT IN ('live', 'ended', 'failed')
    `;
  }

  await sql`
    UPDATE calendar_events
    SET status = 'dispatched',
        recall_bot_id = ${opts.botId},
        dispatched_at = ${dispatchedIso},
        updated_at = now()
    WHERE google_event_id = ${opts.googleEventId}
  `;
}

/**
 * Flip meetings.status from 'scheduled' to 'live' when the bot has actually
 * joined the meeting and started recording.
 *
 * For Vexa: triggered by pollVexaTranscriptsTick when result.status === 'active'.
 * For Recall: would be triggered from the webhook handler (not yet wired —
 * Vexa is the active path).
 *
 * Idempotent — the WHERE clause restricts to status='scheduled', so repeated
 * calls (one per poll tick) are no-ops after the first transition.
 */
export async function markMeetingLive(opts: {
  databaseUrl: string;
  meetingId: number | null;
  botId: string | null;
}): Promise<void> {
  const sql = neon(opts.databaseUrl);

  if (opts.meetingId !== null) {
    await sql`
      UPDATE meetings
      SET status = 'live',
          started_at = now()
      WHERE id = ${opts.meetingId}
        AND status = 'scheduled'
    `;
  } else if (opts.botId) {
    // Fallback: no meeting_id (e.g. manual flow) — match by bot_id.
    await sql`
      UPDATE meetings
      SET status = 'live',
          started_at = now()
      WHERE bot_id = ${opts.botId}
        AND status = 'scheduled'
    `;
  }
}

/**
 * Mark a meeting as cancelled. Called when a Google calendar event is deleted
 * before it dispatches, OR when MeetingDO receives an explicit cancel.
 *
 * Guarded so we don't cancel a row that's already live/ended.
 */
export async function markMeetingCancelled(opts: {
  databaseUrl: string;
  meetingId: number | null;
  googleEventId: string;
}): Promise<void> {
  const sql = neon(opts.databaseUrl);

  if (opts.meetingId !== null) {
    await sql`
      UPDATE meetings
      SET status = 'cancelled',
          ended_at = now()
      WHERE id = ${opts.meetingId}
        AND status NOT IN ('live', 'ended')
    `;
  }

  await sql`
    UPDATE calendar_events
    SET status = 'cancelled',
        updated_at = now()
    WHERE google_event_id = ${opts.googleEventId}
      AND status != 'dispatched'
  `;
}

/**
 * Mark a meeting as ended (Vexa reported terminal status, or polling budget
 * exceeded). Called from MeetingDO.pollVexaTranscriptsTick when status flips.
 */
export async function markMeetingEnded(opts: {
  databaseUrl: string;
  meetingId: number | null;
  botId: string | null;
}): Promise<void> {
  const sql = neon(opts.databaseUrl);

  if (opts.meetingId !== null) {
    await sql`
      UPDATE meetings
      SET status = 'ended',
          ended_at = now()
      WHERE id = ${opts.meetingId}
        AND status NOT IN ('ended', 'cancelled', 'failed')
    `;
  } else if (opts.botId) {
    // Fallback: no meeting_id linked (e.g. manual flow) — match on bot_id.
    await sql`
      UPDATE meetings
      SET status = 'ended',
          ended_at = now()
      WHERE bot_id = ${opts.botId}
        AND status NOT IN ('ended', 'cancelled', 'failed')
    `;
  }
}
