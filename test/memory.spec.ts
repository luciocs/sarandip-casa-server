// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_MEMORY_REPO, extractSections, getMemory, clip, _resetMemoryCache, memoryEnabled, memorySections, type MemoryPack, type MemoryStore, memoryConfigured } from "../src/memory";
import { USER_AGENT } from "../src/config";
import { fastAnswer, systemPrompt } from "../src/adapters/llm";
import { localClock, clockLine, resolveTz } from "../src/clock";
import { buildRoutinePayload } from "../src/adapters/routine";
import type { Env } from "../src/env";

// Synthetic memory file: same heading layout as the example, invented content.
const MD = [
  "# Agent", "", "## Regras fixas", "- nunca isto", "",
  "## Quem sou", "- **Nome:** Fulano de Teste", "- Mora em Cidade Exemplo", "- E-mail: fulano@example.com", "- token de nada", "",
  "## Familia (resumo)", "- Esposa: Beltrana", "- Filho: Ciclano", "",
  "### Tom e formato", "- direto e curto", "- sem negrito", "",
  "---", "## Perfil resumido", "- Gosta de café.", "",
  "## Tabela de roteamento", "- x",
].join("\n");

const env = (over: Partial<Env> = {}): Env => ({
  MEMORY_ENABLED: "true", GITHUB_TOKEN: "gh-test-token", MEMORY_REPO: "luciocs/jarvis-memory-demo", MEMORY_PATH: "Agent.md", MEMORY_REF: "main",
  MEMORY_SECTIONS: "", MEMORY_MAX_CHARS: "1400", MEMORY_TTL_S: "600", MEMORY_FETCH_TIMEOUT_MS: "800",
  ASSISTANT_NAME: "Sarandip", DEVICE_KIND: "device", ESCALATE_MARK: "<<AGENT>>", XAI_MODEL: "grok-test", XAI_MAX_TOKENS: "160", XAI_TIMEOUT_MS: "4000",
  LLM_PROVIDER: "xai", XAI_API_KEY: "xai-k", LANGUAGE: "pt-BR", TZ: "America/Sao_Paulo",
  ...over,
} as Env);

type Call = { url: string; headers: Record<string, string> };
function gh(handler: (c: Call) => Response | Promise<Response>, calls: Call[]) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(url), headers: { ...(init?.headers as Record<string, string>) } };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
}
const okResp = (etag = '"e1"') => new Response(MD, { status: 200, headers: { etag } });

function memStore(): MemoryStore & { data: MemoryPack | null; puts: number } {
  const s = {
    data: null as MemoryPack | null, puts: 0,
    async get(k: string) { return s.data && s.data.key === k ? s.data : null; },
    async put(p: MemoryPack) { s.data = p; s.puts++; },
  };
  return s;
}

beforeEach(() => _resetMemoryCache());

describe("memory extraction", () => {
  it("keeps only the configured sections, drops secret-ish lines, strips bullets and bold", () => {
    const t = extractSections(MD);
    expect(t.split("\n")).toEqual([
      "Quem sou: Nome: Fulano de Teste; Mora em Cidade Exemplo",
      "Familia: Esposa: Beltrana; Filho: Ciclano",
      "Tom e formato: direto e curto",
      "Perfil resumido: Gosta de café.",
    ]);
    expect(t).not.toMatch(/example\.com|token|nunca isto|roteamento/);
  });
  it("MEMORY_SECTIONS is configurable", () => {
    const only = extractSections(MD, ["## Perfil resumido"]);
    expect(only).toBe("Perfil resumido: Gosta de café.");
    expect(memorySections({ MEMORY_SECTIONS: "## Quem sou,## Perfil resumido" })).toEqual(["## Quem sou", "## Perfil resumido"]);
  });
  it("size cut at MEMORY_MAX_CHARS", () => {
    expect(clip("a".repeat(2000), 1400)).toEqual({ text: "a".repeat(1400), truncated: true });
    expect(clip("abc", 1400).truncated).toBe(false);
  });
});

describe("memory fetch + cache", () => {
  it("MEMORY_ENABLED=false -> off, no request, even with a token", async () => {
    const calls: Call[] = [];
    const r = await getMemory(env({ MEMORY_ENABLED: "false" }), null, { fetchFn: gh(() => okResp(), calls) });
    expect(r).toEqual({ text: "", state: "off" });
    expect(calls.length).toBe(0);
    expect(memoryConfigured(env({ MEMORY_ENABLED: "false" }))).toBe(false);
    expect(memoryEnabled(env({ MEMORY_ENABLED: "off" }))).toBe(false);
    expect(memoryEnabled(env({ MEMORY_ENABLED: "" }))).toBe(true);
  });
  it("without GITHUB_TOKEN, a public repo is fetched from raw.githubusercontent with ETag and no Authorization", async () => {
    const calls: Call[] = [];
    const r = await getMemory(env({ GITHUB_TOKEN: undefined }), null, { fetchFn: gh(() => okResp(), calls) });
    expect(r.state).toBe("cold");
    expect(r.text).toContain("Quem sou:");
    expect(calls[0].url).toBe("https://raw.githubusercontent.com/luciocs/jarvis-memory-demo/main/Agent.md");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers["user-agent"]).toBe(USER_AGENT);
    expect(memoryConfigured(env({ GITHUB_TOKEN: "" }))).toBe(true);
  });
  it("MEMORY_REPO defaults to the example repo and must be owner/name", async () => {
    expect(DEFAULT_MEMORY_REPO).toBe("luciocs/jarvis-memory-demo");
    const calls: Call[] = [];
    await getMemory(env({ MEMORY_REPO: "", GITHUB_TOKEN: "gh-test-token" }), null, { fetchFn: gh(() => okResp(), calls) });
    expect(calls[0].url).toBe("https://api.github.com/repos/luciocs/jarvis-memory-demo/contents/Agent.md?ref=main");
    for (const bad of ["no-slash", "a/b/c", "../x", "a/b?x=1"]) expect(memoryConfigured(env({ MEMORY_REPO: bad }))).toBe(false);
    expect(memoryConfigured(env({ MEMORY_PATH: "../secrets/x.md" }))).toBe(false);
    _resetMemoryCache();
    const other: Call[] = [];
    await getMemory(env({ MEMORY_REPO: "someone/other-memory" }), null, { fetchFn: gh(() => okResp(), other) });
    expect(other[0].url).toContain("/repos/someone/other-memory/contents/");
  });
  it("with a token, cold fetch uses the contents API with Bearer, then serves from cache", async () => {
    const calls: Call[] = [];
    const store = memStore();
    let t = 1_000_000;
    const now = () => t;
    const f = gh(() => okResp(), calls);
    const a = await getMemory(env(), store, { fetchFn: f, now });
    expect(a.state).toBe("cold");
    expect(a.text).toContain("Quem sou:");
    expect(calls[0].url).toBe("https://api.github.com/repos/luciocs/jarvis-memory-demo/contents/Agent.md?ref=main");
    expect(calls[0].headers.authorization).toBe("Bearer gh-test-token");
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw+json");
    expect(calls[0].headers["if-none-match"]).toBeUndefined();
    expect(store.puts).toBe(1);
    t += 599_000;
    expect((await getMemory(env(), store, { fetchFn: f, now })).state).toBe("fresh");
    expect(calls.length).toBe(1);
    _resetMemoryCache();
    expect((await getMemory(env(), store, { fetchFn: f, now })).state).toBe("fresh");
    expect(calls.length).toBe(1);
  });
  it("stale -> served immediately, revalidated in background with If-None-Match; 304 keeps text", async () => {
    const calls: Call[] = [];
    const store = memStore();
    let t = 0;
    const now = () => t;
    await getMemory(env(), store, { fetchFn: gh(() => okResp('"v1"'), calls), now });
    t += 601_000;
    const bg: Promise<unknown>[] = [];
    const r = await getMemory(env(), store, { fetchFn: gh(() => new Response(null, { status: 304 }), calls), now, waitUntil: (p) => bg.push(p) });
    expect(r.state).toBe("stale");
    expect(r.text).toContain("Familia:");
    await Promise.all(bg);
    expect(calls[1].headers["if-none-match"]).toBe('"v1"');
    expect((await getMemory(env(), store, { fetchFn: gh(() => okResp(), calls), now })).state).toBe("fresh");
    expect(calls.length).toBe(2);
    expect(store.data!.fetchedAt).toBe(t);
  });
  it("GitHub failure: cold -> no memory + 60 s backoff; stale copy kept", async () => {
    const calls: Call[] = [];
    let t = 0;
    const now = () => t;
    const fail = gh(() => new Response("nope", { status: 500 }), calls);
    expect(await getMemory(env(), null, { fetchFn: fail, now })).toEqual({ text: "", state: "unavailable" });
    expect(await getMemory(env(), null, { fetchFn: fail, now })).toEqual({ text: "", state: "unavailable" });
    expect(calls.length).toBe(1);
    t += 61_000;
    expect((await getMemory(env(), null, { fetchFn: gh(() => okResp(), calls), now })).state).toBe("cold");
    t += 700_000;
    const bg: Promise<unknown>[] = [];
    const r = await getMemory(env(), null, { fetchFn: gh(() => { throw new Error("net"); }, calls), now, waitUntil: (p) => bg.push(p) });
    await Promise.all(bg);
    expect(r.state).toBe("stale");
    expect((await getMemory(env(), null, { fetchFn: fail, now })).text).toContain("Quem sou:");
  });
  it("cold fetch never blocks longer than MEMORY_FETCH_TIMEOUT_MS", async () => {
    const hang = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("abort"))))) as typeof fetch;
    const t0 = performance.now();
    const r = await getMemory(env({ MEMORY_FETCH_TIMEOUT_MS: "50" }), null, { fetchFn: hang });
    expect(r.state).toBe("unavailable");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
  it("big file is cut to MEMORY_MAX_CHARS", async () => {
    const big = "## Quem sou\n" + Array.from({ length: 200 }, (_, i) => `- linha ${i} com algum texto`).join("\n") + "\n";
    const r = await getMemory(env({ MEMORY_MAX_CHARS: "300" }), null, { fetchFn: gh(() => new Response(big, { headers: { etag: '"b"' } }), []) });
    expect(r.text.length).toBeLessThanOrEqual(300);
    expect(r.text.startsWith("Quem sou: linha 0")).toBe(true);
  });
});

describe("clock (configurable TZ, localized text)", () => {
  it("fixed instant in America/Sao_Paulo -> pt-BR date, weekday and time", () => {
    const c = localClock(new Date("2026-11-20T22:40:00Z"), "America/Sao_Paulo", "pt-BR");
    expect(c).toMatchObject({
      timezone: "America/Sao_Paulo", local_date: "20/11/2026", weekday: "sexta-feira", local_time: "19:40", utc_offset: "-03:00",
      iso_local: "2026-11-20T19:40:00-03:00",
    });
    expect(c.local_datetime).toBe("sexta-feira, 20 de novembro de 2026, 19:40");
    expect(localClock(new Date("2026-11-21T02:30:00Z"), "America/Sao_Paulo", "pt-BR").local_date).toBe("20/11/2026");
    expect(localClock(new Date("2026-11-21T03:05:00Z"), "America/Sao_Paulo", "pt-BR")).toMatchObject({ local_date: "21/11/2026", weekday: "sábado", local_time: "00:05" });
  });
  it("another time zone (America/New_York) and English text", () => {
    const c = localClock(new Date("2026-11-20T22:40:00Z"), "America/New_York", "en");
    expect(c.timezone).toBe("America/New_York");
    expect(c.local_date).toBe("2026-11-20");
    expect(c.local_time).toBe("17:40");
    expect(c.utc_offset).toBe("-05:00");
    expect(c.weekday.toLowerCase()).toBe("friday");
    expect(c.local_datetime.toLowerCase()).toContain("friday");
    expect(clockLine(c, "en")).toMatch(/Now, in time zone America\/New_York \(UTC-05:00\):/);
    expect(resolveTz("Not/AZone")).toBe("UTC");
    expect(resolveTz("")).toBe("UTC");
  });
  it("UTC default and English clock line", () => {
    const c = localClock(new Date("2026-11-20T22:40:00Z"), "UTC", "en");
    expect(c).toMatchObject({ timezone: "UTC", local_date: "2026-11-20", local_time: "22:40", utc_offset: "+00:00" });
    expect(clockLine(c, "en")).toContain("Now, in time zone UTC (UTC+00:00):");
  });
  it("the model prompt carries the configured clock of that instant", async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const xai = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: "Hoje é sexta." } }] });
    }) as typeof fetch;
    const clock = localClock(new Date(), "America/Sao_Paulo", "pt-BR");
    await fastAnswer(env(), "que dia é hoje e que horas são?", [], xai, { clock, memory: "Quem sou: Teste" });
    const sys = bodies[0].messages[0].content;
    expect(sys).toContain(clock.local_datetime);
    expect(sys).toContain("America/Sao_Paulo");
    expect(sys).toContain("<<AGENT>>");
    expect(sys).toContain("Quem sou: Teste");
    const fixed = systemPrompt(env(), { clock: localClock(new Date("2026-11-20T22:40:00Z"), "America/Sao_Paulo", "pt-BR"), memory: "" });
    expect(fixed).toContain("Agora, no fuso America/Sao_Paulo (UTC-03:00): sexta-feira, 20 de novembro de 2026, 19:40.");
    expect(fixed).toContain("Memória pessoal indisponível");
  });
  it("routine payload carries the same clock as explicit fields next to spoken_at", () => {
    const now = new Date("2026-11-20T22:40:00Z");
    const p = buildRoutinePayload({ text: "t", turnId: "t_0123456789abcdef", deviceId: "dev", pedido: "p", history: [], replyUrl: "https://x/bloco/reply", clock: localClock(now, "America/Sao_Paulo", "pt-BR"), now, source: "device" });
    expect(p).toMatchObject({
      spoken_at: "2026-11-20T22:40:00.000Z", timezone: "America/Sao_Paulo", local_date: "20/11/2026", weekday: "sexta-feira",
      local_time: "19:40", utc_offset: "-03:00", local_datetime: "sexta-feira, 20 de novembro de 2026, 19:40", source: "device",
    });
  });
});
