/**
 * Google Calendar API helpers — push channels, events.list with syncToken,
 * meeting URL extraction.
 *
 * All calls take an `accessToken` (short-lived; caller is responsible for
 * obtaining via refreshAccessToken).
 */

import type { NormalisedCalendarEvent } from "./types";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

/* --------------------------------------------------------------------------
 * Push channels (events.watch / channels.stop)
 * ------------------------------------------------------------------------ */

export interface RegisterWatchResult {
  /** Echoes our `id`. */
  id: string;
  /** Opaque resource identifier — required to stop the channel later. */
  resourceId: string;
  /** ms epoch when channel auto-expires (Google caps at 7 days). */
  expirationMs: number;
}

/**
 * Subscribe to push notifications for the user's primary calendar.
 *
 * `address` MUST be HTTPS and reachable. Google verifies it on registration
 * (sends a `sync` notification) and rejects if the endpoint doesn't 200.
 */
export async function registerWatchChannel(opts: {
  accessToken: string;
  channelId: string;
  channelSecret: string;
  webhookUrl: string;
  /** TTL in seconds, max 604800 (7d). Default 604800. */
  ttlSeconds?: number;
}): Promise<RegisterWatchResult> {
  const url = `${CAL_BASE}/calendars/primary/events/watch`;
  const body = {
    id: opts.channelId,
    type: "web_hook",
    address: opts.webhookUrl,
    token: opts.channelSecret,
    params: { ttl: String(opts.ttlSeconds ?? 604800) },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Calendar watch register failed ${r.status}: ${text}`);
  }
  const parsed = JSON.parse(text) as {
    id?: string;
    resourceId?: string;
    expiration?: string;
  };
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.resourceId !== "string" ||
    typeof parsed.expiration !== "string"
  ) {
    throw new Error(
      `Calendar watch register: malformed response ${JSON.stringify(parsed)}`,
    );
  }
  return {
    id: parsed.id,
    resourceId: parsed.resourceId,
    expirationMs: Number(parsed.expiration),
  };
}

/** Stop a push channel. Idempotent on Google's side — 404 is fine. */
export async function stopChannel(opts: {
  accessToken: string;
  channelId: string;
  resourceId: string;
}): Promise<void> {
  const url = `${CAL_BASE}/channels/stop`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: opts.channelId, resourceId: opts.resourceId }),
  });
  if (!r.ok && r.status !== 404) {
    const text = await r.text();
    throw new Error(`Calendar channels.stop failed ${r.status}: ${text}`);
  }
}

/* --------------------------------------------------------------------------
 * events.list — full sync + incremental sync
 * ------------------------------------------------------------------------ */

/** Raw Google `events#resource` minus fields we don't use. */
export interface RawCalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string;
      uri?: string;
      label?: string;
    }>;
  };
}

export interface ListEventsPage {
  events: RawCalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

/**
 * One page of events. Pass either `syncToken` (incremental) or no token (full).
 * Pass `pageToken` to walk subsequent pages.
 *
 * On 410 Gone (syncToken expired) the caller MUST drop their syncToken and
 * redo a full sync.
 */
export async function listEventsPage(opts: {
  accessToken: string;
  syncToken?: string;
  pageToken?: string;
  maxResults?: number;
}): Promise<{ status: number; page: ListEventsPage | null; rawText: string }> {
  const params = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "true",
    maxResults: String(opts.maxResults ?? 250),
  });
  if (opts.syncToken) params.set("syncToken", opts.syncToken);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const url = `${CAL_BASE}/calendars/primary/events?${params.toString()}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  const text = await r.text();
  if (r.status === 410) {
    return { status: 410, page: null, rawText: text };
  }
  if (!r.ok) {
    throw new Error(`Calendar events.list failed ${r.status}: ${text}`);
  }
  const parsed = JSON.parse(text) as {
    items?: RawCalendarEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };
  return {
    status: r.status,
    page: {
      events: parsed.items ?? [],
      nextPageToken: parsed.nextPageToken ?? null,
      nextSyncToken: parsed.nextSyncToken ?? null,
    },
    rawText: text,
  };
}

/* --------------------------------------------------------------------------
 * Event normalisation + meeting URL extraction
 * ------------------------------------------------------------------------ */

const ZOOM_RE = /https?:\/\/[a-zA-Z0-9-]*\.?zoom\.us\/[^\s<>"]*/i;
const MEET_RE = /https?:\/\/meet\.google\.com\/[^\s<>"]*/i;
const TEAMS_RE = /https?:\/\/teams\.(microsoft|live)\.com\/[^\s<>"]*/i;

/**
 * Extract the most likely meeting URL from a Google event. Order:
 *   1. hangoutLink (Google Meet — explicit)
 *   2. conferenceData.entryPoints[type=video]
 *   3. Zoom / Teams URL anywhere in description or location
 * Returns null if nothing matches.
 */
export function pickMeetingUrlFromEvent(ev: RawCalendarEvent): string | null {
  if (typeof ev.hangoutLink === "string" && ev.hangoutLink.length > 0) {
    return ev.hangoutLink;
  }
  const eps = ev.conferenceData?.entryPoints ?? [];
  for (const ep of eps) {
    if (
      typeof ep.uri === "string" &&
      ep.uri.length > 0 &&
      (ep.entryPointType === "video" || /^https?:\/\//.test(ep.uri))
    ) {
      return ep.uri;
    }
  }
  const haystack = `${ev.description ?? ""}\n${ev.location ?? ""}`;
  const m =
    haystack.match(MEET_RE) ?? haystack.match(ZOOM_RE) ?? haystack.match(TEAMS_RE);
  return m ? m[0] : null;
}

/**
 * Normalise a raw event. Returns null for all-day events (we only schedule
 * timed meetings) or events without a parseable start.
 */
export function normaliseEvent(ev: RawCalendarEvent): NormalisedCalendarEvent | null {
  if (typeof ev.id !== "string" || ev.id.length === 0) return null;
  // All-day events have `start.date` and no `start.dateTime`. Skip.
  if (!ev.start?.dateTime || !ev.end?.dateTime) return null;
  const start = Date.parse(ev.start.dateTime);
  const end = Date.parse(ev.end.dateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const status: NormalisedCalendarEvent["status"] =
    ev.status === "cancelled"
      ? "cancelled"
      : ev.status === "tentative"
      ? "tentative"
      : "confirmed";
  return {
    google_event_id: ev.id,
    title: typeof ev.summary === "string" ? ev.summary : "(no title)",
    start_time_ms: start,
    end_time_ms: end,
    meeting_url: pickMeetingUrlFromEvent(ev),
    status,
    raw: ev,
  };
}
