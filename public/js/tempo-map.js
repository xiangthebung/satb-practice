/**
 * Tempo maps: converting between score beats and seconds when the tempo moves.
 *
 * With a single tempo, beats and seconds are related by one multiplication.
 * A score that changes tempo needs a piecewise conversion instead, and it needs
 * to run both ways: forwards to schedule a note, backwards to find out where the
 * cursor is at the current instant. Doing that per call by walking every marking
 * would be wasteful during playback, so a map is compiled once into segments
 * carrying the cumulative seconds at their start.
 *
 * Beats are quarter notes throughout, matching MusicXML's `sound@tempo`.
 *
 * The rehearsal tempo control is a scale factor rather than an override. The
 * slider reads the score's opening tempo, and moving it stretches the whole map
 * proportionally, so a written accelerando still accelerates when a singer
 * practises the piece slowly.
 */

export const DEFAULT_TEMPO = 120;
const EPSILON = 1e-9;

/** Keep tempo inside a range the synthesiser and the reader can both follow. */
function clampBpm(value) {
  const bpm = Number(value);
  if (!Number.isFinite(bpm) || bpm <= 0) return DEFAULT_TEMPO;
  return Math.max(10, Math.min(600, bpm));
}

/**
 * Build a normalised tempo map from written tempo markings.
 *
 * Duplicate and out-of-order entries are tolerated because exporters emit them,
 * and a marking that repeats the tempo already in force is dropped so the
 * compiled map stays as short as the music actually requires.
 *
 * @param {Array<{beat: number, bpm: number}>} entries
 * @param {{ baseTempo?: number }} [options]
 * @returns {Array<{beat: number, bpm: number}>} sorted, first entry always at beat 0
 */
export function buildTempoMap(entries = [], { baseTempo } = {}) {
  const cleaned = [];
  for (const entry of entries) {
    const beat = Number(entry?.beat);
    const bpm = Number(entry?.bpm);
    if (!Number.isFinite(beat) || beat < 0) continue;
    if (!Number.isFinite(bpm) || bpm <= 0) continue;
    cleaned.push({ beat: Number(Math.max(0, beat).toFixed(6)), bpm: clampBpm(bpm) });
  }

  // A later marking at the same beat wins, which is what a reader would assume
  // from two directions printed on the same bar.
  cleaned.sort((left, right) => left.beat - right.beat);
  const byBeat = new Map();
  for (const entry of cleaned) byBeat.set(entry.beat, entry.bpm);

  const map = [...byBeat.entries()]
    .map(([beat, bpm]) => ({ beat, bpm }))
    .sort((left, right) => left.beat - right.beat);

  const opening = map.length && map[0].beat <= EPSILON
    ? map[0].bpm
    : clampBpm(baseTempo ?? map[0]?.bpm ?? DEFAULT_TEMPO);

  if (!map.length || map[0].beat > EPSILON) {
    map.unshift({ beat: 0, bpm: opening });
  }

  const trimmed = [map[0]];
  for (let index = 1; index < map.length; index++) {
    if (Math.abs(map[index].bpm - trimmed[trimmed.length - 1].bpm) > 1e-6) {
      trimmed.push(map[index]);
    }
  }
  return trimmed;
}

/**
 * Precompute cumulative seconds so conversions are a single lookup plus a
 * multiply, at the score's own written tempo.
 *
 * @param {Array<{beat: number, bpm: number}>} map
 * @returns {{ segments: Array<{beat: number, bpm: number, seconds: number, secondsPerBeat: number}>, baseTempo: number, isConstant: boolean }}
 */
export function compileTempoMap(map = []) {
  const normalised = buildTempoMap(map);
  const segments = [];
  let seconds = 0;

  for (let index = 0; index < normalised.length; index++) {
    const entry = normalised[index];
    const secondsPerBeat = 60 / entry.bpm;
    segments.push({ beat: entry.beat, bpm: entry.bpm, seconds, secondsPerBeat });
    const next = normalised[index + 1];
    if (next) seconds += (next.beat - entry.beat) * secondsPerBeat;
  }

  return {
    segments,
    baseTempo: segments[0]?.bpm ?? DEFAULT_TEMPO,
    isConstant: segments.length <= 1
  };
}

/** Index of the segment in force at a beat. */
function segmentIndexAtBeat(compiled, beat) {
  const segments = compiled.segments;
  let low = 0;
  let high = segments.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segments[middle].beat <= beat + EPSILON) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Index of the segment in force at a time offset. */
function segmentIndexAtSeconds(compiled, seconds) {
  const segments = compiled.segments;
  let low = 0;
  let high = segments.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segments[middle].seconds <= seconds + EPSILON) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Written tempo in force at a beat.
 * @param {object} compiled
 * @param {number} beat
 * @returns {number} beats per minute
 */
export function tempoAtBeat(compiled, beat) {
  if (!compiled?.segments?.length) return DEFAULT_TEMPO;
  return compiled.segments[segmentIndexAtBeat(compiled, Math.max(0, Number(beat) || 0))].bpm;
}

/**
 * Seconds elapsed from beat 0 to a beat, at the score's written tempo.
 * @param {object} compiled
 * @param {number} beat
 * @returns {number}
 */
export function beatToSeconds(compiled, beat) {
  if (!compiled?.segments?.length) return Math.max(0, Number(beat) || 0) * (60 / DEFAULT_TEMPO);
  const target = Math.max(0, Number(beat) || 0);
  const segment = compiled.segments[segmentIndexAtBeat(compiled, target)];
  return segment.seconds + (target - segment.beat) * segment.secondsPerBeat;
}

/**
 * Beat reached after a number of seconds, at the score's written tempo.
 * @param {object} compiled
 * @param {number} seconds
 * @returns {number}
 */
export function secondsToBeat(compiled, seconds) {
  if (!compiled?.segments?.length) return Math.max(0, Number(seconds) || 0) / (60 / DEFAULT_TEMPO);
  const target = Math.max(0, Number(seconds) || 0);
  const segment = compiled.segments[segmentIndexAtSeconds(compiled, target)];
  return segment.beat + (target - segment.seconds) / segment.secondsPerBeat;
}

/**
 * How much to stretch the written map so its opening tempo reads as the
 * rehearsal tempo the singer chose.
 *
 * @param {number} rehearsalTempo
 * @param {number} baseTempo
 * @returns {number} multiplier applied to every written tempo
 */
export function tempoScale(rehearsalTempo, baseTempo) {
  const requested = Number(rehearsalTempo);
  const base = Number(baseTempo);
  if (!Number.isFinite(requested) || requested <= 0) return 1;
  if (!Number.isFinite(base) || base <= 0) return 1;
  return requested / base;
}

/**
 * A tempo map with no changes, for scores that never mark one.
 * @param {number} bpm
 * @returns {object}
 */
export function constantTempoMap(bpm = DEFAULT_TEMPO) {
  return compileTempoMap([{ beat: 0, bpm: clampBpm(bpm) }]);
}
