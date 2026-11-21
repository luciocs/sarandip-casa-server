// SPDX-License-Identifier: AGPL-3.0-only
import type { DeviceHub } from "./hub";
import type { DeviceRegistry } from "./registry";
import type { FirmwareStore } from "./firmware";

export interface Env {
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  DEVICE_REGISTRY: DurableObjectNamespace<DeviceRegistry>;
  FIRMWARE_STORE: DurableObjectNamespace<FirmwareStore>;
  // vars
  ASSISTANT_NAME: string;
  DEVICE_KIND: string;
  WAKE_WORD: string;
  WAKE_DISPLAY: string;
  LANGUAGE: string;
  TZ: string;
  STT_PROVIDER: string;
  ELEVENLABS_STT_MODEL: string;
  LLM_PROVIDER: string;
  XAI_MODEL: string;
  XAI_MAX_TOKENS: string;
  XAI_TIMEOUT_MS: string;
  ESCALATE_MARK: string;
  TTS_PROVIDER: string;
  ELEVENLABS_TTS_MODEL: string;
  ELEVENLABS_TTS_FALLBACK_MODEL: string;
  ELEVENLABS_VOICE_ID: string;
  TTS_LANGUAGE_CODE: string;
  ROUTINE_PROVIDER: string;
  ROUTINE_TIMEOUT_MS: string;
  ACK_TEXT: string;
  ROUTINE_FAIL_TEXT: string;
  PUBLIC_BASE_URL: string;
  WEBHOOK_AUTH_HEADER?: string;
  REPLY_TTL_S: string;
  REPLY_RETRY_MAX: string;
  MEMORY_ENABLED: string;
  MEMORY_REPO: string;
  MEMORY_PATH: string;
  MEMORY_REF: string;
  MEMORY_SECTIONS: string;
  MEMORY_MAX_CHARS: string;
  MEMORY_TTL_S: string;
  MEMORY_FETCH_TIMEOUT_MS: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_MODEL: string;
  PAIR_RATE_MAX: string;
  PAIR_RATE_WINDOW_S: string;
  WELCOME_MODE?: string;
  WELCOME_TEXT?: string;
  WELCOME_AUDIO_URL?: string;
  WELCOME_DELAY_MS?: string;
  // secrets (wrangler secret put)
  XAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_TOKEN?: string;
  REPLY_SECRET?: string;
  REPLY_SECRET_PREVIOUS?: string;
  ADMIN_TOKEN?: string;
  DEVICE_TOKENS?: string;
  GITHUB_TOKEN?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  WELCOME_AUDIO_TOKEN?: string;
  FIRMWARE_SIGNING_KEY?: string;
}

export const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
