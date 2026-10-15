import { defineConfig, devices } from "@playwright/test"

// The e2e server runs on fictional fixtures only, in a temporary data dir prepared by e2e/prepare.ts.
// Fictional password of that throwaway instance, read by the specs to log in.
process.env.TOCTOC_E2E_PASSWORD = "e2e-mot-de-passe-fictif"
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /(terrain|logements)\.spec\.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /(terrain|logements)\.spec\.ts/ },
  ],
  webServer: {
    command: "pnpm build && tsx e2e/prepare.ts && TOCTOC_CONFIG=/tmp/toctoc-e2e/config.json NODE_ENV=production tsx server/index.ts",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
