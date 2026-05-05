import { json } from "../lib/auth";
import type { Env } from "../lib/types";

/**
 * POST /v1/audio/transcriptions
 *
 * OpenAI Whisper-API-compatible proxy that runs Cloudflare Workers AI's
 * `@cf/openai/whisper-large-v3-turbo` model on the request's audio. Vexa
 * Lite calls this URL via its `TRANSCRIPTION_SERVICE_URL` env — it thinks
 * it's hitting a Whisper deployment somewhere; it's actually our Worker
 * fanning out to CF's edge GPU farm.
 *
 * Why this beats embedded faster-whisper-on-CPU:
 *   - GPU inference: ~10-15× real-time vs ~0.5× on a 2-vCPU box
 *   - $0.00051 / audio-minute (~$1/mo at 30 active hours)
 *   - No Fly GPU approval needed; runs on the same Cloudflare account
 *   - One less moving part on the Vexa Fly machine
 *
 * Auth: `Authorization: Bearer <WHISPER_PROXY_TOKEN>` — must match the
 * `TRANSCRIPTION_SERVICE_TOKEN` env Vexa sends. Failure returns 401.
 *
 * Request body: multipart/form-data with `file` (audio, any container
 * Whisper accepts: WAV/MP3/OGG/FLAC/M4A), optional `language` (e.g. "he"),
 * optional `model` (ignored — we always use turbo).
 *
 * Response: OpenAI-shaped JSON `{ text, language, duration?, segments }`.
 * Vexa's collector pipeline reads `text` + `segments`.
 */
export async function handleWhisperTranscribe(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // Constant-time-ish bearer compare against the proxy secret.
  const auth = request.headers.get("Authorization") ?? "";
  const expected = env.WHISPER_PROXY_TOKEN ?? "";
  if (!expected) {
    return json({ error: "WHISPER_PROXY_TOKEN not configured" }, 500);
  }
  if (auth !== `Bearer ${expected}`) {
    return json({ error: "unauthorized" }, 401);
  }

  // Vexa sends an audio file in `file` plus form fields like model + language.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "expected multipart/form-data" }, 400);
  }

  const file = formData.get("file");
  // Workers FormData returns string | File; checking for `arrayBuffer` is the
  // safest cross-runtime way without depending on `instanceof File` which TS
  // can be picky about under @cloudflare/workers-types.
  if (
    !file ||
    typeof file === "string" ||
    typeof (file as Blob).arrayBuffer !== "function"
  ) {
    return json({ error: "file field required" }, 400);
  }
  const langField = formData.get("language");
  const language = typeof langField === "string" ? langField : undefined;

  // Workers AI's Whisper turbo accepts audio as a base64 string. Read the
  // multipart bytes and encode them.
  const buf = await (file as Blob).arrayBuffer();
  const audioBytes = new Uint8Array(buf);

  // Build base64 in chunks to avoid stack overflow on large arrays.
  let binary = "";
  const CHUNK = 32_768;
  for (let i = 0; i < audioBytes.length; i += CHUNK) {
    binary += String.fromCharCode(...audioBytes.subarray(i, i + CHUNK));
  }
  const audioBase64 = btoa(binary);

  // Workers AI input. Anti-hallucination params per arxiv 2501.11378 +
  // openai/whisper #679 — Whisper-turbo defaults are worst-case for silence
  // hallucinations (Hebrew "תודה רבה", English "thanks for watching", etc.).
  // These settings drop hallucinations ~21% → ~0.2% in published benchmarks.
  type WhisperInput = {
    audio: string;
    language?: string;
    task?: "transcribe" | "translate";
    vad_filter?: boolean;
    condition_on_previous_text?: boolean;
    no_speech_threshold?: number;
    compression_ratio_threshold?: number;
    beam_size?: number;
    hallucination_silence_threshold?: number;
  };
  type WhisperResponse = {
    transcription_info?: { text?: string };
    text?: string;
    vtt?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };
  const aiInput: WhisperInput = {
    audio: audioBase64,
    // Silero VAD on Whisper's input — biggest single hallucination mitigation.
    vad_filter: true,
    // Don't carry hallucinated phrases forward across segments.
    condition_on_previous_text: false,
    // CF default 0.6 is too permissive — flag more silence as silence.
    no_speech_threshold: 0.2,
    // Filter repetitive hallucinations.
    compression_ratio_threshold: 2.4,
    // Counterintuitive: arxiv 2501.11378 Table VI shows larger beams
    // INCREASED hallucinations on silent audio. beam_size=1 wins.
    beam_size: 1,
    // CF-specific: skip silent runs longer than this many seconds.
    hallucination_silence_threshold: 2,
  };
  if (language && language !== "auto") aiInput.language = language;

  let aiOut: WhisperResponse;
  try {
    aiOut = (await (env.AI as { run(model: string, input: WhisperInput): Promise<WhisperResponse> }).run(
      "@cf/openai/whisper-large-v3-turbo",
      aiInput,
    )) as WhisperResponse;
  } catch (err) {
    console.error(
      "[whisper-proxy] Workers AI call failed:",
      err instanceof Error ? err.message : err,
    );
    return json({ error: "transcription failed", detail: String(err) }, 502);
  }

  // turbo returns nested `transcription_info.text`; legacy returns top-level `text`.
  let text = aiOut.transcription_info?.text ?? aiOut.text ?? "";
  let segments = (aiOut.segments ?? []).map((s) => ({
    start: typeof s.start === "number" ? s.start : 0,
    end: typeof s.end === "number" ? s.end : 0,
    text: typeof s.text === "string" ? s.text : "",
  }));

  // Defense-in-depth: drop known Whisper hallucination phrases that slip
  // past the VAD filter. The Hebrew "תודה רבה" pattern is a YouTube-outro
  // training-data artifact; Vexa's upstream filter has en/es/pt/ru phrase
  // lists but no Hebrew. Filter both whole-text and individual segments.
  if (isWhisperHallucination(text)) {
    text = "";
    segments = [];
  } else if (segments.length > 0) {
    segments = segments.filter((s) => !isWhisperHallucination(s.text));
    // If filtering left zero segments but full text was non-trivial, keep
    // text — it's probably one continuous hallucination-free utterance.
    if (segments.length === 0 && !isWhisperHallucination(text)) {
      // keep as-is
    }
  }

  return json({
    text,
    language: language ?? null,
    segments,
  });
}

/**
 * Detect known Whisper-turbo hallucinations. Most are YouTube-outro
 * training-data artifacts that surface on silent or near-silent audio.
 *
 * Sources for these patterns:
 *   - openai/whisper #1455, #679, #1873
 *   - whisper.cpp #1490, #1724
 *   - collabora/WhisperLive #185
 *   - ivrit.ai (Hebrew Whisper fine-tuners)
 */
function isWhisperHallucination(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (text.length === 0) return false;

  // Strip common punctuation and collapse whitespace for matching.
  const norm = text
    .replace(/[.,!?…׃׀״״״''""()\-—–]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Hebrew patterns — the YouTube outro tokens for he-IL.
  const HEBREW: RegExp[] = [
    /^תודה(\s+רבה)?$/u,
    /^תודה\s+רבה\s+על\s+הצפייה$/u,
    /^תודה\s+על\s+הצפייה$/u,
    /^נתראה\s+בפרק\s+הבא$/u,
    /^כתוביות.*$/u,
    /^עריכת\s+כתוביות.*$/u,
    /^בהצלחה$/u,
  ];
  if (HEBREW.some((rx) => rx.test(norm))) return true;

  // English patterns — the canonical YouTube outros Whisper learned.
  const lower = norm.toLowerCase();
  const ENGLISH: RegExp[] = [
    /^thanks?\s+for\s+watching$/,
    /^thank\s+you\s+for\s+watching$/,
    /^thanks?\s+for\s+watching\s+(this\s+)?video$/,
    /^subscribe\b.*$/,
    /^please\s+subscribe.*$/,
    /^like\s+and\s+subscribe.*$/,
    /^see\s+you\s+(in\s+the\s+)?next\s+(video|episode)$/,
    /^bye(\s*bye)?$/,
    /^you('re)?\s+watching.*$/,
  ];
  if (ENGLISH.some((rx) => rx.test(lower))) return true;

  return false;
}
