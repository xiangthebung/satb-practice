/**
 * Microphone Pitch Detection Module
 * Uses Web Audio API AnalyserNode with autocorrelation-based pitch detection.
 * Implements a simplified YIN algorithm for accurate fundamental frequency detection.
 */

import { frequencyToNote } from './utils.js';

const YIN_THRESHOLD = 0.2;
const MAX_YIN_VALUE = 0.5;
const MIN_PITCH_HZ = 50;
const MAX_PITCH_HZ = 2000;
const OCTAVE_CANDIDATE_CONFIDENCE = 0.72;

/**
 * Interpolate a YIN trough to improve the pitch estimate between samples.
 * @param {Float32Array} yinBuffer
 * @param {number} tau
 * @returns {number}
 */
function interpolateTau(yinBuffer, tau) {
  if (tau <= 0 || tau >= yinBuffer.length - 1) return tau;

  const s0 = yinBuffer[tau - 1];
  const s1 = yinBuffer[tau];
  const s2 = yinBuffer[tau + 1];
  const denominator = 2 * (2 * s1 - s2 - s0);
  if (denominator === 0) return tau;

  const adjustment = (s2 - s0) / denominator;
  return Math.abs(adjustment) < 1 ? tau + adjustment : tau;
}

/**
 * Add a candidate unless it duplicates an existing pitch estimate.
 * @param {Array<object>} candidates
 * @param {object} candidate
 */
function addPitchCandidate(candidates, candidate) {
  if (!Number.isFinite(candidate.frequency) ||
      candidate.frequency < MIN_PITCH_HZ ||
      candidate.frequency > MAX_PITCH_HZ) {
    return;
  }

  const duplicate = candidates.some(existing =>
    Math.abs(1200 * Math.log2(candidate.frequency / existing.frequency)) < 35
  );
  if (!duplicate) candidates.push(candidate);
}

/**
 * Analyze a microphone frame with YIN and retain plausible alternative pitches.
 * Keeping alternatives lets the score-aware renderer resolve octave ambiguity
 * immediately instead of waiting for several future frames.
 * @param {Float32Array} buffer - audio sample buffer from AnalyserNode
 * @param {number} sampleRate - audio sample rate
 * @returns {{ frequency: number, confidence: number, candidates: Array<object> }|null}
 */
export function analyzePitchAutocorrelation(buffer, sampleRate) {
  const bufferSize = buffer.length;

  // Check if signal has enough energy (RMS threshold)
  let rms = 0;
  for (let i = 0; i < bufferSize; i++) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / bufferSize);
  if (rms < 0.01) return null;

  // YIN-style difference function
  const halfBuffer = Math.floor(bufferSize / 2);
  const yinBuffer = new Float32Array(halfBuffer);

  // Step 1: Compute the difference function
  for (let tau = 0; tau < halfBuffer; tau++) {
    let sum = 0;
    for (let i = 0; i < halfBuffer; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  // Step 2: Cumulative mean normalized difference function
  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfBuffer; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] = runningSum > 0
      ? yinBuffer[tau] * tau / runningSum
      : 1;
  }

  const minTau = Math.max(2, Math.floor(sampleRate / MAX_PITCH_HZ));
  const maxTau = Math.min(
    halfBuffer - 2,
    Math.ceil(sampleRate / MIN_PITCH_HZ)
  );
  if (minTau >= maxTau) return null;

  // Prefer the first trough below the YIN threshold, preserving the original
  // detector's fundamental-frequency bias instead of blindly taking the
  // strongest short-period harmonic.
  let primaryTau = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (yinBuffer[tau] < YIN_THRESHOLD) {
      while (
        tau + 1 <= maxTau &&
        yinBuffer[tau + 1] < yinBuffer[tau]
      ) {
        tau++;
      }
      primaryTau = tau;
      break;
    }
  }

  if (primaryTau === -1) {
    // No pitch found below threshold; try to find the global minimum.
    let minVal = Infinity;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (yinBuffer[tau] < minVal) {
        minVal = yinBuffer[tau];
        primaryTau = tau;
      }
    }
    if (minVal > MAX_YIN_VALUE) return null;
  }

  const candidateTaus = [primaryTau];
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (
      yinBuffer[tau] <= MAX_YIN_VALUE &&
      yinBuffer[tau] <= yinBuffer[tau - 1] &&
      yinBuffer[tau] <= yinBuffer[tau + 1]
    ) {
      candidateTaus.push(tau);
    }
  }

  const candidates = [];
  for (const tau of candidateTaus) {
    const interpolatedTau = interpolateTau(yinBuffer, tau);
    const frequency = sampleRate / interpolatedTau;
    const clarity = Math.max(0, Math.min(1, 1 - yinBuffer[tau]));
    addPitchCandidate(candidates, { frequency, confidence: clarity });
    if (candidates.length >= 5) break;
  }

  // A period tracker can return a clean octave error even when the missing
  // fundamental is not a separate trough. Include both octave equivalents as
  // lower-confidence alternatives for same-frame contextual selection.
  const primary = candidates[0];
  if (primary) {
    for (const multiplier of [0.5, 2]) {
      addPitchCandidate(candidates, {
        frequency: primary.frequency * multiplier,
        confidence: primary.confidence * OCTAVE_CANDIDATE_CONFIDENCE
      });
    }
  }

  if (!candidates.length) return null;
  return {
    frequency: candidates[0].frequency,
    confidence: candidates[0].confidence,
    candidates
  };
}

/**
 * Compute the best autocorrelation-based pitch using a simplified YIN
 * algorithm. This compatibility wrapper returns the primary candidate while
 * analyzePitchAutocorrelation() exposes alternatives and confidence.
 * @param {Float32Array} buffer - audio sample buffer from AnalyserNode
 * @param {number} sampleRate - audio sample rate
 * @returns {number} detected frequency in Hz, or -1 if no pitch detected
 */
export function detectPitchAutocorrelation(buffer, sampleRate) {
  return analyzePitchAutocorrelation(buffer, sampleRate)?.frequency || -1;
}

/**
 * Calculate cents difference between two frequencies.
 * @param {number} detected - detected frequency
 * @param {number} target - target frequency
 * @returns {number} cents difference (positive = sharp, negative = flat)
 */
export function centsDifference(detected, target) {
  if (detected <= 0 || target <= 0) return 0;
  return 1200 * Math.log2(detected / target);
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
    this.fftSize = 2048;
    this.smoothingFactor = 0.8;
    this.lastFrequency = -1;

    // A short hold prevents one uncertain frame from making the UI flash back
    // to "Listening" between otherwise continuous sung notes.
    this.silenceHoldMs = 140;
    this.lastVoicedAt = 0;
    this.hasReportedSilence = false;

    // Browser-reported MediaTrack latency is often the requested buffer size,
    // not the complete hardware and capture pipeline. Keep a conservative
    // floor for built-in macOS input while still honoring slower devices.
    this.minimumInputLatencySeconds = 0.045;
    this.captureLatencySeconds = this.minimumInputLatencySeconds;
    this.processingLatencySeconds = 0;
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
          autoGainControl: false,
          latency: { ideal: 0.01 }
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
      this.analyser.smoothingTimeConstant = this.smoothingFactor;

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
      this.lastVoicedAt = 0;
      this.hasReportedSilence = false;
      this.processingLatencySeconds = 0;
      this.isActive = true;
      this.detectLoop();
      return true;
    } catch (err) {
      console.error('Microphone access denied:', err);
      this.stop();
      return false;
    }
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
    this.analyser.getFloatTimeDomainData(this.buffer);
    const analysis = analyzePitchAutocorrelation(
      this.buffer,
      this.audioContext.sampleRate
    );
    const now = performance.now();

    if (analysis?.frequency > MIN_PITCH_HZ && analysis.frequency < MAX_PITCH_HZ) {
      // Do not add multi-frame confirmation or weighted pitch smoothing here.
      // The score-aware consumer resolves octave candidates from this frame
      // immediately, which keeps note attacks responsive.
      this.lastFrequency = analysis.frequency;
      this.lastVoicedAt = now;
      this.hasReportedSilence = false;

      const noteInfo = frequencyToNote(analysis.frequency);
      if (noteInfo && this.onPitchDetected) {
        // A changed note is not reliably identifiable until the analyser window
        // has largely filled with its waveform, so the sample belongs one full
        // window in the past rather than at the window midpoint.
        const analysisWindowSeconds = this.analyser.fftSize / this.audioContext.sampleRate;
        const processingSeconds = Math.max(0, now - analysisStartedAt) / 1000;
        this.processingLatencySeconds = this.processingLatencySeconds > 0
          ? this.processingLatencySeconds * 0.8 + processingSeconds * 0.2
          : processingSeconds;
        this.onPitchDetected({
          frequency: analysis.frequency,
          rawFrequency: analysis.frequency,
          candidates: analysis.candidates,
          confidence: analysis.confidence,
          noteName: noteInfo.noteName,
          octave: noteInfo.octave,
          cents: noteInfo.cents,
          accuracy: classifyAccuracy(noteInfo.cents),
          latencySeconds:
            this.captureLatencySeconds + analysisWindowSeconds +
            this.processingLatencySeconds
        });
      }
    } else if (
      !this.hasReportedSilence &&
      (this.lastVoicedAt === 0 || now - this.lastVoicedAt >= this.silenceHoldMs)
    ) {
      this.lastFrequency = -1;
      this.hasReportedSilence = true;
      if (this.onPitchDetected) this.onPitchDetected(null);
    }

    this.animationFrame = requestAnimationFrame(() => this.detectLoop());
  }

  /**
   * Check if the detector is currently active.
   * @returns {boolean}
   */
  getIsActive() {
    return this.isActive;
  }
}
