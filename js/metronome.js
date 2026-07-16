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
    this.schedulerTimer = null;
    this.lookaheadTime = 0.1; // seconds
    this.scheduleIntervalMs = 25; // ms
    this.onBeat = null; // callback(beatNumber, isDownbeat)
    this.tapTimes = [];
    this.maxTapInterval = 2000; // max ms between taps before reset
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
   * Start the metronome.
   * @param {object} [syncOptions] - optional sync parameters
   * @param {number} [syncOptions.startTime] - AudioContext time reference for beat 0
   * @param {number} [syncOptions.currentBeat] - current beat position to sync from
   */
  start(syncOptions) {
    if (this.isRunning) return;
    this.isRunning = true;

    if (syncOptions && typeof syncOptions.startTime === 'number') {
      // Sync to an external time reference (e.g., the audio engine)
      const beatIntervalSec = 60 / this.tempo;
      const elapsed = this.audioContext.currentTime - syncOptions.startTime;
      const currentBeat = syncOptions.currentBeat || (elapsed / beatIntervalSec);
      // Calculate the beat number and align lastBeatTime
      this.currentBeat = Math.floor(currentBeat);
      // Set lastBeatTime so that the next beat aligns correctly
      this.lastBeatTime = syncOptions.startTime + this.currentBeat * beatIntervalSec;
    } else {
      this.currentBeat = 0;
      this.lastBeatTime = this.audioContext.currentTime;
    }

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
  }

  /**
   * Internal scheduling loop using setInterval + lookahead.
   * Re-reads tempo on each tick so tempo changes take effect immediately.
   */
  schedule() {
    this.schedulerTimer = setInterval(() => {
      if (!this.isRunning) return;

      const beatIntervalSec = 60 / this.tempo;
      const currentTime = this.audioContext.currentTime;
      const scheduleUntil = currentTime + this.lookaheadTime;

      while (this.lastBeatTime + beatIntervalSec <= scheduleUntil) {
        const beatTime = this.lastBeatTime + beatIntervalSec;
        const isDownbeat = (this.currentBeat % this.timeSignature.numerator) === 0;

        this.scheduleClick(beatTime, isDownbeat);

        if (this.onBeat) {
          // Use setTimeout to fire the callback near the actual beat time
          const delay = Math.max(0, (beatTime - currentTime) * 1000);
          const beatNum = this.currentBeat;
          setTimeout(() => {
            if (this.isRunning && this.onBeat) {
              this.onBeat(beatNum, isDownbeat);
            }
          }, delay);
        }

        this.lastBeatTime = beatTime;
        this.currentBeat++;
      }
    }, this.scheduleIntervalMs);
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

    oscillator.onended = () => {
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
