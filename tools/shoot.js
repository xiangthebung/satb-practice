/**
 * Screenshot a page for visual checking.
 *
 * Development aid: rendering is the one thing the test suites cannot judge, so
 * this captures a page to a PNG that can actually be looked at.
 *
 * Usage: node tools/shoot.mjs <path> <output.png> [width] [height]
 */

import { chromium } from '@playwright/test';

const [path = '/tools/glyph-preview.html', output = 'shot.png', width = 1200, height = 700] =
  process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 2
});

const problems = [];
page.on('pageerror', error => problems.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') problems.push(message.text());
});

await page.goto(`http://localhost:8199${path}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.screenshot({ path: output, fullPage: true });
await browser.close();

if (problems.length) {
  console.error('problems:', problems);
  process.exitCode = 1;
} else {
  console.log(`captured ${output}`);
}
