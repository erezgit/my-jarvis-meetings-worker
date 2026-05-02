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

  /** Public host of this Worker (no scheme). Used to build webhook URLs. */
  WORKER_PUBLIC_HOST: string;

  /** Recall.ai API key. `wrangler secret put RECALL_API_KEY`. */
  RECALL_API_KEY: string;

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
}

/**
 * Per-tenant config persisted inside `MeetingTenantDO` storage.
 *
 * Recall fields are required for the existing /recall/* routes. Google fields
 * are optional and populated by the calendar OAuth flow — a tenant without
 * calendar connected just doesn't have them set.
 */
export interface TenantConfig {
  /** Neon HTTP connection string for this tenant's DB. */
  database_url: string;
  /** HMAC secret used to sign/verify Recall webhook URLs. */
  recall_webhook_secret: string;
  /** Bearer token clients pass in `Authorization` to act as this tenant. */
  tenant_key: string;

  // ---- Bot provider switch (Recall → Vexa cutover) ---------------------
  /**
   * Which meeting-bot provider to dispatch for new meetings.
   * Defaults to `"recall"` when unset. Flipping to `"vexa"` is the per-tenant
   * cutover. In-flight Recall meetings continue on the Recall path because
   * MeetingDO.alarm() reads this when the alarm fires, not at upsert time.
   */
  bot_provider?: "recall" | "vexa";

  /**
   * Default Vexa platform inferred from the meeting URL when this tenant runs
   * mostly on one platform (e.g. always Google Meet). Optional; if absent,
   * the platform is parsed from each meeting URL at dispatch time.
   */
  vexa_default_platform?: "google_meet" | "zoom" | "teams";

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
  recall_webhook_secret: string;
  tenant_key: string;
  /**
   * Bot provider — defaults to `"recall"` when omitted (preserves existing
   * tenants on the original code path). Set to `"vexa"` to cut a tenant over
   * to the Fly-hosted Vexa Lite. Persisted via the same `setTenantConfig`
   * call so the next meeting alarm picks it up.
   */
  bot_provider?: "recall" | "vexa";
}

/** Body of `POST /recall/bot`. */
export interface BotStartBody {
  meeting_url: string;
  title?: string;
  meeting_id?: string;
  /** Deepgram language code, e.g. "he", "en", "multi". Defaults to "he". */
  language?: string;
}

/**
 * Body of `POST /recall/play` (and the new `POST /play` provider-agnostic
 * variant). For Vexa, the `platform` and `native_meeting_id` fields are
 * required because Vexa's speak endpoint addresses the meeting by those, not
 * by `bot_id`. The dashboard already knows them — they're on the `meetings`
 * row.
 */
export interface PlayBody {
  bot_id: string;
  b64_audio: string;
  kind?: string;
  /** Required when tenant `bot_provider` is `"vexa"`. Ignored for Recall. */
  platform?: "google_meet" | "zoom" | "teams";
  /** Required when tenant `bot_provider` is `"vexa"`. Ignored for Recall. */
  native_meeting_id?: string;
}

/**
 * Body of `POST /vexa/transcript` — the Vexa→Worker relay. The relay
 * subscribes to Vexa's WebSocket and POSTs each transcript segment here.
 * Auth: bearer (tenant_key) + X-Tenant header, same as /recall/play.
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

/** Body of `POST /recall/leave`. */
export interface LeaveBody {
  bot_id: string;
}

/**
 * Shape of a single transcript event we persist. Built from Recall's webhook
 * payload (event + data envelope).
 */
export interface TranscriptSegment {
  bot_id: string;
  speaker_name: string | null;
  speaker_id: string | null;
  is_host: boolean | null;
  /** Joined transcript text (Recall sends words[]; we join into a single line). */
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
  /**
   * Active bot id from the dispatched provider. Field name kept for backward
   * compat with existing Neon rows; semantically provider-agnostic.
   */
  recall_bot_id: string | null;
  dispatched_at_ms: number | null;
  /** FK into Neon `calendar_events.id` (or `meetings.id`) once dispatched. */
  meeting_id_neon: number | null;

  // ---- Vexa-only addressing (set when bot_provider=="vexa" was used) ----
  /** Vexa platform — needed by /play and /leave to address the meeting. */
  vexa_platform?: "google_meet" | "zoom" | "teams";
  /** Vexa native meeting id parsed from the meeting URL. */
  vexa_native_meeting_id?: string;
  /** Which provider was actually dispatched (so reads can branch correctly). */
  bot_provider?: "recall" | "vexa";

  // ---- Vexa transcript-polling state (only used when bot_provider=="vexa") ----
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
}

/**
 * Body of `POST /_internal/upsert` on MeetingDO. Caller supplies the event
 * fields; the DO fills in computed status/recall/dispatched fields.
 */
export interface MeetingUpsertBody {
  tenant_slug: string;
  google_event_id: string;
  start_time_ms: number;
  end_time_ms: number;
  title: string;
  meeting_url: string;
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
