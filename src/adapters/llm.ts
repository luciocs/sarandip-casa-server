// SPDX-License-Identifier: AGPL-3.0-only
// xAI Chat Completions (OpenAI-compatible): POST https://api.x.ai/v1/chat/completions
// body {model, messages, max_tokens}; answer in choices[0].message.content.
// https://docs.x.ai/docs/api-reference#chat-completions
import type { Env } from "../env";
import { num } from "../env";
import { clockLine, localClock, clockLang, type LocalClock } from "../clock";
import { assistantName, deviceKind, memoryPreamble, memoryUnavailable, systemRules } from "../i18n";
import { XAI_URL, withTimeout, type FetchFn } from "./types";

export type Turn = { role: "user" | "assistant"; content: string };
export type FastResult =
  | { kind: "answer"; text: string }
  | { kind: "escalate"; pedido: string; reason: string };

export interface PromptCtx {
  clock: LocalClock; // computed per turn, never cached
  memory: string; // extracted, capped; "" when off or unavailable
}

export function systemPrompt(env: Env, ctx: PromptCtx = { clock: localClock(), memory: "" }): string {
  const name = assistantName(env);
  const mark = env.ESCALATE_MARK || "<<AGENT>>";
  const kind = deviceKind(env);
  const language = env.LANGUAGE || "en";
  const rules = systemRules(name, mark, kind, language);
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
  const mark = env.ESCALATE_MARK || "<<AGENT>>";
  const system = systemPrompt(env, ctx);
  const body = {
    model: env.XAI_MODEL,
    max_tokens: num(env.XAI_MAX_TOKENS, 160),
    messages: [{ role: "system", content: system }, ...history.slice(-8), { role: "user", content: text }],
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
        if (!r.ok) throw new Error(`xai http ${r.status}`);
        const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        return String(j.choices?.[0]?.message?.content ?? "").trim();
      });
    } catch {
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
  if (/lembr|agenda|tarefa|e-?mail|remind|calendar|task|inbox/i.test(text)) return `${mark} ${text}`;
  if (/que dia|que horas|data de hoje|what day|what time|today.s date|what is the date/i.test(text)) {
    const m = /(?:Agora, no fuso|Now, in time zone) \S+ \(UTC[^)]*\): ([^.]+)\./.exec(system);
    if (!m) return clockLang(language) === "pt-BR" ? "Não sei a hora." : "I do not know the time.";
    return clockLang(language) === "pt-BR" ? `Hoje é ${m[1]}.` : `Today is ${m[1]}.`;
  }
  return clockLang(language) === "pt-BR" ? `Resposta rápida para: ${text}.` : `Quick answer for: ${text}.`;
}
