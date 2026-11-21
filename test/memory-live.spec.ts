// SPDX-License-Identifier: AGPL-3.0-only
// Live, networked check: read the public example memory repo WITHOUT GITHUB_TOKEN.
// Not a mock. Run with: npx vitest run -c vitest.live.config.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getMemory, extractSections, clip, _resetMemoryCache, memoryConfigured } from "../src/memory";
import { USER_AGENT } from "../src/config";
import type { Env } from "../src/env";

const REPO = "luciocs/jarvis-memory-demo";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/Agent.md`;
const CONTENTS = `https://api.github.com/repos/${REPO}/contents/Agent.md?ref=main`;

const env = {
  MEMORY_ENABLED: "true",
  MEMORY_REPO: REPO,
  MEMORY_PATH: "Agent.md",
  MEMORY_REF: "main",
  MEMORY_SECTIONS: "",
  MEMORY_MAX_CHARS: "1400",
  MEMORY_TTL_S: "600",
  MEMORY_FETCH_TIMEOUT_MS: "8000",
} as Env;

describe("live memory (public repo, no GITHUB_TOKEN, real network)", () => {
  beforeEach(() => _resetMemoryCache());

  it("raw.githubusercontent and the contents API return 200 without Authorization", async () => {
    const raw = await fetch(RAW, { headers: { "user-agent": USER_AGENT }, redirect: "manual" });
    const rawBody = await raw.text();
    const contents = await fetch(CONTENTS, {
      headers: { "user-agent": USER_AGENT, accept: "application/vnd.github.raw+json", "x-github-api-version": "2022-11-28" },
      redirect: "manual",
    });
    const contentsBody = await contents.text();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      probe: "direct",
      raw: { url: RAW, http: raw.status, bytes: rawBody.length, authorization: "none" },
      contents: { url: CONTENTS, http: contents.status, bytes: contentsBody.length, authorization: "none" },
    }));
    expect(raw.status).toBe(200);
    expect(contents.status).toBe(200);
    expect(rawBody.length).toBeGreaterThan(400);
    const extracted = extractSections(rawBody);
    const clipped = clip(extracted, 1400);
    const titles = extracted.split("\n").map((l) => l.split(":")[0]);
    expect(titles).toEqual(expect.arrayContaining(["Quem sou", "Tom e formato", "Perfil resumido"]));
    expect(titles.some((t) => t === "Família" || t === "Familia")).toBe(true);
    expect(clipped.text.length).toBeLessThanOrEqual(1400);
  });

  it("getMemory fetches raw.githubusercontent without a token or Authorization header", async () => {
    expect(memoryConfigured(env)).toBe(true);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = { ...((init?.headers as Record<string, string>) ?? {}) };
      calls.push({ url: String(url), headers });
      expect(headers.authorization).toBeUndefined();
      expect(Object.keys(headers).some((k) => k.toLowerCase() === "authorization")).toBe(false);
      return fetch(url, init);
    }) as typeof fetch;
    const result = await getMemory(env, null, { fetchFn });
    expect(["cold", "fresh"]).toContain(result.state);
    expect(result.text).toContain("Quem sou:");
    expect(result.text).toMatch(/Fam[ií]lia:/);
    expect(result.text).toContain("Tom e formato:");
    expect(result.text).toContain("Perfil resumido:");
    expect(result.text.length).toBeLessThanOrEqual(1400);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/luciocs\/jarvis-memory-demo\//);
    const dump = JSON.stringify({ calls, text: result.text });
    expect(dump).not.toMatch(/Bearer\s+\S/);
    expect(dump).not.toMatch(/github_pat_|ghp_[A-Za-z0-9]/);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      probe: "getMemory",
      state: result.state,
      url: calls[0].url,
      authorization: "none",
      user_agent: calls[0].headers["user-agent"],
      chars: result.text.length,
      sections: result.text.split("\n").map((l) => l.split(":")[0]),
    }));
  });
});
