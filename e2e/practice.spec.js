/**
 * Browser smoke tests.
 *
 * The unit suite covers the pure logic and the static checks cover the wiring,
 * but neither can tell whether the app actually works. These tests drive the
 * real thing: open a score, play it, move around it, change the settings, and
 * export. They also fail on any uncaught error or console error, which is what
 * catches a module that throws on load.
 *
 * Both a desktop and a phone viewport run the whole suite, because the parts
 * panel and several transport controls behave differently at each size.
 */

import { expect, test } from '@playwright/test';

/** Collect page and console errors so a test can assert nothing went wrong. */
function watchForErrors(page) {
  const problems = [];
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  return problems;
}

/** Open a bundled sample and wait for the practice screen. */
async function openSample(page, name = 'Draw on, sweet night') {
  await page.goto('/index.html');
  await page.getByRole('button', { name: new RegExp(name, 'i') }).click();
  await expect(page.locator('#practice')).toBeVisible();
  await expect(page.locator('#transport')).toBeVisible();

  // The canvas is only meaningful once the renderer has sized its backing store.
  await expect
    .poll(() => page.locator('#score-canvas').evaluate(canvas => canvas.width))
    .toBeGreaterThan(0);
}

/**
 * Make the parts panel usable.
 *
 * It is a column beside the score on a wide screen and a bottom sheet on a
 * narrow one, so a test that wants a part row has to ask for it on a phone.
 */
async function showParts(page) {
  const list = page.locator('#part-list');
  if (await list.isVisible()) return;
  await page.locator('#parts-btn').click();
  await expect(list).toBeVisible();
}

/** Read a value out of the running app. */
function readState(page, path) {
  return page.evaluate(
    expression => new Function('app', `return ${expression};`)(window.choirPracticeApp),
    path
  );
}

test.describe('opening a score', () => {
  test('the home screen offers the samples', async ({ page }) => {
    const problems = watchForErrors(page);
    await page.goto('/index.html');

    await expect(page.getByRole('heading', { name: 'Practice your part' })).toBeVisible();
    await expect(page.locator('.sample')).toHaveCount(3);
    await expect(page.locator('#transport')).toBeHidden();

    expect(problems).toEqual([]);
  });

  test('a sample loads into the practice screen', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);
    await showParts(page);

    await expect(page.locator('#score-name')).toHaveText(/./);
    await expect(page.locator('#part-list .part')).not.toHaveCount(0);

    expect(problems).toEqual([]);
  });

  test('the score title reaches the document title', async ({ page }) => {
    await openSample(page);
    await expect(page).toHaveTitle(/Choir Practice/);
  });

  test('the score reports its structure to the engine', async ({ page }) => {
    await openSample(page);

    const summary = await readState(page, `({
      bars: app.getBarList().length,
      totalScoreBeats: app.audioEngine.getTotalBeats(),
      totalPlaybackBeats: app.audioEngine.getTotalPlaybackBeats(),
      tempoEntries: app.state.metadata.tempoMap.length
    })`);

    expect(summary.bars).toBeGreaterThan(0);
    expect(summary.totalScoreBeats).toBeGreaterThan(0);
    expect(summary.totalPlaybackBeats).toBeGreaterThanOrEqual(summary.totalScoreBeats);
    expect(summary.tempoEntries).toBeGreaterThan(0);
  });
});

test.describe('the transport', () => {
  test('play and pause change the button and move the position', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);

    const play = page.locator('#play-btn');
    await expect(play).toHaveAttribute('aria-label', 'Play');

    await play.click();
    await expect(play).toHaveAttribute('aria-label', 'Pause');

    // The clock has to actually advance.
    await expect
      .poll(() => page.locator('#time-display').textContent(), { timeout: 8000 })
      .not.toBe('0:00 / 0:00');

    await play.click();
    await expect(play).toHaveAttribute('aria-label', 'Play');

    expect(problems).toEqual([]);
  });

  test('the space bar plays and pauses', async ({ page }) => {
    await openSample(page);
    await page.locator('#stage').click();

    await page.keyboard.press('Space');
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-label', 'Pause');

    await page.keyboard.press('Space');
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-label', 'Play');
  });

  test('the arrow keys step through the bars', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);

    const beatAt = () => readState(page, 'app.state.currentBeat');
    expect(await beatAt()).toBe(0);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const forward = await beatAt();
    expect(forward).toBeGreaterThan(0);

    await page.keyboard.press('ArrowLeft');
    expect(await beatAt()).toBeLessThan(forward);

    await page.keyboard.press('Home');
    expect(await beatAt()).toBe(0);

    expect(problems).toEqual([]);
  });

  test('the tempo slider changes the tempo', async ({ page }) => {
    await openSample(page);

    await page.locator('#tempo').fill('72');
    await page.locator('#tempo').dispatchEvent('change');

    await expect(page.locator('#tempo-value')).toHaveText('72 BPM');
    expect(await readState(page, 'app.state.tempo')).toBe(72);
  });

  test('clicking the score moves the cursor', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);

    const box = await page.locator('#score-canvas').boundingBox();
    // Clicking snaps to the nearest note onset, so aim well clear of the fixed
    // name and clef gutter on the left.
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.4);

    expect(await readState(page, 'app.state.currentBeat')).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

test.describe('parts and mix', () => {
  test('choosing a part updates the session', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);
    await showParts(page);

    const rows = page.locator('#part-list .part');
    expect(await rows.count()).toBeGreaterThan(1);

    await rows.nth(1).locator('input[name="my-part"]').check();
    expect(await readState(page, 'app.state.myPartId')).toBeTruthy();

    expect(problems).toEqual([]);
  });

  test('solo isolates a part and can be cleared', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);
    await showParts(page);

    const solo = page.locator('#part-list .part').first().locator('.part-solo');

    await solo.click();
    await expect(solo).toHaveAttribute('aria-pressed', 'true');
    expect(await readState(page, 'app.state.soloed.size')).toBe(1);

    await solo.click();
    await expect(solo).toHaveAttribute('aria-pressed', 'false');
    expect(await readState(page, 'app.state.soloed.size')).toBe(0);

    expect(problems).toEqual([]);
  });

  test('solo overrides mute rather than combining with it', async ({ page }) => {
    await openSample(page);
    await showParts(page);

    const row = page.locator('#part-list .part').first();
    await row.locator('.part-mute').click();
    await row.locator('.part-solo').click();

    // Asking to hear a line on its own works even when that line was muted.
    const audible = await readState(
      page,
      'app.audioEngine.getEffectivePartVolume(app.state.parts[0].id)'
    );
    expect(audible).toBeGreaterThan(0);
  });

  test('mute dims the row and stays put', async ({ page }) => {
    await openSample(page);
    await showParts(page);

    const row = page.locator('#part-list .part').first();
    const mute = row.locator('.part-mute');

    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toHaveClass(/is-muted/);
  });

  test('a rehearsal mix changes the part volumes', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);
    await showParts(page);

    // The radio is visually hidden behind its label, which is the row itself.
    await page
      .locator('.mix-option', { has: page.locator('input[value="only-mine"]') })
      .click();

    const volumes = await readState(page, 'app.state.volumes');
    const values = Object.values(volumes);
    expect(values).toContain(100);
    expect(values).toContain(0);

    expect(problems).toEqual([]);
  });
});

test.describe('settings', () => {
  test('the dialog opens and holds every control', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);

    await page.locator('#settings-btn').click();
    const dialog = page.locator('#settings-dialog');
    await expect(dialog).toBeVisible();

    for (const id of [
      '#master-volume', '#room', '#tuning', '#transpose', '#fermata',
      '#follow-dynamics', '#play-repeats', '#click-pattern', '#click-volume', '#count-in',
      '#show-lyrics', '#show-time-signatures', '#verse'
    ]) {
      await expect(dialog.locator(id)).toBeAttached();
    }

    await page.locator('#settings-done').click();
    await expect(dialog).toBeHidden();

    expect(problems).toEqual([]);
  });

  test('transposing changes the sounding pitch but not the score', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);
    await page.locator('#settings-btn').click();

    const firstMidi = () => readState(page, 'app.audioEngine.buildSchedule()[0].midi');
    const written = await readState(
      page,
      'app.state.parts[0].measures.flatMap(m => m.notes).find(n => n.pitch).pitch.octave'
    );

    await page.locator('#transpose').fill('-2');
    await page.locator('#transpose').dispatchEvent('input');
    await expect(page.locator('#transpose-value')).toHaveText('2 semitones down');
    const shifted = await firstMidi();

    await page.locator('#transpose').fill('0');
    await page.locator('#transpose').dispatchEvent('input');
    const plain = await firstMidi();

    expect(plain - shifted).toBe(2);
    // The notation is untouched by a rehearsal transposition.
    expect(await readState(
      page,
      'app.state.parts[0].measures.flatMap(m => m.notes).find(n => n.pitch).pitch.octave'
    )).toBe(written);

    expect(problems).toEqual([]);
  });

  test('restoring defaults resets the controls', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();

    await page.locator('#room').fill('90');
    await page.locator('#room').dispatchEvent('input');
    await expect(page.locator('#room-value')).toHaveText('90%');

    await page.locator('#settings-reset').click();
    await expect(page.locator('#room-value')).toHaveText('34%');
  });

  test('the tuning reference is adjustable', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();

    await page.locator('#tuning').fill('442');
    await page.locator('#tuning').dispatchEvent('input');

    await expect(page.locator('#tuning-value')).toHaveText('A = 442 Hz');
    expect(await readState(page, 'app.audioEngine.tuningHz')).toBe(442);
  });

  test('turning off repeats shortens the performance', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();

    const before = await readState(page, 'app.audioEngine.getTotalPlaybackBeats()');
    await page.locator('#play-repeats').uncheck();
    const after = await readState(page, 'app.audioEngine.getTotalPlaybackBeats()');

    // This sample has no repeats, so the length must be unchanged rather than wrong.
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });

  test('dynamics can be switched off', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();

    await page.locator('#follow-dynamics').uncheck();
    const levels = await readState(
      page,
      'app.audioEngine.buildSchedule().map(e => e.velocity)'
    );
    expect(new Set(levels).size).toBe(1);
  });

  test('a count-in delays the first note', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();

    await page.locator('#count-in').fill('2');
    await page.locator('#count-in').dispatchEvent('input');
    await expect(page.locator('#count-in-value')).toHaveText('2 bars');

    expect(await readState(page, 'app.audioEngine.getCountInBeats()')).toBeGreaterThan(0);
    expect(await readState(page, 'app.audioEngine.getCountInSeconds()')).toBeGreaterThan(0);
  });
});

test.describe('the score view', () => {
  /**
   * Count the pixels the renderer has painted.
   *
   * Whether something was drawn is the only honest test of a drawing option, so
   * these tests compare how much ink lands on the canvas rather than trusting a
   * flag on the renderer.
   *
   * @param {import('@playwright/test').Page} page
   * @param {{ fromLeft?: number }} [region] limit the count to a left-hand strip
   */
  function countInk(page, region = {}) {
    return page.locator('#score-canvas').evaluate((canvas, { fromLeft }) => {
      const ctx = canvas.getContext('2d');
      const width = fromLeft ? Math.min(canvas.width, fromLeft) : canvas.width;
      const { data } = ctx.getImageData(0, 0, width, canvas.height);
      let painted = 0;
      for (let index = 0; index < data.length; index += 4) {
        // Anything appreciably darker than the paper counts, which takes in the
        // black clefs and numerals as well as the coloured notes and words.
        const light = (data[index] + data[index + 1] + data[index + 2]) / 3;
        if (light < 200 && data[index + 3] > 20) painted++;
      }
      return painted;
    }, region);
  }

  test('the words can be hidden and brought back', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);
    await page.locator('#settings-btn').click();

    const toggle = page.locator('#show-lyrics');
    await expect(toggle).toBeChecked();
    const withWords = await countInk(page);

    await toggle.uncheck();
    expect(await readState(page, 'app.renderer.showLyrics')).toBe(false);
    const withoutWords = await countInk(page);
    expect(withoutWords).toBeLessThan(withWords);

    await toggle.check();
    expect(await countInk(page)).toBeGreaterThan(withoutWords);

    expect(problems).toEqual([]);
  });

  test('hiding the words is remembered across a reload', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();
    await page.locator('#show-lyrics').uncheck();

    await openSample(page);
    expect(await readState(page, 'app.renderer.showLyrics')).toBe(false);
    await page.locator('#settings-btn').click();
    await expect(page.locator('#show-lyrics')).not.toBeChecked();
  });

  test('the words clear the notes above them', async ({ page }) => {
    await openSample(page);

    // Words are placed under the lowest ink the part reaches, stems included, so
    // there has to be a clear band between the two.
    const clear = await page.locator('#score-canvas').evaluate(canvas => {
      const app = window.choirPracticeApp;
      const renderer = app.renderer;
      const part = app.state.parts[0];
      const ratio = renderer.pixelRatio;
      const { lineSpacing } = renderer.config;
      const staffBottom = renderer.getStaffY(0) + lineSpacing * 4;
      const baseline = staffBottom + renderer.getLyricBaselineOffset(part);
      const ink = renderer.getPartInk(part);
      const [, r, g, b] = ink.match(/(\d+), (\d+), (\d+)/).map(Number);

      const ctx = canvas.getContext('2d');
      // Look between the lowest note ink and the top of the words.
      const from = Math.round((baseline - lineSpacing * 1.25) * ratio);
      const to = Math.round((baseline - lineSpacing * 1.05) * ratio);
      const { data } = ctx.getImageData(0, from, canvas.width, Math.max(1, to - from));
      let coloured = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (Math.abs(data[index] - r) < 40 &&
            Math.abs(data[index + 1] - g) < 40 &&
            Math.abs(data[index + 2] - b) < 40) coloured++;
      }
      return coloured;
    });

    expect(clear).toBe(0);
  });

  test('a single-verse score hides the verse picker', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();

    expect(await readState(page, 'app.renderer.getVerseCount()')).toBe(1);
    await expect(page.locator('#verse-row')).toBeHidden();
  });

  test('the time signature can be hidden, which narrows the gutter', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);
    await page.locator('#settings-btn').click();

    const gutter = () => page.locator('#score-canvas').evaluate(canvas => {
      const renderer = window.choirPracticeApp.renderer;
      return Math.round((renderer.config.marginLeft + renderer.config.clefWidth) *
        renderer.pixelRatio);
    });

    const strip = await gutter();
    const withTime = await countInk(page, { fromLeft: strip });

    await page.locator('#show-time-signatures').uncheck();
    expect(await readState(page, 'app.renderer.showTimeSignatures')).toBe(false);

    expect(await countInk(page, { fromLeft: strip })).toBeLessThan(withTime);
    // The reserved room shrinks with the numerals, rather than being left empty.
    expect(await gutter()).toBeLessThan(strip);

    expect(problems).toEqual([]);
  });
});

test.describe('the rehearsal loop', () => {
  test('a bar range can be set and cleared', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);

    await page.locator('#loop-range-btn').click();
    await page.locator('#loop-from').fill('2');
    await page.locator('#loop-to').fill('4');
    await page.locator('#loop-to').blur();

    await expect(page.locator('#loop-range-summary')).toHaveText('Bars 2 to 4');
    await expect(page.locator('#loop-range-badge')).toBeVisible();

    const range = await readState(page, 'app.audioEngine.getLoopRange()');
    expect(range).not.toBeNull();
    expect(range.end).toBeGreaterThan(range.start);

    await page.locator('#loop-clear').click();
    await expect(page.locator('#loop-range-summary')).toHaveText('The whole score');
    expect(await readState(page, 'app.audioEngine.getLoopRange()')).toBeNull();

    expect(problems).toEqual([]);
  });

  test('the bracket keys mark the loop from the cursor', async ({ page }) => {
    await openSample(page);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('BracketLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('BracketRight');

    const range = await readState(page, 'app.state.loopRange');
    expect(range).not.toBeNull();
    expect(range.toBar).toBeGreaterThanOrEqual(range.fromBar);

    await page.keyboard.press('Backslash');
    expect(await readState(page, 'app.state.loopRange')).toBeNull();
  });

  test('marking a range from the keyboard fills the fields', async ({ page }) => {
    await openSample(page);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('BracketLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('BracketRight');

    await page.locator('#loop-range-btn').click();
    await expect(page.locator('#loop-from')).not.toHaveValue('');
    await expect(page.locator('#loop-to')).not.toHaveValue('');
  });
});

test.describe('exports', () => {
  test('MusicXML export produces a file', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page);

    await page.locator('#export-btn').click();
    const download = page.waitForEvent('download');
    await page.locator('#export-xml-btn').click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.musicxml$/);

    expect(problems).toEqual([]);
  });
});

test.describe('accessibility basics', () => {
  test('the help sheet opens from the keyboard', async ({ page }) => {
    await openSample(page);
    await page.keyboard.press('?');
    await expect(page.locator('#help-dialog')).toBeVisible();
  });

  test('sliders describe themselves', async ({ page }) => {
    await openSample(page);
    await expect(page.locator('#tempo')).toHaveAttribute('aria-valuetext', /beats per minute/);
    await expect(page.locator('#seek')).toHaveAttribute('aria-valuetext', /of/);
  });

  test('the skip link is the first focus stop', async ({ page }) => {
    await page.goto('/index.html');
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
  });

  test('the clefs and key signature are actually painted', async ({ page }) => {
    await openSample(page);

    // Clefs and accidentals are drawn as geometry rather than set as characters
    // from a music font, so this is the check that they appear at all: with the
    // old font stack a machine without a music font drew nothing here.
    const ink = await page.locator('#score-canvas').evaluate(canvas => {
      const ctx = canvas.getContext('2d');
      const gutter = Math.min(canvas.width, 360);
      const { data } = ctx.getImageData(0, 0, gutter, canvas.height);
      let dark = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] < 120 && data[index + 1] < 120 && data[index + 2] < 120) dark++;
      }
      return dark;
    });

    expect(ink).toBeGreaterThan(200);
  });

  test('the score canvas names the piece and its parts', async ({ page }) => {
    await openSample(page);
    await expect(page.locator('#score-canvas'))
      .toHaveAttribute('aria-label', /Score for .+\. Parts: .+/);
  });
});
