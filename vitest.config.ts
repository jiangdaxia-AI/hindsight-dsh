import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * The UI primitive library and the other client packages are application modules with no npm
 * install to point at, so tests resolve them to a faithful double under `src/client/__stubs__`.
 * The production bundles leave the same specifiers external and the browser kernel answers them.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@deepseek-ai/dsh-client-ui-primitives": resolve(__dirname, "src/client/__stubs__/primitives.ts"),
    },
  },
  test: {
    // `src` is the plugin; `scripts` holds the runtime guard, whose failure modes are silent enough
    // that it needs its own tests (see scripts/pin-runtime.test.mjs); `vendor/coding-agents` is the
    // runtime this package OWNS, so its tests live beside the modules they cover.
    include: ["src/**/*.test.ts", "vendor/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
  },
});
