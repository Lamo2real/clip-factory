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
    // WebKit too: the Mac app (WKWebView) and the iPhone PWA (Safari) are WebKit. Pictures in Ask (§26), the
    // assistant's files and markup editor (§28), the motion, stillness and top-line checks (§20.13, §20.16, §11.1),
    // Home's boxes fitting what is in them at every size (home-fit), and Get paid (§40.8).
    // CI runs this project in its own job (ci.yml).
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: /(help-pictures|ask-assistant|ask-markup|nav-smooth|page-still|top-line|job-head|drop-video|home-fit|getpaid)\.spec\.ts/,
    },
    {
      name: "webkit-phone",
      use: { ...devices["iPhone 15"] },
      testMatch: /(help-pictures|ask-assistant|ask-markup|getpaid)\.spec\.ts/,
      // Desktop sizes run in the webkit project: a phone at 3x pixels and a 1920 px wide page made Linux WebKit's
      // screenshots and clicks time out in CI.
      grepInvert: /desktop/,
    },
    {
      name: "screenshots",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /screenshots\.spec\.ts/,
    },
  ],
});
