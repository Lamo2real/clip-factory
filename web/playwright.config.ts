import { defineConfig, devices } from "@playwright/test";

// Runs the mock build (in-memory API, fake signed-in owner) with `vite preview`. Nothing leaves the machine.
// CF_E2E_PORT picks another port when 4179 is taken (another checkout's preview), so tests never reuse its server.
const port = Number(process.env.CF_E2E_PORT || 4179);

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: true,
  // One retry on CI only, so a test that is slow under load once does not block a merge; local runs never retry.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, trace: "off" },
  webServer: {
    command: `npm run build:mock && npx vite preview --outDir dist-mock --port ${port} --strictPort`,
    port,
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
    // The macOS desktop app draws with WebKit (WKWebView), not Chromium: the motion, stillness and top-line checks run
    // there too (docs/CONTRACTS.md §20.13, §20.16, §11.1). CI installs WebKit next to Chromium (ci.yml).
    {
      name: "webkit",
      // Stated, not left to the system: WebKit on Linux follows the desktop's "animations off" setting, which a CI
      // runner without a desktop may report as reduced motion, and then nothing slides at all.
      use: { ...devices["Desktop Safari"], reducedMotion: "no-preference" },
      testMatch: /(nav-smooth|page-still|top-line)\.spec\.ts/,
    },
    {
      name: "screenshots",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /screenshots\.spec\.ts/,
    },
  ],
});
