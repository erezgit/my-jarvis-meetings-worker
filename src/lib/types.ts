import type { DurableObjectNamespace } from "@cloudflare/workers-types";

/** Worker environment — bindings, vars, and secrets. */
export interface Env {
  /** Per-tenant Durable Object namespace, class `MeetingTenantDO`. */
  MEETING_TENANT: DurableObjectNamespace;

  /** Public host of this Worker (no scheme). Used to build webhook URLs. */
  WORKER_PUBLIC_HOST: string;

  /** Recall.ai API key. `wrangler secret put RECALL_API_KEY`. */
  RECALL_API_KEY: string;

  /** Bearer token for `/admin/register`. `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN: string;
}

/** Per-tenant config persisted inside `MeetingTenantDO` storage. */
export interface TenantConfig {
  /** Neon HTTP connection string for this tenant's DB. */
  database_url: string;
  /** HMAC secret used to sign/verify Recall webhook URLs. */
  recall_webhook_secret: string;
  /** Bearer token clients pass in `Authorization` to act as this tenant. */
  tenant_key: string;
}

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
