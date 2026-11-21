// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";

// Node environment, real network. Kept separate from the workerd suite
// so the Cloudflare plugin cannot intercept fetch.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/memory-live.spec.ts"],
  },
});
