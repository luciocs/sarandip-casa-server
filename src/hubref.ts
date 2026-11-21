// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from "./env";
export function hub(env: Env, deviceId: string) {
  return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(deviceId));
}
