/**
 * Screenshot the score canvas with a sample loaded.
 *
 * Development aid for judging the notation, which no test suite can do. The
 * optional clip is given in canvas coordinates so a single staff can be pulled
 * out and enlarged, which is the only way to check things like where a time
 * signature's numerals sit against the staff lines.
 *
 * Usage: node tools/score-shot.js <output.png> [sample] [width] [height] [clipX clipY clipW clipH] [scale]
 */

import { chromium } from '@playwright/test';

const [
  output = 'score.png',
  sample = 'Draw on, sweet night',
  width = 1280,
  height = 800,
  clipX,
  clipY,
  clipW,
  clipH,
  scale = 2
] = process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: Number(scale)
});

const problems = [];
page.on('pageerror', error => problems.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') problems.push(message.text());
});

await page.goto('http://localhost:8199/index.html');
await page.getByRole('button', { name: new RegExp(sample, 'i') }).click();
await page.waitForSelector('#transport:not([hidden])');
await page.waitForTimeout(500);

if (clipW !== undefined) {
  const origin = await page.locator('#score-canvas').evaluate(canvas => {
    const box = canvas.getBoundingClientRect();
    return { x: box.x, y: box.y };
  });
  await page.screenshot({
    path: output,
    clip: {
      x: origin.x + Number(clipX),
      y: origin.y + Number(clipY),
      width: Number(clipW),
      height: Number(clipH)
    }
  });
} else {
  await page.locator('#score-frame').screenshot({ path: output });
}
await browser.close();

if (problems.length) {
  console.error('problems:', problems);
  process.exitCode = 1;
} else {
  console.log(`captured ${output}`);
}
