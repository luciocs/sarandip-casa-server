// SPDX-License-Identifier: AGPL-3.0-only
// Agent hand-off. Providers: webhook (any 2xx), openai (OpenAI-compatible
// chat completions), anthropic (Messages API), stub, off.
// A Grok Bot routine webhook is just a webhook; OpenClaw is documented the same way.
import type { Env } from "../env";
import { num } from "../env";
import type { LocalClock } from "../clock";
import { assistantName, deviceKind, historyLabel } from "../i18n";
import { ANTHROPIC_DEFAULT_BASE, OPENAI_DEFAULT_BASE, withTimeout, type FetchFn } from "./types";

export interface RoutinePayload {
  text: string;
  turn_id: string;
  device_id: string;
  spoken_at: string; // ISO UTC
  timezone: string;
  local_date: string;
  weekday: string;
  local_time: string;
  utc_offset: string;
  local_datetime: string;
  source: string;
  context: string;
  reply_url: string;
}

export function buildRoutinePayload(a: {
  text: string; turnId: string; deviceId: string; pedido: string; history: { role: string; content: string }[];
  replyUrl: string; clock: LocalClock; now: Date; source?: string; assistant?: string; language?: string;
}): RoutinePayload {
  const name = a.assistant || "sarandip";
  const talked = a.history.slice(-4).map((t) => `${historyLabel(t.role, name, a.language || "en")}: ${t.content.slice(0, 200)}`).join("\n");
  return {
    text: a.text,
    turn_id: a.turnId,
    device_id: a.deviceId,
    spoken_at: a.now.toISOString(),
    timezone: a.clock.timezone,
    local_date: a.clock.local_date,
    weekday: a.clock.weekday,
    local_time: a.clock.local_time,
    utc_offset: a.clock.utc_offset,
    local_datetime: a.clock.local_datetime,
    source: a.source || "device",
    context: [`pedido: ${a.pedido.slice(0, 300)}`, talked].filter(Boolean).join("\n").slice(0, 800),
    reply_url: a.replyUrl,
  };
}

export function isNativeRoutine(env: Env): boolean {
  const p = (env.ROUTINE_PROVIDER || "").toLowerCase();
  return p === "openai" || p === "anthropic";
}

export async function triggerRoutine(env: Env, payload: RoutinePayload, fetchFn: FetchFn = fetch): Promise<boolean> {
  const p = (env.ROUTINE_PROVIDER || "off").toLowerCase();
  if (p === "off") return false;
  if (p === "stub") return !/falha|fail/i.test(payload.text);
  if (p === "openai") return !!(env.OPENAI_API_KEY && openaiBase(env));
  if (p === "anthropic") return !!env.ANTHROPIC_API_KEY;
  const url = env.WEBHOOK_URL ?? "";
  if (!url.startsWith("https://") || !env.WEBHOOK_TOKEN) return false;
  try {
    return await withTimeout(num(env.ROUTINE_TIMEOUT_MS, 5000), async (signal) => {
      const r = await fetchFn(url, {
        method: "POST",
        headers: { authorization: `Bearer ${env.WEBHOOK_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal,
      });
      const ok = r.status >= 200 && r.status < 300;
      await r.body?.cancel();
      return ok;
    });
  } catch {
    return false;
  }
}

function openaiBase(env: Env): string {
  return (env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE).replace(/\/$/, "");
}

function spokenSystem(language?: string): string {
  return (language || "en").toLowerCase().startsWith("pt")
    ? "Você é um assistente de voz. Responda em uma ou duas frases curtas faladas, sem markdown, listas, emojis ou links."
    : "You are a voice assistant. Reply in one or two short spoken sentences, with no markdown, lists, emoji or links.";
}

/** Runs the OpenAI-compatible or Anthropic call and returns spoken text, or null on failure. */
export async function completeNativeRoutine(env: Env, payload: RoutinePayload, fetchFn: FetchFn = fetch): Promise<string | null> {
  const p = (env.ROUTINE_PROVIDER || "").toLowerCase();
  const timeout = num(env.ROUTINE_TIMEOUT_MS, 15000);
  try {
    if (p === "openai") {
      if (!env.OPENAI_API_KEY) return null;
      return await withTimeout(timeout, async (signal) => {
        const r = await fetchFn(`${openaiBase(env)}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: env.OPENAI_MODEL || "gpt-4o-mini",
            max_tokens: 300,
            messages: [
              { role: "system", content: spokenSystem(env.LANGUAGE) },
              { role: "user", content: JSON.stringify(payload) },
            ],
          }),
          signal,
        });
        if (!r.ok) { await r.body?.cancel(); return null; }
        const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        const text = String(j.choices?.[0]?.message?.content ?? "").trim();
        return text || null;
      });
    }
    if (p === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) return null;
      const base = (env.ANTHROPIC_BASE_URL || ANTHROPIC_DEFAULT_BASE).replace(/\/$/, "");
      return await withTimeout(timeout, async (signal) => {
        const r = await fetchFn(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY ?? "",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
            max_tokens: 300,
            system: spokenSystem(env.LANGUAGE),
            messages: [{ role: "user", content: JSON.stringify(payload) }],
          }),
          signal,
        });
        if (!r.ok) { await r.body?.cancel(); return null; }
        const j = (await r.json()) as { content?: { type?: string; text?: string }[] };
        const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
        return text || null;
      });
    }
  } catch {
    return null;
  }
  return null;
}

export { assistantName, deviceKind };
