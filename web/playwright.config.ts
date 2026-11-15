import { defineConfig, devices } from "@playwright/test";

// Runs the mock build (in-memory API, fake signed-in owner) with `vite preview`. Nothing leaves the machine.
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:4179", trace: "off" },
  webServer: {
    command: "npm run build:mock && npm run preview:mock",
    port: 4179,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: import.meta.dirname,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /screenshots\.spec\.ts/,
    },
    {
      name: "screenshots",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /screenshots\.spec\.ts/,
    },
  ],
});
