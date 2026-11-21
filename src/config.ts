// SPDX-License-Identifier: AGPL-3.0-only
/** Public constants. The wire protocol name is documented in PROTOCOL.md. */

export const PROTOCOL = "sarandip-ws-1";
/** Legacy name accepted on WebSocket hello for backward compatibility. */
export const PROTOCOL_LEGACY = "luva-ws-1";
export const FILTER_VERSION = "casa-1";
export const SERVER_ID = "sarandip-casa/0.1";
export const USER_AGENT = "sarandip-casa";
export const DEFAULT_ASSISTANT_NAME = "Sarandip";
export const DEFAULT_DEVICE_KIND = "device";
export const DEFAULT_TZ = "UTC";
export const DEFAULT_MEMORY_REPO = "luciocs/jarvis-memory-demo";
export const DEFAULT_MEMORY_SECTIONS = [
  "## Quem sou",
  "## Família",
  "## Familia",
  "## Tom e formato",
  "### Tom e formato",
  "## Perfil resumido",
];

export function parseFlag(v: string | undefined, defaultTrue: boolean): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return defaultTrue;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultTrue;
}

export function publicBase(base: string | undefined, origin: string): string {
  return (base || origin).replace(/\/$/, "");
}

export function wsUrl(base: string): string {
  return `${base.replace(/^http/, "ws")}/v1/devices/stream`;
}
