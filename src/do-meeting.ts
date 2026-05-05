import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStub,
} from "@cloudflare/workers-types";
import { fetchTenantConfig, getTenantStub } from "./do";
import { hmacSha256Hex } from "./lib/hmac";
import { createRecallBot, recallBotLeave } from "./lib/recall-bot";
import {
  createVexaBot,
  getVexaTranscripts,
  parseVexaMeetingUrl,
  vexaBotLeave,
} from "./lib/vexa-bot";
import { adaptVexaSegment } from "./lib/vexa-transcript-adapter";
import { insertTranscriptSegment } from "./lib/neon";
import {
  markMeetingDispatched,
  markMeetingEnded,
  markMeetingLive,
} from "./lib/meeting-persistence";
import type {
  Env,
  MeetingState,
  MeetingUpsertBody,
  TenantConfig,
} from "./lib/types";

/**
 * MeetingDO — one instance per (tenant_slug, google_event_id).
 * idFromName: `meeting:<tenant_slug>:<google_event_id>`.
 *
 * Storage:
 *   "state" → MeetingState
 *
 * Internal HTTP surface:
 *   POST /_internal/upsert       body: MeetingUpsertBody    -> 200 {ok, state}
 *   POST /_internal/cancel                                  -> 200 {ok}
 *   GET  /_internal/state                                   -> 200 MeetingState | 404
 *
 * On `setAlarm`, when the alarm fires we:
 *   1. No-op if status === 'dispatched' || dispatched_at_ms is set (idempotent)
 *   2. No-op if status === 'cancelled'
 *   3. Call Recall to spawn a bot
 *   4. UPSERT into tenant Neon `calendar_events` + `meetings`
 *   5. Persist new state with status='dispatched'
 *
 * IDEMPOTENCY: Cloudflare retries alarm() up to 6× on thrown errors. Recall
 * gets an Idempotency-Key per (tenant, event) so duplicates are no-ops on
 * their side too. The dispatched_at_ms check is the primary guard.
 */
export class MeetingDO {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === "/_internal/upsert" && method === "POST") {
      const body = (await request.json()) as MeetingUpsertBody;
      if (
        typeof body?.tenant_slug !== "string" ||
        typeof body?.google_event_id !== "string" ||
        typeof body?.start_time_ms !== "number" ||
        typeof body?.end_time_ms !== "number" ||
        typeof body?.title !== "string" ||
        typeof body?.meeting_url !== "string"
      ) {
        return jsonResponse({ ok: false, error: "invalid body" }, 400);
      }

      const existing =
        (await this.state.storage.get<MeetingState>("state")) ?? null;

      // Preserve dispatch state across upserts — if we already fired the bot
      // we don't want a calendar update to flip status back to 'scheduled'.
      // Prefer existing meeting_id_neon (set at first persist) over body.meeting_id
      // — the FK never changes once set.
      const next: MeetingState = {
        tenant_slug: body.tenant_slug,
        google_event_id: body.google_event_id,
        start_time_ms: body.start_time_ms,
        end_time_ms: body.end_time_ms,
        title: body.title,
        meeting_url: body.meeting_url,
        status: existing?.status === "dispatched" ? "dispatched" : "scheduled",
        recall_bot_id: existing?.recall_bot_id ?? null,
        dispatched_at_ms: existing?.dispatched_at_ms ?? null,
        meeting_id_neon:
          existing?.meeting_id_neon ?? body.meeting_id ?? null,
      };
      await this.state.storage.put("state", next);

      // Schedule the alarm 90s before start_time. The 90-second buffer
      // accommodates Fly Machines `suspend` wake-up + Vexa container start
      // when bot_provider="vexa". For bot_provider="recall" this is a no-op
      // — Recall just gets the bot in the lobby a minute earlier. Past
      // timestamps can silently never fire (CF issue #18324) — clamp to
      // now+1s as the documented workaround.
      if (next.status === "scheduled") {
        const target = next.start_time_ms - 90_000;
        const safe = Math.max(target, Date.now() + 1000);
        await this.state.storage.setAlarm(safe);
      }

      return jsonResponse({ ok: true, state: next });
    }

    if (url.pathname === "/_internal/start-vexa-polling" && method === "POST") {
      // Used by /recall/bot for manually-started meetings (no calendar event).
      // Seeds the DO with a synthetic state already in "dispatched" mode and
      // arms the transcript-polling alarm 30s out. Idempotent — re-calling is
      // a no-op if state already shows the same bot.
      const body = (await request.json()) as {
        tenant_slug: string;
        bot_id: string;
        meeting_url: string;
        platform: "google_meet" | "zoom" | "teams";
        native_meeting_id: string;
        meeting_id_neon?: number | null;
        title?: string;
      };
      if (
        typeof body?.tenant_slug !== "string" ||
        typeof body?.bot_id !== "string" ||
        typeof body?.platform !== "string" ||
        typeof body?.native_meeting_id !== "string"
      ) {
        return jsonResponse({ ok: false, error: "invalid body" }, 400);
      }
      const existing =
        (await this.state.storage.get<MeetingState>("state")) ?? null;
      if (existing?.recall_bot_id === body.bot_id) {
        return jsonResponse({ ok: true, already: true });
      }
      const now = Date.now();
      const next: MeetingState = {
        tenant_slug: body.tenant_slug,
        google_event_id: `manual-${body.bot_id}`,
        start_time_ms: now,
        end_time_ms: now + 4 * 60 * 60 * 1000,
        title: body.title ?? "manual",
        meeting_url: body.meeting_url,
        status: "dispatched",
        recall_bot_id: body.bot_id,
        dispatched_at_ms: now,
        meeting_id_neon: body.meeting_id_neon ?? null,
        bot_provider: "vexa",
        vexa_platform: body.platform,
        vexa_native_meeting_id: body.native_meeting_id,
        poll_started_ms: now,
      };
      await this.state.storage.put("state", next);
      // First poll 30s out — gives the bot time to actually join.
      await this.state.storage.setAlarm(now + 30_000);
      return jsonResponse({ ok: true, state: next });
    }

    if (url.pathname === "/_internal/cancel" && method === "POST") {
      const existing =
        (await this.state.storage.get<MeetingState>("state")) ?? null;
      if (!existing) return jsonResponse({ ok: true, was: "absent" });

      // Best-effort: if we already dispatched, ask Recall to leave.
      if (existing.status === "dispatched" && existing.recall_bot_id) {
        try {
          await recallBotLeave({
            apiKey: this.env.RECALL_API_KEY,
            botId: existing.recall_bot_id,
          });
        } catch (err) {
          console.error(
            `[meeting-do] cancel: recall leave failed for ${existing.recall_bot_id}:`,
            err,
          );
          // Don't throw — cancellation in our state is what matters.
        }
      }

      const next: MeetingState = { ...existing, status: "cancelled" };
      await this.state.storage.put("state", next);
      await this.state.storage.deleteAlarm();
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/_internal/state" && method === "GET") {
      const s = await this.state.storage.get<MeetingState>("state");
      if (!s) return jsonResponse({ ok: false, error: "no state" }, 404);
      return jsonResponse(s);
    }

    return new Response("meeting-do — internal namespace only", { status: 410 });
  }

  /**
   * Alarm handler — must be idempotent. CF Workers fires alarms at-least-once
   * with up to 6 retries on thrown errors before silently dropping.
   *
   * Two responsibilities, branched by state.status:
   *   1. status="scheduled" → dispatch the bot to Recall or Vexa
   *   2. status="dispatched" + bot_provider="vexa" → poll Vexa transcripts
   *      every 5s, insert new segments into Neon, then re-arm the alarm.
   *      Stops when Vexa reports terminal status or polling exceeds budget.
   */
  async alarm(): Promise<void> {
    const s = (await this.state.storage.get<MeetingState>("state")) ?? null;
    if (!s) {
      console.warn("[meeting-do.alarm] no state — orphan alarm dropped");
      return;
    }
    if (
      s.status === "cancelled" ||
      s.status === "failed" ||
      s.status === "completed"
    ) {
      console.log(
        `[meeting-do.alarm] status=${s.status} for event=${s.google_event_id} — terminal, no further alarms`,
      );
      return;
    }

    // Already dispatched and on Vexa → enter the transcript-polling loop.
    if (s.status === "dispatched" && s.bot_provider === "vexa") {
      await this.pollVexaTranscriptsTick(s);
      return;
    }
    // Already dispatched on Recall → webhooks handle it; nothing to do here.
    if (s.status === "dispatched" || s.dispatched_at_ms) {
      console.log(
        `[meeting-do.alarm] already dispatched event=${s.google_event_id} bot=${s.recall_bot_id} provider=${s.bot_provider ?? "recall"}`,
      );
      return;
    }
    if (!s.meeting_url || s.meeting_url.length === 0) {
      // No meeting URL means no Recall bot can join. Mark failed so we don't
      // retry every minute via the reconcile cron.
      const next: MeetingState = { ...s, status: "failed" };
      await this.state.storage.put("state", next);
      console.warn(
        `[meeting-do.alarm] no meeting_url event=${s.google_event_id} — marked failed`,
      );
      return;
    }

    // Pull tenant config — we need recall_webhook_secret for the transcript
    // webhook URL HMAC, plus database_url for the Neon insert.
    const tenantStub = getTenantStub(this.env.MEETING_TENANT, s.tenant_slug);
    const cfg = await fetchTenantConfig(tenantStub, s.tenant_slug);
    if (!cfg) {
      throw new Error(
        `[meeting-do.alarm] tenant ${s.tenant_slug} has no config — cannot dispatch`,
      );
    }

    const sig = await hmacSha256Hex(cfg.recall_webhook_secret, s.tenant_slug);
    const webhookUrl =
      `https://${this.env.WORKER_PUBLIC_HOST}/recall/webhook` +
      `?tenant=${encodeURIComponent(s.tenant_slug)}&sig=${sig}`;

    const dedupeKey = `meeting:${s.tenant_slug}:${s.google_event_id}`;

    // Per-tenant provider switch. Defaults to recall for backward compat —
    // explicitly flipping to "vexa" is how we cut a tenant over.
    const provider: "recall" | "vexa" = cfg.bot_provider ?? "recall";

    let result: { bot_id: string };
    let vexaPlatform: "google_meet" | "zoom" | "teams" | undefined;
    let vexaNativeId: string | undefined;

    if (provider === "vexa") {
      // Vexa pre-flight: must have a configured Vexa instance. Per-tenant
      // config takes precedence; falls back to worker env for tenants that
      // haven't migrated to per-tenant Fly apps yet.
      const vexaUrl = cfg.vexa_api_url || this.env.VEXA_API_URL;
      const vexaKey = cfg.vexa_api_key || this.env.VEXA_API_KEY;
      if (!vexaUrl || vexaUrl.length === 0) {
        throw new Error(
          `[meeting-do.alarm] tenant ${s.tenant_slug} bot_provider=vexa but no vexa_api_url (cfg or env)`,
        );
      }
      if (!vexaKey || vexaKey.length === 0) {
        throw new Error(
          `[meeting-do.alarm] tenant ${s.tenant_slug} bot_provider=vexa but no vexa_api_key (cfg or env)`,
        );
      }

      const parsed = parseVexaMeetingUrl(s.meeting_url);
      vexaPlatform = parsed.platform;
      vexaNativeId = parsed.nativeMeetingId;

      try {
        const out = await createVexaBot({
          apiUrl: vexaUrl,
          apiKey: vexaKey,
          platform: parsed.platform,
          nativeMeetingId: parsed.nativeMeetingId,
          language: "he",
          task: "transcribe",
          botName: "Jarvis",
        });
        result = { bot_id: out.bot_id };
      } catch (err) {
        console.error(
          `[meeting-do.alarm] vexa create failed event=${s.google_event_id}:`,
          err,
        );
        throw err;
      }
    } else {
      try {
        result = await createRecallBot({
          apiKey: this.env.RECALL_API_KEY,
          meetingUrl: s.meeting_url,
          webhookUrl,
          language: "he",
          metadata: {
            tenant: s.tenant_slug,
            event_id: s.google_event_id,
          },
          dedupeKey,
        });
      } catch (err) {
        // Throw — CF will retry up to 6× (exponential backoff) before silent drop.
        // The 5-min reconcile cron is our DLQ for that final silent drop.
        console.error(
          `[meeting-do.alarm] recall create failed event=${s.google_event_id}:`,
          err,
        );
        throw err;
      }
    }

    const dispatchedAt = Date.now();

    // Mark the meeting dispatched in Neon — UPDATEs the meetings row that
    // upsertCalendarMeeting created (status: scheduled → live, sets bot_id)
    // and the calendar_events row (status: scheduled → dispatched).
    try {
      await markMeetingDispatched({
        databaseUrl: cfg.database_url,
        meetingId: s.meeting_id_neon,
        googleEventId: s.google_event_id,
        botId: result.bot_id,
        dispatchedAtMs: dispatchedAt,
      });
    } catch (err) {
      // We DID dispatch — recording the dispatch in our state is more
      // important than the Neon row. Log and continue; the reconcile cron
      // can re-attempt the Neon write.
      console.error(
        `[meeting-do.alarm] neon mark-dispatched failed event=${s.google_event_id} bot=${result.bot_id}:`,
        err,
      );
    }

    const next: MeetingState = {
      ...s,
      status: "dispatched",
      recall_bot_id: result.bot_id,
      dispatched_at_ms: dispatchedAt,
      meeting_id_neon: s.meeting_id_neon,
      bot_provider: provider,
      vexa_platform: vexaPlatform,
      vexa_native_meeting_id: vexaNativeId,
      poll_started_ms: provider === "vexa" ? dispatchedAt : undefined,
    };
    await this.state.storage.put("state", next);
    console.log(
      `[meeting-do.alarm] dispatched event=${s.google_event_id} bot=${result.bot_id} tenant=${s.tenant_slug} provider=${provider}`,
    );

    // Vexa: arm the transcript-polling loop. First poll fires 30s after
    // dispatch — gives the bot time to join and produce its first segment.
    if (provider === "vexa") {
      await this.state.storage.setAlarm(Date.now() + 30_000);
    }
  }

  /**
   * One tick of the Vexa transcript-polling loop. Called from alarm() when
   * status === "dispatched" && bot_provider === "vexa".
   *
   * Each tick:
   *   1. GET Vexa /transcripts/<platform>/<native_id>
   *   2. Filter segments where absolute_end_time > state.last_synced_iso
   *   3. Insert each new segment into Neon meeting_transcript
   *   4. Advance last_synced_iso to the new max
   *   5. If Vexa reports terminal status → mark our state terminal, no re-alarm
   *      Else → re-alarm in 5s
   *
   * Errors don't throw past this method — they log + still re-alarm so a
   * transient Vexa hiccup doesn't permanently stop polling.
   */
  private async pollVexaTranscriptsTick(s: MeetingState): Promise<void> {
    const RE_ALARM_MS = 1_000;
    const HARD_BUDGET_MS = 4 * 60 * 60 * 1000; // 4 hours
    const POLL_BUDGET_EXCEEDED =
      s.poll_started_ms !== undefined &&
      Date.now() - s.poll_started_ms > HARD_BUDGET_MS;

    if (POLL_BUDGET_EXCEEDED) {
      console.warn(
        `[meeting-do.poll] budget exceeded event=${s.google_event_id} — stopping`,
      );
      const next: MeetingState = { ...s, status: "completed" };
      await this.state.storage.put("state", next);
      // Reflect into Neon — fetch tenant config for the database URL.
      try {
        const tenantStub = getTenantStub(
          this.env.MEETING_TENANT,
          s.tenant_slug,
        );
        const cfg = await fetchTenantConfig(tenantStub, s.tenant_slug);
        if (cfg) {
          await markMeetingEnded({
            databaseUrl: cfg.database_url,
            meetingId: s.meeting_id_neon,
            botId: s.recall_bot_id,
          });
        }
      } catch (err) {
        console.error(
          `[meeting-do.poll] mark-ended (budget) failed event=${s.google_event_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return;
    }

    if (
      !s.vexa_platform ||
      !s.vexa_native_meeting_id ||
      !s.recall_bot_id
    ) {
      console.error(
        `[meeting-do.poll] missing state event=${s.google_event_id} — re-alarming`,
      );
      await this.state.storage.setAlarm(Date.now() + RE_ALARM_MS);
      return;
    }

    const tenantStub = getTenantStub(this.env.MEETING_TENANT, s.tenant_slug);
    const cfg = await fetchTenantConfig(tenantStub, s.tenant_slug);
    if (!cfg) {
      console.error(
        `[meeting-do.poll] no tenant cfg slug=${s.tenant_slug} — re-alarming`,
      );
      await this.state.storage.setAlarm(Date.now() + RE_ALARM_MS);
      return;
    }
    const vexaUrl = cfg.vexa_api_url || this.env.VEXA_API_URL;
    const vexaKey = cfg.vexa_api_key || this.env.VEXA_API_KEY;
    if (!vexaUrl || !vexaKey) {
      console.error(
        `[meeting-do.poll] no vexa creds (cfg or env) slug=${s.tenant_slug}`,
      );
      await this.state.storage.setAlarm(Date.now() + RE_ALARM_MS);
      return;
    }

    let result;
    try {
      result = await getVexaTranscripts({
        apiUrl: vexaUrl,
        apiKey: vexaKey,
        platform: s.vexa_platform,
        nativeMeetingId: s.vexa_native_meeting_id,
      });
    } catch (err) {
      console.error(
        `[meeting-do.poll] fetch failed event=${s.google_event_id}:`,
        err instanceof Error ? err.message : err,
      );
      // Transient — try again next tick.
      await this.state.storage.setAlarm(Date.now() + RE_ALARM_MS);
      return;
    }

    // Diff by absolute_end_time watermark. Vexa's segments come sorted
    // by start time but `absolute_end_time` is the safer monotonic guarantee
    // because earlier segments can be re-emitted as "completed" later.
    const watermark = s.last_synced_iso ?? "";
    const newSegments = result.segments.filter((seg) => {
      const end =
        typeof seg.absolute_end_time === "string"
          ? seg.absolute_end_time
          : "";
      return end > watermark && typeof seg.text === "string" && seg.text.length > 0;
    });

    let inserted = 0;
    let newWatermark = watermark;
    for (const seg of newSegments) {
      const adapted = adaptVexaSegment(seg, {
        botId: s.recall_bot_id,
        meetingStartIso: result.start_time ?? null,
        eventType: "transcript.mutable",
      });
      try {
        const ok = await insertTranscriptSegment(cfg.database_url, adapted);
        if (ok) inserted++;
      } catch (err) {
        console.error(
          `[meeting-do.poll] insert failed event=${s.google_event_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      const end =
        typeof seg.absolute_end_time === "string"
          ? seg.absolute_end_time
          : "";
      if (end > newWatermark) newWatermark = end;
    }

    if (inserted > 0) {
      console.log(
        `[meeting-do.poll] event=${s.google_event_id} inserted=${inserted} watermark=${newWatermark}`,
      );
    }

    // First-time transition to live: Vexa reports status='active' AND we
    // haven't flipped meetings.status yet. The bot is now actually in the
    // meeting and recording — that's what the dashboard's 'live' label means.
    let liveMarkedAtMs = s.live_marked_at_ms;
    if (result.status === "active" && !liveMarkedAtMs) {
      try {
        await markMeetingLive({
          databaseUrl: cfg.database_url,
          meetingId: s.meeting_id_neon,
          botId: s.recall_bot_id,
        });
        liveMarkedAtMs = Date.now();
        console.log(
          `[meeting-do.poll] event=${s.google_event_id} marked live (vexa active)`,
        );
      } catch (err) {
        console.error(
          `[meeting-do.poll] mark-live failed event=${s.google_event_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Track participant presence for clean-shutdown detection. Vexa returns
    // `participants` (display-name array) on the /transcripts endpoint; the
    // bot itself is NOT in this list, only humans. Update the watermark every
    // tick where we see at least one human.
    let lastHumanSeenAtMs = s.last_human_seen_at_ms;
    if (result.participants.length > 0) {
      lastHumanSeenAtMs = Date.now();
    }

    // Host-left detection: bot has been live, we've seen humans at some point,
    // and they've all been gone for 30s straight. Force-leave so Vexa flips
    // status to 'completed' on the next tick, which fires markMeetingEnded
    // and stops polling. Idempotent via leave_requested_at_ms — we only issue
    // the leave once per meeting.
    const HOST_GRACE_MS = 30_000;
    let leaveRequestedAtMs = s.leave_requested_at_ms;
    const hostLeft =
      liveMarkedAtMs !== undefined &&
      lastHumanSeenAtMs !== undefined &&
      result.participants.length === 0 &&
      Date.now() - lastHumanSeenAtMs > HOST_GRACE_MS &&
      result.status === "active" &&
      !leaveRequestedAtMs;

    if (hostLeft) {
      console.log(
        `[meeting-do.poll] event=${s.google_event_id} host left (no participants for ${HOST_GRACE_MS}ms) — issuing vexaBotLeave`,
      );
      try {
        await vexaBotLeave({
          apiUrl: vexaUrl,
          apiKey: vexaKey,
          platform: s.vexa_platform!,
          nativeMeetingId: s.vexa_native_meeting_id!,
        });
        leaveRequestedAtMs = Date.now();
      } catch (err) {
        console.error(
          `[meeting-do.poll] vexa leave failed event=${s.google_event_id}:`,
          err instanceof Error ? err.message : err,
        );
        // Don't throw — try again next tick.
      }
    }

    // Persist new watermark + maybe transition to terminal.
    const isTerminal =
      result.status === "completed" || result.status === "failed";
    const nextStatus: MeetingState["status"] = isTerminal
      ? result.status === "failed"
        ? "failed"
        : "completed"
      : s.status;

    const next: MeetingState = {
      ...s,
      last_synced_iso: newWatermark || undefined,
      status: nextStatus,
      live_marked_at_ms: liveMarkedAtMs,
      last_human_seen_at_ms: lastHumanSeenAtMs,
      leave_requested_at_ms: leaveRequestedAtMs,
    };
    await this.state.storage.put("state", next);

    if (!isTerminal) {
      await this.state.storage.setAlarm(Date.now() + RE_ALARM_MS);
    } else {
      console.log(
        `[meeting-do.poll] event=${s.google_event_id} Vexa status=${result.status} — polling stopped`,
      );
      // Reflect the terminal status into Neon so the dashboard list flips
      // from 'live' to 'ended'/'failed'. Best-effort.
      try {
        await markMeetingEnded({
          databaseUrl: cfg.database_url,
          meetingId: s.meeting_id_neon,
          botId: s.recall_bot_id,
        });
      } catch (err) {
        console.error(
          `[meeting-do.poll] mark-ended failed event=${s.google_event_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/* --------------------------------------------------------------------------
 * Helpers (used by routes/calendar-* to talk to MeetingDO)
 * ------------------------------------------------------------------------ */

export function getMeetingStub(
  ns: DurableObjectNamespace,
  tenantSlug: string,
  googleEventId: string,
): DurableObjectStub {
  const id = ns.idFromName(`meeting:${tenantSlug}:${googleEventId}`);
  return ns.get(id);
}

export async function upsertMeetingDO(
  ns: DurableObjectNamespace,
  body: MeetingUpsertBody,
): Promise<MeetingState> {
  const stub = getMeetingStub(ns, body.tenant_slug, body.google_event_id);
  const r = await stub.fetch(meetingInternalUrl("/_internal/upsert", body), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`MeetingDO upsert failed: ${r.status}`);
  }
  const parsed = (await r.json()) as { ok: boolean; state: MeetingState };
  return parsed.state;
}

export async function cancelMeetingDO(
  ns: DurableObjectNamespace,
  tenantSlug: string,
  googleEventId: string,
): Promise<void> {
  const stub = getMeetingStub(ns, tenantSlug, googleEventId);
  const r = await stub.fetch(
    meetingInternalUrl("/_internal/cancel", { tenant_slug: tenantSlug, google_event_id: googleEventId }),
    { method: "POST" },
  );
  if (!r.ok) {
    throw new Error(`MeetingDO cancel failed: ${r.status}`);
  }
}

/**
 * Seed a MeetingDO for a manually-started Vexa meeting (no calendar event)
 * and arm the transcript-polling alarm. Called from /recall/bot when the
 * tenant's bot_provider is "vexa".
 */
export async function startVexaPollingForBot(
  ns: DurableObjectNamespace,
  body: {
    tenant_slug: string;
    bot_id: string;
    meeting_url: string;
    platform: "google_meet" | "zoom" | "teams";
    native_meeting_id: string;
    meeting_id_neon?: number | null;
    title?: string;
  },
): Promise<void> {
  // Synthesize a stable id so multiple calls for the same bot route to the
  // same DO. Use `manual-<bot_id>` (hyphen, not colon) so the resulting
  // hostname segment is encoder-safe — encodeURIComponent of "manual:8"
  // produces "manual%3A8", invalid as a hostname label.
  const eventId = `manual-${body.bot_id}`;
  const id = ns.idFromName(`meeting:${body.tenant_slug}:${eventId}`);
  const stub = ns.get(id);
  const safeTenant = encodeURIComponent(body.tenant_slug);
  const safeEvent = encodeURIComponent(eventId);
  const r = await stub.fetch(
    `https://meeting-${safeTenant}-${safeEvent}.do/_internal/start-vexa-polling`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    throw new Error(`startVexaPollingForBot failed: ${r.status}`);
  }
}

export async function getMeetingDOState(
  ns: DurableObjectNamespace,
  tenantSlug: string,
  googleEventId: string,
): Promise<MeetingState | null> {
  const stub = getMeetingStub(ns, tenantSlug, googleEventId);
  const r = await stub.fetch(
    meetingInternalUrl("/_internal/state", { tenant_slug: tenantSlug, google_event_id: googleEventId }),
    { method: "GET" },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`MeetingDO get-state failed: ${r.status}`);
  return (await r.json()) as MeetingState;
}

/* --------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------ */

function meetingInternalUrl(
  path: string,
  ctx: { tenant_slug: string; google_event_id: string },
): string {
  const safeTenant = encodeURIComponent(ctx.tenant_slug);
  const safeEvent = encodeURIComponent(ctx.google_event_id);
  return `https://meeting-${safeTenant}-${safeEvent}.do${path}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Re-export so type-only consumers don't need to reach into ./lib/types.
export type { TenantConfig };
