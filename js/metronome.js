/**
 * Metronome Module
 * Generates click sounds using oscillator bursts via Web Audio API.
 * Supports tempo adjustment, time signature, visual beat indicator, and tap tempo.
 */

/**
 * Calculate the interval between beats in milliseconds.
 * @param {number} bpm - beats per minute
 * @returns {number} interval in milliseconds
 */
export function bpmToInterval(bpm) {
  if (bpm <= 0) return 0;
  return 60000 / bpm;
}

/**
 * Calculate BPM from an array of tap intervals (in ms).
 * @param {number[]} intervals - array of time intervals between taps
 * @returns {number} calculated BPM (rounded to nearest integer)
 */
export function calculateTapTempo(intervals) {
  if (!intervals || intervals.length === 0) return 0;
  const avgInterval = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  if (avgInterval <= 0) return 0;
  return Math.round(60000 / avgInterval);
}

/**
 * Calculate the next beat time using lookahead scheduling.
 * @param {number} currentTime - current AudioContext time
 * @param {number} lastBeatTime - time of the last scheduled beat
 * @param {number} beatInterval - interval between beats in seconds
 * @returns {number} time of the next beat
 */
export function getNextBeatTime(currentTime, lastBeatTime, beatInterval) {
  let nextTime = lastBeatTime + beatInterval;
  // If we've fallen behind, snap to next upcoming beat
  while (nextTime < currentTime) {
    nextTime += beatInterval;
  }
  return nextTime;
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
    this.isRunning = false;
    this.currentBeat = 0;
    this.lastBeatTime = 0;
    this.startTime = 0;
    this.nextScoreBeat = 0;
    this.scoreToPlaybackBeat = beat => beat;
    this.schedulerTimer = null;
    this.scheduledClicks = new Set();
    this.visualTimers = new Set();
    this.lookaheadTime = 0.1; // seconds
    this.scheduleIntervalMs = 25; // ms
    this.onBeat = null; // callback(beatNumber, isDownbeat)
    this.tapTimes = [];
    this.maxTapInterval = 2000; // max ms between taps before reset
    // Measure boundaries from the score: sorted array of score-beat positions
    // where each measure starts. Used to determine true downbeats (accents)
    // instead of relying on a simple modulo counter which breaks on pickup
    // measures and time signature changes.
    this.measureStartBeats = null;
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
   * Set measure boundary data from the parsed score. This allows the metronome
   * to accent on actual measure starts rather than using a naive modulo counter.
   * @param {number[]} startBeats - sorted array of score-beat positions where measures begin
   */
  setMeasureStartBeats(startBeats) {
    this.measureStartBeats = startBeats && startBeats.length > 0 ? startBeats : null;
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
   * @param {object} [syncOptions] - optional score-aware synchronization
   * @param {number} [syncOptions.startTime] - AudioContext time reference for score beat 0
   * @param {number} [syncOptions.currentScoreBeat] - current quarter-note score position
   * @param {(beat: number) => number} [syncOptions.scoreToPlaybackBeat] - fermata timeline mapping
   */
  start(syncOptions) {
    if (this.isRunning) return;
    this.isRunning = true;

    const denominator = Number(this.timeSignature.denominator) || 4;
    const scoreBeatStep = 4 / denominator;
    if (syncOptions && typeof syncOptions.startTime === 'number') {
      this.startTime = syncOptions.startTime;
      this.scoreToPlaybackBeat = typeof syncOptions.scoreToPlaybackBeat === 'function'
        ? syncOptions.scoreToPlaybackBeat
        : beat => beat;
      const currentScoreBeat = Number(
        syncOptions.currentScoreBeat ?? syncOptions.currentBeat ?? 0
      );
      this.nextScoreBeat = Math.max(
        0,
        Math.ceil((currentScoreBeat - 1e-6) / scoreBeatStep) * scoreBeatStep
      );
    } else {
      this.startTime = this.audioContext.currentTime;
      this.scoreToPlaybackBeat = beat => beat;
      this.nextScoreBeat = 0;
    }

    this.currentBeat = Math.round(this.nextScoreBeat / scoreBeatStep);
    this.schedule();
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
    // the old and new click. Let an already-sounding 60 ms click finish naturally.
    const now = this.audioContext.currentTime;
    for (const click of this.scheduledClicks) {
      if (click.startTime >= now) {
        try {
          click.gainNode.gain.cancelScheduledValues(now);
          click.gainNode.gain.setValueAtTime(0, now);
          click.oscillator.stop(now);
        } catch (e) { /* already stopped */ }
      }
    }
  }

  /** Schedule score-beat clicks, mapping around fermata holds when provided. */
  schedule() {
    const scheduleAhead = () => {
      if (!this.isRunning) return;

      const quarterDuration = 60 / this.tempo;
      const denominator = Number(this.timeSignature.denominator) || 4;
      const numerator = Number(this.timeSignature.numerator) || 4;
      const scoreBeatStep = 4 / denominator;
      const currentTime = this.audioContext.currentTime;
      const scheduleUntil = currentTime + this.lookaheadTime;

      while (this.isRunning) {
        const playbackBeat = this.scoreToPlaybackBeat(this.nextScoreBeat);
        const clickTime = this.startTime + playbackBeat * quarterDuration;
        if (clickTime > scheduleUntil) break;

        const clickIndex = Math.round(this.nextScoreBeat / scoreBeatStep);
        if (clickTime >= currentTime - 0.01) {
          const isDownbeat = this.isDownbeatAtScoreBeat(this.nextScoreBeat, clickIndex);
          this.scheduleClick(clickTime, isDownbeat);

          if (this.onBeat) {
            // Compute the beat number within the current measure. When measure
            // boundaries are available, count clicks since the last measure start.
            // Otherwise fall back to modulo arithmetic.
            let beatInMeasure;
            if (this.measureStartBeats) {
              let measureStart = 0;
              for (const start of this.measureStartBeats) {
                if (start > this.nextScoreBeat + 1e-3) break;
                measureStart = start;
              }
              beatInMeasure = Math.round((this.nextScoreBeat - measureStart) / scoreBeatStep);
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

        this.lastBeatTime = clickTime;
        this.currentBeat = clickIndex;
        this.nextScoreBeat += scoreBeatStep;
      }
    };

    scheduleAhead();
    this.schedulerTimer = setInterval(scheduleAhead, this.scheduleIntervalMs);
  }

  /**
   * Schedule a click sound at a specific time.
   * @param {number} time - AudioContext time to play the click
   * @param {boolean} isDownbeat - true for beat 1 (higher pitch)
   */
  scheduleClick(time, isDownbeat) {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    // High pitch for downbeat, lower for other beats
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(
      isDownbeat ? 1000 : 800,
      time
    );

    // Short burst envelope
    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(0.5, time + 0.001);
    gainNode.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    oscillator.connect(gainNode);
    gainNode.connect(this.destination);

    oscillator.start(time);
    oscillator.stop(time + 0.06);

    const clickEntry = {
      oscillator,
      gainNode,
      startTime: time,
      endTime: time + 0.06
    };
    this.scheduledClicks.add(clickEntry);

    oscillator.onended = () => {
      this.scheduledClicks.delete(clickEntry);
      try {
        oscillator.disconnect();
        gainNode.disconnect();
      } catch (e) { /* already disconnected */ }
    };
  }

  /**
   * Record a tap for tap tempo calculation.
   * @returns {number|null} calculated BPM if enough taps, null otherwise
   */
  tap() {
    const now = Date.now();

    // Reset if too long since last tap
    if (this.tapTimes.length > 0 &&
        now - this.tapTimes[this.tapTimes.length - 1] > this.maxTapInterval) {
      this.tapTimes = [];
    }

    this.tapTimes.push(now);

    // Keep last 8 taps
    if (this.tapTimes.length > 8) {
      this.tapTimes.shift();
    }

    // Need at least 2 taps to calculate
    if (this.tapTimes.length < 2) return null;

    // Calculate intervals between consecutive taps
    const intervals = [];
    for (let i = 1; i < this.tapTimes.length; i++) {
      intervals.push(this.tapTimes[i] - this.tapTimes[i - 1]);
    }

    return calculateTapTempo(intervals);
  }

  /**
   * Reset the metronome state.
   */
  reset() {
    this.stop();
    this.currentBeat = 0;
    this.tapTimes = [];
  }
}
