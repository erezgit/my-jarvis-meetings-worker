/**
 * HMAC-SHA256 helpers for signing/verifying the per-tenant Recall webhook URL.
 * The signed payload is the tenant slug — short, stable, and tenant-scoped,
 * which is exactly what we need to authenticate inbound Recall callbacks.
 */

/** Lower-case hex of HMAC-SHA256(secret, message). */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufferToHex(sig);
}

/**
 * Constant-time hex comparison. Returns false on length mismatch without
 * leaking via early-exit. Inputs are normalised to lower-case to tolerate
 * either case in the inbound query string.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }
  return diff === 0;
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? "0" + h : h;
  }
  return out;
}
