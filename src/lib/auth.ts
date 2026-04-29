import type { TenantConfig } from "./types";

/**
 * Extract a `Bearer <token>` value from the `Authorization` header.
 * Returns null on missing header, wrong scheme, or empty token.
 */
export function readBearer(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/** Read the tenant slug from the `X-Tenant` header. */
export function readTenantHeader(request: Request): string | null {
  const v = request.headers.get("X-Tenant") ?? request.headers.get("x-tenant");
  if (!v) return null;
  const slug = v.trim();
  return slug.length > 0 ? slug : null;
}

/**
 * Verify the bearer matches this tenant's stored `tenant_key`. Constant-time
 * to avoid leaking key length via early exit on mismatched prefixes.
 */
export function tenantKeyMatches(
  bearer: string,
  config: TenantConfig,
): boolean {
  return constantTimeStringEq(bearer, config.tenant_key);
}

function constantTimeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Standard JSON helper for route handlers. */
export function json(
  body: unknown,
  init: number | ResponseInit = 200,
): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  return new Response(JSON.stringify(body), {
    ...responseInit,
    headers: {
      "Content-Type": "application/json",
      ...(responseInit.headers ?? {}),
    },
  });
}
