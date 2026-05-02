/**
 * Vexa.ai bot dispatch helper. Mirrors the shape of `recall-bot.ts` so
 * `do-meeting.ts` can swap providers behind a tenant-level `bot_provider`
 * switch without changing call sites.
 *
 * Vexa is the Apache-2.0 alternative to Recall.ai. Self-hosted on a Linux
 * box (Hetzner $5 VPS in Erez's deployment plan) running Vexa Lite. Uses
 * its own faster-whisper(large-v3-turbo) for STT, replacing the Recall →
 * DeepGram pipeline in one move. Same Whisper family the user already
 * validated for Hebrew via OpenSuperWhisper locally.
 *
 * API spec source: https://docs.vexa.ai/api/bots and /api/interactive-bots
 * Verified against the official docs site on 2026-05-01.
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
  const botName = opts.botName && opts.botName.length > 0 ? opts.botName : "Jarvis";

  const body: Record<string, unknown> = {
    platform: opts.platform,
    native_meeting_id: opts.nativeMeetingId,
    language,
    task,
    bot_name: botName,
    recording_enabled: opts.recordingEnabled ?? true,
    transcribe_enabled: opts.transcribeEnabled ?? true,
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
  if (typeof parsed.id !== "string") {
    throw new Error(`Vexa bot create response missing id: ${text.slice(0, 200)}`);
  }
  return {
    bot_id: parsed.id,
    platform: opts.platform,
    native_meeting_id: opts.nativeMeetingId,
    raw: parsed,
  };
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
 * Parse a meeting URL into the (platform, native_meeting_id) pair Vexa
 * expects. Throws if the URL doesn't match a supported platform — the caller
 * should treat that as a fatal dispatch error and mark the MeetingState
 * `failed` (same way the existing alarm handler treats a missing meeting_url).
 *
 * Patterns recognised (verified against docs.vexa.ai/meeting-ids):
 *   Google Meet: `https://meet.google.com/abc-defg-hij`
 *   Zoom:        `https://*.zoom.us/j/123456789(?pwd=...)`
 *   Teams:       `https://teams.microsoft.com/l/meetup-join/<encoded>` —
 *                Vexa uses the full URL-encoded `19:meeting_<id>@thread.v2`
 *                segment as the native id.
 */
export function parseVexaMeetingUrl(meetingUrl: string): {
  platform: VexaBotCreateOpts["platform"];
  nativeMeetingId: string;
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

  // Zoom — "<*>.zoom.us/j/<id>"
  if (host.endsWith("zoom.us")) {
    const m = u.pathname.match(/\/j\/(\d+)/);
    if (!m) {
      throw new Error(`parseVexaMeetingUrl: bad Zoom path in ${meetingUrl}`);
    }
    return { platform: "zoom", nativeMeetingId: m[1] };
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
