import type { ExecutionContext, ScheduledEvent } from "@cloudflare/workers-types";
import { json } from "./lib/auth";
import type { Env } from "./lib/types";
import { handleAdminRegister } from "./routes/admin";
import { handleMeetingBot } from "./routes/bot";
import { handleMeetingLeave } from "./routes/leave";
import { handleMeetingPlay } from "./routes/play";
import { handleVexaTranscript } from "./routes/vexa-transcript";
import { handleWhisperTranscribe } from "./routes/whisper-transcribe";
import {
  handleOAuthCallback,
  handleOAuthStart,
} from "./routes/calendar-oauth";
import { handleCalendarNotify } from "./routes/calendar-notify";
import { handleCalendarDisconnect } from "./routes/calendar-disconnect";
import { handleCalendarStatus } from "./routes/calendar-status";
import { reconcileAllTenants } from "./cron-reconcile";

// Re-export Durable Object classes so wrangler can bind them.
export { MeetingTenantDO } from "./do";
export { MeetingDO } from "./do-meeting";

/**
 * Default Worker fetch handler — single dispatcher over URL path + method.
 *
 * Meeting routes:
 *   POST /admin/register             → admin
 *   POST /meeting/bot                → start a bot for a meeting URL
 *   POST /meeting/play               → play TTS audio through the bot
 *   POST /meeting/leave              → kick the bot
 *   POST /vexa/transcript            → ingest a Vexa relay transcript segment
 *   POST /v1/audio/transcriptions    → Workers-AI Whisper proxy for Vexa
 *   GET  /healthz                    → uptime probe
 *
 * Calendar routes:
 *   GET  /calendar/oauth/start       → 302 to Google consent
 *   GET  /calendar/oauth/callback    → exchange code, register watch, full sync
 *   POST /calendar/notify            → Google push receiver (channel token authed)
 *   POST /calendar/disconnect        → tear down channel + clear DO state
 *   GET  /calendar/status            → connected? oauth_email? channel expires?
 *
 * Legacy redirects (will be removed once dashboards/scripts are updated):
 *   POST /recall/bot   → 308 → /meeting/bot
 *   POST /recall/play  → 308 → /meeting/play
 *   POST /recall/leave → 308 → /meeting/leave
 *
 * Scheduled handler runs every 5 min:
 *   - Channel renewal at T-24h
 *   - Missed-dispatch reconcile (DLQ for at-least-once alarms)
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      if (path === "/healthz" && method === "GET") {
        return json({ ok: true, ts: Date.now() });
      }

      if (path === "/admin/register" && method === "POST") {
        return await handleAdminRegister(request, env);
      }

      // Meeting bot routes — Vexa-only as of commit a1d9140.
      if (path === "/meeting/bot" && method === "POST") {
        return await handleMeetingBot(request, env);
      }
      if (path === "/meeting/play" && method === "POST") {
        return await handleMeetingPlay(request, env);
      }
      if (path === "/meeting/leave" && method === "POST") {
        return await handleMeetingLeave(request, env);
      }

      // Legacy /recall/* paths — 308 Permanent Redirect (preserves method + body).
      // Active until all callers (dashboards, scripts) migrate. Remove after
      // a deprecation window.
      if (path === "/recall/bot" && method === "POST") {
        return Response.redirect(
          new URL("/meeting/bot", url).toString(),
          308,
        );
      }
      if (path === "/recall/play" && method === "POST") {
        return Response.redirect(
          new URL("/meeting/play", url).toString(),
          308,
        );
      }
      if (path === "/recall/leave" && method === "POST") {
        return Response.redirect(
          new URL("/meeting/leave", url).toString(),
          308,
        );
      }

      // Vexa relay → Worker transcript ingest.
      if (path === "/vexa/transcript" && method === "POST") {
        return await handleVexaTranscript(request, env);
      }

      // Whisper-API-compatible proxy for Vexa Lite. Vexa points its
      // TRANSCRIPTION_SERVICE_URL at this endpoint and we fan out to
      // Cloudflare Workers AI's GPU-backed Whisper. Replaces embedded
      // faster-whisper on the Fly Vexa box.
      if (path === "/v1/audio/transcriptions" && method === "POST") {
        return await handleWhisperTranscribe(request, env);
      }

      // Calendar routes — accept GET on /oauth/start so a plain link can kick
      // off the flow (POST also fine if someone wants form-style).
      if (path === "/calendar/oauth/start" && (method === "GET" || method === "POST")) {
        return await handleOAuthStart(request, env);
      }

      if (path === "/calendar/oauth/callback" && method === "GET") {
        return await handleOAuthCallback(request, env, ctx);
      }

      if (path === "/calendar/notify" && method === "POST") {
        return await handleCalendarNotify(request, env, ctx);
      }

      if (path === "/calendar/disconnect" && method === "POST") {
        return await handleCalendarDisconnect(request, env);
      }

      if (path === "/calendar/status" && method === "GET") {
        return await handleCalendarStatus(request, env);
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      console.error(`[fatal] ${method} ${path}:`, err);
      return json(
        {
          ok: false,
          error: "internal error",
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  },

  /**
   * Cron handler — `*\/5 * * * *`. Runs in the same isolate as fetch, sharing
   * env bindings. Heavy work goes via ctx.waitUntil so the scheduled invocation
   * itself returns quickly (CF kills scheduled workers after ~30s wall time).
   */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(reconcileAllTenants(env));
  },
};
