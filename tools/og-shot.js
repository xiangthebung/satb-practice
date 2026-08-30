/**
 * Redraw `public/og.png`, the 1200x630 card that Slack, iMessage and LinkedIn
 * show when somebody pastes a link to this app.
 *
 * The picture is the real app. A bundled sample is opened in a real browser, a
 * part is chosen the way a singer chooses one, the notation is left to finish
 * drawing, and that frame is captured and laid into a titled card. Nothing in it
 * is a drawing of the app, so re-running this after a change to the notation or
 * the panel shows the change rather than quietly going stale.
 *
 * The score is one of the three that ship in `public/sample-pieces/` — a six-part
 * Wilbye madrigal from 1609, public domain, and nobody's own music.
 *
 * Usage:
 *   node tools/serve.js 8199   # in one terminal
 *   npm run og                 # in another
 *
 * One caveat before re-running it: this app uses the platform's own UI typeface,
 * so the card is set in whatever that is on the machine that ran this. The
 * committed PNG was made on Windows.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'public', 'og.png');
const BASE = `http://localhost:${process.argv[2] || 8199}`;

/* The card, as the Open Graph tags in public/index.html promise it. */
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

/** The viewport the app is photographed at: wide enough that the parts panel is
 *  a column beside the score rather than a sheet under it. */
const SHOT = { width: 1400, height: 880 };

/** The window the photograph sits in, cropped by the card's bottom edge. */
const WINDOW = { width: 1054, height: 664, top: 194, left: 73 };

const SAMPLE = 'Draw on, sweet night';

/** The card around the photograph. Every colour here is one of the app's own. */
function cardHtml(shot) {
  return `
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
    overflow: hidden;
    position: relative;
    background: #f5f5f7;
    color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto,
      'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* The home screen's own light: a cool wash, a warm one, and ruled staves
     underneath them. */
  .wash { position: absolute; inset: 0;
    background:
      radial-gradient(760px 420px at 8% -16%, rgba(0,113,227,0.16), transparent 72%),
      radial-gradient(620px 360px at 74% -20%, rgba(255,159,10,0.13), transparent 72%);
  }
  .staves { position: absolute; inset: 0;
    background: repeating-linear-gradient(
      to bottom, transparent 0 13px, rgba(0,0,0,0.045) 13px 14px);
    mask-image: linear-gradient(to bottom, rgba(0,0,0,0.5) 0, transparent 190px);
    -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0.5) 0, transparent 190px);
  }
  .head { position: relative; padding: 46px 73px 0; }
  .mark { display: flex; align-items: center; gap: 10px; }
  .mark .badge { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 4px 14px rgba(0,113,227,0.18); }
  .mark .name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  h1 { margin-top: 20px; font-size: 44px; line-height: 1.06; font-weight: 600; letter-spacing: -0.032em; }
  h1 span { color: #0071e3; }
  .chips { position: absolute; top: 116px; right: 73px; display: flex; gap: 8px; }
  .chip { border-radius: 999px; padding: 8px 15px; font-size: 14px; font-weight: 500;
    background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
  .window {
    position: absolute; top: ${WINDOW.top}px; left: ${WINDOW.left}px;
    width: ${WINDOW.width}px; height: ${WINDOW.height}px;
    border-radius: 14px 14px 0 0; overflow: hidden;
    background: #fff; border: 1px solid rgba(0,0,0,0.09); border-bottom: 0;
    box-shadow: 0 26px 70px rgba(29,29,31,0.20), 0 3px 10px rgba(29,29,31,0.06);
  }
  .titlebar { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 13px;
    background: #f0f0f3; border-bottom: 1px solid rgba(0,0,0,0.07); }
  .titlebar b { width: 10px; height: 10px; border-radius: 999px; background: rgba(0,0,0,0.14); }
  .titlebar span { margin-left: 10px; font-size: 11px; color: #6e6e73; }
  .window img { display: block; width: 100%; }
</style>
<div class="wash"></div>
<div class="staves"></div>
<div class="head">
  <div class="mark">
    <span class="badge">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#0071e3" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>
      </svg>
    </span>
    <span class="name">Choir Practice</span>
  </div>
  <h1>Practice <span>your part</span></h1>
</div>
<div class="chips">
  <span class="chip">Open a score</span>
  <span class="chip">Choose your part</span>
  <span class="chip">Press play</span>
</div>
<div class="window">
  <div class="titlebar"><b></b><b></b><b></b><span>satb-practice.xiangli3625.workers.dev</span></div>
  <img src="data:image/png;base64,${shot}" alt="">
</div>
`;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: SHOT, deviceScaleFactor: 2 });
const page = await context.newPage();

const problems = [];
page.on('pageerror', error => problems.push(`page error: ${error.message}`));
page.on('console', message => {
  if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
});

await page.goto(`${BASE}/index.html`);

/* The first-run coach note covers the part list with an instruction to do the
   thing the picture is about to show being done. */
await page.evaluate(() => window.localStorage.setItem('choir-practice:coach-seen', 'true'));
await page.reload();

await page.getByRole('button', { name: new RegExp(SAMPLE, 'i') }).click();
await page.waitForSelector('#transport:not([hidden])');
await page.waitForFunction(() => document.getElementById('score-canvas').width > 0);

/* The panel is a column beside the score at this width, but whether it starts
   open is a remembered preference, so ask rather than assume. */
if (!(await page.locator('#part-list').isVisible())) {
  await page.locator('#parts-btn').click();
  await page.waitForSelector('#part-list', { state: 'visible' });
}

/* Choose a part, the way a singer does. An inner voice rather than the top line:
   it is the part people come here to learn, and it puts the highlight somewhere
   other than the first stave. Clicked rather than `.check()`ed, because checking
   an input scrolls the panel to reach it and the panel would then be
   photographed part way down its own list. */
const parts = page.locator('#part-list .part');
await parts.nth(Math.min(1, (await parts.count()) - 1)).locator('.part-pick').click();

/*
 * Move off bar 1. Voices in a madrigal enter one at a time, so the opening bars
 * are mostly rests -- a true picture of the app and a poor picture of a score.
 *
 * The transport button rather than the arrow key it is labelled with: choosing a
 * part leaves focus on a radio, and an arrow key inside a radio group moves the
 * selection rather than the bar. Eight presses walked the part list back round
 * and never touched the score.
 */
for (let bar = 0; bar < 8; bar++) await page.locator('#next-bar').click();

/* Checking a part scrolls the panel to reach it; put the list back at the top
   so the picture starts where the reader's eye does. */
await page.locator('.panel-scroll').evaluate(node => node.scrollTo(0, 0));

/* The canvas redraws on each of those; give it a moment to settle. */
await page.waitForTimeout(900);

const shot = (await page.screenshot({ type: 'png' })).toString('base64');

if (problems.length) {
  await browser.close();
  console.error('the app logged problems while being photographed:', problems);
  process.exit(1);
}

/*
 * Lay the photograph into the card, in its own context at a device pixel ratio
 * of 1: the card is 1200x630 *pixels*, not 1200x630 CSS pixels, and a scale
 * factor of 2 here would quietly write a 2400x1260 image under a tag that
 * promises otherwise. The photograph inside it was taken at 2, so it is scaled
 * down rather than up.
 */
const cardContext = await browser.newContext({
  viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
  deviceScaleFactor: 1
});
const card = await cardContext.newPage();
await card.setContent(cardHtml(shot), { waitUntil: 'load' });
await card.evaluate(() => document.fonts.ready);
const png = await card.screenshot({
  type: 'png',
  clip: { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }
});
writeFileSync(OUTPUT, png);

await browser.close();
console.log(`wrote ${OUTPUT} (${CARD_WIDTH}x${CARD_HEIGHT}, ${(png.length / 1024).toFixed(0)} kB)`);
