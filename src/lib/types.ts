import type {
  DurableObjectNamespace,
  KVNamespace,
} from "@cloudflare/workers-types";

/** Worker environment — bindings, vars, and secrets. */
export interface Env {
  /** Per-tenant Durable Object namespace, class `MeetingTenantDO`. */
  MEETING_TENANT: DurableObjectNamespace;

  /** Per-meeting Durable Object namespace, class `MeetingDO`. */
  MEETING_DO: DurableObjectNamespace;

  /** Reverse-lookup KV: `channel_id → tenant_slug`. */
  CALENDAR_ROUTING: KVNamespace;

  /** Public host of this Worker (no scheme). Used to build callback URLs. */
  WORKER_PUBLIC_HOST: string;

  /** Bearer token for `/admin/register`. `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN: string;

  /** Google OAuth client id. `wrangler secret put GOOGLE_OAUTH_CLIENT_ID`. */
  GOOGLE_OAUTH_CLIENT_ID: string;

  /** Google OAuth client secret. `wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET`. */
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  /**
   * Vexa instance base URL — e.g. `https://vexa.myjarvis.dev`.
   * Set in wrangler.toml `[vars]`. Empty string disables Vexa routing.
   */
  VEXA_API_URL: string;

  /** Vexa API key (admin or scoped). `wrangler secret put VEXA_API_KEY`. */
  VEXA_API_KEY: string;

  /**
   * Cloudflare Workers AI binding. Drives the Whisper proxy at
   * /v1/audio/transcriptions. Declared in wrangler.toml as `[ai] binding = "AI"`.
   */
  AI: { run(model: string, input: unknown): Promise<unknown> };

  /**
   * Bearer token Vexa Lite sends as TRANSCRIPTION_SERVICE_TOKEN to authenticate
   * to the Whisper proxy. `wrangler secret put WHISPER_PROXY_TOKEN`.
   */
  WHISPER_PROXY_TOKEN: string;
}

/**
 * Per-tenant config persisted inside `MeetingTenantDO` storage.
 *
 * Required fields cover the meeting-bot routes; Google fields are optional and
 * populated by the calendar OAuth flow — a tenant without calendar connected
 * just doesn't have them set.
 */
export interface TenantConfig {
  /** Neon HTTP connection string for this tenant's DB. */
  database_url: string;
  /** Bearer token clients pass in `Authorization` to act as this tenant. */
  tenant_key: string;

  /**
   * Per-tenant Vexa instance URL — e.g. `https://my-jarvis-vexa-yaronkra3.fly.dev`.
   * When set, MeetingDO dispatches this tenant's bots to this URL. When unset,
   * falls back to `env.VEXA_API_URL` (the legacy single-shared-Vexa setup).
   */
  vexa_api_url?: string;
  /**
   * Per-tenant Vexa user API key minted on that tenant's Vexa instance.
   * When set, MeetingDO uses this for `X-API-Key`. Falls back to env.VEXA_API_KEY.
   */
  vexa_api_key?: string;

  // ---- Google Calendar fields (set via /calendar/oauth/callback) ---------
  /** Long-lived Google OAuth refresh token. Exchanged for short-lived access tokens. */
  google_refresh_token?: string;
  /** Email of the Google account that authorised. Display only. */
  google_oauth_email?: string;
  /** X-Goog-Channel-Id we registered for this tenant's primary calendar. */
  google_channel_id?: string;
  /** X-Goog-Channel-Token (per-channel random secret). Constant-time compared on /calendar/notify. */
  google_channel_secret?: string;
  /** Resource ID returned by events.watch — required for channels.stop. */
  google_channel_resource_id?: string;
  /** When the current channel expires (ms epoch). Renewed at T-24h by cron. */
  google_channel_expiration_ms?: number;
  /** Latest Google Calendar incremental sync token. 410 → drop & full-resync. */
  google_sync_token?: string;
}

/** Subset of TenantConfig containing only the Google fields. */
export type GoogleStatePatch = Partial<
  Pick<
    TenantConfig,
    | "google_refresh_token"
    | "google_oauth_email"
    | "google_channel_id"
    | "google_channel_secret"
    | "google_channel_resource_id"
    | "google_channel_expiration_ms"
    | "google_sync_token"
  >
>;

/** Body of `POST /admin/register`. */
export interface AdminRegisterBody {
  slug: string;
  database_url: string;
  tenant_key: string;
  /** Per-tenant Vexa instance URL (overrides env.VEXA_API_URL when set). */
  vexa_api_url?: string;
  /** Per-tenant Vexa user API key (overrides env.VEXA_API_KEY when set). */
  vexa_api_key?: string;
}

/** Body of `POST /meeting/bot`. */
export interface BotStartBody {
  meeting_url: string;
  title?: string;
  meeting_id?: string;
  /** Whisper language code, e.g. "he", "en", "multi". Defaults to "he". */
  language?: string;
  /**
   * Zoom/Teams passcode. Optional — if the meeting URL already carries it
   * (`?pwd=<token>` for Zoom), the parser extracts it and this field is
   * ignored. Used when the user pastes a bare Zoom URL and types the
   * passcode separately. Recall path ignores this field.
   */
  passcode?: string;
}

/**
 * Body of `POST /meeting/play`. `platform` and `native_meeting_id` are required
 * because Vexa's speak endpoint addresses the meeting by those, not by `bot_id`.
 * The dashboard already knows them — they're on the `meetings` row.
 */
export interface PlayBody {
  bot_id: string;
  b64_audio: string;
  /** Audio container format (default "wav"). */
  kind?: "wav" | "mp3" | "pcm" | "opus";
  platform: "google_meet" | "zoom" | "teams";
  native_meeting_id: string;
}

/**
 * Body of `POST /vexa/transcript` — the Vexa→Worker relay. The relay
 * subscribes to Vexa's WebSocket and POSTs each transcript segment here.
 * Auth: bearer (tenant_key) + X-Tenant header, same as /meeting/play.
 *
 * Identification: provide EITHER `bot_id` (if the relay tracks our internal
 * id) OR `(platform, native_meeting_id)` (the relay receives these directly
 * from Vexa frames). When both are absent the request is rejected. When
 * `bot_id` is present it is used directly; otherwise the Worker resolves
 * `meetings.bot_id` by `meeting_url LIKE '%native_meeting_id%'`.
 */
export interface VexaTranscriptBody {
  /** `meetings.bot_id` for the active session — supply if you have it. */
  bot_id?: string;
  /** Used to resolve bot_id when the relay only knows Vexa's identifiers. */
  platform?: "google_meet" | "zoom" | "teams";
  /** Used with `platform` for resolution. */
  native_meeting_id?: string;
  /** Vexa transcript segment as received from `wss://vexa-host/ws`. */
  segment: {
    text?: string;
    speaker?: string | null;
    absolute_start_time?: string;
    absolute_end_time?: string;
    updated_at?: string;
  };
  /**
   * ISO 8601 meeting start anchor for converting absolute timestamps into
   * relative seconds. Optional — null is acceptable per the schema.
   */
  meeting_start_iso?: string;
}

/**
 * Body of `POST /meeting/leave`. Vexa's stop endpoint is keyed by
 * `(platform, native_meeting_id)` — not by bot_id. Either pass them directly
 * (the dashboard has them on the meetings row) or pass `meeting_url` as a
 * fallback for the Worker to parse.
 */
export interface LeaveBody {
  bot_id: string;
  platform?: "google_meet" | "zoom" | "teams";
  native_meeting_id?: string;
  /** Fallback: Worker parses platform + native_meeting_id from this if the
   * structured fields aren't supplied. */
  meeting_url?: string;
}

/**
 * Shape of a single transcript event we persist. Built from Vexa's transcript
 * envelope by `adaptVexaSegment` in `lib/vexa-transcript-adapter.ts`.
 */
export interface TranscriptSegment {
  bot_id: string;
  speaker_name: string | null;
  speaker_id: string | null;
  is_host: boolean | null;
  /** Joined transcript text — one line per segment. */
  words: string;
  start_ts: number | null;
  end_ts: number | null;
  event_type: string;
  /** Original event payload, JSON-stringified before INSERT. */
  raw: unknown;
}

/* --------------------------------------------------------------------------
 * Calendar / per-meeting types
 * ------------------------------------------------------------------------ */

/**
 * State persisted inside a `MeetingDO`. One DO per (tenant, google_event_id).
 *
 * Storage key: "state". The DO `alarm()` reads this, dispatches to Recall if
 * status === 'scheduled' && !dispatched_at_ms, then transitions to 'dispatched'.
 */
export interface MeetingState {
  tenant_slug: string;
  google_event_id: string;
  start_time_ms: number;
  end_time_ms: number;
  title: string;
  meeting_url: string;
  status: "scheduled" | "dispatched" | "cancelled" | "failed" | "completed";
  /** Active Vexa bot id once dispatched. */
  bot_id: string | null;
  dispatched_at_ms: number | null;
  /** FK into Neon `meetings.id` once dispatched. */
  meeting_id_neon: number | null;

  /** Vexa platform — needed by /meeting/play and /meeting/leave to address the meeting. */
  vexa_platform?: "google_meet" | "zoom" | "teams";
  /** Vexa native meeting id parsed from the meeting URL. */
  vexa_native_meeting_id?: string;

  // ---- Vexa transcript-polling state ----
  /**
   * ISO 8601 of the last segment we synced from Vexa to Neon. Each alarm tick
   * fetches the full transcript list, filters by `absolute_end_time > this`,
   * inserts new segments, then advances this watermark to the new max.
   */
  last_synced_iso?: string;
  /**
   * Wall-clock ms when we first saw the meeting in Vexa. Used to bound the
   * polling loop — if we've been polling for >2× max meeting length and Vexa
   * still hasn't terminated, stop alarming so a wedged DO doesn't spin forever.
   */
  poll_started_ms?: number;
  /**
   * Wall-clock ms when we first observed Vexa reporting status='active' AND
   * flipped meetings.status to 'live'. Once set, the polling loop stops
   * issuing markMeetingLive UPDATEs (idempotent guard).
   */
  live_marked_at_ms?: number;
  /**
   * Wall-clock ms of the last poll tick where Vexa reported any human
   * participants in the meeting. Used to detect "host left" — when this is
   * set AND now()-this > grace period AND participants_count is 0, the
   * polling loop force-leaves the bot for a clean shutdown.
   */
  last_human_seen_at_ms?: number;
  /**
   * Wall-clock ms when we issued vexaBotLeave because the host left. Idempotent
   * guard — once set, we don't issue leave again, and we let Vexa transition
   * to 'completed' naturally so markMeetingEnded can fire on the next tick.
   */
  leave_requested_at_ms?: number;
  /**
   * Current transcript-poll backoff in ms. Starts at the base interval (5s),
   * doubles on each consecutive Vexa fetch error / 429 up to a 30s cap, and
   * resets to the base on a successful fetch. Prevents the old 1s hammer that
   * flooded Vexa with 429s.
   */
  poll_backoff_ms?: number;
}

/**
 * Pointer (stored in MeetingTenantDO under "active_meeting") to the tenant's
 * single currently-active meeting. The per-tenant Vexa instance allows only
 * one bot at a time, so starting a NEW meeting first supersedes this one —
 * leaves its Vexa bot + cancels its MeetingDO — before creating the new bot.
 * This is what makes "start, stop the agent, start again on any link" always
 * work, and guarantees only one transcript-poller runs per tenant.
 */
export interface ActiveMeeting {
  /** MeetingDO key suffix (google_event_id) — e.g. "manual-<bot_id>". */
  event_id: string;
  bot_id: string;
  platform: "google_meet" | "zoom" | "teams";
  native_meeting_id: string;
  meeting_id_neon: number | null;
}

/**
 * Body of `POST /_internal/upsert` on MeetingDO. Caller supplies the event
 * fields; the DO fills in computed status/dispatched fields.
 *
 * `meeting_id` (Neon meetings.id) is supplied by the calendar pipeline so the
 * DO can persist it into MeetingState and use it to UPDATE the meetings row
 * at dispatch time. Optional — manual flows that don't pre-create a row pass
 * undefined and the DO leaves meeting_id_neon null.
 */
export interface MeetingUpsertBody {
  tenant_slug: string;
  google_event_id: string;
  start_time_ms: number;
  end_time_ms: number;
  title: string;
  meeting_url: string;
  meeting_id?: number | null;
}

/** Normalised calendar event extracted from Google's `events#resource` shape. */
export interface NormalisedCalendarEvent {
  google_event_id: string;
  title: string;
  start_time_ms: number;
  end_time_ms: number;
  meeting_url: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  raw: unknown;
}
