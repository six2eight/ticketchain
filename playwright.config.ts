import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3199;
const RPC_PORT = 8547;
const WEB_PORT = 5199;

export default defineConfig({
  testDir: "./web/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: [
    {
      command: "npx tsx scripts/e2e-stack.ts",
      url: `http://127.0.0.1:${API_PORT}/health`,
      env: { E2E_API_PORT: String(API_PORT), E2E_RPC_PORT: String(RPC_PORT) },
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `npm --prefix web run dev -- --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: {
        VITE_API_URL: `http://127.0.0.1:${API_PORT}`,
        VITE_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
        VITE_CHAIN_ID: "31337",
        VITE_DEV_WALLETS: "true",
      },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
