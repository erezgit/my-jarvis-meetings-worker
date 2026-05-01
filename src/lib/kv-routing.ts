/**
 * KV reverse-lookup: `channel_id → tenant_slug`.
 *
 * Google Calendar webhook payloads carry only the channel id (X-Goog-Channel-Id),
 * not metadata. We need a mapping from channel id back to which tenant owns it.
 * KV's eventual consistency is fine here — channel registration writes the
 * mapping BEFORE returning to the caller, and the first push usually arrives
 * seconds later. Worst case the first push 200s as "drop" and Google retries.
 */

import type { KVNamespace } from "@cloudflare/workers-types";

const KEY_PREFIX = "channel:";

function key(channelId: string): string {
  return `${KEY_PREFIX}${channelId}`;
}

/** Look up the tenant for a given channel id. Returns null if unknown. */
export async function getTenantByChannelId(
  kv: KVNamespace,
  channelId: string,
): Promise<string | null> {
  const v = await kv.get(key(channelId));
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Upsert the mapping. */
export async function setChannelTenant(
  kv: KVNamespace,
  channelId: string,
  tenantSlug: string,
): Promise<void> {
  await kv.put(key(channelId), tenantSlug);
}

/** Remove the mapping. */
export async function removeChannel(
  kv: KVNamespace,
  channelId: string,
): Promise<void> {
  await kv.delete(key(channelId));
}

/**
 * List all (channel_id, tenant_slug) pairs. Used by the reconcile cron to
 * iterate known tenants. KV `list` paginates; we walk all pages.
 */
export async function listAllChannelTenants(
  kv: KVNamespace,
): Promise<Array<{ channelId: string; tenantSlug: string }>> {
  const out: Array<{ channelId: string; tenantSlug: string }> = [];
  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await kv.list({ prefix: KEY_PREFIX, cursor });
    for (const k of page.keys) {
      const tenant = await kv.get(k.name);
      if (tenant) {
        out.push({
          channelId: k.name.slice(KEY_PREFIX.length),
          tenantSlug: tenant,
        });
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}
