/**
 * The playback timeline: one place that knows how the written score maps onto
 * the performance, and how the performance maps onto real time.
 *
 * Three separate things pull those two apart, and they compose badly if each is
 * handled where it is needed:
 *
 *   - repeats mean one written bar can be sung several times, so a score
 *     position no longer identifies a moment in the performance;
 *   - a fermata freezes the score position while time keeps passing;
 *   - a tempo change makes beats and seconds a piecewise relationship rather
 *     than a single multiplication.
 *
 * All three are resolved once, into a list of spans along a single playback axis.
 * A span either carries music (score beats advance with playback beats) or holds
 * (playback beats advance, the score position stands still). Tempo is then
 * layered on as segments of constant seconds-per-beat with cumulative seconds,
 * so converting a position in either direction is a binary search and a multiply.
 *
 * Three coordinate systems appear throughout the app, and mixing them up is the
 * easiest way to break playback:
 *
 *   score beat     where the cursor is on the page. Can repeat.
 *   playback beat  how far through the performance. Always increases.
 *   seconds        real time, after the rehearsal tempo scale is applied.
 *
 * The rehearsal tempo is deliberately a scale factor on the whole map rather
 * than an override, so a written accelerando still accelerates when a singer
 * practises the piece slowly.
 *
 * Pure: no AudioContext, no DOM.
 */

import { groupIntoRuns } from './repeats.js';
import { DEFAULT_TEMPO, compileTempoMap, tempoAtBeat } from './tempo-map.js';

const EPSILON = 1e-6;

function clamp(value, low, high) {
  const number = Number(value);
  if (!Number.isFinite(number)) return low;
  return Math.max(low, Math.min(high, number));
}

/**
 * Turn the performance order into contiguous score ranges.
 *
 * A run of consecutive measures is one continuous stretch of the written page,
 * so it becomes a single range no matter how many bars it covers.
 *
 * @param {Array<{startBeat: number, beats: number}>} measures
 * @param {Array<number>|null} order
 * @param {number} totalScoreBeats
 * @returns {Array<{scoreStart: number, scoreEnd: number}>}
 */
function buildScoreRanges(measures, order, totalScoreBeats) {
  if (!Array.isArray(order) || !order.length || !measures.length) {
    return [{ scoreStart: 0, scoreEnd: Math.max(0, totalScoreBeats) }];
  }

  const ranges = [];
  for (const run of groupIntoRuns(order)) {
    const first = measures[run.startIndex];
    const last = measures[run.endIndex];
    if (!first || !last) continue;
    const scoreStart = Math.max(0, Number(first.startBeat) || 0);
    const scoreEnd = Math.max(scoreStart, (Number(last.startBeat) || 0) + (Number(last.beats) || 0));
    if (scoreEnd - scoreStart <= EPSILON) continue;
    ranges.push({ scoreStart, scoreEnd });
  }

  return ranges.length ? ranges : [{ scoreStart: 0, scoreEnd: Math.max(0, totalScoreBeats) }];
}

/**
 * Lay the score ranges out along the playback axis, inserting a hold span
 * wherever a fermata pauses the music.
 *
 * A hold belongs to the range whose music reaches it, so a fermata written
 * before a repeat sign is held on every pass through that repeat.
 *
 * @param {Array<{scoreStart: number, scoreEnd: number}>} ranges
 * @param {Array<{scoreBeat: number, extraBeats: number}>} fermataHolds
 * @returns {Array<object>} spans
 */
function buildSpans(scoreRanges, fermataHolds) {
  const spans = [];
  const ranges = [];
  const holds = [...(fermataHolds || [])]
    .filter(hold => Number.isFinite(Number(hold?.scoreBeat)) && Number(hold.extraBeats) > EPSILON)
    .sort((left, right) => left.scoreBeat - right.scoreBeat);
  let playback = 0;

  const pushSpan = (rangeIndex, kind, scoreStart, length, scoreLength = length, sustained = false) => {
    if (length <= EPSILON) return;
    spans.push({
      rangeIndex,
      kind,
      playbackStart: playback,
      playbackEnd: playback + length,
      scoreStart,
      scoreEnd: scoreStart + scoreLength,
      /* Hold spans only. True when the mark was written over a note, so the notes
         ending here go on sounding through it rather than the ensemble waiting in
         silence. See `collectFermataHolds`. */
      sustained
    });
    playback += length;
  };

  for (let rangeIndex = 0; rangeIndex < scoreRanges.length; rangeIndex++) {
    const range = scoreRanges[rangeIndex];
    const playbackStart = playback;
    let cursor = range.scoreStart;

    // A hold exactly at the range start came from the previous range's music,
    // which has already accounted for it.
    const inRange = holds.filter(hold =>
      hold.scoreBeat > range.scoreStart + EPSILON &&
      hold.scoreBeat <= range.scoreEnd + EPSILON
    );

    for (const hold of inRange) {
      const boundary = Math.min(range.scoreEnd, hold.scoreBeat);
      pushSpan(rangeIndex, 'music', cursor, boundary - cursor);
      cursor = Math.max(cursor, boundary);
      pushSpan(rangeIndex, 'hold', cursor, Number(hold.extraBeats), 0, !!hold.sustained);
    }

    pushSpan(rangeIndex, 'music', cursor, range.scoreEnd - cursor);

    ranges.push({
      index: rangeIndex,
      scoreStart: range.scoreStart,
      scoreEnd: range.scoreEnd,
      playbackStart,
      playbackEnd: playback
    });
  }

  if (!spans.length) {
    spans.push({
      rangeIndex: 0,
      kind: 'music',
      playbackStart: 0,
      playbackEnd: 0,
      scoreStart: 0,
      scoreEnd: 0
    });
    ranges.push({ index: 0, scoreStart: 0, scoreEnd: 0, playbackStart: 0, playbackEnd: 0 });
  }
  return { spans, ranges };
}

/**
 * Project the score's tempo map onto the playback axis.
 *
 * Each span is cut at every tempo change inside it, so the result is a flat list
 * of constant-tempo segments with the cumulative seconds at their start. A held
 * fermata runs at whatever tempo is in force where it is written.
 *
 * @param {Array<object>} spans
 * @param {object} compiledScoreTempo
 * @returns {Array<{playbackStart: number, secondsPerBeat: number, seconds: number}>}
 */
function buildTempoSegments(spans, compiledScoreTempo) {
  const segments = [];
  let seconds = 0;

  const push = (playbackStart, secondsPerBeat, length) => {
    if (length <= EPSILON) return;
    segments.push({ playbackStart, secondsPerBeat, seconds });
    seconds += length * secondsPerBeat;
  };

  for (const span of spans) {
    const length = span.playbackEnd - span.playbackStart;
    if (length <= EPSILON) continue;

    if (span.kind === 'hold') {
      push(span.playbackStart, 60 / tempoAtBeat(compiledScoreTempo, span.scoreStart), length);
      continue;
    }

    let scoreCursor = span.scoreStart;
    let playbackCursor = span.playbackStart;
    const boundaries = compiledScoreTempo.segments
      .map(segment => segment.beat)
      .filter(beat => beat > span.scoreStart + EPSILON && beat < span.scoreEnd - EPSILON);
    boundaries.push(span.scoreEnd);

    for (const boundary of boundaries) {
      const stretch = boundary - scoreCursor;
      if (stretch <= EPSILON) {
        scoreCursor = boundary;
        continue;
      }
      push(playbackCursor, 60 / tempoAtBeat(compiledScoreTempo, scoreCursor), stretch);
      playbackCursor += stretch;
      scoreCursor = boundary;
    }
  }

  if (!segments.length) {
    segments.push({
      playbackStart: 0,
      secondsPerBeat: 60 / (compiledScoreTempo.baseTempo || DEFAULT_TEMPO),
      seconds: 0
    });
  }
  return segments;
}

/** Index of the last entry whose `key` is at or before `value`. */
function lastIndexAtOrBefore(list, key, value) {
  let low = 0;
  let high = list.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (list[middle][key] <= value + EPSILON) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export class PlaybackTimeline {
  /**
   * @param {object} input
   * @param {Array<object>} input.spans
   * @param {Array<object>} input.tempoSegments
   * @param {object} input.compiledScoreTempo
   * @param {number} input.totalScoreBeats
   */
  constructor({ spans, ranges, tempoSegments, compiledScoreTempo, totalScoreBeats }) {
    this.spans = spans;
    /**
     * Contiguous stretches of the written score, in performance order. One
     * range is one pass through one run of bars, so a repeated section appears
     * twice. Notes are expanded per range, not per span, because a fermata
     * splits a span without starting a new pass through the music.
     */
    this.ranges = ranges;
    this.tempoSegments = tempoSegments;
    this.compiledScoreTempo = compiledScoreTempo;
    this.totalScoreBeats = Math.max(0, Number(totalScoreBeats) || 0);
    this.totalPlaybackBeats = spans.length ? spans[spans.length - 1].playbackEnd : 0;
    this.musicSpans = spans.filter(span => span.kind === 'music');
    /** True when a written bar is performed more than once. */
    this.isUnfolded = ranges.length > 1;
    this.baseTempo = compiledScoreTempo.baseTempo || DEFAULT_TEMPO;
    this.scale = 1;
  }

  /**
   * Where a note beginning at a score beat sounds, on one pass through the music.
   *
   * A note written at the beat a fermata is held on starts *after* the hold, so
   * the span the position falls strictly inside wins over the one it merely
   * touches the end of.
   *
   * @param {number} rangeIndex
   * @param {number} scoreBeat
   * @returns {number|null} playback beat, or null when this pass excludes it
   */
  onsetPlaybackBeat(rangeIndex, scoreBeat) {
    let fallback = null;
    for (const span of this.spans) {
      if (span.rangeIndex !== rangeIndex || span.kind !== 'music') continue;
      if (scoreBeat < span.scoreStart - EPSILON || scoreBeat > span.scoreEnd + EPSILON) continue;
      const playbackBeat = span.playbackStart + (scoreBeat - span.scoreStart);
      if (scoreBeat < span.scoreEnd - EPSILON) return playbackBeat;
      fallback = playbackBeat;
    }
    return fallback;
  }

  /**
   * Where a note ending at a score beat stops, on one pass through the music.
   *
   * The mirror of `onsetPlaybackBeat`: a note that ends where a fermata is
   * written ends before the hold, which is what makes a *waited* hold audible —
   * a fermata over a rest or a barline is silence you are supposed to hear.
   *
   * A note carrying its own fermata is the other mark and wants
   * `heldEndPlaybackBeat` instead: it goes on sounding through the hold.
   *
   * @param {number} rangeIndex
   * @param {number} scoreBeat
   * @returns {number|null}
   */
  endPlaybackBeat(rangeIndex, scoreBeat) {
    let fallback = null;
    for (const span of this.spans) {
      if (span.rangeIndex !== rangeIndex || span.kind !== 'music') continue;
      if (scoreBeat < span.scoreStart - EPSILON || scoreBeat > span.scoreEnd + EPSILON) continue;
      const playbackBeat = span.playbackStart + (scoreBeat - span.scoreStart);
      if (scoreBeat > span.scoreStart + EPSILON) return playbackBeat;
      fallback = playbackBeat;
    }
    return fallback;
  }

  /**
   * Where a note *carrying a fermata* stops: the end of the hold it opens.
   *
   * "Hold this note" is what a fermata over a note means, and the sound has to
   * do it. Ending such a note at its written length instead — which is what
   * `endPlaybackBeat` does, correctly, for every other note — leaves the score
   * waiting out the hold in silence. At the end of a piece that reads as the
   * sound being cut off, because it is: the last chord of "Happy Birthday"
   * stopped a full second before the playhead reached the final barline.
   *
   * Falls through to the plain end when the hold at this beat is a waited one,
   * so a fermata over a rest still buys silence.
   *
   * @param {number} rangeIndex
   * @param {number} scoreBeat
   * @returns {number|null}
   */
  heldEndPlaybackBeat(rangeIndex, scoreBeat) {
    const end = this.endPlaybackBeat(rangeIndex, scoreBeat);
    if (end === null) return null;
    for (const span of this.spans) {
      if (span.kind !== 'hold' || !span.sustained) continue;
      if (Math.abs(span.playbackStart - end) > EPSILON) continue;
      return span.playbackEnd;
    }
    return end;
  }

  /**
   * Set the rehearsal tempo scale. 1 means play at the written tempo.
   * @param {number} scale
   */
  setScale(scale) {
    const value = Number(scale);
    this.scale = Number.isFinite(value) && value > 0 ? value : 1;
  }

  /** Length of the whole performance in seconds, at the current scale. */
  get totalSeconds() {
    return this.beatToSeconds(this.totalPlaybackBeats);
  }

  /* -------------------------------------------------------- beats and time */

  /**
   * Seconds from the start of the performance to a playback beat.
   * @param {number} playbackBeat
   * @returns {number}
   */
  beatToSeconds(playbackBeat) {
    const target = Math.max(0, Number(playbackBeat) || 0);
    const index = lastIndexAtOrBefore(this.tempoSegments, 'playbackStart', target);
    const segment = this.tempoSegments[index];
    const raw = segment.seconds + (target - segment.playbackStart) * segment.secondsPerBeat;
    return raw / this.scale;
  }

  /**
   * Playback beat reached after a number of seconds.
   * @param {number} seconds
   * @returns {number}
   */
  secondsToBeat(seconds) {
    const raw = Math.max(0, (Number(seconds) || 0) * this.scale);
    const index = lastIndexAtOrBefore(this.tempoSegments, 'seconds', raw);
    const segment = this.tempoSegments[index];
    return segment.playbackStart + (raw - segment.seconds) / segment.secondsPerBeat;
  }

  /**
   * How long a stretch of playback beats lasts, starting at a position.
   *
   * This is not simply `beats * secondsPerBeat`: a note that straddles a tempo
   * change or a fermata takes its length from both sides of the boundary.
   *
   * @param {number} playbackBeat
   * @param {number} beats
   * @returns {number} seconds
   */
  durationSeconds(playbackBeat, beats) {
    const start = Math.max(0, Number(playbackBeat) || 0);
    const length = Math.max(0, Number(beats) || 0);
    return this.beatToSeconds(start + length) - this.beatToSeconds(start);
  }

  /**
   * Seconds per playback beat in force at a position, at the current scale.
   * @param {number} playbackBeat
   * @returns {number}
   */
  secondsPerBeatAt(playbackBeat) {
    const index = lastIndexAtOrBefore(
      this.tempoSegments,
      'playbackStart',
      Math.max(0, Number(playbackBeat) || 0)
    );
    return this.tempoSegments[index].secondsPerBeat / this.scale;
  }

  /**
   * Sounding tempo at a position, in beats per minute.
   * @param {number} playbackBeat
   * @returns {number}
   */
  tempoAtPlaybackBeat(playbackBeat) {
    const secondsPerBeat = this.secondsPerBeatAt(playbackBeat);
    return secondsPerBeat > 0 ? 60 / secondsPerBeat : DEFAULT_TEMPO;
  }

  /* ------------------------------------------------------ score and playback */

  /**
   * Where a playback position sits in the written score.
   * @param {number} playbackBeat
   * @returns {number} score beat
   */
  playbackBeatToScoreBeat(playbackBeat) {
    const target = clamp(playbackBeat, 0, this.totalPlaybackBeats);
    const span = this.spans[lastIndexAtOrBefore(this.spans, 'playbackStart', target)];
    if (span.kind === 'hold') return span.scoreStart;
    return span.scoreStart + (target - span.playbackStart);
  }

  /** True while the transport is waiting inside a fermata. */
  isHoldAtPlaybackBeat(playbackBeat) {
    const target = clamp(playbackBeat, 0, this.totalPlaybackBeats);
    const span = this.spans[lastIndexAtOrBefore(this.spans, 'playbackStart', target)];
    return span.kind === 'hold' && target < span.playbackEnd - EPSILON;
  }

  /**
   * Every playback position at which a score beat is performed.
   * A bar inside a repeat has more than one; a bar skipped by a volta has none.
   * @param {number} scoreBeat
   * @returns {Array<number>}
   */
  occurrences(scoreBeat) {
    const target = clamp(scoreBeat, 0, this.totalScoreBeats);
    const found = [];
    for (const range of this.ranges) {
      const playbackBeat = this.onsetPlaybackBeat(range.index, target);
      if (playbackBeat !== null) found.push(playbackBeat);
    }
    return found;
  }

  /**
   * Where to resume playback for a score position.
   *
   * With repeats, one score beat can be several moments in the performance, so
   * the occurrence at or after the current position is preferred: seeking
   * forwards from inside a repeat should not jump back to the first pass.
   *
   * @param {number} scoreBeat
   * @param {{ after?: number }} [options]
   * @returns {number} playback beat
   */
  scoreBeatToPlaybackBeat(scoreBeat, { after = -Infinity } = {}) {
    const found = this.occurrences(scoreBeat);
    if (found.length) {
      return found.find(candidate => candidate >= after - EPSILON) ?? found[0];
    }

    // The position is not performed at all, which happens for a bar that only
    // a first-time-only ending contains. Land on the nearest performed moment
    // so seeking there still does something sensible.
    const target = clamp(scoreBeat, 0, this.totalScoreBeats);
    let best = 0;
    let bestDistance = Infinity;
    for (const range of this.ranges) {
      for (const [scoreEdge, playbackEdge] of [
        [range.scoreStart, range.playbackStart],
        [range.scoreEnd, range.playbackEnd]
      ]) {
        const distance = Math.abs(scoreEdge - target);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = playbackEdge;
        }
      }
    }
    return best;
  }

  /**
   * The next beat of a regular grid, walking the performance rather than the page.
   *
   * The metronome needs this. Stepping through score beats and converting each
   * one would click its way through a repeated section only once, and stepping
   * through playback beats would keep clicking while a fermata is held. Walking
   * the ranges gives the grid the performance actually has: every pass through a
   * repeat is clicked, and a hold is waited out in silence.
   *
   * @param {number} afterPlaybackBeat position to search from
   * @param {number} step grid spacing in quarter-note beats
   * @param {{ inclusive?: boolean }} [options] accept a position exactly at the start
   * @returns {{ playbackBeat: number, scoreBeat: number }|null} null past the end
   */
  nextGridPosition(afterPlaybackBeat, step, { inclusive = false } = {}) {
    const grid = Number(step) > 0 ? Number(step) : 1;
    const from = Math.max(0, Number(afterPlaybackBeat) || 0);
    const accepts = (playbackBeat) => inclusive
      ? playbackBeat >= from - EPSILON
      : playbackBeat > from + EPSILON;

    for (const range of this.ranges) {
      if (range.playbackEnd < from - EPSILON) continue;

      const enterAt = Math.max(from, range.playbackStart);
      const scoreAt = this.playbackBeatToScoreBeat(enterAt);
      let candidate = Math.max(
        range.scoreStart,
        Math.ceil((scoreAt - EPSILON) / grid) * grid
      );

      // The beat on a range's closing barline belongs to whatever the
      // performance does next, so it is left to the following range.
      while (candidate < range.scoreEnd - EPSILON) {
        const playbackBeat = this.onsetPlaybackBeat(range.index, candidate);
        if (playbackBeat !== null && accepts(playbackBeat)) {
          return { playbackBeat, scoreBeat: candidate };
        }
        candidate += grid;
      }
    }
    return null;
  }

  /**
   * Score beats that are never performed, as ranges.
   * Used to tell a singer that part of the page is skipped on this pass.
   * @returns {Array<{scoreStart: number, scoreEnd: number}>}
   */
  unperformedRanges() {
    const covered = this.ranges
      .map(range => ({ start: range.scoreStart, end: range.scoreEnd }))
      .sort((left, right) => left.start - right.start);

    const gaps = [];
    let reached = 0;
    for (const range of covered) {
      if (range.start > reached + EPSILON) {
        gaps.push({ scoreStart: reached, scoreEnd: range.start });
      }
      reached = Math.max(reached, range.end);
    }
    if (this.totalScoreBeats > reached + EPSILON) {
      gaps.push({ scoreStart: reached, scoreEnd: this.totalScoreBeats });
    }
    return gaps;
  }
}

/**
 * Build a playback timeline for a score.
 *
 * @param {object} input
 * @param {Array<{startBeat: number, beats: number}>} [input.measures] written measures
 * @param {Array<number>|null} [input.order] performance order of measure indices
 * @param {Array<{beat: number, bpm: number}>} [input.tempoMap] written tempo, in score beats
 * @param {Array<{scoreBeat: number, extraBeats: number}>} [input.fermataHolds]
 * @param {number} [input.totalScoreBeats]
 * @param {number} [input.scale] rehearsal tempo scale
 * @returns {PlaybackTimeline}
 */
export function buildPlaybackTimeline({
  measures = [],
  order = null,
  tempoMap = [],
  fermataHolds = [],
  totalScoreBeats = 0,
  scale = 1
} = {}) {
  const measureEnd = measures.reduce(
    (highest, measure) =>
      Math.max(highest, (Number(measure?.startBeat) || 0) + (Number(measure?.beats) || 0)),
    0
  );
  const scoreLength = Math.max(Number(totalScoreBeats) || 0, measureEnd);

  const compiledScoreTempo = compileTempoMap(tempoMap);
  const scoreRanges = buildScoreRanges(measures, order, scoreLength);
  const { spans, ranges } = buildSpans(scoreRanges, fermataHolds);
  const tempoSegments = buildTempoSegments(spans, compiledScoreTempo);

  const timeline = new PlaybackTimeline({
    spans,
    ranges,
    tempoSegments,
    compiledScoreTempo,
    totalScoreBeats: scoreLength
  });
  timeline.setScale(scale);
  return timeline;
}
