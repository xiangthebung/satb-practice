/**
 * Microphone Pitch Detection Module
 * Uses Web Audio API AnalyserNode with autocorrelation-based pitch detection.
 * Implements a simplified YIN algorithm for accurate fundamental frequency detection.
 */

import { STANDARD_TUNING_HZ, frequencyToNote } from './utils.js';

const MIN_PITCH_HZ = 50;
const MAX_PITCH_HZ = 2000;
const YIN_THRESHOLD = 0.15;

/** Return the middle value without mutating the caller's array. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Calculate the distance between two frequencies in cents. */
function frequencyDistanceInCents(a, b) {
  return 1200 * Math.abs(Math.log2(a / b));
}

/**
 * Analyse one frame with YIN and keep the periodicity measurement alongside
 * the estimate. Callers can use this confidence to reject ambiguous frames
 * instead of treating every local minimum as a note.
 *
 * @returns {{ frequency: number, confidence: number, rms: number }|null}
 */
export function analysePitchYin(buffer, sampleRate) {
  const bufferSize = buffer.length;
  if (!bufferSize || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;

  let mean = 0;
  let energy = 0;
  for (let i = 0; i < bufferSize; i++) {
    mean += buffer[i];
    energy += buffer[i] * buffer[i];
  }
  mean /= bufferSize;
  const rms = Math.sqrt(energy / bufferSize);
  if (rms < 0.01) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / MAX_PITCH_HZ));
  const maxTau = Math.min(
    Math.floor(bufferSize / 2),
    Math.floor(sampleRate / MIN_PITCH_HZ)
  );
  if (maxTau <= minTau + 2) return null;

  // Give every tested period the same comparison window. The earlier version
  // compared only half the buffer, which left low voices with very little
  // periodic evidence and made harmonic/octave choices unstable.
  const comparisonLength = bufferSize - maxTau;
  const yinBuffer = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < comparisonLength; i++) {
      const delta = (buffer[i] - mean) - (buffer[i + tau] - mean);
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  let runningSum = 0;
  yinBuffer[0] = 1;
  for (let tau = 1; tau <= maxTau; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] = runningSum > 0
      ? yinBuffer[tau] * tau / runningSum
      : 1;
  }

  let tauEstimate = -1;
  for (let tau = minTau; tau < maxTau; tau++) {
    if (yinBuffer[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= maxTau && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  // Do not fall back to an arbitrary global minimum. That was the source of
  // many false notes on breath, room noise, and accompaniment leakage.
  if (tauEstimate < 0) return null;

  const confidence = Math.max(0, Math.min(1, 1 - yinBuffer[tauEstimate]));
  if (tauEstimate > minTau && tauEstimate < maxTau) {
    const s0 = yinBuffer[tauEstimate - 1];
    const s1 = yinBuffer[tauEstimate];
    const s2 = yinBuffer[tauEstimate + 1];
    const denominator = 2 * (2 * s1 - s2 - s0);
    const adjustment = denominator === 0 ? 0 : (s2 - s0) / denominator;
    if (Number.isFinite(adjustment) && Math.abs(adjustment) < 1) {
      tauEstimate += adjustment;
    }
  }

  return { frequency: sampleRate / tauEstimate, confidence, rms };
}

/**
 * Determine pitch accuracy classification.
 * @param {number} cents - absolute cents difference
 * @returns {string} 'correct' (<=50 cents), 'close' (<=100 cents), or 'off'
 */
export function classifyAccuracy(cents) {
  const absCents = Math.abs(cents);
  if (absCents <= 50) return 'correct';
  if (absCents <= 100) return 'close';
  return 'off';
}

/**
 * PitchDetector class - manages microphone input and real-time pitch detection.
 */
export class PitchDetector {
  constructor() {
    // PitchDetector creates its own AudioContext dedicated to mic input.
    // Sharing the playback context causes silent failures on many browsers.
    this.audioContext = null;
    this.analyser = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.buffer = null;
    this.isActive = false;
    this.animationFrame = null;
    this.onPitchDetected = null;
    // A 4096-sample window gives bass voices several full cycles at common
    // sample rates. Detection is deliberately throttled below display rate;
    // analysing near-identical frames on every paint adds jitter, not insight.
    this.fftSize = 4096;
    this.analysisIntervalMs = 33;
    this.minimumConfidence = 0.82;
    this.historySize = 3;
    this.unvoicedHoldFrames = 4;
    this.lastAnalysisAt = -Infinity;
    this.lastFrequency = -1;
    this.smoothedLogFrequency = null;
    this.logFrequencyHistory = [];
    this.unvoicedFrames = 0;
    this.pendingOctaveFrequency = -1;
    this.pendingOctaveFrames = 0;

    // Browser-reported MediaTrack latency is often the requested buffer size,
    // not the complete hardware and capture pipeline. Keep a conservative
    // floor for built-in macOS input while still honoring slower devices.
    this.minimumInputLatencySeconds = 0.045;
    this.captureLatencySeconds = this.minimumInputLatencySeconds;
    this.processingLatencySeconds = 0;

    // The tuning the guidance judges against. A choir singing at 442 is in tune
    // with itself, and the feedback has to agree with the room.
    this.tuningHz = STANDARD_TUNING_HZ;
  }

  /**
   * Set the tuning reference for A4 in hertz.
   * @param {number} hertz
   */
  setTuning(hertz) {
    const reference = Number(hertz);
    this.tuningHz = Number.isFinite(reference) && reference > 0
      ? Math.max(390, Math.min(490, reference))
      : STANDARD_TUNING_HZ;
  }

  /**
   * Request microphone access and set up the audio graph.
   * @returns {Promise<boolean>} true if microphone was successfully accessed
   */
  async start() {
    try {
      // Request mic permission first, before creating the AudioContext.
      // Some browsers require this ordering.
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      // Create a dedicated AudioContext for mic analysis
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      // This setting only affects frequency-domain reads. Pitch estimation
      // uses time-domain audio, so temporal smoothing happens below instead.
      this.analyser.smoothingTimeConstant = 0;

      const inputTrack = this.mediaStream.getAudioTracks()[0];
      const reportedLatency = Number(inputTrack?.getSettings?.().latency);
      const usableReportedLatency = Number.isFinite(reportedLatency) && reportedLatency >= 0
        ? reportedLatency
        : 0;
      this.captureLatencySeconds = Math.max(
        this.minimumInputLatencySeconds,
        usableReportedLatency
      );

      this.sourceNode.connect(this.analyser);
      // Do NOT connect analyser to destination to avoid feedback

      this.buffer = new Float32Array(this.analyser.fftSize);
      this.lastFrequency = -1;
      this.smoothedLogFrequency = null;
      this.logFrequencyHistory = [];
      this.unvoicedFrames = 0;
      this.pendingOctaveFrequency = -1;
      this.pendingOctaveFrames = 0;
      this.lastAnalysisAt = -Infinity;
      this.processingLatencySeconds = 0;
      this.isActive = true;
      this.detectLoop();
      return true;
    } catch (err) {
      // A refused or unavailable microphone is a user choice, not a fault.
      console.warn('Microphone unavailable:', err?.name || err);
      this.stop();
      return false;
    }
  }

  /**
   * Reject one-frame octave errors, then smooth accepted frequencies in log
   * space. Log smoothing corresponds to musical cents rather than raw Hz.
   * @returns {number|null} a stable frequency, or null while confirming a jump
   */
  stabiliseFrequency(frequency) {
    if (this.lastFrequency > 0 && frequencyDistanceInCents(frequency, this.lastFrequency) > 700) {
      const matchesPending = this.pendingOctaveFrequency > 0 &&
        frequencyDistanceInCents(frequency, this.pendingOctaveFrequency) < 100;
      this.pendingOctaveFrequency = frequency;
      this.pendingOctaveFrames = matchesPending ? this.pendingOctaveFrames + 1 : 1;

      // A genuine octave change is accepted on its second consecutive frame;
      // a single harmonic mistake is never shown to the singer.
      if (this.pendingOctaveFrames < 2) return null;
      this.logFrequencyHistory = [];
      this.smoothedLogFrequency = null;
    }

    this.pendingOctaveFrequency = -1;
    this.pendingOctaveFrames = 0;
    this.logFrequencyHistory.push(Math.log(frequency));
    if (this.logFrequencyHistory.length > this.historySize) {
      this.logFrequencyHistory.shift();
    }

    const medianLogFrequency = median(this.logFrequencyHistory);
    this.smoothedLogFrequency = this.smoothedLogFrequency === null
      ? medianLogFrequency
      : this.smoothedLogFrequency + (medianLogFrequency - this.smoothedLogFrequency) * 0.35;
    this.lastFrequency = Math.exp(this.smoothedLogFrequency);
    return this.lastFrequency;
  }

  clearStablePitch() {
    this.lastFrequency = -1;
    this.smoothedLogFrequency = null;
    this.logFrequencyHistory = [];
    this.pendingOctaveFrequency = -1;
    this.pendingOctaveFrames = 0;
  }

  /**
   * Stop pitch detection and release microphone.
   */
  stop() {
    this.isActive = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    this.analyser = null;
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  /**
   * Continuous detection loop using requestAnimationFrame.
   */
  detectLoop() {
    if (!this.isActive || !this.analyser) return;

    const analysisStartedAt = performance.now();
    if (analysisStartedAt - this.lastAnalysisAt < this.analysisIntervalMs) {
      this.animationFrame = requestAnimationFrame(() => this.detectLoop());
      return;
    }
    this.lastAnalysisAt = analysisStartedAt;

    this.analyser.getFloatTimeDomainData(this.buffer);
    const estimate = analysePitchYin(
      this.buffer,
      this.audioContext.sampleRate
    );
    const now = performance.now();

    const hasReliablePitch = estimate &&
      estimate.frequency > MIN_PITCH_HZ &&
      estimate.frequency < MAX_PITCH_HZ &&
      estimate.confidence >= this.minimumConfidence;

    if (hasReliablePitch) {
      this.unvoicedFrames = 0;
      const stableFrequency = this.stabiliseFrequency(estimate.frequency);
      if (stableFrequency === null) {
        this.animationFrame = requestAnimationFrame(() => this.detectLoop());
        return;
      }

      const noteInfo = frequencyToNote(this.lastFrequency, this.tuningHz);
      if (noteInfo && this.onPitchDetected) {
        // Preserve capture-aligned trail placement without changing the pitch
        // calculation itself.
        const analysisWindowSeconds = this.analyser.fftSize / this.audioContext.sampleRate;
        const processingSeconds = Math.max(0, now - analysisStartedAt) / 1000;
        this.processingLatencySeconds = this.processingLatencySeconds > 0
          ? this.processingLatencySeconds * 0.8 + processingSeconds * 0.2
          : processingSeconds;

        this.onPitchDetected({
          frequency: this.lastFrequency,
          noteName: noteInfo.noteName,
          octave: noteInfo.octave,
          cents: noteInfo.cents,
          accuracy: classifyAccuracy(noteInfo.cents),
          latencySeconds:
            this.captureLatencySeconds + analysisWindowSeconds +
            this.processingLatencySeconds
        });
      }
    } else {
      // Keep a reliable note visible through a small number of unvoiced or
      // ambiguous frames. A singer's breath should not break the pitch trail.
      this.unvoicedFrames++;
      if (this.unvoicedFrames >= this.unvoicedHoldFrames) {
        this.clearStablePitch();
        if (this.onPitchDetected) this.onPitchDetected(null);
      }
    }

    this.animationFrame = requestAnimationFrame(() => this.detectLoop());
  }

}
