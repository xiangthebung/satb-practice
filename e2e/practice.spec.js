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

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { REPEAT_WITH_ENDINGS_XML } from './fixtures/repeat-with-endings.js';
import { TWO_VOICES_ON_ONE_STAFF_XML } from './fixtures/two-voices-on-one-staff.js';

/**
 * Open a score that is not one of the shipped samples, through the app's own
 * file input — the same path a singer uses for their own MusicXML.
 */
async function openFixture(page, xml, name = 'fixture.musicxml') {
  await page.goto('/index.html');
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'application/xml',
    buffer: Buffer.from(xml, 'utf8'),
  });
  await expect(page.locator('#practice')).toBeVisible();
  await expect(page.locator('#transport')).toBeVisible();
  await expect
    .poll(() => page.locator('#score-canvas').evaluate(canvas => canvas.width))
    .toBeGreaterThan(0);
}

/**
 * The scores actually sitting in `public/sample-pieces/`.
 *
 * Counted rather than hardcoded. The home-screen assertion below used to say
 * `toHaveCount(3)`, which meant adding a fourth sample failed a test that had no
 * opinion about the fourth sample — and, worse, said nothing about the case that
 * matters: a score shipped in the bundle that the home screen never offers.
 * Reading the directory tests that instead.
 */
const BUNDLED_SAMPLES = readdirSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'sample-pieces'),
).filter(name => /\.(musicxml|xml|mxl)$/i.test(name));

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
  // The sample card, not the "Continue" card that names the same score once it
  // has been opened before.
  await page.locator('button.sample', { hasText: new RegExp(name, 'i') }).click();
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

/**
 * Flip one of the settings switches by its row.
 *
 * Not `locator('#show-lyrics').uncheck()`, which aims at the 44x26 input. The
 * settings dialog scrolls under a sticky head and a sticky actions bar, and a
 * point computed against a 26px-tall target inside a scroller is a point that
 * stops being right the moment anything above it changes height. That is what
 * made this suite red on CI for three weeks and green on the author's machine
 * the whole time: the runner's system font is wider, the rows wrap, the switch
 * sits somewhere else, and the click landed on the label or on the actions bar.
 *
 * The row is the honest target anyway. It is a `<label for>` spanning the full
 * width of the dialog, so it is what a person taps.
 */
async function setSwitch(page, id, on) {
  const input = page.locator(`#${id}`);
  if ((await input.isChecked()) === on) return;
  await page.locator(`label.switch-row[for="${id}"]`).click();
  await expect(input).toBeChecked({ checked: on });
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
    await expect(page.locator('.sample')).toHaveCount(BUNDLED_SAMPLES.length);
    // Every bundled score is reachable from the home screen, and each card points at
    // a file that is really there. Either half failing is a sample nobody can open.
    const offered = await page.locator('.sample').evaluateAll(nodes =>
      nodes.map(node => node.dataset.samplePath),
    );
    expect(offered.map(path => path.replace(/^sample-pieces\//, '')).sort()).toEqual(
      [...BUNDLED_SAMPLES].sort(),
    );
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

    // The readout also says how the tempo compares with the score's own.
    await expect(page.locator('#tempo-value')).toHaveText(/^72 BPM · \d+%$/);
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

  test('the shortcuts still work once you have chosen your part', async ({ page }) => {
    // Choosing a part is the first thing anybody does, and it leaves focus on a
    // radio. Every shortcut the help sheet advertises used to stop working at
    // that moment -- silently, so the app simply appeared not to respond. The
    // arrows and Home belong to the radio group and still do; everything else
    // does not and now falls through.
    const problems = watchForErrors(page);
    await openSample(page);
    await showParts(page);

    const chosen = page.locator('#part-list .part input[name="my-part"]').nth(1);
    await chosen.check();
    await expect(chosen).toBeFocused();

    const metronomeBefore = await readState(page, 'app.state.metronome');
    await page.keyboard.press('m');
    expect(
      await readState(page, 'app.state.metronome'),
      'M did not reach the metronome from a focused part radio'
    ).toBe(!metronomeBefore);

    await page.keyboard.press('Space');
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-label', 'Pause');
    await page.keyboard.press('Space');
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-label', 'Play');

    // And `?` opens the sheet that makes the promise, which was itself swallowed.
    await page.keyboard.press('?');
    await expect(page.locator('#help-dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    // The keys the radio group genuinely owns are still the radio group's: an
    // arrow moves the choice, it does not seek a bar.
    await chosen.focus();
    const barBefore = await readState(page, 'app.renderer.currentBeat');
    await page.keyboard.press('ArrowRight');
    expect(
      await readState(page, 'app.renderer.currentBeat'),
      'the arrow keys stopped belonging to the radio group'
    ).toBe(barBefore);

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
      '#follow-dynamics', '#play-repeats', '#click-pattern', '#click-volume', '#count-in-bars',
      '#show-lyrics', '#show-time-signatures', '#verse'
    ]) {
      await expect(dialog.locator(id)).toBeAttached();
    }

    await page.locator('#settings-done').click();
    await expect(dialog).toBeHidden();

    expect(problems).toEqual([]);
  });

  test('the settings dialog never scrolls a control under its own furniture', async ({ page }) => {
    // The dialog is the scroller and its head and actions bar are sticky, so
    // every scroll-into-view — the browser's, when Tab reaches a control near
    // the edge, and an automated check's, before it clicks — can put the thing
    // it was aiming for underneath one of those two strips. Under the head the
    // control is invisible. Under the actions bar it is also unclickable: that
    // bar takes the pointer, so the click lands on "Restore defaults" instead
    // of on what the person could see a moment ago.
    //
    // `scroll-padding-block` in styles.css is the only thing preventing that.
    // This test exists because its value has to stay ahead of two bars that
    // grow with the system font, and nothing else would notice if it stopped.
    const problems = watchForErrors(page);
    await openSample(page);
    await page.locator('#settings-btn').click();

    const dialog = page.locator('#settings-dialog');
    await expect(dialog).toBeVisible();

    const bars = await dialog.evaluate(element => {
      const styles = getComputedStyle(element);
      return {
        head: element.querySelector('.modal-head').getBoundingClientRect().height,
        actions: element.querySelector('.modal-actions').getBoundingClientRect().height,
        padTop: parseFloat(styles.scrollPaddingBlockStart),
        padBottom: parseFloat(styles.scrollPaddingBlockEnd),
        scrolls: element.scrollHeight > element.clientHeight
      };
    });

    // If the dialog stops scrolling there is nothing to hide behind and the
    // rest of this proves nothing, so say so rather than passing quietly.
    expect(bars.scrolls, 'the settings dialog no longer scrolls').toBe(true);
    expect(bars.padTop, 'scroll padding no longer clears the sticky head')
      .toBeGreaterThanOrEqual(bars.head);
    expect(bars.padBottom, 'scroll padding no longer clears the sticky actions bar')
      .toBeGreaterThanOrEqual(bars.actions);

    // And the property those numbers exist for: scroll each switch to the
    // bottom edge, the worst case, and check the pointer still reaches it.
    for (const id of ['show-lyrics', 'show-time-signatures', 'follow-dynamics', 'play-repeats']) {
      const reachable = await page.evaluate(async controlId => {
        const input = document.getElementById(controlId);
        input.scrollIntoView({ block: 'end', behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(resolve));
        const box = input.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { ok: hit === input || input.contains(hit) || hit?.contains(input), hit: hit?.className ?? null };
      }, id);
      expect(reachable.ok, `#${id} scrolled under ${reachable.hit}`).toBe(true);
    }

    await page.locator('#settings-done').click();
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

    await page.locator('#count-in-bars').fill('2');
    await page.locator('#count-in-bars').dispatchEvent('input');
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

    await setSwitch(page, 'show-lyrics', false);
    expect(await readState(page, 'app.renderer.showLyrics')).toBe(false);
    const withoutWords = await countInk(page);
    expect(withoutWords).toBeLessThan(withWords);

    await setSwitch(page, 'show-lyrics', true);
    expect(await countInk(page)).toBeGreaterThan(withoutWords);

    expect(problems).toEqual([]);
  });

  test('hiding the words is remembered across a reload', async ({ page }) => {
    await openSample(page);
    await page.locator('#settings-btn').click();
    await setSwitch(page, 'show-lyrics', false);

    await openSample(page);
    expect(await readState(page, 'app.renderer.showLyrics')).toBe(false);
    await page.locator('#settings-btn').click();
    await expect(page.locator('#show-lyrics')).not.toBeChecked();
  });

  test('the words are painted clear of the notes above them', async ({ page }) => {
    // Two voices on one staff routinely carry forced down stems. Opened out onto
    // a staff each, those stems hang three spaces under every notehead, and the
    // words used to be drawn straight through them. This is the score shape that
    // shows it, and it is a fixture rather than a shipped sample: the app offers
    // four real pieces, and a harmony exercise existing only for this measurement
    // does not need to be one of them. See e2e/fixtures/two-voices-on-one-staff.js.
    await openFixture(page, TWO_VOICES_ON_ONE_STAFF_XML);

    /**
     * Measure each part's lyric band off the painted canvas.
     *
     * The band is recorded relative to the part's own staff, because switching
     * the words off re-spaces the staves while leaving each part's notes in the
     * same place relative to its staff. Sampling the same band twice therefore
     * separates the two kinds of ink that share a colour: whatever is still there
     * with the words switched off is a note, a stem or a beam.
     */
    const sampleLyricBands = () => page.locator('#score-canvas').evaluate(canvas => {
      const app = window.choirPracticeApp;
      const renderer = app.renderer;
      const ctx = canvas.getContext('2d');
      const ratio = renderer.pixelRatio;
      const { lineSpacing, lyricSize } = renderer.config;

      // The playback cursor is drawn in the accent colour, close enough to a blue
      // part's ink to be mistaken for it, so its column is left out.
      const cursorX = (renderer.getScoreX(renderer.currentBeat) - renderer.scrollX) * ratio;

      ctx.save();
      ctx.font = `${Math.max(8, Math.round(lineSpacing * lyricSize))}px ` +
        'Georgia, "Iowan Old Style", "Times New Roman", serif';
      const metrics = ctx.measureText('Sngh');
      ctx.restore();

      return app.state.parts.map((part, index) => {
        if (!renderer.partSingsSelectedVerse(part)) return null;

        const staffTop = renderer.getStaffY(index);
        // Offsets from the staff, so the same band can be found again after the
        // staves have been re-spaced.
        const bandTop = lineSpacing * 4 + renderer.getLyricBaselineOffset(part) -
          metrics.actualBoundingBoxAscent;
        const bandBottom = lineSpacing * 4 + renderer.getLyricBaselineOffset(part) +
          metrics.actualBoundingBoxDescent;

        const from = Math.round((staffTop + bandTop) * ratio);
        const height = Math.max(1, Math.round((staffTop + bandBottom) * ratio) - from);
        const { data } = ctx.getImageData(0, from, canvas.width, height);

        const [, r, g, b] = renderer.getPartInk(part).match(/(\d+), (\d+), (\d+)/).map(Number);
        let ink = 0;
        for (let row = 0; row < height; row++) {
          for (let x = 0; x < canvas.width; x++) {
            if (Math.abs(x - cursorX) < 8 * ratio) continue;
            const at = (row * canvas.width + x) * 4;
            if (Math.abs(data[at] - r) < 40 &&
                Math.abs(data[at + 1] - g) < 40 &&
                Math.abs(data[at + 2] - b) < 40) ink++;
          }
        }
        return { name: part.name, bandTop, bandBottom, ink };
      }).filter(Boolean);
    });

    const withWords = await sampleLyricBands();
    expect(withWords.length).toBeGreaterThan(0);
    // A part can hold words yet have none of them in the opening window, so the
    // paint check is made across the score.
    expect(
      withWords.reduce((sum, row) => sum + row.ink, 0),
      'no words were painted anywhere'
    ).toBeGreaterThan(0);

    // Now take the notes on their own. Anything left in a lyric band is ink the
    // words would have been drawn on top of.
    await page.locator('#settings-btn').click();
    await setSwitch(page, 'show-lyrics', false);
    await page.locator('#settings-done').click();

    const bands = withWords.map(row => ({ bandTop: row.bandTop, bandBottom: row.bandBottom }));
    const intruding = await page.locator('#score-canvas').evaluate((canvas, bands) => {
      const app = window.choirPracticeApp;
      const renderer = app.renderer;
      const ctx = canvas.getContext('2d');
      const ratio = renderer.pixelRatio;
      const cursorX = (renderer.getScoreX(renderer.currentBeat) - renderer.scrollX) * ratio;

      const singing = app.state.parts
        .map((part, index) => ({ part, index }))
        .filter(entry => renderer.partSingsSelectedVerse(entry.part));

      return singing.map((entry, position) => {
        const band = bands[position];
        const staffTop = renderer.getStaffY(entry.index);
        const from = Math.round((staffTop + band.bandTop) * ratio);
        const height = Math.max(1, Math.round((staffTop + band.bandBottom) * ratio) - from);
        const { data } = ctx.getImageData(0, from, canvas.width, height);

        const [, r, g, b] = renderer.getPartInk(entry.part)
          .match(/(\d+), (\d+), (\d+)/).map(Number);
        let ink = 0;
        for (let row = 0; row < height; row++) {
          for (let x = 0; x < canvas.width; x++) {
            if (Math.abs(x - cursorX) < 8 * ratio) continue;
            const at = (row * canvas.width + x) * 4;
            if (Math.abs(data[at] - r) < 40 &&
                Math.abs(data[at + 1] - g) < 40 &&
                Math.abs(data[at + 2] - b) < 40) ink++;
          }
        }
        return { name: entry.part.name, ink };
      });
    }, bands);

    for (const row of intruding) {
      expect(row.ink, `${row.name}: notes reach into the row the words sit on`).toBe(0);
    }
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

    // Clefs, key signatures and numerals share the fixed gutter that the music
    // scrolls past. Counting the score ink inside whatever the gutter currently
    // spans keeps the notes out of the measurement: they begin where it ends, so
    // the count follows the gutter as it narrows instead of filling up with music.
    const gutterInk = () => page.locator('#score-canvas').evaluate(canvas => {
      const renderer = window.choirPracticeApp.renderer;
      const ratio = renderer.pixelRatio;
      const { marginLeft, clefWidth } = renderer.config;
      const width = Math.max(1, Math.round((marginLeft + clefWidth) * ratio) - 1);

      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, width, canvas.height);
      let black = 0;
      for (let at = 0; at < data.length; at += 4) {
        // Numerals are printed in the score ink, so the count is limited to
        // neutral dark pixels; that leaves out the coloured notes and the pale
        // staff lines running through the gutter.
        const spread = Math.max(data[at], data[at + 1], data[at + 2]) -
          Math.min(data[at], data[at + 1], data[at + 2]);
        if (data[at] < 110 && spread < 30) black++;
      }
      return black;
    });

    const gutter = () => readState(
      page,
      'app.renderer.config.marginLeft + app.renderer.config.clefWidth'
    );
    const lineSpacing = await readState(page, 'app.renderer.config.lineSpacing');

    const withTime = await gutter();
    const inkWithTime = await gutterInk();
    expect(inkWithTime).toBeGreaterThan(0);

    await page.locator('#show-time-signatures').uncheck();
    expect(await readState(page, 'app.renderer.showTimeSignatures')).toBe(false);

    // The room reserved for the numerals is released rather than left empty.
    expect(await gutter()).toBeLessThanOrEqual(withTime - lineSpacing);
    expect(await gutterInk()).toBeLessThan(inkWithTime);

    expect(problems).toEqual([]);
  });
});

/**
 * The parts panel, at both layouts.
 *
 * These exist because both of its layouts were wrong in the same way and neither
 * was caught by anything: above 900px it could not be closed at all (no close
 * button, no trigger, and a `close` listener that re-opened it), and below 900px
 * it opened with `showModal()`, which put it over the score with a backdrop —
 * measured at 860x640 it covered 83% of the score, made the play button
 * unclickable, and stopped the space bar, because the app stands its keyboard
 * handler down while a modal dialog is open. All three break the one thing the
 * app is for: moving the balance while you listen.
 *
 * Everything here is a geometric or hit-test assertion rather than a class name,
 * so a stylesheet change that reintroduces the overlap fails even if the markup
 * is untouched.
 */
/**
 * Repeats and endings, on the page as well as in the ear.
 *
 * `repeats.js` has always expanded a repeat into the performance order, and the
 * audio has always jumped correctly. Nothing drew the signs, so a singer heard
 * the music go back four bars at a barline that looked exactly like the other
 * fifty. Both assertions below are differential — the same region of canvas is
 * measured with the barline data present and with it removed — so they test that
 * the marks are *painted from the score*, which a fixed pixel count would not.
 */
test.describe('repeats and endings', () => {
  /**
   * Remember a region of the canvas so it can be compared with itself later.
   *
   * Counting dark pixels does not work here: the score is drawn on an opaque
   * paper fill, so every pixel in any region is already opaque and nearly every
   * pixel is already near the paper colour. What distinguishes "painted" from
   * "not painted" is that the region *changed*, so that is what is measured.
   */
  function rememberRegion(page, region) {
    return page.evaluate(box => {
      const canvas = document.querySelector('#score-canvas');
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      window.__region = {
        x: Math.round(box.x * ratio),
        y: Math.round(box.y * ratio),
        width: Math.max(1, Math.round(box.width * ratio)),
        height: Math.max(1, Math.round(box.height * ratio)),
      };
      const { x, y, width, height } = window.__region;
      window.__before = canvas.getContext('2d').getImageData(x, y, width, height).data;
    }, region);
  }

  /** How many pixels of the remembered region are now a different colour. */
  function countChangedPixels(page) {
    return page.evaluate(() => {
      const canvas = document.querySelector('#score-canvas');
      const { x, y, width, height } = window.__region;
      const after = canvas.getContext('2d').getImageData(x, y, width, height).data;
      const before = window.__before;
      let changed = 0;
      for (let at = 0; at < after.length; at += 4) {
        if (Math.abs(after[at] - before[at]) > 12 ||
            Math.abs(after[at + 1] - before[at + 1]) > 12 ||
            Math.abs(after[at + 2] - before[at + 2]) > 12) changed++;
      }
      return changed;
    });
  }

  /** Re-render with every barline marking stripped out of the parsed score. */
  function stripBarlines(page) {
    return page.evaluate(() => {
      const renderer = window.choirPracticeApp.renderer;
      for (const measure of renderer.metadata.measureStructure) measure.barlines = [];
      renderer.invalidateStaticScore();
      renderer.render();
    });
  }

  test('the performance is longer than the page, and says so on the page', async ({ page }) => {
    const problems = watchForErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openFixture(page, REPEAT_WITH_ENDINGS_XML, 'repeat.musicxml');

    // Four bars of score, five bars of performance: 1, 2, 1, 3, 4.
    const beats = await readState(page, `({
      score: app.audioEngine.getTotalBeats(),
      performance: app.audioEngine.getTotalPlaybackBeats()
    })`);
    expect(beats.score).toBe(16);
    expect(beats.performance).toBe(20);

    const geometry = await page.evaluate(() => {
      const renderer = window.choirPracticeApp.renderer;
      return { staffTop: renderer.staffTop, width: renderer.viewWidth };
    });

    // The volta brackets sit in the band above the top stave, where nothing else
    // is ever drawn except the measure numbers lower down.
    const bracketBand = {
      x: 0,
      y: Math.max(0, geometry.staffTop - 50),
      width: geometry.width,
      height: 18,
    };
    await rememberRegion(page, bracketBand);
    await stripBarlines(page);
    const changed = await countChangedPixels(page);

    expect(changed, 'nothing above the stave is painted from the endings')
      .toBeGreaterThan(200);

    expect(problems).toEqual([]);
  });

  test('the repeat signs are painted on the staves', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openFixture(page, REPEAT_WITH_ENDINGS_XML, 'repeat.musicxml');

    const staff = await page.evaluate(() => {
      const renderer = window.choirPracticeApp.renderer;
      return {
        staffTop: renderer.staffTop,
        lineSpacing: renderer.config.lineSpacing,
        width: renderer.viewWidth,
      };
    });

    /* A horizontal strip through the middle of the second stave space, where the
       repeat dots sit. Staff lines fall on whole multiples of the line spacing,
       so a strip at 1.5 spaces crosses no staff line and the dots are the only
       thing that can put ink in it apart from a notehead. */
    const dotStrip = {
      x: 0,
      y: staff.staffTop + staff.lineSpacing * 1.5 - 2,
      width: staff.width,
      height: 4,
    };
    await rememberRegion(page, dotStrip);
    await stripBarlines(page);
    const changed = await countChangedPixels(page);

    expect(changed, 'no repeat dots are painted at the barlines').toBeGreaterThan(20);
  });
});

test.describe('the parts panel', () => {
  test('it closes and reopens, and closing gives the room to the score', async ({ page }) => {
    const problems = watchForErrors(page);
    await page.setViewportSize({ width: 1280, height: 560 });
    await openSample(page);

    const trigger = page.locator('#parts-btn');
    const panel = page.locator('#parts-panel');
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const wide = () => page.locator('#score-frame').evaluate(el => el.getBoundingClientRect().width);
    const withPanel = await wide();

    await trigger.click();
    await expect(panel).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The panel's track collapses rather than leaving a reserved gap.
    expect(await wide()).toBeGreaterThan(withPanel + 200);

    await trigger.click();
    await expect(panel).toBeVisible();
    expect(Math.round(await wide())).toBe(Math.round(withPanel));

    expect(problems).toEqual([]);
  });

  test('the close button inside the panel closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSample(page);

    await page.locator('#parts-close').click();
    await expect(page.locator('#parts-panel')).toBeHidden();
    // Focus goes back to the control that can bring it back.
    await expect(page.locator('#parts-btn')).toBeFocused();
  });

  for (const [width, height] of [[860, 640], [390, 844]]) {
    test(`at ${width}x${height} the open panel does not cover the score`, async ({ page }) => {
      const problems = watchForErrors(page);
      await page.setViewportSize({ width, height });
      await openSample(page);
      await showParts(page);

      const overlap = await page.evaluate(() => {
        const panelEl = document.querySelector('#parts-panel');
        const panel = panelEl.getBoundingClientRect();
        const frame = document.querySelector('#score-frame').getBoundingClientRect();
        const box = document.querySelector('#play-btn').getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          vertical: Math.max(0, Math.min(panel.bottom, frame.bottom) - Math.max(panel.top, frame.top)),
          frameHeight: Math.round(frame.height),
          modal: panelEl.matches(':modal'),
          playReachable: Boolean(hit && hit.closest('#play-btn')),
        };
      });

      expect(overlap.modal, 'the sheet is in the top layer again').toBe(false);
      expect(overlap.vertical, 'the panel overlaps the score frame').toBe(0);
      expect(overlap.frameHeight, 'the score has been squeezed to nothing').toBeGreaterThan(120);
      expect(overlap.playReachable, 'the panel is covering the play button').toBe(true);

      expect(problems).toEqual([]);
    });
  }

  test('the space bar still plays while the panel is open', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 640 });
    await openSample(page);
    await showParts(page);
    await expect(page.locator('#parts-panel')).toBeVisible();

    await page.locator('#stage').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Space');
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-label', 'Pause');
    expect(await readState(page, 'app.state.isPlaying')).toBe(true);

    await page.keyboard.press('Space');
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-label', 'Play');
  });

  test('Escape closes the panel', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 640 });
    await openSample(page);
    await showParts(page);

    await page.locator('#part-list input[name="my-part"]').first().focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#parts-panel')).toBeHidden();
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

test.describe('rehearsing a passage', () => {
  test('dragging along the bar ruler sets a loop, shows it on the score and turns looping on', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page, 'Happy birthday');

    // From the middle of the first bar to the middle of the last bar that is
    // on screen, which on a phone is only a bar or two along.
    const drag = await page.evaluate(() => {
      const renderer = window.choirPracticeApp.renderer;
      const box = document.querySelector('#score-canvas').getBoundingClientRect();
      const scale = renderer.scale;
      const origin = renderer.config.marginLeft + renderer.config.clefWidth;
      const ruler = renderer.getRulerBounds();
      const measures = renderer.horizontalLayout.measures;
      const middle = index => box.left +
        (origin + measures[index].startX + measures[index].width / 2 - renderer.scrollX) * scale;
      let last = 0;
      for (let index = 1; index < measures.length; index++) {
        if (middle(index) < box.right - 12) last = index;
      }
      return {
        y: box.top + ((ruler.top + ruler.bottom) / 2) * scale,
        from: middle(0),
        to: middle(last),
        fromBar: measures[0].number,
        toBar: measures[last].number
      };
    });
    expect(drag.toBar).toBeGreaterThan(drag.fromBar);

    await page.mouse.move(drag.from, drag.y);
    await page.mouse.down();
    await page.mouse.move(drag.from + 12, drag.y, { steps: 3 });
    await page.mouse.move(drag.to, drag.y, { steps: 8 });
    await page.mouse.up();

    const loop = await readState(page, `({
      range: app.state.loopRange && [app.state.loopRange.fromBar, app.state.loopRange.toBar],
      on: app.state.loop,
      band: app.renderer.getLoopBandX(),
      engine: app.audioEngine.getLoopRange()
    })`);
    expect(loop.range).toEqual([drag.fromBar, drag.toBar]);
    expect(loop.on, 'marking a range must turn looping on').toBe(true);
    expect(loop.band).not.toBeNull();
    expect(loop.engine.end).toBeGreaterThan(loop.engine.start);
    await expect(page.locator('#loop-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#loop-range-badge')).toBeVisible();
    await expect(page.locator('#loop-range-summary')).toHaveText(`Bars ${drag.fromBar} to ${drag.toBar}`);

    // The band is painted: the ruler strip inside the range is no longer paper.
    const painted = await page.evaluate(() => {
      const renderer = window.choirPracticeApp.renderer;
      const canvas = document.querySelector('#score-canvas');
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const band = renderer.getLoopBandX();
      const ruler = renderer.getRulerBounds();
      const x = Math.round((band.startX + 6 - renderer.scrollX) * renderer.scale * ratio);
      const y = Math.round((ruler.top + 3) * renderer.scale * ratio);
      const [r, g, b] = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      return { r, g, b };
    });
    expect(painted.r === painted.g && painted.g === painted.b, 'the loop band is not tinted').toBe(false);

    // A tap on the ruler is a seek, not a range.
    await page.mouse.click(drag.from, drag.y);
    expect(await readState(page, 'app.state.loopRange.fromBar')).toBe(drag.fromBar);
    await expect(page.locator('#bar-display')).toHaveText(new RegExp(`^bar ${drag.fromBar} `));

    expect(problems).toEqual([]);
  });

  test('the tempo readout shows the share of the written tempo, takes a typed tempo and resets on double-click', async ({ page }) => {
    await openSample(page, 'Happy birthday');
    const readout = page.locator('#tempo-value');
    await expect(readout).toHaveText('85 BPM · 100%');

    await readout.click();
    const entry = page.locator('#tempo-entry');
    await expect(entry).toBeVisible();
    await entry.fill('60');
    await entry.press('Enter');
    await expect(readout).toHaveText('60 BPM · 71%');
    expect(await readState(page, 'app.state.tempo')).toBe(60);

    await readout.dblclick();
    await expect(readout).toHaveText('85 BPM · 100%');
    expect(await readState(page, 'app.state.tempo')).toBe(85);
  });

  test('the count-in is one bar by default, counted over the score, and stops with the music', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page, 'Happy birthday');
    await page.locator('#settings-btn').click();
    await expect(page.locator('#count-in-value')).toHaveText('1 bar');
    await page.locator('#settings-done').click();

    await page.locator('#play-btn').click();
    const overlay = page.locator('#count-in');
    await expect(overlay).toBeVisible();
    // A whole bar of 3/4, even though the score opens with a one-beat pickup.
    await expect(overlay.locator('.count-in-beat')).toHaveCount(3);
    await expect(overlay.locator('.count-in-beat.is-now')).toHaveCount(1, { timeout: 5000 });

    await page.locator('#play-btn').click();
    await expect(overlay).toBeHidden();

    // And from the middle of the score, which is where a count-in is needed
    // most and where it used to be timed against a start twenty seconds gone.
    await page.locator('#next-bar').click();
    await page.locator('#next-bar').click();
    await page.locator('#next-bar').click();
    await expect(page.locator('#bar-display')).toHaveText(/^bar 4 /);
    await page.locator('#play-btn').click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.count-in-beat.is-now')).toHaveCount(1, { timeout: 5000 });
    await page.locator('#play-btn').click();
    await expect(overlay).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('the gutter shows the metre in force at the left edge, and never beside its own inline copy', async ({ page }) => {
    await openSample(page, 'Quick! We have but a second');
    // 9/8, then 12/8 at bar 12 and back to 9/8 at bar 13.
    const indices = await page.evaluate(() => {
      const app = window.choirPracticeApp;
      const renderer = app.renderer;
      const part = app.state.parts[0];
      const at = number => {
        renderer.setScrollX(renderer.getMeasureLayoutByNumber(number).startX);
        return renderer.getCourtesyIndices(part, null).timeIndex;
      };
      const times = renderer.partAttributes.get(part.id).times
        .map(time => `${time.numerator}/${time.denominator}@${time.measureIndex + 1}`);
      return { times, atStart: at(1), atTwelve: at(12), atThirteen: at(13) };
    });
    expect(indices.times.slice(0, 3)).toEqual(['9/8@1', '12/8@12', '9/8@13']);
    expect(indices.atStart).toBe(0);
    expect(indices.atTwelve).toBe(1);
    expect(indices.atThirteen).toBe(2);
  });

  test('syllables are given the room their words need', async ({ page }) => {
    await openSample(page, 'Quick! We have but a second');
    const overlaps = await page.evaluate(() => {
      const app = window.choirPracticeApp;
      const renderer = app.renderer;
      const ctx = document.createElement('canvas').getContext('2d');
      const { lineSpacing, lyricSize } = renderer.config;
      ctx.font = `${Math.max(8, Math.round(lineSpacing * lyricSize))}px ` +
        'Georgia, "Iowan Old Style", "Times New Roman", serif';
      const found = [];
      for (const part of app.state.parts) {
        const entries = [];
        part.measures.forEach((measure, index) => {
          for (const note of measure.notes) {
            const lyric = renderer.selectLyric(note);
            if (!lyric || note.isGrace) continue;
            entries.push({
              x: renderer.horizontalLayout.getNoteX(measure, index, note.startBeatInMeasure, note),
              text: lyric.text,
              width: ctx.measureText(lyric.text).width
            });
          }
        });
        entries.sort((left, right) => left.x - right.x);
        for (let index = 1; index < entries.length; index++) {
          const previous = entries[index - 1];
          const next = entries[index];
          if (next.x === previous.x) continue;
          const gap = (next.x - next.width / 2) - (previous.x + previous.width / 2);
          if (gap < 0) found.push(`${part.name}: "${previous.text}" runs into "${next.text}" by ${(-gap).toFixed(1)}px`);
        }
      }
      return found;
    });
    expect(overlaps).toEqual([]);
  });

  test('the parts panel transposes a semitone at a time, in step with the settings slider', async ({ page }) => {
    await openSample(page);
    await showParts(page);

    await page.locator('#transpose-up').click();
    await expect(page.locator('#transpose-readout')).toHaveText('1 semitone up');
    expect(await readState(page, 'app.state.transpose')).toBe(1);
    expect(await readState(page, 'app.audioEngine.transposeSemitones')).toBe(1);

    await page.locator('#transpose-down').click();
    await page.locator('#transpose-down').click();
    await expect(page.locator('#transpose-readout')).toHaveText('1 semitone down');

    await page.locator('#settings-btn').click();
    await expect(page.locator('#transpose')).toHaveValue('-1');
  });

  test('a hidden tab widens the scheduling window and coming back narrows it', async ({ page }) => {
    await openSample(page, 'Happy birthday');
    await page.locator('#play-btn').click();

    const setVisibility = state => page.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);

    await setVisibility('hidden');
    expect(await readState(page, 'app.audioEngine.lookaheadTime')).toBeGreaterThanOrEqual(1.5);
    expect(await readState(page, 'app.metronome.lookaheadTime')).toBeGreaterThanOrEqual(1.5);

    await setVisibility('visible');
    expect(await readState(page, 'app.audioEngine.lookaheadTime')).toBe(0.1);
    expect(await readState(page, 'app.state.isPlaying')).toBe(true);
    await page.locator('#play-btn').click();
  });
});

test.describe('the score view', () => {
  test('only my stave hides the others and enlarges yours', async ({ page }) => {
    await openSample(page);
    await showParts(page);

    await setSwitch(page, 'only-mine', true);
    const solo = await readState(page, `({
      visible: app.renderer.visibleStaffCount,
      scale: app.renderer.scale,
      parts: app.state.parts.length
    })`);
    expect(solo.parts).toBeGreaterThan(1);
    expect(solo.visible).toBe(1);
    expect(solo.scale).toBeGreaterThan(1);

    await setSwitch(page, 'only-mine', false);
    expect(await readState(page, 'app.renderer.visibleStaffCount')).toBe(solo.parts);
    expect(await readState(page, 'app.renderer.scale')).toBe(1);
  });

  test('the zoom buttons and keys change the scale, and fit brings every stave into view', async ({ page }) => {
    await openSample(page);

    await page.locator('#zoom-in').click();
    await expect(page.locator('#zoom-level')).toHaveText('115%');
    expect(await readState(page, 'app.renderer.scale')).toBeCloseTo(1.15, 2);

    await page.locator('#zoom-out').click();
    await page.locator('#zoom-out').click();
    await expect(page.locator('#zoom-level')).toHaveText('87%');

    await page.locator('#zoom-level').click();
    const fit = await page.evaluate(() => ({
      canvas: document.querySelector('#score-canvas').getBoundingClientRect().height,
      frame: document.querySelector('#score-frame').clientHeight,
      zoom: window.choirPracticeApp.state.zoom,
      staves: window.choirPracticeApp.state.parts.length
    }));
    expect(fit.staves).toBe(6);
    if (fit.zoom > 0.5) {
      expect(fit.canvas, 'fit left the score taller than its frame').toBeLessThanOrEqual(fit.frame + 1);
    }

    await page.locator('#stage').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('=');
    expect(await readState(page, 'app.state.zoom')).toBeCloseTo(fit.zoom * 1.15, 1);
    await page.keyboard.press('-');
    expect(await readState(page, 'app.state.zoom')).toBeCloseTo(fit.zoom, 1);
  });
});

test.describe('deep links', () => {
  test('the address bar mirrors the passage, and the link opens it again', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page, 'Quick! We have but a second');
    await showParts(page);
    await page.locator('#part-list .part input[name="my-part"]').nth(1).check();

    await page.locator('#loop-range-btn').click();
    await page.locator('#loop-from').fill('13');
    await page.locator('#loop-to').fill('16');
    await page.locator('#loop-to').blur();
    await page.keyboard.press('Escape');

    await page.locator('#tempo-value').click();
    await page.locator('#tempo-entry').fill('90');
    await page.locator('#tempo-entry').press('Enter');

    await expect.poll(() => page.evaluate(() => window.location.hash))
      .toBe('#sample=quick&part=alto&loop=13-16&tempo=90&mix=mostly-mine');

    const link = await page.evaluate(() => window.choirPracticeApp.buildShareLink());
    // A fresh load, not a fragment navigation within the page that is open.
    await page.goto('about:blank');
    await page.goto(link);
    await expect(page.locator('#practice')).toBeVisible();
    await expect.poll(() => readState(page, 'app.state.loopRange && app.state.loopRange.fromBar')).toBe(13);

    const restored = await readState(page, `({
      part: app.state.parts.find(part => part.id === app.state.myPartId).voiceType,
      to: app.state.loopRange.toBar,
      tempo: app.state.tempo,
      loop: app.state.loop
    })`);
    expect(restored).toEqual({ part: 'alto', to: 16, tempo: 90, loop: true });
    await expect(page.locator('#bar-display')).toHaveText(/^bar 13 /);
    await expect(page.locator('#tempo-value')).toHaveText('90 BPM · 60%');

    expect(problems).toEqual([]);
  });

  test('the share button copies the link', async ({ page }) => {
    await openSample(page, 'Happy birthday');
    await page.locator('#share-btn').click();
    await expect(page.locator('.toast')).toContainText(/Link copied/);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('#sample=birthday');
    expect(copied).toContain('part=soprano');
  });
});

test.describe('coming back', () => {
  test('the home screen offers the last score at the bar it was left at', async ({ page }) => {
    const problems = watchForErrors(page);
    await openSample(page, 'Happy birthday');
    await page.locator('#next-bar').click();
    await page.locator('#next-bar').click();
    await expect(page.locator('#bar-display')).toHaveText(/^bar 3 /);

    await page.locator('#home-btn').click();
    const card = page.locator('#continue');
    await expect(card).toBeVisible();
    await expect(page.locator('#continue-label')).toHaveText('Continue: Happy Birthday, bar 3');
    await expect(page.locator('#continue-detail')).toContainText('Soprano');

    // It survives a reload, which is the point of it.
    await page.reload();
    await expect(card).toBeVisible();
    await page.locator('#continue-btn').click();
    await expect(page.locator('#practice')).toBeVisible();
    await expect(page.locator('#bar-display')).toHaveText(/^bar 3 /);

    await page.locator('#home-btn').click();
    await expect(card).toBeVisible();
    await page.locator('#continue-forget').click();
    await expect(card).toBeHidden();
    await page.reload();
    await expect(page.locator('#home')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(card).toBeHidden();

    expect(problems).toEqual([]);
  });

  test('your own file comes back too', async ({ page }) => {
    await openFixture(page, REPEAT_WITH_ENDINGS_XML, 'repeat.musicxml');
    await page.locator('#home-btn').click();
    await expect(page.locator('#continue-label')).toContainText('Continue:');
    await expect(page.locator('#continue-detail')).toContainText('your own file');

    await page.reload();
    await page.locator('#continue-btn').click();
    await expect(page.locator('#practice')).toBeVisible();
    expect(await readState(page, 'app.state.fileName')).toBe('repeat.musicxml');
  });
});

test.describe('a phone', () => {
  test('a long title does not push the transport off the screen', async ({ page }) => {
    const problems = watchForErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSample(page, 'Quick! We have but a second');

    const fit = await page.evaluate(() => {
      const within = id => {
        const box = document.getElementById(id).getBoundingClientRect();
        return box.width > 0 && box.left >= -0.5 && box.right <= window.innerWidth + 0.5;
      };
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        settings: within('settings-btn'),
        mic: within('mic-btn'),
        exportButton: within('export-btn'),
        share: within('share-btn'),
        previous: within('prev-bar'),
        next: within('next-bar')
      };
    });
    // Held to the width this test set, not to `innerWidth`: a phone's layout
    // viewport quietly grows to fit whatever overflows, so a 406px page in a
    // 406px viewport once read as a pass.
    expect(fit.pageWidth, 'the page is wider than the phone').toBeLessThanOrEqual(390);
    expect(fit.viewport, 'the layout viewport grew past the phone').toBe(390);
    expect(fit).toMatchObject({
      settings: true, mic: true, exportButton: true, share: true, previous: true, next: true
    });
    await expect(page.locator('#score-name')).toHaveText('Quick! We have but a second');
    await expect(page.locator('#score-composer')).toHaveText('C. V. Stanford');
    expect(problems).toEqual([]);
  });

  test('the parts sheet is compact: presets on top, one line per part', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSample(page, 'Quick! We have but a second');
    await showParts(page);

    const layout = await page.evaluate(() => {
      const presets = document.querySelector('#mix-options').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#part-list .part')].map(row => row.getBoundingClientRect());
      const sheet = document.querySelector('#parts-panel').getBoundingClientRect();
      return {
        presetsTop: presets.top,
        firstRowTop: rows[0].top,
        rowHeights: rows.map(row => row.height),
        sheetHeight: sheet.height,
        viewport: window.innerHeight
      };
    });
    expect(layout.presetsTop, 'the presets are not above the parts').toBeLessThan(layout.firstRowTop);
    for (const height of layout.rowHeights) expect(height, 'a part row is more than one line').toBeLessThan(56);
    expect(layout.sheetHeight).toBeLessThanOrEqual(layout.viewport * 0.5);
  });

  test('on its side, the sheet becomes a column beside the score', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openSample(page, 'Happy birthday');
    await showParts(page);

    const boxes = await page.evaluate(() => ({
      panel: document.querySelector('#parts-panel').getBoundingClientRect().toJSON(),
      frame: document.querySelector('#score-frame').getBoundingClientRect().toJSON()
    }));
    expect(boxes.panel.left).toBeGreaterThanOrEqual(boxes.frame.right - 1);
    expect(boxes.frame.height).toBeGreaterThan(150);
    expect(Math.abs(boxes.panel.top - boxes.frame.top)).toBeLessThan(24);

    // And the column is wide enough to say who each part is: the one-line
    // rows of the portrait sheet cut every name to "S…" here.
    const cut = await page.evaluate(() => [...document.querySelectorAll('#part-list .part-name')]
      .filter(name => name.scrollWidth > name.clientWidth + 1)
      .map(name => name.textContent.trim()));
    expect(cut, 'part names are truncated in the landscape column').toEqual([]);
  });

  test('the bar stepper stays on a phone and the readout counts bars', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSample(page, 'Happy birthday');

    await expect(page.locator('#bar-display')).toHaveText('bar 1 / 9');
    await page.locator('#next-bar').click();
    await expect(page.locator('#bar-display')).toHaveText('bar 2 / 9');
    await page.locator('#prev-bar').click();
    await expect(page.locator('#bar-display')).toHaveText('bar 1 / 9');
  });

  test('a nine-beat count fits the width of a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSample(page, 'Quick! We have but a second');
    // Slow, so the count is up for long enough to be measured.
    await page.evaluate(() => window.choirPracticeApp.setTempo(60));
    await page.locator('#play-btn').click();

    const overlay = page.locator('#count-in');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.count-in-beat')).toHaveCount(9);
    const fit = await page.evaluate(() => {
      const box = document.querySelector('#count-in').getBoundingClientRect();
      const beats = [...document.querySelectorAll('#count-in .count-in-beat')]
        .map(beat => beat.getBoundingClientRect());
      return {
        left: box.left,
        right: box.right,
        inside: beats.every(beat => beat.left >= box.left - 0.5 && beat.right <= box.right + 0.5),
        oneLine: beats.every(beat => Math.abs(beat.top - beats[0].top) < 1)
      };
    });
    expect(fit.right, 'the count was not on screen to measure').toBeGreaterThan(fit.left);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right, 'the count runs off the right of the phone').toBeLessThanOrEqual(390);
    expect(fit.inside, 'a number of the count spills out of its box').toBe(true);
    expect(fit.oneLine, 'the count broke onto a second line').toBe(true);
    await page.locator('#play-btn').click();
  });

  test('the first run says which part is chosen while the sheet is closed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSample(page, 'Happy birthday');

    const banner = page.locator('#part-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Soprano');

    await page.locator('#part-banner-open').click();
    await expect(page.locator('#part-list')).toBeVisible();
    await expect(banner).toBeHidden();
    await expect(page.locator('#coach')).toBeVisible();

    await page.locator('#coach-dismiss').click();
    await page.locator('#parts-close').click();
    await expect(page.locator('#part-list')).toBeHidden();
    await expect(banner).toBeHidden();
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

  test('stepping through the bars says what your part sings there', async ({ page }) => {
    await openSample(page, 'Happy birthday');
    await showParts(page);

    /* A canvas tells a screen reader nothing, so the live region is the only
       thing a singer reading by ear and keyboard has. It used to say "Bar 3" and
       stop, which locates you without telling you anything about the music. */
    await page.locator('#score-canvas').focus();
    await page.keyboard.press('ArrowRight');
    const spoken = await page.locator('#status-live').textContent();

    expect(spoken).toMatch(/^Bar \d+/);
    expect(spoken, 'the announcement names no pitch')
      .toMatch(/[A-G](?: (?:double )?(?:sharp|flat))? -?\d|rest/);
  });

  test('every voice carries its name as well as its colour', async ({ page }) => {
    await openSample(page);
    await showParts(page);

    /* The four parts are colour-coded, and green, orange and red are the classic
       confusion set. Colour is never the only channel: the name is written in
       the score's left gutter and on every panel row. This checks the second
       half, because the first is a canvas. */
    const rows = await page.locator('#part-list .part').evaluateAll(nodes =>
      nodes.map(node => ({
        name: node.querySelector('.part-name')?.textContent?.trim(),
        color: node.style.getPropertyValue('--part-color'),
      })),
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.name, 'a part row is identified by colour alone').toBeTruthy();
      expect(row.color).toMatch(/\S/);
    }
    // Distinct names, so the text channel actually distinguishes them.
    expect(new Set(rows.map(row => row.name)).size).toBe(rows.length);
  });

  test('the score canvas names the piece and its parts', async ({ page }) => {
    await openSample(page);
    await expect(page.locator('#score-canvas'))
      .toHaveAttribute('aria-label', /Score for .+\. Parts: .+/);
  });
});
