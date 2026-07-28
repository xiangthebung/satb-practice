/** Throwaway probe: where the key-signature accidentals actually land. */
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', error => console.log('PAGE ERROR', error.message));
await page.goto('http://localhost:8199/index.html');
await page.getByRole('button', { name: /Smávinir/i }).click();
await page.waitForSelector('#transport:not([hidden])');
await page.waitForTimeout(400);

const report = await page.evaluate(async () => {
  const renderer = window.choirPracticeApp.renderer;
  const module = await import('/js/notation-renderer.js');
  const canvas = document.getElementById('score-canvas');
  const ctx = canvas.getContext('2d');
  const ratio = renderer.pixelRatio;
  const { lineSpacing } = renderer.config;
  const staffTop = renderer.getStaffY(0);
  const clef = module.getClefDescriptorForPart(
    window.choirPracticeApp.state.parts[0], 0, 4
  );
  const layout = module.getKeySignatureLayout(4, clef);

  // The key signature starts after the clef; read the drawn x from the renderer.
  const keyX = renderer.config.marginLeft +
    (await import('/js/glyphs.js')).clefGlyphWidth(clef.sign, lineSpacing) +
    lineSpacing * 0.35;

  const dark = (x, y) => {
    const d = ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
    return d[0] < 140 && d[1] < 140 && d[2] < 140;
  };

  // For each accidental column, find the vertical span of dark ink.
  const step = 0.92 * lineSpacing;
  return layout.map((item, index) => {
    const centreX = keyX + index * step;
    const expectedY = staffTop + 4 * lineSpacing - item.position * lineSpacing / 2;
    let top = null;
    let bottom = null;
    for (let y = Math.round(staffTop - 40); y < staffTop + 4 * lineSpacing + 40; y += 0.5) {
      let hit = false;
      for (let dx = -1.5; dx <= 1.5; dx += 0.5) if (dark(centreX + dx, y)) hit = true;
      if (hit) {
        if (top === null) top = y;
        bottom = y;
      }
    }
    return {
      step: item.step,
      position: item.position,
      expectedCentreY: Math.round(expectedY * 10) / 10,
      measuredCentreY: top === null ? null : Math.round((top + bottom) / 2 * 10) / 10,
      inkSpan: top === null ? null : [top, bottom]
    };
  });
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
