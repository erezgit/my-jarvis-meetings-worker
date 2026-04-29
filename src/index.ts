import { json } from "./lib/auth";
import type { Env } from "./lib/types";
import { handleAdminRegister } from "./routes/admin";
import { handleRecallBot } from "./routes/bot";
import { handleRecallLeave } from "./routes/leave";
import { handleRecallPlay } from "./routes/play";
import { handleRecallWebhook } from "./routes/webhook";

// Re-export the Durable Object class so wrangler can bind it.
export { MeetingTenantDO } from "./do";

/**
 * Default Worker fetch handler — single dispatcher over URL path + method.
 *
 * Route table:
 *   POST /admin/register      → admin
 *   POST /recall/bot          → bot
 *   POST /recall/webhook      → webhook (HMAC-authed)
 *   POST /recall/play         → play
 *   POST /recall/leave        → leave
 *   GET  /healthz             → uptime probe
 *   else                      → 404
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
};
