import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Dummy values for the secrets wrangler.jsonc marks as required; tests never call real APIs.
// Wrangler's "Missing required secrets" check reads process.env / .dev.vars, not miniflare
// bindings, so they go to both.
const TEST_SECRETS = {
  SESSION_SECRET: "test-session-secret-0123456789-abcdef",
  IMAGE_URL_SECRET: "test-image-url-secret-0123456789-abcdef",
  OWNER_INITIAL_PASSWORD: "test-owner-password",
  ANTHROPIC_API_KEY: "test-key",
};
for (const [key, value] of Object.entries(TEST_SECRETS)) process.env[key] ??= value;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "drizzle"),
      );
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ...TEST_SECRETS },
        },
      };
    }),
  ],
  // Same `~/…` path alias as the app build (vite.config.ts).
  resolve: { tsconfigPaths: true },
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
