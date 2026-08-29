/**
 * Microphone pitch detection.
 *
 * A YIN-style periodicity estimator over the time-domain signal, plus the parts
 * that make it usable in a rehearsal room rather than in a lab:
 *
 *   band-limiting   The input is filtered to the range a voice can occupy
 *                   before it is analysed. Desk rumble and consonant hiss are
 *                   the two things most likely to look periodic to a search
 *                   that is allowed to see them.
 *   a noise gate    The threshold follows the room instead of being a fixed
 *                   number, so a noisy rehearsal space stops producing notes
 *                   nobody sang, and a quiet one still hears a soft entry.
 *   two-stage search A half-rate search locates the period and a full-rate pass
 *                   refines it. This costs about a quarter of what a full-rate
 *                   search costs, which matters because it shares a thread with
 *                   the score.
 *   octave guarding  A voice with a weak fundamental repeats convincingly at
 *                   half its period, so the first candidate is checked against
 *                   the octave below before it is believed.
 */

import { STANDARD_TUNING_HZ, frequencyToNote } from './utils.js';

/**
 * The range the search is allowed to consider.
 *
 * The bottom is a little under a bass low C rather than down in the region where
 * air handling and desk thumps live: allowing lags no singer can produce only
 * gives the search a way to report the room.
 */
const MIN_PITCH_HZ = 62;
const MAX_PITCH_HZ = 2000;
const YIN_THRESHOLD = 0.15;
/** Below this the estimate is unambiguous, so the octave check has no work. */
const OCTAVE_CHECK_FLOOR = 0.02;
/** How much better the octave below has to look before it is preferred. */
const OCTAVE_PREFERENCE = 0.7;
/** Quietest frame worth analysing at all, whatever the room is doing. */
const ABSOLUTE_GATE_RMS = 0.012;
/**
 * The analysis band: low enough for a bass, high enough for a soprano.
 *
 * The high-pass is a pair of stages rather than one. A single stage leaves
 * enough of a 40 Hz rumble for the search to prefer it over a quiet singer,
 * because a steady mechanical tone is more periodic than a voice.
 */
const INPUT_HIGHPASS_HZ = 65;
const INPUT_HIGHPASS_STAGES = 2;
const INPUT_LOWPASS_HZ = 2600;

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

/** Root mean square of a frame, the level the gate works from. */
export function frameRms(buffer) {
  const length = buffer?.length || 0;
  if (!length) return 0;
  let energy = 0;
  for (let i = 0; i < length; i++) energy += buffer[i] * buffer[i];
  return Math.sqrt(energy / length);
}

/**
 * Squared difference between the signal and itself delayed by `tau`.
 * @param {Float32Array} buffer
 * @param {number} tau lag in samples
 * @param {number} length samples compared, the same for every lag
 */
function differenceAt(buffer, tau, length) {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const delta = buffer[i] - buffer[i + tau];
    sum += delta * delta;
  }
  return sum;
}

/**
 * Locate the true period near an approximate one, at the full sample rate.
 *
 * The half-rate search is only accurate to two samples, which at the top of a
 * soprano's range is worth tens of cents. Testing the neighbourhood at full
 * resolution and interpolating between the three lowest points recovers the
 * precision without paying for a full-rate search.
 *
 * @param {Float32Array} buffer
 * @param {number} approximateTau
 * @param {number} window lags either side to test
 * @param {number} maxTau largest lag the buffer can support
 * @returns {number} period in samples, fractional
 */
function refinePeriod(buffer, approximateTau, window, maxTau) {
  const length = buffer.length - maxTau - 1;
  if (length <= 8) return approximateTau;

  const lower = Math.max(3, approximateTau - window);
  const upper = Math.min(maxTau - 2, approximateTau + window);
  if (upper <= lower) return approximateTau;

  let bestTau = lower;
  let bestValue = Infinity;
  for (let tau = lower; tau <= upper; tau++) {
    const value = differenceAt(buffer, tau, length);
    if (value < bestValue) {
      bestValue = value;
      bestTau = tau;
    }
  }

  const before = differenceAt(buffer, bestTau - 1, length);
  const after = differenceAt(buffer, bestTau + 1, length);
  const denominator = 2 * (2 * bestValue - after - before);
  const adjustment = denominator === 0 ? 0 : (after - before) / denominator;
  return Number.isFinite(adjustment) && Math.abs(adjustment) < 1
    ? bestTau + adjustment
    : bestTau;
}

/**
 * Analyse one frame and keep the periodicity measurement alongside the
 * estimate. Callers can use this confidence to reject ambiguous frames instead
 * of treating every local minimum as a note.
 *
 * @param {Float32Array} buffer time-domain frame
 * @param {number} sampleRate
 * @returns {{ frequency: number, confidence: number, rms: number }|null}
 */
export function analysePitchYin(buffer, sampleRate) {
  const bufferSize = buffer?.length || 0;
  if (!bufferSize || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;

  const rms = frameRms(buffer);
  if (rms < 0.01) return null;

  // Search a half-rate copy. Averaging sample pairs both halves the rate and
  // removes the top octave, which is above anything a voice can sustain and is
  // where hiss lives, so the search sees only the part of the signal that can
  // carry a pitch.
  const decimation = 2;
  const coarseSize = bufferSize >> 1;
  const coarseRate = sampleRate / decimation;
  const coarse = new Float32Array(coarseSize);
  for (let i = 0; i < coarseSize; i++) {
    coarse[i] = (buffer[i * 2] + buffer[i * 2 + 1]) * 0.5;
  }

  const minTau = Math.max(2, Math.floor(coarseRate / MAX_PITCH_HZ));
  const maxTau = Math.min(
    Math.floor(coarseSize / 2),
    Math.floor(coarseRate / MIN_PITCH_HZ)
  );
  if (maxTau <= minTau + 2) return null;

  // Give every tested period the same comparison window, so a low voice is not
  // judged on less evidence than a high one.
  const comparisonLength = coarseSize - maxTau;
  const yinBuffer = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    yinBuffer[tau] = differenceAt(coarse, tau, comparisonLength);
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

  // The first period below the threshold can be half the real one when the
  // fundamental is weak, which reads as an octave error to the singer. Take the
  // octave below only when it accounts for the signal markedly better, so a
  // genuine pitch is never dragged down an octave.
  if (yinBuffer[tauEstimate] > OCTAVE_CHECK_FLOOR) {
    const doubled = tauEstimate * 2;
    let candidate = -1;
    for (let tau = doubled - 2; tau <= doubled + 2; tau++) {
      if (tau < minTau || tau > maxTau) continue;
      if (candidate < 0 || yinBuffer[tau] < yinBuffer[candidate]) candidate = tau;
    }
    if (candidate > 0 &&
        yinBuffer[candidate] < yinBuffer[tauEstimate] * OCTAVE_PREFERENCE) {
      tauEstimate = candidate;
    }
  }

  const confidence = Math.max(0, Math.min(1, 1 - yinBuffer[tauEstimate]));
  const period = refinePeriod(
    buffer,
    tauEstimate * decimation,
    decimation,
    maxTau * decimation
  );
  if (!(period > 0)) return null;

  return { frequency: sampleRate / period, confidence, rms };
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
 * Turn a `getUserMedia` rejection into something a singer can act on.
 *
 * Every one of these used to produce the same sentence — "Microphone access was
 * blocked. Allow it in your browser settings" — which is only true for one of
 * them. Told that, someone with no microphone at all goes and looks at a
 * permissions list that already says "allow", and someone on plain HTTP never
 * finds out that the browser will not offer the microphone at all until the page
 * is served over HTTPS.
 *
 * Pure, and exported, so the mapping is unit-testable without a browser or a
 * device. The names are `DOMException.name` values from the getUserMedia spec,
 * plus the two legacy spellings Chrome and Firefox both emitted for years.
 *
 * @param {unknown} error
 * @returns {string} a sentence to show the singer
 */
export function describeMicrophoneFailure(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access was blocked. Allow it in your browser settings to use pitch guidance.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Connect one, then turn the guidance on again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is being used by another app. Close it, then try again.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'This microphone cannot record in the format the guidance needs.';
    case 'SecurityError':
      return 'Pitch guidance needs a secure connection. Open this page over HTTPS, or on localhost.';
    case 'AbortError':
      return 'The microphone stopped responding. Try turning the guidance on again.';
    default:
      return 'The microphone could not be started. Try turning the guidance on again.';
  }
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
    this.inputFilters = [];
    this.buffer = null;
    this.isActive = false;
    this.animationFrame = null;
    this.onPitchDetected = null;
    // A 4096-sample window gives bass voices several full cycles at common
    // sample rates. Detection is deliberately throttled below display rate;
    // analysing near-identical frames on every paint adds jitter, not insight.
    this.fftSize = 4096;
    this.analysisIntervalMs = 25;
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

    // What the room sounds like with nobody singing, and whether the current
    // frame is above it. Tracked rather than assumed, because a fixed threshold
    // is either deaf in a quiet room or credulous in a noisy one.
    this.noiseFloorRms = 0;
    this.isGateOpen = false;

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
   *
   * On failure, `failureReason` holds a sentence saying what actually went
   * wrong. It used to say "access was blocked" whatever happened, which is a lie
   * to anyone whose laptop has no microphone, or who opened the page over plain
   * HTTP on their own network — both of which send the singer to a permissions
   * screen that will not help them.
   *
   * @returns {Promise<boolean>} true if microphone was successfully accessed
   */
  async start() {
    this.failureReason = null;
    try {
      if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
        // Missing rather than refused: the API is only exposed in a secure
        // context, so this is nearly always plain HTTP on a LAN address.
        throw new DOMException('getUserMedia is unavailable', 'SecurityError');
      }
      // Request mic permission first, before creating the AudioContext.
      // Some browsers require this ordering.
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
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

      // Everything outside the range a voice can sustain is removed before the
      // signal is measured: air handling and desk thumps below, consonants and
      // hiss above. Both are periodic enough to be mistaken for a note.
      this.inputFilters = this.createInputFilters(this.audioContext);
      let tail = this.sourceNode;
      for (const filter of this.inputFilters) {
        tail.connect(filter);
        tail = filter;
      }
      tail.connect(this.analyser);
      // Do NOT connect analyser to destination to avoid feedback

      this.buffer = new Float32Array(this.analyser.fftSize);
      this.lastFrequency = -1;
      this.smoothedLogFrequency = null;
      this.logFrequencyHistory = [];
      this.unvoicedFrames = 0;
      this.pendingOctaveFrequency = -1;
      this.pendingOctaveFrames = 0;
      this.noiseFloorRms = 0;
      this.isGateOpen = false;
      this.lastAnalysisAt = -Infinity;
      this.processingLatencySeconds = 0;
      this.isActive = true;
      this.detectLoop();
      return true;
    } catch (err) {
      // A refused or unavailable microphone is a user choice, not a fault.
      this.failureReason = describeMicrophoneFailure(err);
      this.stop();
      return false;
    }
  }

  /**
   * The band-limiting chain the analyser reads through.
   * @param {AudioContext} ctx
   * @returns {Array<BiquadFilterNode>}
   */
  createInputFilters(ctx) {
    const filters = [];
    for (let stage = 0; stage < INPUT_HIGHPASS_STAGES; stage++) {
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = INPUT_HIGHPASS_HZ;
      highpass.Q.value = 0.7;
      filters.push(highpass);
    }

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = Math.min(INPUT_LOWPASS_HZ, ctx.sampleRate * 0.2);
    lowpass.Q.value = 0.7;
    filters.push(lowpass);

    return filters;
  }

  /**
   * Decide whether a frame is loud enough to be a voice.
   *
   * The floor follows quiet immediately and loud only while the gate is shut,
   * so it settles on the room rather than creeping up to the singer. Opening
   * and closing at different levels stops a held note from chattering on and
   * off at the threshold.
   *
   * @param {number} rms level of the current frame
   * @returns {boolean} true while the gate is open
   */
  updateNoiseGate(rms) {
    if (rms < this.noiseFloorRms) {
      this.noiseFloorRms += (rms - this.noiseFloorRms) * 0.3;
    } else if (!this.isGateOpen) {
      this.noiseFloorRms += (rms - this.noiseFloorRms) * 0.05;
    }

    const openAt = Math.max(ABSOLUTE_GATE_RMS, this.noiseFloorRms * 3.2);
    const closeAt = Math.max(ABSOLUTE_GATE_RMS * 0.7, this.noiseFloorRms * 2);
    this.isGateOpen = this.isGateOpen ? rms > closeAt : rms > openAt;
    return this.isGateOpen;
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
    if (this.smoothedLogFrequency === null) {
      this.smoothedLogFrequency = medianLogFrequency;
    } else {
      // Follow a real move quickly and a wobble slowly. One fixed coefficient
      // has to choose between lagging behind a step between notes and making
      // vibrato look like unsteady pitch; the size of the move says which it is.
      const cents = Math.abs(medianLogFrequency - this.smoothedLogFrequency) * 1200 / Math.LN2;
      const weight = cents > 120 ? 0.7 : cents > 40 ? 0.45 : 0.25;
      this.smoothedLogFrequency +=
        (medianLogFrequency - this.smoothedLogFrequency) * weight;
    }
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
    for (const filter of this.inputFilters) {
      filter.disconnect();
    }
    this.inputFilters = [];
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
    // A frame the gate rejects is not analysed at all, which keeps room noise
    // out of the results and the cost of listening down while nobody sings.
    const estimate = this.updateNoiseGate(frameRms(this.buffer))
      ? analysePitchYin(this.buffer, this.audioContext.sampleRate)
      : null;
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
        // The estimate describes the whole analysis window, so it belongs at the
        // middle of it. Dating it from the end of the window pushed the trail
        // about half a window earlier in the score than the singer sang it.
        const windowCentreSeconds =
          this.analyser.fftSize / (2 * this.audioContext.sampleRate);
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
            this.captureLatencySeconds + windowCentreSeconds +
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
