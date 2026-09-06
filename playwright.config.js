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
    // Playback, microphone and the share button's clipboard must all run
    // without a permission prompt.
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
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
    },
    {
      // Narrower than the Pixel 7's 412px. This is the width at which a long
      // score title first pushed the transport off the edge of the screen, and
      // nothing ran at it, so nothing noticed.
      name: 'chromium-phone-390',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }
    }
  ],
  webServer: {
    command: `node tools/serve.js ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore'
  }
});
