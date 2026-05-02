import { json, readBearer } from "../lib/auth";
import type { AdminRegisterBody, Env } from "../lib/types";
import { getTenantStub, setTenantConfig } from "../do";

/**
 * POST /admin/register
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>`
 *
 * Body: { slug, database_url, recall_webhook_secret, tenant_key }
 *
 * Idempotent: writes config into the tenant's MeetingTenantDO, replacing
 * whatever was there. Adding a brand-new tenant or rotating any of its
 * secrets is the same call.
 */
export async function handleAdminRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  const bearer = readBearer(request);
  if (!bearer || !env.ADMIN_TOKEN || bearer !== env.ADMIN_TOKEN) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: AdminRegisterBody;
  try {
    body = (await request.json()) as AdminRegisterBody;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  if (
    typeof body?.slug !== "string" ||
    body.slug.trim().length === 0 ||
    typeof body?.database_url !== "string" ||
    typeof body?.recall_webhook_secret !== "string" ||
    typeof body?.tenant_key !== "string"
  ) {
    return json(
      { ok: false, error: "missing required fields" },
      400,
    );
  }

  // Optional bot_provider — accepted for the Recall→Vexa cutover. Validated
  // here so a typo in a curl call doesn't get persisted as garbage.
  let botProvider: "recall" | "vexa" | undefined;
  if (body.bot_provider !== undefined) {
    if (body.bot_provider !== "recall" && body.bot_provider !== "vexa") {
      return json(
        { ok: false, error: "bot_provider must be 'recall' or 'vexa'" },
        400,
      );
    }
    botProvider = body.bot_provider;
  }

  const slug = body.slug.trim();
  const stub = getTenantStub(env.MEETING_TENANT, slug);
  await setTenantConfig(stub, slug, {
    database_url: body.database_url,
    recall_webhook_secret: body.recall_webhook_secret,
    tenant_key: body.tenant_key,
    bot_provider: botProvider,
  });

  console.log(
    `[admin/register] slug=${slug}${botProvider ? ` bot_provider=${botProvider}` : ""}`,
  );
  return json({ ok: true });
}
