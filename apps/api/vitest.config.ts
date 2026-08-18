import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    env: {
      // config.ts validates at boot and exits if a key is missing. No live call
      // is ever made from a test, so this only has to be non-empty.
      ANTHROPIC_API_KEY: "test-key-never-used",
      DATABASE_PATH: "./data/test-cookmate.db",

      // Limits are pinned to small, round numbers so the assertions read as
      // statements about the policy rather than arithmetic about the defaults.
      RATE_LIMIT_PER_MINUTE: "3",
      MAX_CONCURRENT_PER_USER: "2",
      DAILY_COST_CAP_USD: "1",
      GLOBAL_DAILY_COST_CAP_USD: "5",
      ESTIMATED_TURN_COST_USD: "0.06",
    },
  },
});
