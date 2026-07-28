import { defineConfig, devices } from '@playwright/test';

const PORT = 8123;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    // Playback and microphone paths must run without a permission prompt.
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream'
      ]
    }
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] }
    }
  ],
  webServer: {
    command: `node tools/serve.js ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore'
  }
});
