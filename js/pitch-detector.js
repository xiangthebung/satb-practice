/**
 * Microphone Pitch Detection Module
 * Uses Web Audio API AnalyserNode with autocorrelation-based pitch detection.
 * Implements a simplified YIN algorithm for accurate fundamental frequency detection.
 */

import { frequencyToNote } from './utils.js';

const MIN_PITCH_HZ = 50;
const MAX_PITCH_HZ = 2000;

/**
 * Compute the autocorrelation-based pitch using a simplified YIN algorithm.
 * @param {Float32Array} buffer - audio sample buffer from AnalyserNode
 * @param {number} sampleRate - audio sample rate
 * @returns {number} detected frequency in Hz, or -1 if no pitch detected
 */
export function detectPitchAutocorrelation(buffer, sampleRate) {
  const bufferSize = buffer.length;

  // Check if signal has enough energy (RMS threshold)
  let rms = 0;
  for (let i = 0; i < bufferSize; i++) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / bufferSize);
  if (rms < 0.01) return -1; // Too quiet

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
    yinBuffer[tau] = yinBuffer[tau] * tau / runningSum;
  }

  // Step 3: Find the first dip below threshold
  const threshold = 0.2;
  let tauEstimate = -1;
  for (let tau = 2; tau < halfBuffer; tau++) {
    if (yinBuffer[tau] < threshold) {
      // Find the minimum in this dip
      while (tau + 1 < halfBuffer && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau++;
      }
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    // No pitch found below threshold; try to find global minimum
    let minVal = Infinity;
    for (let tau = 2; tau < halfBuffer; tau++) {
      if (yinBuffer[tau] < minVal) {
        minVal = yinBuffer[tau];
        tauEstimate = tau;
      }
    }

    // Only accept if reasonably periodic
    if (minVal > 0.5) return -1;
  }

  // Step 4: Parabolic interpolation for sub-sample accuracy
  if (tauEstimate > 0 && tauEstimate < halfBuffer - 1) {
    const s0 = yinBuffer[tauEstimate - 1];
    const s1 = yinBuffer[tauEstimate];
    const s2 = yinBuffer[tauEstimate + 1];
    const adjustment = (s2 - s0) / (2 * (2 * s1 - s2 - s0));

    if (Math.abs(adjustment) < 1) {
      tauEstimate = tauEstimate + adjustment;
    }
  }

  return sampleRate / tauEstimate;
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
    const frequency = detectPitchAutocorrelation(
      this.buffer,
      this.audioContext.sampleRate
    );
    const now = performance.now();

    if (frequency > MIN_PITCH_HZ && frequency < MAX_PITCH_HZ) {
      // Restore the previous detector's temporal smoothing. The raw YIN
      // estimate varies slightly from frame to frame as the analysis window
      // moves through the waveform; retaining 30% of the previous estimate
      // keeps the pitch, cents, trail, and color feedback stable.
      if (this.lastFrequency > 0) {
        const smoothed = this.lastFrequency * 0.3 + frequency * 0.7;
        this.lastFrequency = smoothed;
      } else {
        this.lastFrequency = frequency;
      }

      const noteInfo = frequencyToNote(this.lastFrequency);
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
      // Match the previous detector: an unvoiced frame ends the current trail
      // segment and allows the next voiced frame to start cleanly.
      this.lastFrequency = -1;
      if (this.onPitchDetected) {
        this.onPitchDetected(null);
      }
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
