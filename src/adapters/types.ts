// SPDX-License-Identifier: AGPL-3.0-only
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export const ELEVEN_BASE = "https://api.elevenlabs.io";
export const XAI_URL = "https://api.x.ai/v1/chat/completions";
export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

export async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await run(ac.signal);
  } finally {
    clearTimeout(t);
  }
}
