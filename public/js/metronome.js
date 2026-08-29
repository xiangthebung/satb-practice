/**
 * Metronome Module
 *
 * Schedules woodblock-style clicks against the score's own measure boundaries,
 * so accents stay correct through pickup bars and time-signature changes.
 * The clicks are routed to a bus that bypasses the playback compressor: a click
 * that hits the compressor ducks the voices on every beat.
 */

/** Total lifetime of one click, comfortably past its decay. */
const CLICK_LENGTH = 0.07;

/**
 * How often the click sounds, relative to the beat the time signature counts.
 *
 * "Bars only" is for holding a slow tempo without the clutter of every beat, and
 * the subdivisions are for the opposite problem: pinning down where the offbeats
 * fall in a passage that keeps slipping.
 */
export const CLICK_PATTERNS = [
  { id: 'bars', label: 'Bars only', factor: 0 },
  { id: 'beat', label: 'Every beat', factor: 1 },
  { id: 'eighths', label: 'Eighths', factor: 2 },
  { id: 'triplets', label: 'Triplets', factor: 3 },
  { id: 'sixteenths', label: 'Sixteenths', factor: 4 }
];

const PATTERN_BY_ID = new Map(CLICK_PATTERNS.map(pattern => [pattern.id, pattern]));

/** True when the id names a known click pattern. */
export function isClickPattern(id) {
  return PATTERN_BY_ID.has(id);
}

/**
 * Grid spacing for a click pattern, in quarter-note beats.
 *
 * "Bars only" has no regular spacing of its own: it uses the beat grid and then
 * suppresses everything that is not a downbeat, because bar lengths change and a
 * fixed spacing would drift out of the music.
 *
 * @param {string} patternId
 * @param {number} denominator time-signature denominator
 * @returns {number}
 */
export function clickGridStep(patternId, denominator = 4) {
  const beatStep = 4 / (Number(denominator) || 4);
  const factor = PATTERN_BY_ID.get(patternId)?.factor ?? 1;
  if (factor <= 0) return beatStep;
  return beatStep / factor;
}

/**
 * Interval between beats in seconds.
 * @param {number} bpm - beats per minute
 * @returns {number}
 */
export function beatIntervalSeconds(bpm) {
  if (bpm <= 0) return 0;
  return 60 / bpm;
}

/**
 * Metronome class - generates audible and visual beat indicators.
 */
export class Metronome {
  constructor(audioContext, destinationNode) {
    this.audioContext = audioContext;
    this.destination = destinationNode;
    this.tempo = 120;
    this.timeSignature = { numerator: 4, denominator: 4 };
    /** Which beats and subdivisions are clicked. */
    this.pattern = 'beat';
    /** Click level, 0..1, applied on top of the accent difference. */
    this.volume = 1;
    this.isRunning = false;
    this.currentBeat = 0;
    this.startTime = 0;
    // How a performance position becomes a time offset from the transport start.
    // Supplied by the engine so a score that changes tempo clicks in step with
    // the music instead of drifting away from it.
    this.playbackBeatToSeconds = beat => beat * beatIntervalSeconds(this.tempo);
    /** Supplied by the engine; walks the performance rather than the page. */
    this.nextGridPosition = null;
    this.searchFrom = 0;
    this.searchInclusive = true;
    this.schedulerTimer = null;
    this.scheduledClicks = new Set();
    this.clickNoise = null;
    this.visualTimers = new Set();
    this.lookaheadTime = 0.1; // seconds
    this.scheduleIntervalMs = 25; // ms
    this.onBeat = null; // callback(beatNumber, isDownbeat)
    // Measure boundaries from the score: sorted array of score-beat positions
    // where each measure starts. Used to determine true downbeats (accents)
    // instead of relying on a simple modulo counter which breaks on pickup
    // measures and time signature changes.
    this.measureStartBeats = null;
    // Bar starts with the metre each one is in, so the click spacing can follow
    // a change of metre rather than being fixed by the first bar of the score.
    this.measureGrid = null;
    // The score beat of the last click scheduled, which is what the next grid
    // step is read from.
    this.lastScoreBeat = 0;
  }

  /**
   * Set the tempo.
   * @param {number} bpm
   */
  setTempo(bpm) {
    this.tempo = Math.max(40, Math.min(240, bpm));
  }

  /**
   * Set the time signature.
   * @param {number} numerator - beats per measure
   * @param {number} denominator - beat note value
   */
  setTimeSignature(numerator, denominator) {
    this.timeSignature = { numerator, denominator };
  }

  /**
   * Choose which beats and subdivisions are clicked.
   * @param {string} patternId one of CLICK_PATTERNS
   */
  setPattern(patternId) {
    this.pattern = isClickPattern(patternId) ? patternId : 'beat';
  }

  /**
   * Set the click level.
   * @param {number} percent 0 to 100
   */
  setVolume(percent) {
    const level = Number(percent);
    this.volume = Number.isFinite(level) ? Math.max(0, Math.min(1, level / 100)) : 1;
  }

  /** Grid spacing the current pattern needs, in quarter-note beats. */
  getGridStep() {
    return clickGridStep(this.pattern, this.timeSignature.denominator);
  }

  /**
   * Play a count-in leading up to a start time.
   *
   * This is deliberately separate from the running click: a count-in is wanted
   * whether or not the metronome itself is on, because its job is to tell the
   * singer when to come in rather than to keep time through the piece.
   *
   * @param {{ startTime: number, clicks: number, interval: number, beatsPerBar?: number }} options
   */
  playCountIn({ startTime, clicks, interval, beatsPerBar = 4 } = {}) {
    const count = Math.round(Number(clicks) || 0);
    const gap = Number(interval);
    if (count <= 0 || !Number.isFinite(gap) || gap <= 0) return;
    if (!Number.isFinite(startTime) || !this.audioContext) return;

    const firstClick = startTime - count * gap;
    const now = this.audioContext.currentTime;
    for (let index = 0; index < count; index++) {
      const time = firstClick + index * gap;
      if (time < now - 0.01) continue;
      // Accent the first count of each bar so a two-bar count-in is countable.
      const isDownbeat = beatsPerBar > 0 && index % beatsPerBar === 0;
      this.scheduleClick(time, isDownbeat);
      this.flashAt(time, isDownbeat, (index % Math.max(1, beatsPerBar)) + 1);
    }
  }

  /**
   * Fire the visual beat callback at an AudioContext time.
   * @param {number} time
   * @param {boolean} isDownbeat
   * @param {number} beatInMeasure
   */
  flashAt(time, isDownbeat, beatInMeasure) {
    if (!this.onBeat || !this.audioContext) return;
    const delay = Math.max(0, (time - this.audioContext.currentTime) * 1000);
    const visualTimer = setTimeout(() => {
      this.visualTimers.delete(visualTimer);
      if (this.onBeat) this.onBeat(beatInMeasure, isDownbeat);
    }, delay);
    this.visualTimers.add(visualTimer);
  }

  /**
   * Set measure boundary data from the parsed score. This allows the metronome
   * to accent on actual measure starts rather than using a naive modulo counter.
   * @param {number[]} startBeats - sorted array of score-beat positions where measures begin
   */
  setMeasureStartBeats(startBeats) {
    this.measureStartBeats = startBeats && startBeats.length > 0 ? startBeats : null;
    this.measureGrid = null;
  }

  /**
   * Set the score's bar grid: where every bar starts and what metre it is in.
   *
   * Accents were already right through a metre change, because they come from
   * the real measure starts above. The *spacing* was not: the whole piece was
   * clicked at the denominator of its first bar, so a score that goes 4/4 to 6/8
   * kept clicking crotchets against quavers, and the Eighths and Triplets
   * subdivisions were measured against the wrong beat.
   *
   * @param {Array<{ startBeat: number, timeSignature?: { numerator: number, denominator: number } }>} measures
   */
  setMeasureGrid(measures) {
    const grid = [];
    let numerator = Number(this.timeSignature.numerator) || 4;
    let denominator = Number(this.timeSignature.denominator) || 4;
    for (const measure of measures || []) {
      const startBeat = Number(measure?.startBeat);
      if (!Number.isFinite(startBeat)) continue;
      // A bar with no <time> of its own carries the last one forward, which is
      // what MusicXML means by leaving it out.
      if (measure.timeSignature) {
        numerator = Number(measure.timeSignature.numerator) || numerator;
        denominator = Number(measure.timeSignature.denominator) || denominator;
      }
      grid.push({ startBeat, numerator, denominator });
    }
    this.measureGrid = grid.length ? grid : null;
    this.measureStartBeats = grid.length ? grid.map(entry => entry.startBeat) : null;
  }

  /**
   * The metre in force at a score position.
   * @param {number} scoreBeat
   * @returns {{ numerator: number, denominator: number }}
   */
  timeSignatureAtScoreBeat(scoreBeat) {
    if (!this.measureGrid) return this.timeSignature;
    let current = this.measureGrid[0];
    for (const entry of this.measureGrid) {
      if (entry.startBeat > scoreBeat + 1e-3) break;
      current = entry;
    }
    return current || this.timeSignature;
  }

  /**
   * Determine whether the given score beat falls on a measure boundary.
   * Uses the score's actual measure start positions when available, otherwise
   * falls back to modulo arithmetic against the time signature.
   * @param {number} scoreBeat - position in score quarter-note beats
   * @param {number} clickIndex - sequential click number (fallback for modulo)
   * @returns {boolean}
   */
  isDownbeatAtScoreBeat(scoreBeat, clickIndex) {
    if (this.measureStartBeats) {
      const epsilon = 1e-3;
      for (const start of this.measureStartBeats) {
        if (start > scoreBeat + epsilon) break;
        if (Math.abs(start - scoreBeat) < epsilon) return true;
      }
      return false;
    }
    // Fallback: simple modulo when no score data is available
    const numerator = Number(this.timeSignature.numerator) || 4;
    const beatInMeasure = ((clickIndex % numerator) + numerator) % numerator;
    return beatInMeasure === 0;
  }

  /**
   * Start the metronome.
   *
   * When given a timeline the clicks walk the performance: every pass through a
   * repeated section is counted, a held fermata is waited out in silence, and a
   * written tempo change is followed. Without one, it falls back to a plain
   * steady click from wherever it was started.
   *
   * @param {object} [syncOptions]
   * @param {number} [syncOptions.startTime] AudioContext time for playback beat 0
   * @param {number} [syncOptions.currentPlaybackBeat] where the transport is now
   * @param {(after: number, step: number, options?: object) => object|null} [syncOptions.nextGridPosition]
   * @param {(beat: number) => number} [syncOptions.playbackBeatToSeconds]
   */
  start(syncOptions) {
    if (this.isRunning) return;
    this.isRunning = true;

    if (syncOptions && typeof syncOptions.startTime === 'number') {
      this.startTime = syncOptions.startTime;
      this.playbackBeatToSeconds = typeof syncOptions.playbackBeatToSeconds === 'function'
        ? syncOptions.playbackBeatToSeconds
        : beat => beat * beatIntervalSeconds(this.tempo);
      this.nextGridPosition = typeof syncOptions.nextGridPosition === 'function'
        ? syncOptions.nextGridPosition
        : null;
      this.searchFrom = Math.max(0, Number(syncOptions.currentPlaybackBeat) || 0);
      this.lastScoreBeat = Number.isFinite(syncOptions.currentScoreBeat)
        ? Math.max(0, syncOptions.currentScoreBeat)
        : this.searchFrom;
    } else {
      this.startTime = this.audioContext.currentTime;
      this.playbackBeatToSeconds = beat => beat * beatIntervalSeconds(this.tempo);
      this.nextGridPosition = null;
      this.searchFrom = 0;
      this.lastScoreBeat = 0;
    }

    // The first click may fall exactly on the position the transport starts at.
    this.searchInclusive = true;
    this.currentBeat = 0;
    this.schedule();
  }

  /**
   * Find the next click, in performance coordinates.
   *
   * Falls back to a plain grid when no timeline was supplied, which is what the
   * metronome does when it is used on its own without a score loaded.
   *
   * @param {number} step grid spacing in quarter-note beats
   * @returns {{ playbackBeat: number, scoreBeat: number }|null}
   */
  findNextClick(step) {
    if (this.nextGridPosition) {
      return this.nextGridPosition(this.searchFrom, step, { inclusive: this.searchInclusive });
    }
    const grid = step > 0 ? step : 1;
    const next = this.searchInclusive
      ? Math.max(0, Math.ceil((this.searchFrom - 1e-6) / grid) * grid)
      : Math.max(0, Math.floor((this.searchFrom + 1e-6) / grid) * grid + grid);
    return { playbackBeat: next, scoreBeat: next };
  }

  /**
   * Stop the metronome.
   */
  stop() {
    this.isRunning = false;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    for (const timer of this.visualTimers) {
      clearTimeout(timer);
    }
    this.visualTimers.clear();

    // The lookahead scheduler may have queued clicks that have not started yet.
    // Silence and stop those nodes so restarting at a new tempo cannot play both
    // the old and new click. Let an already-sounding click finish naturally.
    const now = this.audioContext.currentTime;
    for (const click of this.scheduledClicks) {
      if (click.startTime >= now) {
        try {
          click.output.gain.cancelScheduledValues(now);
          click.output.gain.setValueAtTime(0, now);
          for (const source of click.sources) {
            try {
              source.stop(now);
            } catch (e) { /* already stopped */ }
          }
        } catch (e) { /* already stopped */ }
      }
    }
  }

  /** Schedule score-beat clicks, mapping around fermata holds when provided. */
  schedule() {
    const scheduleAhead = () => {
      if (!this.isRunning) return;

      const barsOnly = this.pattern === 'bars';
      const currentTime = this.audioContext.currentTime;
      const scheduleUntil = currentTime + this.lookaheadTime;

      while (this.isRunning) {
        /* The grid is re-read every click from the metre of the bar the last one
           landed in, rather than once from the first bar of the score. Using the
           previous click's bar rather than the next one's is not a shortcut: the
           next position is not known until it has been searched for, and the
           search needs a step. It is exact wherever a bar's length is a whole
           number of the outgoing step — which is every metre change in ordinary
           notation, because the outgoing step divides its own bar and bars abut.  */
        const outgoing = this.timeSignatureAtScoreBeat(this.lastScoreBeat);
        const denominator = Number(outgoing.denominator) || 4;
        const gridStep = clickGridStep(this.pattern, denominator);

        const position = this.findNextClick(gridStep);
        if (!position) break; // past the end of the performance

        // Beat numbering and the on/off-grid test belong to the bar the click
        // actually falls in, which may already be the next metre.
        const here = this.timeSignatureAtScoreBeat(position.scoreBeat);
        const numerator = Number(here.numerator) || 4;
        const scoreBeatStep = 4 / (Number(here.denominator) || 4);
        this.lastScoreBeat = position.scoreBeat;

        const clickTime = this.startTime + this.playbackBeatToSeconds(position.playbackBeat);
        if (clickTime > scheduleUntil) break;

        const clickIndex = Math.round(position.scoreBeat / scoreBeatStep);
        const isDownbeat = this.isDownbeatAtScoreBeat(position.scoreBeat, clickIndex);
        // A subdivision falls between the counted beats, so it is never accented
        // and is quieter than the beat it belongs to.
        const isOffGrid = Math.abs(
          position.scoreBeat - Math.round(position.scoreBeat / scoreBeatStep) * scoreBeatStep
        ) > 1e-6;

        // "Bars only" walks the beat grid and keeps just the downbeats, because
        // bar lengths change and a fixed spacing would drift out of the music.
        if (barsOnly && !isDownbeat) {
          this.searchFrom = position.playbackBeat;
          this.searchInclusive = false;
          continue;
        }

        if (clickTime >= currentTime - 0.01) {
          this.scheduleClick(clickTime, isDownbeat, { subdivision: isOffGrid });

          if (this.onBeat && !isOffGrid) {
            // Compute the beat number within the current measure. When measure
            // boundaries are available, count clicks since the last measure start.
            // Otherwise fall back to modulo arithmetic.
            let beatInMeasure;
            if (this.measureStartBeats) {
              let measureStart = 0;
              for (const start of this.measureStartBeats) {
                if (start > position.scoreBeat + 1e-3) break;
                measureStart = start;
              }
              beatInMeasure = Math.round((position.scoreBeat - measureStart) / scoreBeatStep);
            } else {
              beatInMeasure = ((clickIndex % numerator) + numerator) % numerator;
            }
            const delay = Math.max(0, (clickTime - currentTime) * 1000);
            const visualTimer = setTimeout(() => {
              this.visualTimers.delete(visualTimer);
              if (this.isRunning && this.onBeat) {
                this.onBeat(beatInMeasure + 1, isDownbeat);
              }
            }, delay);
            this.visualTimers.add(visualTimer);
          }
        }

        this.currentBeat = clickIndex;
        this.searchFrom = position.playbackBeat;
        this.searchInclusive = false;
      }
    };

    scheduleAhead();
    this.schedulerTimer = setInterval(scheduleAhead, this.scheduleIntervalMs);
  }

  /** Short burst of noise reused by every click's attack transient. */
  getClickNoise() {
    if (this.clickNoise) return this.clickNoise;
    const ctx = this.audioContext;
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.05));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.clickNoise = buffer;
    return buffer;
  }

  /**
   * Schedule a click at a specific time.
   *
   * Modelled on a struck woodblock rather than a beep: a couple of
   * milliseconds of band-passed noise for the edge, then two inharmonic
   * partials that decay almost immediately. The transient is what makes a
   * click easy to lock onto, and the fast decay keeps it out of the way of the
   * voices.
   *
   * @param {number} time - AudioContext time to play the click
   * @param {boolean} isDownbeat - true for beat 1 (brighter and a little louder)
   */
  scheduleClick(time, isDownbeat, { subdivision = false } = {}) {
    const ctx = this.audioContext;
    const output = ctx.createGain();
    // A subdivision sits under the beat it belongs to rather than competing
    // with it, so it is markedly quieter than an ordinary beat.
    const baseLevel = isDownbeat ? 0.26 : subdivision ? 0.1 : 0.19;
    output.gain.value = baseLevel * this.volume;
    if (output.gain.value <= 0.0001) return;
    output.connect(this.destination);

    const sources = [];
    const nodes = [output];
    const endTime = time + CLICK_LENGTH;

    const base = isDownbeat ? 1500 : 1050;
    const partials = [
      { ratio: 1, gain: 1, decay: 0.035 },
      { ratio: 2.76, gain: 0.32, decay: 0.016 }
    ];
    for (const partial of partials) {
      const oscillator = ctx.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(base * partial.ratio, time);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(partial.gain, time + 0.0015);
      gain.gain.exponentialRampToValueAtTime(0.0005, time + partial.decay);

      oscillator.connect(gain);
      gain.connect(output);
      oscillator.start(time);
      oscillator.stop(endTime);
      sources.push(oscillator);
      nodes.push(gain);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = this.getClickNoise();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = isDownbeat ? 3200 : 2400;
    band.Q.value = 1.2;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, time);
    noiseGain.gain.linearRampToValueAtTime(0.5, time + 0.0008);
    noiseGain.gain.exponentialRampToValueAtTime(0.0005, time + 0.012);

    noise.connect(band);
    band.connect(noiseGain);
    noiseGain.connect(output);
    noise.start(time);
    noise.stop(endTime);
    sources.push(noise);
    nodes.push(band, noiseGain);

    const clickEntry = { sources, nodes, output, startTime: time, endTime };
    this.scheduledClicks.add(clickEntry);

    // Every source stops at the same moment, so the first one to report in can
    // release the whole click.
    sources[0].onended = () => {
      this.scheduledClicks.delete(clickEntry);
      for (const node of nodes.concat(sources)) {
        try {
          node.disconnect();
        } catch (e) { /* already disconnected */ }
      }
    };
  }

  /**
   * Reset the metronome state.
   */
  reset() {
    this.stop();
    this.currentBeat = 0;
    this.searchFrom = 0;
    this.lastScoreBeat = 0;
    this.searchInclusive = true;
    this.nextGridPosition = null;
  }
}
