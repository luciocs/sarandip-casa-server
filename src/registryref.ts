// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from "./env";

export const REGISTRY_NAME = "registry";

export function registry(env: Env) {
  return env.DEVICE_REGISTRY.get(env.DEVICE_REGISTRY.idFromName(REGISTRY_NAME));
}
