// SPDX-License-Identifier: AGPL-3.0-only
// Read-only memory for the fast path: Agent.md of MEMORY_REPO (default
// luciocs/jarvis-memory-demo, a fictional example), extracted with a fixed
// set of rules: only the configured sections, lines with secret-ish words
// dropped, capped at MEMORY_MAX_CHARS (default 1400). Never logged.
//
// Enabled by MEMORY_ENABLED (default true). The owner can skip it by setting
// MEMORY_ENABLED=false. A public repo is fetched without GITHUB_TOKEN
// (raw.githubusercontent.com, with ETag). A private repo still needs the token
// and is read through the GitHub contents API. The default example repo is
// is public and is read without a token.
//
// Cache: L1 isolate memory + L2 Durable Object SQLite (the Cache API is a no-op on
// *.workers.dev). Fresh for MEMORY_TTL_S. Stale -> served as-is and refreshed in
// waitUntil with If-None-Match. Cold -> one fetch with a short timeout; failure ->
// no memory and a 60 s backoff. A turn never waits on GitHub longer than the timeout.
import type { Env } from "./env";
import { num } from "./env";
import type { FetchFn } from "./adapters/types";
import { DEFAULT_MEMORY_REPO, DEFAULT_MEMORY_SECTIONS, USER_AGENT, parseFlag } from "./config";

const SECRET_LINE =
  /e-?mail|senha|token|cpf|telefone|@|vault|api[_-]?key|authorization|bearer |password|formacao|cargo anterior|negrito|estruturadas/i;
export const THEME_ASK = /\b(di[aá]rio|temas?|anota[cç][oõ]es|o que eu escrevi|diar(y|ies)|themes?|notes?\b|what I wrote)\b/i;
const FAIL_BACKOFF_MS = 60_000;
export { DEFAULT_MEMORY_REPO };
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH_RE = /^[A-Za-z0-9_./ -]+$/;

export function memorySections(env?: Pick<Env, "MEMORY_SECTIONS"> | { MEMORY_SECTIONS?: string }): string[] {
  const raw = env?.MEMORY_SECTIONS?.trim();
  if (!raw) return [...DEFAULT_MEMORY_SECTIONS];
  const parts = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [...DEFAULT_MEMORY_SECTIONS];
}

export function memoryRepo(env: Env): string {
  return (env.MEMORY_REPO || DEFAULT_MEMORY_REPO).trim();
}
const memoryPath = (env: Env) => (env.MEMORY_PATH || "Agent.md").trim();

export interface MemoryPack {
  key: string;
  text: string;
  etag: string;
  fetchedAt: number;
  truncated: boolean;
}

export interface MemoryStore {
  get(key: string): Promise<MemoryPack | null>;
  put(pack: MemoryPack): Promise<void>;
}

export type MemoryState = "off" | "fresh" | "stale" | "cold" | "unavailable";

export interface MemoryResult {
  text: string;
  state: MemoryState;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripDash = (s: string) => s.replace(/^[- ]+|[- ]+$/g, "");

/** Heading line, then body until the next ##/### heading, --- or end. */
export function extractSections(md: string, sections: string[] = DEFAULT_MEMORY_SECTIONS): string {
  const text = md.replace(/\r\n/g, "\n");
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    const m = new RegExp(esc(section) + "[^\\n]*\\n([\\s\\S]*?)(?=\\n#{2,3} |\\n---|$(?![\\s\\S]))").exec(text);
    if (!m) continue;
    const lines: string[] = [];
    for (const line of m[1].split("\n")) {
      if (!line.trim() || SECRET_LINE.test(line)) continue;
      lines.push(stripDash(line.trim()).replace(/\*\*/g, ""));
    }
    if (!lines.length) continue;
    const title = section.replace(/^[# ]+/, "");
    if (seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    parts.push(title + ": " + lines.join("; "));
  }
  return parts.join("\n").trim();
}

export function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit).trimEnd(), truncated: true };
}

export function memoryKey(env: Env): string {
  return `${memoryRepo(env)}/${memoryPath(env)}@${env.MEMORY_REF || "main"}#${num(env.MEMORY_MAX_CHARS, 1400)}`;
}

export function memoryEnabled(env: Env): boolean {
  return parseFlag(env.MEMORY_ENABLED, true);
}

export function memoryConfigured(env: Env): boolean {
  if (!memoryEnabled(env)) return false;
  const path = memoryPath(env);
  return REPO_RE.test(memoryRepo(env)) && !memoryRepo(env).includes("..") && PATH_RE.test(path) && !path.includes("..");
}

// L1: per isolate.
let l1: MemoryPack | null = null;
let failUntil = 0;
let inflight: Promise<MemoryPack | null> | null = null;

export function _resetMemoryCache(): void {
  l1 = null;
  failUntil = 0;
  inflight = null;
}

function contentsUrl(env: Env): string {
  const path = memoryPath(env).split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${memoryRepo(env)}/contents/${path}?ref=${encodeURIComponent(env.MEMORY_REF || "main")}`;
}

function rawUrl(env: Env): string {
  const path = memoryPath(env).split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${memoryRepo(env)}/${encodeURIComponent(env.MEMORY_REF || "main")}/${path}`;
}

async function fetchPack(env: Env, prev: MemoryPack | null, fetchFn: FetchFn, timeoutMs: number, now: () => number): Promise<MemoryPack | null> {
  const key = memoryKey(env);
  const token = env.GITHUB_TOKEN?.trim();
  const url = token ? contentsUrl(env) : rawUrl(env);
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers.accept = "application/vnd.github.raw+json";
    headers["x-github-api-version"] = "2022-11-28";
  }
  if (prev?.etag) headers["if-none-match"] = prev.etag;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { headers, signal: ac.signal, redirect: "manual" });
    if (r.status === 304 && prev) {
      await r.body?.cancel();
      return { ...prev, fetchedAt: now() };
    }
    if (r.status !== 200) {
      await r.body?.cancel();
      return null;
    }
    const raw = await r.text();
    if (raw.length > 512 * 1024) return null; // not a memory file
    const c = clip(extractSections(raw, memorySections(env)), num(env.MEMORY_MAX_CHARS, 1400));
    return { key, text: c.text, etag: r.headers.get("etag") ?? "", fetchedAt: now(), truncated: c.truncated };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function refresh(env: Env, prev: MemoryPack | null, store: MemoryStore | null, fetchFn: FetchFn, timeoutMs: number, now: () => number): Promise<MemoryPack | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    const pack = await fetchPack(env, prev, fetchFn, timeoutMs, now);
    if (pack) {
      l1 = pack;
      failUntil = 0;
      if (store) await store.put(pack).catch(() => undefined);
    } else {
      failUntil = now() + FAIL_BACKOFF_MS;
      if (prev) l1 = prev; // keep serving the old copy
    }
    return pack;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export interface MemoryOpts {
  fetchFn?: FetchFn;
  now?: () => number;
  waitUntil?: (p: Promise<unknown>) => void;
}

export async function getMemory(env: Env, store: MemoryStore | null, opts: MemoryOpts = {}): Promise<MemoryResult> {
  if (!memoryConfigured(env)) return { text: "", state: "off" };
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = num(env.MEMORY_TTL_S, 600) * 1000;
  const timeoutMs = num(env.MEMORY_FETCH_TIMEOUT_MS, 800);
  const key = memoryKey(env);
  let pack = l1 && l1.key === key ? l1 : null;
  if (!pack && store) {
    pack = await store.get(key).catch(() => null);
    if (pack) l1 = pack;
  }
  if (pack && now() - pack.fetchedAt < ttl) return { text: pack.text, state: "fresh" };
  if (pack) {
    if (now() >= failUntil) {
      const p = refresh(env, pack, store, fetchFn, timeoutMs, now);
      if (opts.waitUntil) opts.waitUntil(p);
    }
    return { text: pack.text, state: "stale" };
  }
  if (now() < failUntil) return { text: "", state: "unavailable" };
  const fresh = await refresh(env, null, store, fetchFn, timeoutMs, now);
  return fresh ? { text: fresh.text, state: "cold" } : { text: "", state: "unavailable" };
}
