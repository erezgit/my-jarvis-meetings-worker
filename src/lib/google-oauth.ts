/**
 * Google OAuth 2.0 helpers — auth code flow with offline access.
 *
 * We hold the refresh_token in MeetingTenantDO storage and exchange it for
 * short-lived access tokens on demand. Access tokens are NOT persisted; we
 * fetch fresh per call (Google caches our refresh_token internally so this is
 * a normal, supported pattern).
 *
 * Scopes (minimum):
 *   https://www.googleapis.com/auth/calendar.events.readonly
 *   https://www.googleapis.com/auth/userinfo.email
 *   https://www.googleapis.com/auth/userinfo.profile
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/** Build the Google authorisation redirect URL. */
export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface ExchangeCodeResult {
  access_token: string;
  refresh_token: string;
  /** ID token JWT (header.payload.signature) — payload contains the email claim. */
  id_token?: string;
  /** Seconds until access_token expires (typically 3599). */
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Exchange the auth code for tokens. */
export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<ExchangeCodeResult> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Google token exchange failed ${r.status}: ${text}`);
  }
  const parsed = JSON.parse(text) as ExchangeCodeResult;
  if (typeof parsed.refresh_token !== "string" || parsed.refresh_token.length === 0) {
    throw new Error(
      "Google token exchange returned no refresh_token — user may have already granted; revoke and retry",
    );
  }
  return parsed;
}

export interface RefreshAccessTokenResult {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Use the long-lived refresh_token to mint a new short-lived access_token. */
export async function refreshAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<RefreshAccessTokenResult> {
  const body = new URLSearchParams({
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Google token refresh failed ${r.status}: ${text}`);
  }
  return JSON.parse(text) as RefreshAccessTokenResult;
}

/**
 * Decode the email claim out of an id_token JWT. Does NOT verify signature —
 * we trust the value because the JWT was returned over TLS directly from
 * Google's token endpoint as part of an exchange we initiated.
 */
export function decodeIdTokenEmail(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(b64UrlDecodeToString(parts[1])) as {
      email?: unknown;
    };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

/** Base64url decode → UTF-8 string. */
function b64UrlDecodeToString(s: string): string {
  // Pad to a multiple of 4 and translate -_ to +/.
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  // atob is available in Workers runtime.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
