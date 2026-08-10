/**
 * Vexa.ai bot dispatch helper.
 *
 * Vexa is the Apache-2.0 self-hosted meeting-bot stack. We run Vexa Lite
 * per-tenant on Fly Machines (one app per tenant: my-jarvis-vexa-erez,
 * my-jarvis-vexa-yaron). Its bot uses faster-whisper(large-v3-turbo) for
 * Hebrew STT but our deployment offloads transcription to Cloudflare
 * Workers AI via the /v1/audio/transcriptions proxy.
 *
 * API spec source: https://docs.vexa.ai/api/bots and /api/interactive-bots.
 */

export interface VexaBotCreateOpts {
  /** Vexa instance URL — e.g. `https://vexa.myjarvis.dev`. No trailing slash. */
  apiUrl: string;
  /** Vexa `X-API-Key` token. */
  apiKey: string;
  /** Meeting platform. Vexa supports `google_meet`, `zoom`, `teams`. */
  platform: "google_meet" | "zoom" | "teams";
  /** Native meeting ID extracted from the URL (e.g. `abc-defg-hij` for Meet). */
  nativeMeetingId: string;
  /** Optional Zoom/Teams passcode. */
  passcode?: string;
  /** Whisper language hint. Default `"he"` to match the Recall path. */
  language?: string;
  /** Whisper task. Default `"transcribe"`. `"translate"` forces English output. */
  task?: "transcribe" | "translate";
  /** Display name shown in the meeting roster. Default `"Jarvis"`. */
  botName?: string;
  /** Whether Vexa should record audio for later playback. Default `true`. */
  recordingEnabled?: boolean;
  /** Whether Vexa should run live transcription. Default `true`. */
  transcribeEnabled?: boolean;
}

export interface VexaBotCreateResult {
  /** Vexa's internal bot id (UUID). Used for stop / speak addressing alongside platform+native_meeting_id. */
  bot_id: string;
  /** Echoes back into our state so the relay + speak path can target this meeting. */
  platform: VexaBotCreateOpts["platform"];
  native_meeting_id: string;
  /** Full Vexa response — opaque, kept for debugging. */
  raw: unknown;
}

/** Create a Vexa bot. Throws on non-2xx. */
export async function createVexaBot(
  opts: VexaBotCreateOpts,
): Promise<VexaBotCreateResult> {
  const language = opts.language && opts.language.length > 0 ? opts.language : "he";
  const task = opts.task ?? "transcribe";
  // ⚠️ ONE capital T, lower-case m: "Tailormind". Not TailorMind, not
  // Taylormind. It is the client-facing brand and this string is the most
  // client-facing thing we own — it is the name that appears in the roster of
  // someone else's meeting, next to real people's names.
  const botName = opts.botName && opts.botName.length > 0 ? opts.botName : "Tailormind Notetaker";

  const body: Record<string, unknown> = {
    platform: opts.platform,
    native_meeting_id: opts.nativeMeetingId,
    language,
    task,
    bot_name: botName,
    recording_enabled: opts.recordingEnabled ?? true,
    transcribe_enabled: opts.transcribeEnabled ?? true,
    // Join Google Meet SIGNED IN as the shared "Tailormind Notetaker" Google account.
    //
    // ⚠️ AND THAT ACCOUNT'S OWN DISPLAY NAME IS THE ONE MEET SHOWS. For a
    // signed-in participant Google renders the Google profile name, so fixing
    // `bot_name` here is only half of it: the Google account has to be renamed
    // too, or the roster keeps whatever it says. Two representations of one
    // name, and the one nobody edits is the one everybody reads.
    // meeting-api reads this and injects the R2 creds + userdataS3Path into BOT_CONFIG
    // so the bot restores the signed-in browser profile from R2 (clears Google's
    // anonymous-bot block). Old images without the wiring ignore this field.
    authenticated: true,
  };
  if (opts.passcode && opts.passcode.length > 0) {
    body.passcode = opts.passcode;
  }

  const url = `${trimTrailingSlash(opts.apiUrl)}/bots`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": opts.apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Vexa bot create failed ${r.status}: ${text.slice(0, 400)}`);
  }
  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Vexa bot create returned non-JSON: ${text.slice(0, 200)}`);
  }
  // Vexa returns a numeric `id`; Recall returned a string. Coerce here so
  // downstream consumers can keep treating bot_id as a single string column.
  let botId: string;
  if (typeof parsed.id === "string") {
    botId = parsed.id;
  } else if (typeof parsed.id === "number") {
    botId = String(parsed.id);
  } else {
    throw new Error(`Vexa bot create response missing id: ${text.slice(0, 200)}`);
  }
  return {
    bot_id: botId,
    platform: opts.platform,
    native_meeting_id: opts.nativeMeetingId,
    raw: parsed,
  };
}

export interface VexaReadyResult {
  ready: true;
  /** Total wall-clock ms spent waiting (≈0 for an already-warm box). */
  waitedMs: number;
  /** How many probes it took (1 = warm). */
  probes: number;
}

/**
 * Wake a tenant's Vexa Fly machine and block until its bot-manager is ready to
 * spawn a bot container — or throw after `capMs`.
 *
 * WHY THIS EXISTS (root-cause fix): the per-tenant Vexa box runs on Fly with
 * `auto_stop_machines = "suspend"` + `min_machines_running = 0`, so it SLEEPS
 * whenever no meeting is active (deliberately — it keeps the box at ~$5/mo).
 * The first meeting after idle wakes it, but the box boots in stages
 * (embedded Postgres → whisper → Vexa pre-flight → supervisord → API gateway +
 * bot-manager + Docker). The API gateway answers `GET /` (and the Fly proxy
 * lets the request through) BEFORE the bot-manager/Docker are up. A bot create
 * fired in that window fails with no bot — which is exactly what users saw as
 * "meetings not working". A plain retry loop that only pokes `POST /bots` gives
 * up long before a cold boot (30–90s) finishes.
 *
 * THE READINESS SIGNAL is `GET /bots/status`: it queries the container manager,
 * so a 200 with a `running_bots` array proves the exact subsystem a subsequent
 * `POST /bots` needs is up. Hitting it ALSO triggers Fly's `auto_start`, so this
 * single call both WAKES the machine and GATES on true readiness.
 *
 * Cost stays untouched — the box still suspends when idle; we just refuse to
 * dispatch until it has finished waking. A warm box passes on the first probe
 * (≈instant); a cold box costs one wake, capped hard at `capMs`.
 */
export async function waitForVexaReady(opts: {
  apiUrl: string;
  apiKey: string;
  /** Hard ceiling on the total wait before giving up. Default 120_000 (2 min). */
  capMs?: number;
  /** Delay between probes. Default 4_000. */
  probeIntervalMs?: number;
  /** Per-probe fetch timeout so one hung probe can't eat the whole budget. Default 10_000. */
  probeTimeoutMs?: number;
}): Promise<VexaReadyResult> {
  const capMs = opts.capMs ?? 120_000;
  const probeIntervalMs = opts.probeIntervalMs ?? 4_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;
  const url = `${trimTrailingSlash(opts.apiUrl)}/bots/status`;
  const startedAt = Date.now();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let probes = 0;
  let lastReason = "no probe completed";
  while (Date.now() - startedAt < capMs) {
    probes++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), probeTimeoutMs);
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: { "X-API-Key": opts.apiKey },
        signal: ac.signal,
      });
      if (r.ok) {
        // 200 alone isn't enough — require the bot-manager's own shape so we
        // don't false-pass on an edge/proxy error page.
        const body = (await r.json().catch(() => null)) as
          | { running_bots?: unknown }
          | null;
        if (body && Array.isArray(body.running_bots)) {
          return { ready: true, waitedMs: Date.now() - startedAt, probes };
        }
        lastReason = "200 but unexpected body";
      } else {
        lastReason = `status ${r.status}`;
      }
    } catch (err) {
      lastReason =
        err instanceof Error
          ? err.name === "AbortError"
            ? `probe timeout after ${probeTimeoutMs}ms`
            : err.message
          : String(err);
    } finally {
      clearTimeout(timer);
    }
    // Don't oversleep past the cap.
    if (Date.now() - startedAt + probeIntervalMs < capMs) {
      await sleep(probeIntervalMs);
    } else {
      break;
    }
  }
  throw new Error(
    `Vexa not ready after ${Date.now() - startedAt}ms / ${probes} probes (last: ${lastReason})`,
  );
}

/** Tell Vexa to leave a call. Idempotent on Vexa side; 404 is fine. */
export async function vexaBotLeave(opts: {
  apiUrl: string;
  apiKey: string;
  platform: VexaBotCreateOpts["platform"];
  nativeMeetingId: string;
}): Promise<void> {
  const url = `${trimTrailingSlash(opts.apiUrl)}/bots/${encodeURIComponent(
    opts.platform,
  )}/${encodeURIComponent(opts.nativeMeetingId)}`;
  const r = await fetch(url, {
    method: "DELETE",
    headers: { "X-API-Key": opts.apiKey },
  });
  if (!r.ok && r.status !== 404) {
    const text = await r.text();
    throw new Error(`Vexa leave failed ${r.status}: ${text.slice(0, 400)}`);
  }
}

/**
 * Send pre-rendered audio for the bot to play into the meeting.
 *
 * Vexa speak endpoint expects PCM 24 kHz mono WAV by default — the relay/TTS
 * layer is responsible for producing that format. We forward base64 audio
 * verbatim and let Vexa's PulseAudio bridge pipe it into WebRTC.
 *
 * Note: Vexa also supports server-side TTS (mode "openai") and audio_url
 * fetches; we use audio_base64 (mode "c") because the dashboard already
 * generates audio upstream.
 */
export async function vexaSpeak(opts: {
  apiUrl: string;
  apiKey: string;
  platform: VexaBotCreateOpts["platform"];
  nativeMeetingId: string;
  audioBase64: string;
  /** PCM-encoded audio container. Default `"wav"`. */
  format?: "wav" | "mp3" | "pcm" | "opus";
  /** Default 24000. */
  sampleRate?: number;
  /** Default 1 (mono). */
  channels?: number;
}): Promise<{ status: number; body: string; contentType: string }> {
  const url = `${trimTrailingSlash(opts.apiUrl)}/bots/${encodeURIComponent(
    opts.platform,
  )}/${encodeURIComponent(opts.nativeMeetingId)}/speak`;

  const body = {
    audio_base64: opts.audioBase64,
    format: opts.format ?? "wav",
    sample_rate: opts.sampleRate ?? 24000,
    channels: opts.channels ?? 1,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": opts.apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return {
    status: r.status,
    body: text,
    contentType: r.headers.get("Content-Type") ?? "application/json",
  };
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Fetch the latest transcript snapshot for a Vexa meeting. The endpoint
 * returns the full segment list each call — caller filters by timestamp
 * watermark to avoid double-inserting.
 *
 * Vexa returns segment objects shaped like:
 *   { text, speaker, language, segment_id, absolute_start_time, absolute_end_time, completed }
 * plus a meeting envelope with `status` (active | completed | failed | ...).
 */
export interface VexaTranscriptsResult {
  /** Vexa meeting id (numeric). */
  id: number;
  /** Lifecycle status — drives whether the polling loop should keep running. */
  status:
    | "requested"
    | "joining"
    | "awaiting_admission"
    | "active"
    | "stopping"
    | "completed"
    | "failed";
  segments: Array<{
    text?: string;
    speaker?: string | null;
    segment_id?: string;
    absolute_start_time?: string;
    absolute_end_time?: string;
    [k: string]: unknown;
  }>;
  /** Used to anchor relative timestamps (Vexa returns ISO 8601 absolutes). */
  start_time?: string | null;
  /** Display names of humans currently in the meeting (excludes the bot). */
  participants: string[];
  /** Set once the meeting concludes — explains why ('stopped', 'idle_timeout', etc). */
  completion_reason: string | null;
  /** Full raw payload — kept for debugging / future use. */
  raw: unknown;
}

export async function getVexaTranscripts(opts: {
  apiUrl: string;
  apiKey: string;
  platform: VexaBotCreateOpts["platform"];
  nativeMeetingId: string;
}): Promise<VexaTranscriptsResult> {
  const url = `${trimTrailingSlash(opts.apiUrl)}/transcripts/${encodeURIComponent(
    opts.platform,
  )}/${encodeURIComponent(opts.nativeMeetingId)}`;
  const r = await fetch(url, {
    headers: { "X-API-Key": opts.apiKey },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(
      `Vexa transcripts fetch failed ${r.status}: ${text.slice(0, 400)}`,
    );
  }
  let parsed: {
    id?: unknown;
    status?: unknown;
    segments?: unknown;
    start_time?: unknown;
    data?: unknown;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Vexa transcripts returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
  const segs = Array.isArray(parsed.segments)
    ? (parsed.segments as VexaTranscriptsResult["segments"])
    : [];

  // `data` envelope holds participants + completion_reason. Vexa keeps these
  // here (not at top level) — verified against the live response shape.
  const data =
    parsed.data && typeof parsed.data === "object"
      ? (parsed.data as Record<string, unknown>)
      : {};
  const participants = Array.isArray(data.participants)
    ? (data.participants as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  const completionReason =
    typeof data.completion_reason === "string"
      ? (data.completion_reason as string)
      : null;

  return {
    id: typeof parsed.id === "number" ? parsed.id : -1,
    status: (typeof parsed.status === "string"
      ? parsed.status
      : "active") as VexaTranscriptsResult["status"],
    segments: segs,
    start_time:
      typeof parsed.start_time === "string" ? parsed.start_time : null,
    participants,
    completion_reason: completionReason,
    raw: parsed,
  };
}

/**
 * Parse a meeting URL into the (platform, native_meeting_id, passcode) tuple
 * Vexa expects. Throws if the URL doesn't match a supported platform — the
 * caller should treat that as a fatal dispatch error and mark the MeetingState
 * `failed` (same way the existing alarm handler treats a missing meeting_url).
 *
 * Patterns recognised (verified against docs.vexa.ai/meeting-ids):
 *   Google Meet: `https://meet.google.com/abc-defg-hij`
 *   Zoom:        `https://*.zoom.us/j/123456789(?pwd=...)` — `pwd` returned as passcode
 *   Teams:       `https://teams.microsoft.com/l/meetup-join/<encoded>` —
 *                Vexa uses the full URL-encoded `19:meeting_<id>@thread.v2`
 *                segment as the native id.
 */
export function parseVexaMeetingUrl(meetingUrl: string): {
  platform: VexaBotCreateOpts["platform"];
  nativeMeetingId: string;
  passcode?: string;
} {
  let u: URL;
  try {
    u = new URL(meetingUrl);
  } catch {
    throw new Error(`parseVexaMeetingUrl: invalid URL: ${meetingUrl}`);
  }
  const host = u.hostname.toLowerCase();

  // Google Meet — "meet.google.com/<code>"
  if (host === "meet.google.com" || host.endsWith(".meet.google.com")) {
    const code = u.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (!/^[a-z0-9-]+$/i.test(code) || code.length < 5) {
      throw new Error(`parseVexaMeetingUrl: bad Meet code in ${meetingUrl}`);
    }
    return { platform: "google_meet", nativeMeetingId: code };
  }

  // Zoom — "<*>.zoom.us/j/<id>" with optional embedded `?pwd=<token>`.
  // Most Zoom share-links carry pwd in the querystring; pulling it here lets
  // the user paste a single URL and have the bot join without a second prompt.
  if (host.endsWith("zoom.us")) {
    const m = u.pathname.match(/\/j\/(\d+)/);
    if (!m) {
      throw new Error(`parseVexaMeetingUrl: bad Zoom path in ${meetingUrl}`);
    }
    const pwd = u.searchParams.get("pwd");
    return {
      platform: "zoom",
      nativeMeetingId: m[1],
      passcode: pwd && pwd.length > 0 ? pwd : undefined,
    };
  }

  // Microsoft Teams — "teams.microsoft.com/l/meetup-join/<urlencoded id>/..."
  if (host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com")) {
    const m = u.pathname.match(/\/l\/meetup-join\/([^/]+)/);
    if (!m) {
      throw new Error(`parseVexaMeetingUrl: bad Teams path in ${meetingUrl}`);
    }
    return { platform: "teams", nativeMeetingId: decodeURIComponent(m[1]) };
  }

  throw new Error(`parseVexaMeetingUrl: unsupported host ${host} in ${meetingUrl}`);
}
