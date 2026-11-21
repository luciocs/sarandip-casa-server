// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from "./env";
import { clockLang, type ClockLang } from "./clock";
import { DEFAULT_ASSISTANT_NAME, DEFAULT_DEVICE_KIND } from "./config";

export function lang(env: Pick<Env, "LANGUAGE"> | { LANGUAGE?: string }): ClockLang {
  return clockLang(env.LANGUAGE);
}

export function assistantName(env: Pick<Env, "ASSISTANT_NAME"> | { ASSISTANT_NAME?: string }): string {
  return env.ASSISTANT_NAME?.trim() || DEFAULT_ASSISTANT_NAME;
}

export function deviceKind(env: Pick<Env, "DEVICE_KIND"> | { DEVICE_KIND?: string }): string {
  return env.DEVICE_KIND?.trim() || DEFAULT_DEVICE_KIND;
}

export function memoryUnavailable(language: string): string {
  return clockLang(language) === "pt-BR"
    ? "Memória pessoal indisponível nesta chamada. Não invente fatos pessoais."
    : "Personal memory is unavailable on this call. Do not invent personal facts.";
}

export function defaultAck(language: string): string {
  return clockLang(language) === "pt-BR"
    ? "Deixa comigo, já te respondo."
    : "On it, I'll get back to you.";
}

export function defaultRoutineFail(language: string): string {
  return clockLang(language) === "pt-BR"
    ? "Não consegui falar com o agente agora."
    : "I couldn't reach your agent just now.";
}

function spokenOrDefault(configured: string | undefined, language: string, fallback: (lang: string) => string, englishDefault: string): string {
  const t = configured?.trim() ?? "";
  if (!t) return fallback(language);
  // A Worker copied from wrangler.example.toml keeps the English canned lines even
  // after LANGUAGE is set to pt-BR. Prefer the language default in that case.
  if (clockLang(language) === "pt-BR" && t === englishDefault) return fallback(language);
  return t;
}

export function ackText(env: Pick<Env, "ACK_TEXT" | "LANGUAGE">): string {
  return spokenOrDefault(env.ACK_TEXT, env.LANGUAGE, defaultAck, "On it, I'll get back to you.");
}

export function failText(env: Pick<Env, "ROUTINE_FAIL_TEXT" | "LANGUAGE">): string {
  return spokenOrDefault(env.ROUTINE_FAIL_TEXT, env.LANGUAGE, defaultRoutineFail, "I couldn't reach your agent just now.");
}

export function systemRules(name: string, mark: string, kind: string, language: string): string {
  if (clockLang(language) === "pt-BR") {
    return [
      `Você é ${name}, a voz de um ${kind} assistente. Responda em português do Brasil,`,
      "em uma ou duas frases curtas faladas, sem markdown, listas, emojis ou links.",
      "Responda direto o que der para responder com conhecimento geral, com a memória abaixo ou com o relógio abaixo.",
      `Se o pedido exigir agenda, e-mail, tarefas, ferramentas, dados ao vivo ou memória que não está abaixo,`,
      `não invente: responda só ${mark} seguido do pedido reescrito em uma frase.`,
    ].join(" ");
  }
  return [
    `You are ${name}, the voice of a ${kind} assistant. Answer in English,`,
    "in one or two short spoken sentences, with no markdown, lists, emoji or links.",
    "Answer directly anything you can from general knowledge, the memory below or the clock below.",
    `If the request needs a calendar, email, tasks, tools, live data or memory that is not below,`,
    `do not invent: reply only with ${mark} followed by the request rewritten in one sentence.`,
  ].join(" ");
}

export function memoryPreamble(language: string): string {
  return clockLang(language) === "pt-BR"
    ? "Memória do usuário (somente leitura; pode estar incompleta; não invente além dela):"
    : "User memory (read-only; may be incomplete; do not invent beyond it):";
}

export function historyLabel(role: string, name: string, language: string): string {
  if (clockLang(language) === "pt-BR") return role === "user" ? "usuário" : name.toLowerCase();
  return role === "user" ? "user" : name.toLowerCase();
}
