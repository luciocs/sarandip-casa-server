// SPDX-License-Identifier: AGPL-3.0-only
// xAI Chat Completions (OpenAI-compatible): POST https://api.x.ai/v1/chat/completions
// body {model, messages, max_tokens}; answer in choices[0].message.content.
// https://docs.x.ai/docs/api-reference#chat-completions
import type { Env } from "../env";
import { num } from "../env";
import { clockLine, localClock, clockLang, type LocalClock } from "../clock";
import { assistantName, deviceKind, memoryPreamble, memoryUnavailable, systemRules } from "../i18n";
import { parseFlag } from "../config";
import { XAI_URL, withTimeout, type FetchFn } from "./types";

export type Turn = { role: "user" | "assistant"; content: string };
export type FastResult =
  | { kind: "answer"; text: string }
  | { kind: "escalate"; pedido: string; reason: string };

export interface PromptCtx {
  clock: LocalClock; // computed per turn, never cached
  memory: string; // extracted, capped; "" when off or unavailable
}

/** Drop empty lines and keep user/assistant alternating so a failed escalate cannot break the next turn. */
export function historyForLlm(history: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of history) {
    const content = (t.content ?? "").trim();
    if (!content || (t.role !== "user" && t.role !== "assistant")) continue;
    if (out.length && out[out.length - 1].role === t.role) {
      out[out.length - 1] = { role: t.role, content: `${out[out.length - 1].content}\n${content}`.slice(0, 500) };
    } else {
      out.push({ role: t.role, content });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.slice(-8);
}

/** Fold accents so "reunião" and "reuniao" match the same pattern. */
export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function routineProviderActive(env: Pick<Env, "ROUTINE_PROVIDER"> | { ROUTINE_PROVIDER?: string }): boolean {
  const p = (env.ROUTINE_PROVIDER || "off").trim().toLowerCase();
  return p !== "" && p !== "off";
}

/**
 * Calendar, email, tasks, reminders, messages and other live personal data.
 * Accent-insensitive. Does not match clock questions such as "que horas são" or "que dia é hoje".
 */
const LIVE_DATA_ASK = new RegExp(
  [
    String.raw`\b(agendas?|calendarios?|compromissos?|reunioes?|reuniao|agendar|agendamento|calendars?|appointments?|meetings?)\b`,
    String.raw`\b(e-?mails?|caixa de entrada|inbox)\b`,
    String.raw`\b(tarefas?|tasks?|to-?dos?|afazeres?|pendencias?)\b`,
    String.raw`\b(lembretes?|reminders?|remind me)\b`,
    String.raw`\b((me|nos) (lembra|lembre|relembra))\b`,
    String.raw`\blembr(a|e|ar) d[eoa]s?\b`,
    String.raw`\b(mensagens?|messages?|recados?|whatsapp|telegram|sms)\b`,
    String.raw`\b(notificacoes?|notifications?)\b`,
  ].join("|"),
  "i",
);

export function isLiveDataAsk(text: string): boolean {
  const folded = foldAccents(text);
  if (LIVE_DATA_ASK.test(folded) && !/\bse lembr(a|e|ar) d[eoa]s?\b/i.test(folded)) return true;
  return false;
}

export function prerouteEnabled(env: Pick<Env, "ROUTINE_PROVIDER" | "ESCALATE_PREROUTE"> | { ROUTINE_PROVIDER?: string; ESCALATE_PREROUTE?: string }): boolean {
  return routineProviderActive(env) && parseFlag(env.ESCALATE_PREROUTE, true);
}

export function systemPrompt(env: Env, ctx: PromptCtx = { clock: localClock(), memory: "" }): string {
  const name = assistantName(env);
  const mark = env.ESCALATE_MARK || "<<AGENT>>";
  const kind = deviceKind(env);
  const language = env.LANGUAGE || "en";
  const rules = systemRules(name, mark, kind, language, { agentConnected: routineProviderActive(env) });
  const mem = ctx.memory
    ? `${memoryPreamble(language)}\n${ctx.memory}`
    : memoryUnavailable(language);
  return [rules, clockLine(ctx.clock, language), mem].join("\n");
}

export async function fastAnswer(
  env: Env,
  text: string,
  history: Turn[],
  fetchFn: FetchFn = fetch,
  ctx: PromptCtx = { clock: localClock(new Date(), env.TZ, env.LANGUAGE), memory: "" },
): Promise<FastResult> {
  if (prerouteEnabled(env) && isLiveDataAsk(text)) {
    return { kind: "escalate", pedido: text, reason: "preroute" };
  }
  const mark = env.ESCALATE_MARK || "<<AGENT>>";
  const system = systemPrompt(env, ctx);
  const body = {
    model: env.XAI_MODEL,
    max_tokens: num(env.XAI_MAX_TOKENS, 160),
    messages: [{ role: "system", content: system }, ...historyForLlm(history), { role: "user", content: text }],
  };
  let out: string;
  if (env.LLM_PROVIDER === "stub") {
    out = stubLlm(text, system, mark, env.LANGUAGE);
  } else {
    if (!env.XAI_API_KEY) return { kind: "escalate", pedido: text, reason: "llm_unset" };
    try {
      out = await withTimeout(num(env.XAI_TIMEOUT_MS, 4000), async (signal) => {
        const r = await fetchFn(XAI_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!r.ok) {
          const raw = await r.text().catch(() => "");
          let hint = raw.replace(/\s+/g, " ").trim().slice(0, 160);
          try {
            const j = JSON.parse(raw) as { error?: { message?: string; code?: string; type?: string } | string };
            const e = j.error;
            if (typeof e === "string") hint = e.slice(0, 160);
            else if (e && typeof e === "object") hint = [e.type, e.code, e.message].filter(Boolean).join(" ").slice(0, 160);
          } catch { /* not json */ }
          console.error("xai http", r.status, hint, "model", env.XAI_MODEL);
          throw new Error(`xai http ${r.status}`);
        }
        const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        return String(j.choices?.[0]?.message?.content ?? "").trim();
      });
    } catch (e) {
      console.error("llm error", (e as Error)?.name ?? "error", (e as Error)?.message ?? "", "model", env.XAI_MODEL);
      return { kind: "escalate", pedido: text, reason: "llm_error" };
    }
  }
  if (!out) return { kind: "escalate", pedido: text, reason: "llm_empty" };
  const i = out.indexOf(mark);
  if (i >= 0) return { kind: "escalate", pedido: out.slice(i + mark.length).trim() || text, reason: "mark" };
  return { kind: "answer", text: out.slice(0, 500) };
}

/** Test double. Date/time questions are answered from the clock line of the prompt it was given. */
export function stubLlm(text: string, system: string, mark: string, language?: string): string {
  if (isLiveDataAsk(text)) return `${mark} ${text}`;
  if (/que dia|que horas|data de hoje|what day|what time|today.s date|what is the date/i.test(text)) {
    const m = /(?:Agora, no fuso|Now, in time zone) \S+ \(UTC[^)]*\): ([^.]+)\./.exec(system);
    if (!m) return clockLang(language) === "pt-BR" ? "Não sei a hora." : "I do not know the time.";
    return clockLang(language) === "pt-BR" ? `Hoje é ${m[1]}.` : `Today is ${m[1]}.`;
  }
  return clockLang(language) === "pt-BR" ? `Resposta rápida para: ${text}.` : `Quick answer for: ${text}.`;
}
