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
}

/** Body of `POST /recall/bot`. */
export interface BotStartBody {
  meeting_url: string;
  title?: string;
  meeting_id?: string;
  /** Deepgram language code, e.g. "he", "en", "multi". Defaults to "he". */
  language?: string;
}

/** Body of `POST /recall/play`. */
export interface PlayBody {
  bot_id: string;
  b64_audio: string;
  kind?: string;
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
  status: "scheduled" | "dispatched" | "cancelled" | "failed";
  recall_bot_id: string | null;
  dispatched_at_ms: number | null;
  /** FK into Neon `calendar_events.id` (or `meetings.id`) once dispatched. */
  meeting_id_neon: number | null;
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
