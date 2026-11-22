// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_FIRMWARE_SIGNING_KEY = readFileSync(
  new URL("./test/fixtures/firmware-test-p256.pkcs8.pem", import.meta.url),
  "utf8",
);

// Test-only bindings: every external API is a stub, and the device token is a
// throwaway value whose SHA-256 is below. No real key is used or needed.
export const TEST_TOKEN = "test-token-casa-0123456789";
export const TEST_TOKEN_SHA = "7704685303b2132fd42cc33272a38a6dd85174c94fcb99fb36243269a75d0009";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.example.toml" },
      miniflare: {
        bindings: {
          STT_PROVIDER: "stub",
          LLM_PROVIDER: "stub",
          TTS_PROVIDER: "stub",
          ROUTINE_PROVIDER: "stub",
          LANGUAGE: "pt-BR",
          TZ: "America/Sao_Paulo",
          ESCALATE_MARK: "<<AGENT>>",
          ACK_TEXT: "Deixa comigo, já te respondo.",
          ROUTINE_FAIL_TEXT: "Não consegui falar com o agente agora.",
          ELEVENLABS_VOICE_ID: "test-voice",
          PUBLIC_BASE_URL: "https://casa.test",
          MEMORY_ENABLED: "false",
          REPLY_SECRET: "reply-secret-for-tests-only-0001",
          REPLY_SECRET_PREVIOUS: "reply-secret-for-tests-only-prev",
          ADMIN_TOKEN: "admin-token-for-tests-only-0001",
          PAIR_RATE_MAX: "10",
          PAIR_RATE_WINDOW_S: "300",
          // On-device claim: only this test id may claim the shared test registry (keeps other tests deterministic).
          CLAIM_DEVICE_IDS: "sc-c1a100000001",
          // "audio" exercises both paths: the uploaded clip and the spoken fallback.
          WELCOME_MODE: "audio",
          WELCOME_DELAY_MS: "300",
          DEVICE_TOKENS: JSON.stringify({ dev_home01: TEST_TOKEN_SHA, dev_other: "0".repeat(64) }),
          FIRMWARE_SIGNING_KEY: TEST_FIRMWARE_SIGNING_KEY,
        },
      },
    }),
  ],
  test: { exclude: ["node_modules/**", "dist/**", "test/token-tool.spec.mjs", "test/memory-live.spec.ts"] },
});
