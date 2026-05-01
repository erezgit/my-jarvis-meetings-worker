import type { ExecutionContext, ScheduledEvent } from "@cloudflare/workers-types";
import { json } from "./lib/auth";
import type { Env } from "./lib/types";
import { handleAdminRegister } from "./routes/admin";
import { handleRecallBot } from "./routes/bot";
import { handleRecallLeave } from "./routes/leave";
import { handleRecallPlay } from "./routes/play";
import { handleRecallWebhook } from "./routes/webhook";
import {
  handleOAuthCallback,
  handleOAuthStart,
} from "./routes/calendar-oauth";
import { handleCalendarNotify } from "./routes/calendar-notify";
import { handleCalendarDisconnect } from "./routes/calendar-disconnect";
import { reconcileAllTenants } from "./cron-reconcile";

// Re-export Durable Object classes so wrangler can bind them.
export { MeetingTenantDO } from "./do";
export { MeetingDO } from "./do-meeting";

/**
 * Default Worker fetch handler — single dispatcher over URL path + method.
 *
 * Existing routes:
 *   POST /admin/register             → admin
 *   POST /recall/bot                 → bot
 *   POST /recall/webhook             → webhook (HMAC-authed)
 *   POST /recall/play                → play
 *   POST /recall/leave               → leave
 *   GET  /healthz                    → uptime probe
 *
 * Calendar routes:
 *   GET  /calendar/oauth/start       → 302 to Google consent
 *   GET  /calendar/oauth/callback    → exchange code, register watch, full sync
 *   POST /calendar/notify            → Google push receiver (channel token authed)
 *   POST /calendar/disconnect        → tear down channel + clear DO state
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

      if (path === "/recall/bot" && method === "POST") {
        return await handleRecallBot(request, env);
      }

      if (path === "/recall/webhook" && method === "POST") {
        return await handleRecallWebhook(request, env);
      }

      if (path === "/recall/play" && method === "POST") {
        return await handleRecallPlay(request, env);
      }

      if (path === "/recall/leave" && method === "POST") {
        return await handleRecallLeave(request, env);
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
