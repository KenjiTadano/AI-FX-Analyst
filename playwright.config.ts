import { loadEnvConfig } from "@next/env";
import { defineConfig, devices } from "@playwright/test";
import { E2E_DUMMY_SUPABASE_ANON_KEY, E2E_DUMMY_SUPABASE_URL, e2eOrigin, e2ePort } from "./e2e/env";

loadEnvConfig(process.cwd());

const port = e2ePort();
const baseURL = e2eOrigin();

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: port,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || E2E_DUMMY_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || E2E_DUMMY_SUPABASE_ANON_KEY,
    },
  },
});
