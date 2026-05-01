import { json, readBearer, readTenantHeader, tenantKeyMatches } from "../lib/auth";
import { fetchTenantConfig, getTenantStub } from "../do";
import type { Env } from "../lib/types";

/**
 * GET /calendar/status
 *
 * Auth: `Authorization: Bearer <tenant_key>` + `X-Tenant: <slug>`.
 *
 * Returns:
 *   { connected: false }
 *     — tenant has not run the OAuth flow
 *   { connected: true, oauth_email, channel_expires_at?: ISO }
 *     — tenant has a refresh_token + active push channel
 *
 * The dashboard polls this on the Meetings page to render the
 * Connect Calendar card. Source of truth lives in MeetingTenantDO.
 */
export async function handleCalendarStatus(
  request: Request,
  env: Env,
): Promise<Response> {
  const slug = readTenantHeader(request);
  const bearer = readBearer(request);
  if (!slug || !bearer) {
    return json({ ok: false, error: "missing auth" }, 401);
  }

  const stub = getTenantStub(env.MEETING_TENANT, slug);
  const cfg = await fetchTenantConfig(stub, slug);
  if (!cfg) return json({ ok: false, error: "unknown tenant" }, 404);
  if (!tenantKeyMatches(bearer, cfg)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  if (!cfg.google_refresh_token) {
    return json({ connected: false });
  }

  return json({
    connected: true,
    oauth_email: cfg.google_oauth_email ?? null,
    channel_expires_at: cfg.google_channel_expiration_ms
      ? new Date(cfg.google_channel_expiration_ms).toISOString()
      : null,
  });
}
