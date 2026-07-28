/**
 * Repeat structure: turning written barlines into the order bars are sung in.
 *
 * A score is written compactly and performed expanded. This module does the
 * expansion once, producing a plain list of measure indices in performance
 * order, which is all the rest of the app needs: playback schedules it, the
 * transport measures its length, and the cursor follows it.
 *
 * Pure (no DOM, no audio) so the structure of a tricky score can be asserted
 * directly in tests.
 */

/** Guard against malformed files describing an unbounded performance. */
const MAX_PERFORMED_MEASURES = 20_000;

/** Repeat and navigation markings this module does not expand. */
export const UNSUPPORTED_NAVIGATION = ['dacapo', 'dalsegno', 'tocoda', 'fine', 'segno', 'coda'];

/**
 * Find the repeat marking on a measure, if any.
 * @param {object} measure
 * @param {'forward'|'backward'} direction
 * @returns {object|null}
 */
function findRepeat(measure, direction) {
  for (const barline of measure?.barlines || []) {
    if (barline?.repeat?.direction === direction) return barline.repeat;
  }
  return null;
}

/**
 * Find the ending (volta) marking of a given type on a measure.
 * @param {object} measure
 * @param {Array<string>} types
 * @returns {object|null}
 */
function findEnding(measure, types) {
  for (const barline of measure?.barlines || []) {
    const ending = barline?.ending;
    if (ending && types.includes(ending.type)) return ending;
  }
  return null;
}

/**
 * Expand written repeats into performance order.
 *
 * Handles forward and backward repeat barlines, repeat counts greater than two,
 * and numbered endings. Da capo and dal segno jumps are reported rather than
 * expanded, because following them correctly needs the whole navigation graph
 * and getting it subtly wrong is worse for a rehearsal tool than saying so.
 *
 * @param {Array<{barlines?: Array}>} measures written measures, in score order
 * @param {{ maxMeasures?: number }} [options]
 * @returns {{ order: Array<number>, hasRepeats: boolean, truncated: boolean, navigationMarks: Array<string> }}
 */
export function buildRepeatPlan(measures = [], { maxMeasures = MAX_PERFORMED_MEASURES } = {}) {
  const count = measures.length;
  const order = [];
  const navigationMarks = new Set();
  let hasRepeats = false;
  let truncated = false;

  for (const measure of measures) {
    for (const mark of measure?.navigation || []) {
      if (UNSUPPORTED_NAVIGATION.includes(mark)) navigationMarks.add(mark);
    }
  }

  if (count === 0) {
    return { order, hasRepeats, truncated, navigationMarks: [...navigationMarks] };
  }

  // How many times the repeated section beginning at an index has been entered.
  const passes = new Map();
  let repeatStart = 0;
  let index = 0;

  while (index < count) {
    if (order.length >= maxMeasures) {
      truncated = true;
      break;
    }

    const measure = measures[index];

    if (findRepeat(measure, 'forward')) {
      hasRepeats = true;
      repeatStart = index;
      if (!passes.has(index)) passes.set(index, 1);
    }

    // A numbered ending is only sung on its listed passes. On other passes the
    // whole ending is skipped, including any repeat barline inside it, which is
    // exactly right: that repeat was consumed on an earlier pass.
    const endingStart = findEnding(measure, ['start']);
    if (endingStart) {
      hasRepeats = true;
      const pass = passes.get(repeatStart) || 1;
      const numbers = endingStart.numbers?.length ? endingStart.numbers : [1];
      if (!numbers.includes(pass)) {
        let skipTo = index;
        while (skipTo < count && !findEnding(measures[skipTo], ['stop', 'discontinue'])) {
          skipTo++;
        }
        index = skipTo + 1;
        continue;
      }
    }

    order.push(index);

    const backward = findRepeat(measure, 'backward');
    if (backward) {
      hasRepeats = true;
      const totalTimes = Math.max(2, Number(backward.times) || 2);
      const played = passes.get(repeatStart) || 1;
      if (played < totalTimes) {
        passes.set(repeatStart, played + 1);
        index = repeatStart;
        continue;
      }
      passes.set(repeatStart, 1);
    }

    index++;
  }

  return {
    order,
    hasRepeats,
    truncated,
    navigationMarks: [...navigationMarks]
  };
}

/**
 * Group a performance order into contiguous runs of written measures.
 *
 * Playback and the cursor both care about spans rather than individual bars: a
 * run is a stretch of the score that is performed straight through, so it maps
 * to one continuous slice of the notated timeline.
 *
 * @param {Array<number>} order
 * @returns {Array<{ startIndex: number, endIndex: number, length: number }>}
 */
export function groupIntoRuns(order = []) {
  const runs = [];
  for (const index of order) {
    const last = runs[runs.length - 1];
    if (last && index === last.endIndex + 1) {
      last.endIndex = index;
      last.length++;
      continue;
    }
    runs.push({ startIndex: index, endIndex: index, length: 1 });
  }
  return runs;
}

/**
 * True when the performance order is simply every measure once.
 * @param {Array<number>} order
 * @param {number} measureCount
 * @returns {boolean}
 */
export function isStraightThrough(order = [], measureCount = 0) {
  if (order.length !== measureCount) return false;
  return order.every((index, position) => index === position);
}
