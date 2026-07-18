/**
 * Web Audio API Playback Engine
 * Synthesizes notes for each part using oscillators with per-part volume control.
 * Uses lookahead scheduling for sample-accurate timing.
 */

import { noteToFrequency, pitchToFrequency, pitchToMidi } from './utils.js';

/**
 * Calculate the duration of a beat in seconds at a given tempo.
 * @param {number} bpm - beats per minute
 * @returns {number} seconds per beat
 */
export function beatDuration(bpm) {
  if (bpm <= 0) return 0;
  return 60 / bpm;
}

/**
 * Calculate the time offset for a note given its beat position and tempo.
 * @param {number} beatPosition - beat offset from start
 * @param {number} bpm - tempo in BPM
 * @returns {number} time in seconds
 */
export function beatToTime(beatPosition, bpm) {
  return beatPosition * beatDuration(bpm);
}

/** Default interpretation for an otherwise duration-less fermata mark. */
export const FERMATA_DURATION_MULTIPLIER = 2;

/**
 * Collect score-wide fermata holds. A fermata belongs to the whole ensemble,
 * so simultaneous marks collapse into one hold at the shared note/rest end.
 * @param {Array} parts
 * @param {number} multiplier
 * @returns {Array<{scoreBeat: number, extraBeats: number}>}
 */
export function collectFermataHolds(parts, multiplier = FERMATA_DURATION_MULTIPLIER) {
  const byBeat = new Map();
  const extension = Math.max(0, multiplier - 1);
  const addHold = (scoreBeat, extraBeats) => {
    const key = scoreBeat.toFixed(6);
    const existing = byBeat.get(key);
    if (!existing || extraBeats > existing.extraBeats) {
      byBeat.set(key, { scoreBeat, extraBeats });
    }
  };

  for (const part of parts || []) {
    for (const measure of part.measures || []) {
      const measureStart = Number(measure.startBeat) || 0;
      for (const note of measure.notes || []) {
        if (!note.fermata || !(note.durationBeats > 0)) continue;
        const scoreBeat = measureStart + (Number(note.startBeatInMeasure) || 0) + note.durationBeats;
        addHold(scoreBeat, note.durationBeats * extension);
      }

      // A barline fermata has no note duration. Hold it for one denominator
      // beat (one quarter in 4/4, one eighth in 6/8) by default.
      const denominator = Number(measure.timeSignature?.denominator) || 4;
      const boundaryHold = (4 / denominator) * extension;
      for (const fermata of measure.barlineFermatas || []) {
        const scoreBeat = fermata.location === 'left'
          ? measureStart
          : measureStart + (Number(measure.beats) || 0);
        addHold(scoreBeat, boundaryHold);
      }
    }
  }
  return Array.from(byBeat.values()).sort((a, b) => a.scoreBeat - b.scoreBeat);
}

/** Map a notated score beat to its position on the fermata-expanded timeline. */
export function scoreBeatToPlaybackBeat(scoreBeat, holds = []) {
  let playbackBeat = Math.max(0, Number(scoreBeat) || 0);
  for (const hold of holds) {
    if (hold.scoreBeat <= scoreBeat + 1e-6) playbackBeat += hold.extraBeats;
    else break;
  }
  return playbackBeat;
}

/** Map a fermata-expanded playback beat back to the score cursor position. */
export function playbackBeatToScoreBeat(playbackBeat, holds = []) {
  const target = Math.max(0, Number(playbackBeat) || 0);
  let accumulatedHold = 0;
  for (const hold of holds) {
    const holdStart = hold.scoreBeat + accumulatedHold;
    const holdEnd = holdStart + hold.extraBeats;
    if (target < holdStart) return target - accumulatedHold;
    if (target <= holdEnd) return hold.scoreBeat;
    accumulatedHold += hold.extraBeats;
  }
  return target - accumulatedHold;
}

/**
 * Per-part timbre definitions for additive synthesis.
 * Each voice gets a distinct blend of oscillator layers so parts remain
 * perceptually separable even when sounding simultaneously.
 *
 * Each layer: { type, gain, detuneCents }
 *   - type: OscillatorNode waveform
 *   - gain: relative amplitude of this layer (they are normalized internally)
 *   - detuneCents: pitch offset in cents for chorusing / warmth
 */
const PART_TIMBRES = {
  soprano: [
    { type: 'sine',     gain: 0.6,  detuneCents: 0 },
    { type: 'triangle', gain: 0.25, detuneCents: 3 },
    { type: 'sine',     gain: 0.15, detuneCents: -4 }
  ],
  alto: [
    { type: 'triangle', gain: 0.55, detuneCents: 0 },
    { type: 'sine',     gain: 0.3,  detuneCents: -3 },
    { type: 'triangle', gain: 0.15, detuneCents: 5 }
  ],
  tenor: [
    { type: 'triangle', gain: 0.5,  detuneCents: 0 },
    { type: 'sawtooth', gain: 0.15, detuneCents: 2 },
    { type: 'sine',     gain: 0.35, detuneCents: -5 }
  ],
  bass: [
    { type: 'triangle', gain: 0.5,  detuneCents: 0 },
    { type: 'sine',     gain: 0.35, detuneCents: -2 },
    { type: 'sawtooth', gain: 0.15, detuneCents: 4 }
  ],
  default: [
    { type: 'triangle', gain: 0.55, detuneCents: 0 },
    { type: 'sine',     gain: 0.3,  detuneCents: 3 },
    { type: 'sine',     gain: 0.15, detuneCents: -4 }
  ]
};

/**
 * Per-part stereo panning values. Spreading voices across the stereo field
 * gives the ear spatial cues that separate overlapping frequencies.
 */
const PART_PAN = {
  soprano: 0.3,
  alto: -0.25,
  tenor: 0.15,
  bass: -0.15,
  default: 0
};

/**
 * Per-part EQ settings. Each voice gets a low-shelf and high-shelf filter
 * to carve out its own spectral lane and reduce masking.
 *   lowShelf:  { frequency, gain } — boost/cut below this frequency
 *   highShelf: { frequency, gain } — boost/cut above this frequency
 */
const PART_EQ = {
  soprano: {
    lowShelf:  { frequency: 400, gain: -3 },
    highShelf: { frequency: 2000, gain: 2 }
  },
  alto: {
    lowShelf:  { frequency: 300, gain: -2 },
    highShelf: { frequency: 1800, gain: -1 }
  },
  tenor: {
    lowShelf:  { frequency: 200, gain: 1 },
    highShelf: { frequency: 2500, gain: -3 }
  },
  bass: {
    lowShelf:  { frequency: 150, gain: 3 },
    highShelf: { frequency: 800, gain: -4 }
  },
  default: {
    lowShelf:  { frequency: 250, gain: 0 },
    highShelf: { frequency: 2000, gain: 0 }
  }
};

/**
 * Vocal formant data for formant synthesis mode. Each voice type gets a set
 * of 5 formant frequencies (F1–F5) with bandwidth and relative gain, modeled
 * on an open "ah" vowel which is the most resonant and natural for singing.
 *
 * Values are approximate averages from vocal acoustics literature,
 * tuned by ear for pleasant Web Audio output.
 *
 * Each entry: { freq: Hz, bw: bandwidth Hz, gain: linear amplitude }
 */
const VOCAL_FORMANTS = {
  soprano: [
    { freq: 800,  bw: 80,  gain: 1.0 },
    { freq: 1150, bw: 90,  gain: 0.63 },
    { freq: 2800, bw: 120, gain: 0.32 },
    { freq: 3500, bw: 130, gain: 0.20 },
    { freq: 4950, bw: 140, gain: 0.10 }
  ],
  alto: [
    { freq: 700,  bw: 80,  gain: 1.0 },
    { freq: 1100, bw: 90,  gain: 0.50 },
    { freq: 2600, bw: 120, gain: 0.28 },
    { freq: 3300, bw: 130, gain: 0.16 },
    { freq: 4700, bw: 140, gain: 0.08 }
  ],
  tenor: [
    { freq: 650,  bw: 70,  gain: 1.0 },
    { freq: 1080, bw: 80,  gain: 0.50 },
    { freq: 2650, bw: 120, gain: 0.35 },
    { freq: 3200, bw: 130, gain: 0.18 },
    { freq: 4600, bw: 140, gain: 0.08 }
  ],
  bass: [
    { freq: 600,  bw: 60,  gain: 1.0 },
    { freq: 1000, bw: 70,  gain: 0.45 },
    { freq: 2400, bw: 110, gain: 0.25 },
    { freq: 3000, bw: 120, gain: 0.14 },
    { freq: 4500, bw: 140, gain: 0.06 }
  ],
  default: [
    { freq: 700,  bw: 75,  gain: 1.0 },
    { freq: 1100, bw: 85,  gain: 0.50 },
    { freq: 2600, bw: 115, gain: 0.30 },
    { freq: 3200, bw: 125, gain: 0.17 },
    { freq: 4700, bw: 140, gain: 0.08 }
  ]
};

/**
 * Resolve the voice type key for a given part.
 * @returns {string} one of 'soprano', 'alto', 'tenor', 'bass', 'default'
 */
function resolveVoiceKey(partId, parts) {
  const part = parts.find(p => p.id === partId);
  if (part && part.voiceType) {
    const vt = part.voiceType.toLowerCase();
    if (vt.includes('soprano')) return 'soprano';
    if (vt.includes('alto') || vt.includes('contralto') || vt.includes('mezzo')) return 'alto';
    if (vt.includes('tenor')) return 'tenor';
    if (vt.includes('bass') || vt.includes('baritone')) return 'bass';
  }
  return 'default';
}

/**
 * Resolve the timbre layers to use for a given partId.
 * Falls back to 'default' if the voice type is unrecognized.
 */
function getTimbreForPart(partId, parts) {
  return PART_TIMBRES[resolveVoiceKey(partId, parts)];
}

/** Return whether a parsed part should always use the piano synthesizer. */
function isPianoPart(partId, parts) {
  return parts.find(part => part.id === partId)?.isPiano === true;
}

/**
 * AudioEngine class - manages Web Audio API playback.
 */
export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.partGains = new Map(); // partId -> GainNode
    this.partVolumeLevels = new Map(); // partId -> intended volume (0-1)
    this.partMuted = new Map(); // partId -> boolean
    this.partSoloed = new Map(); // partId -> boolean
    this.parts = [];
    this.tempo = 120;
    this.isPlaying = false;
    this.isPaused = false;
    this.startTime = 0;
    this.pauseTime = 0;
    this.pausePlaybackBeat = 0;
    this.currentBeat = 0;
    this.trackingFloorPlaybackBeat = 0;
    this.scheduledNodes = [];
    this.lookaheadTime = 0.1; // seconds to look ahead
    this.scheduleInterval = 25; // ms between scheduling checks
    this.startLead = 0.08; // seconds of lead time before the first note plays
    this.schedulerTimer = null;
    this.nextScheduledBeat = 0; // next beat index to schedule in lookahead
    this.onBeatUpdate = null; // callback(currentBeat)
    this.onPlaybackEnd = null; // callback when playback reaches the end naturally
    this.animationFrame = null;
    this.schedule = []; // cached note schedule
    this.scheduleIndex = 0; // current position in schedule for lookahead
    this.preservedEventIndices = new Set(); // active voices retained across tempo changes
    this.vocalPhraseNodes = new Map(); // vocal phrase key -> continuous voice node
    this.fermataMultiplier = FERMATA_DURATION_MULTIPLIER; // user-adjustable
    this.fermataHolds = []; // score-wide pauses on the expanded playback timeline
    this.synthMode = 'vocal'; // 'oscillator' or 'vocal' (default)
  }

  /**
   * Initialize the AudioContext (must be called after user interaction).
   * Signal chain: partGains → masterGain → compressor → limiter → destination
   */
  async init() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Master gain — overall volume control
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.7;

      // Dynamics compressor — tames transient peaks on dense chords
      this.compressor = this.audioContext.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 8;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.12;

      // Soft-clip limiter — guarantees output never exceeds ±1.0
      this.limiter = this.audioContext.createWaveShaper();
      this.limiter.curve = this.buildSoftClipCurve();
      this.limiter.oversample = '4x';

      // Wire the master bus: masterGain → compressor → limiter → destination
      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.limiter);
      this.limiter.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  /**
   * Build a soft-clip transfer curve for the WaveShaperNode limiter.
   * Uses a tanh-style curve that passes quiet signals linearly but gently
   * saturates peaks approaching ±1.0.
   * @returns {Float32Array}
   */
  buildSoftClipCurve() {
    const samples = 8192;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1; // map [0, samples) → [-1, 1)
      // tanh soft-clip with a slight drive (1.5×) to engage limiting earlier
      curve[i] = Math.tanh(1.5 * x);
    }
    return curve;
  }

  /**
   * Set the fermata duration multiplier and recalculate holds.
   * @param {number} multiplier - e.g. 1.5 means 50% longer, 2 means double
   */
  setFermataMultiplier(multiplier) {
    this.fermataMultiplier = Math.max(1, multiplier);
    this.fermataHolds = collectFermataHolds(this.parts, this.fermataMultiplier);
  }

  /**
   * Set the parts data and create gain/EQ/panner nodes for each part.
   * Per-part signal chain: partGain → lowShelf → highShelf → panner → masterGain
   * @param {Array} parts - parsed parts from MusicXML parser
   */
  setParts(parts) {
    this.parts = parts;
    this.fermataHolds = collectFermataHolds(parts, this.fermataMultiplier);
    // Create gain, EQ, and panner nodes for each part
    for (const part of parts) {
      if (!this.partGains.has(part.id)) {
        const voiceKey = resolveVoiceKey(part.id, parts);
        const eqSettings = PART_EQ[voiceKey];
        const panValue = PART_PAN[voiceKey];

        // Per-part gain
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = 0.8;

        // Low-shelf EQ
        const lowShelf = this.audioContext.createBiquadFilter();
        lowShelf.type = 'lowshelf';
        lowShelf.frequency.value = eqSettings.lowShelf.frequency;
        lowShelf.gain.value = eqSettings.lowShelf.gain;

        // High-shelf EQ
        const highShelf = this.audioContext.createBiquadFilter();
        highShelf.type = 'highshelf';
        highShelf.frequency.value = eqSettings.highShelf.frequency;
        highShelf.gain.value = eqSettings.highShelf.gain;

        // Stereo panner
        const panner = this.audioContext.createStereoPanner();
        panner.pan.value = panValue;

        // Wire: gainNode → lowShelf → highShelf → panner → masterGain
        gainNode.connect(lowShelf);
        lowShelf.connect(highShelf);
        highShelf.connect(panner);
        panner.connect(this.masterGain);

        this.partGains.set(part.id, gainNode);
        this.partVolumeLevels.set(part.id, 0.8);
        this.partMuted.set(part.id, false);
        this.partSoloed.set(part.id, false);
      }
    }
  }

  /**
   * Set volume for a specific part.
   * @param {string} partId
   * @param {number} volume - 0 to 100
   */
  setPartVolume(partId, volume) {
    const gainNode = this.partGains.get(partId);
    if (gainNode) {
      const normalizedVolume = Math.max(0, Math.min(1, volume / 100));
      this.partVolumeLevels.set(partId, normalizedVolume);
      // Only apply if the part is currently audible
      const isMuted = this.partMuted.get(partId);
      const anySoloed = Array.from(this.partSoloed.values()).some(v => v);
      const isSoloed = this.partSoloed.get(partId);
      const isAudible = !isMuted && (!anySoloed || isSoloed);
      if (isAudible) {
        gainNode.gain.setValueAtTime(normalizedVolume, this.audioContext.currentTime);
      }
    }
  }

  /**
   * Mute/unmute a specific part.
   * @param {string} partId
   * @param {boolean} muted
   */
  setPartMuted(partId, muted) {
    this.partMuted.set(partId, muted);
    this.updatePartAudibility();
  }

  /**
   * Solo/unsolo a specific part.
   * @param {string} partId
   * @param {boolean} soloed
   */
  setPartSoloed(partId, soloed) {
    this.partSoloed.set(partId, soloed);
    this.updatePartAudibility();
  }

  /**
   * Update audibility of all parts based on mute/solo state.
   */
  updatePartAudibility() {
    const anySoloed = Array.from(this.partSoloed.values()).some(v => v);

    for (const [partId, gainNode] of this.partGains) {
      const isMuted = this.partMuted.get(partId);
      const isSoloed = this.partSoloed.get(partId);

      if (isMuted) {
        gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      } else if (anySoloed && !isSoloed) {
        gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      } else {
        // Restore to intended volume stored in partVolumeLevels
        const intendedVolume = this.partVolumeLevels.has(partId) ? this.partVolumeLevels.get(partId) : 0.8;
        gainNode.gain.setValueAtTime(intendedVolume, this.audioContext.currentTime);
      }
    }
  }

  /**
   * Set the playback tempo.
   * If playing, adjusts the start time reference so the current beat position
   * is maintained and future notes are scheduled at the new tempo.
   * @param {number} bpm
   */
  setTempo(bpm) {
    const newTempo = Math.max(40, Math.min(240, bpm));
    if (newTempo === this.tempo) return;
    if (this.isPlaying && this.audioContext) {
      // Re-anchor the transport at one exact AudioContext timestamp so the
      // current playback beat remains continuous across the tempo change.
      const now = this.audioContext.currentTime;
      const elapsed = now - this.startTime;
      const currentPlaybackBeat = elapsed / beatDuration(this.tempo);
      this.currentBeat = playbackBeatToScoreBeat(
        Math.max(0, currentPlaybackBeat),
        this.fermataHolds
      );
      this.startTime = now - beatToTime(currentPlaybackBeat, newTempo);

      // Keep oscillators that are already sounding. Re-time their remaining
      // envelope instead of restarting them, preserving oscillator phase and
      // eliminating the audible re-attack. Only silent lookahead nodes are
      // cancelled and recreated on the new transport timeline.
      const retainedNodes = [];
      const retainedEventIndices = new Set();
      for (const node of this.scheduledNodes) {
        const isActive = node.startTime <= now && node.endTime > now;
        if (isActive) {
          // Piano partials model a physical string decay in seconds. Keep that
          // decay untouched across tempo changes; retiming its independently
          // scheduled partial envelopes causes gain jumps and hollow tails.
          if (!node.isPiano && node.playbackEndBeat > currentPlaybackBeat + 1e-6) {
            this.retimeActiveNode(node, now, currentPlaybackBeat, newTempo);
          }
          retainedNodes.push(node);
          if (node.eventIndices instanceof Set) {
            for (const eventIndex of node.eventIndices) {
              retainedEventIndices.add(eventIndex);
            }
          } else if (Number.isInteger(node.eventIndex)) {
            retainedEventIndices.add(node.eventIndex);
          }
        } else {
          this.fadeOutNode(node, now);
        }
      }
      this.scheduledNodes = retainedNodes;
      this.preservedEventIndices = retainedEventIndices;

      // Resume scheduling at the first unpreserved event that has not ended.
      // This includes a sustained note whose resume oscillator was still in its
      // short start lead and therefore had to be cancelled above.
      this.scheduleIndex = this.schedule.length;
      for (let i = 0; i < this.schedule.length; i++) {
        const event = this.schedule[i];
        const eventBeat = event.playbackStartBeat ?? event.startBeat;
        const eventDuration = event.playbackDurationBeats ?? event.durationBeats;
        if (eventBeat + eventDuration > currentPlaybackBeat + 1e-6 &&
            !retainedEventIndices.has(i)) {
          this.scheduleIndex = i;
          break;
        }
      }

      this.tempo = newTempo;
      this.scheduleAhead();
    } else {
      this.tempo = newTempo;
    }
  }

  /**
   * Build a schedule of all notes with their start times and durations.
   * @returns {Array} array of { partId, frequency, startBeat, durationBeats }
   */
  buildSchedule() {
    const schedule = [];
    this.fermataHolds = collectFermataHolds(this.parts, this.fermataMultiplier);

    for (const part of this.parts) {
      const activeSlurs = new Set();
      for (const measure of part.measures) {
        const measureStart = measure.startBeat || 0;
        for (const note of measure.notes) {
          const slurs = note.slurs || [];
          const starts = slurs.filter(slur => slur.type === 'start' || slur.type === 'continue');
          const stops = slurs.filter(slur => slur.type === 'stop' || slur.type === 'continue');
          for (const slur of starts) activeSlurs.add(Number(slur.number) || 1);
          const noteSlurIds = new Set(activeSlurs);
          for (const slur of stops) noteSlurIds.add(Number(slur.number) || 1);
          const slursAfter = new Set(activeSlurs);
          for (const slur of slurs.filter(item => item.type === 'stop')) {
            slursAfter.delete(Number(slur.number) || 1);
          }
          const legato = noteSlurIds.size > 0;

          // Rests and pitchless notes make no sound. Chord notes ARE played -
          // they share an onset with the preceding note (same startBeatInMeasure).
          if (!note.isRest && note.pitch && note.durationBeats > 0) {
            // Compute the frequency directly from step + alter + octave. This is
            // robust to accidentals like E#, B# and double sharps/flats.
            let frequency;
            let midi;
            try {
              const p = note.pitch;
              if (p.step !== undefined) {
                midi = pitchToMidi(p.step, p.alter || 0, p.octave);
                frequency = pitchToFrequency(p.step, p.alter || 0, p.octave);
              } else {
                frequency = noteToFrequency(p.noteName, p.octave);
              }
            } catch (err) {
              console.warn('Skipping note with unresolved pitch:', note.pitch, err.message);
              frequency = null;
            }
            if (frequency && frequency > 0) {
              schedule.push({
                partId: part.id,
                frequency,
                midi: midi != null ? midi : Math.round(frequency),
                startBeat: measureStart + (note.startBeatInMeasure || 0),
                durationBeats: note.durationBeats,
                voice: note.voice ?? null,
                tieStart: !!(note.tie && note.tie.start),
                tieStop: !!(note.tie && note.tie.stop),
                staccato: !!note.staccato,
                legato,
                legatoStart: starts.length > 0,
                legatoStop: stops.length > 0,
                slurIds: Array.from(noteSlurIds),
                slursAfter: Array.from(slursAfter),
                fermata: note.fermata || null
              });
            }
          }

          // A continue marker closes one drawn segment and opens the next, so
          // it remains active. A true stop removes only that phrase identity.
          activeSlurs.clear();
          for (const slurNumber of slursAfter) activeSlurs.add(slurNumber);
        }
      }
    }

    const merged = this.mergeTiedNotes(schedule);
    for (const event of merged) {
      const playbackStart = scoreBeatToPlaybackBeat(event.startBeat, this.fermataHolds);
      const playbackEnd = scoreBeatToPlaybackBeat(
        event.startBeat + event.durationBeats,
        this.fermataHolds
      );
      event.playbackStartBeat = playbackStart;
      event.playbackDurationBeats = Math.max(0, playbackEnd - playbackStart);
    }

    // Mark contiguous notes within a slur. The scheduler uses this to overlap
    // their envelopes slightly, avoiding a separate attack/gap on every note.
    const byPart = new Map();
    for (const event of merged) {
      if (!byPart.has(event.partId)) byPart.set(event.partId, []);
      byPart.get(event.partId).push(event);
    }
    for (const events of byPart.values()) {
      events.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
      const byStart = new Map();
      for (const event of events) {
        const key = event.startBeat.toFixed(6);
        if (!byStart.has(key)) byStart.set(key, []);
        const onsetEvents = byStart.get(key);
        event.onsetRank = onsetEvents.length;
        onsetEvents.push(event);
        event.legatoToNext = false;
        event.legatoFromPrevious = false;
        event.legatoNextEvent = null;
        event.legatoPreviousEvent = null;
        event.vocalConnectToNext = false;
        event.vocalConnectFromPrevious = false;
        event.vocalNextEvent = null;
        event.vocalPreviousEvent = null;
      }

      // Resolve slur edges explicitly. A flat event list interleaves chord
      // tones, so adjacent array entries are not necessarily melodic neighbors.
      for (const event of events) {
        if (!event.legato || !event.slursAfter?.length) continue;
        const endKey = (event.startBeat + event.durationBeats).toFixed(6);
        const candidates = (byStart.get(endKey) || []).filter(next =>
          next.legato && event.slursAfter.some(id => next.slurIds?.includes(id))
        );
        if (!candidates.length) continue;

        // Pair chord tones by voice and onset rank where possible. If the
        // notation omits voice data, nearest MIDI pitch is the safest fallback.
        const sameVoice = candidates.filter(next => next.voice === event.voice);
        const rankedCandidates = sameVoice.length ? sameVoice : candidates;
        const ranked = rankedCandidates.find(next => next.onsetRank === event.onsetRank);
        const next = ranked || rankedCandidates.reduce((best, candidate) =>
          Math.abs(candidate.midi - event.midi) < Math.abs(best.midi - event.midi)
            ? candidate
            : best
        );
        if (next.legatoPreviousEvent) continue;
        event.legatoToNext = true;
        event.legatoNextEvent = next;
        next.legatoFromPrevious = true;
        next.legatoPreviousEvent = event;
      }

      // A singer does not restart their glottal source at every ordinary note.
      // Connect contiguous notes into a vocal phrase unless either endpoint is
      // marked staccato. Slurs still control the synthesized envelope, while
      // this connection controls continuous vocal-source pitch transitions.
      for (const event of events) {
        if (event.staccato) continue;
        const endKey = (event.startBeat + event.durationBeats).toFixed(6);
        const candidates = (byStart.get(endKey) || []).filter(next => !next.staccato);
        if (!candidates.length) continue;

        const sameVoice = candidates.filter(next => next.voice === event.voice);
        // Do not bridge distinct explicitly-numbered voices. When a score has
        // no voice numbers, retain the nearest-pitch fallback for chord tones.
        if (event.voice != null && !sameVoice.length) continue;
        const rankedCandidates = sameVoice.length ? sameVoice : candidates;
        const ranked = rankedCandidates.find(next => next.onsetRank === event.onsetRank);
        const next = ranked || rankedCandidates.reduce((best, candidate) =>
          Math.abs(candidate.midi - event.midi) < Math.abs(best.midi - event.midi)
            ? candidate
            : best
        );
        if (next.vocalPreviousEvent) continue;
        event.vocalConnectToNext = true;
        event.vocalNextEvent = next;
        next.vocalConnectFromPrevious = true;
        next.vocalPreviousEvent = event;
      }
    }

    // A vocal phrase keeps one continuous glottal source across every
    // contiguous non-staccato note. Store phrase bounds so the scheduler can
    // pitch-glide instead of restarting the singer at each normal transition.
    for (const events of byPart.values()) {
      const visited = new Set();
      let phraseCounter = 0;
      for (const first of events) {
        if (visited.has(first)) continue;

        const phraseEvents = [];
        let current = first;
        while (current && !visited.has(current)) {
          phraseEvents.push(current);
          visited.add(current);
          const next = current.vocalNextEvent;
          if (!next || next.startBeat <= current.startBeat) break;
          current = next;
        }

        const phraseStartBeat = first.startBeat;
        const phraseEndBeat = phraseEvents[phraseEvents.length - 1].startBeat +
          phraseEvents[phraseEvents.length - 1].durationBeats;
        const phraseId = `${first.partId}:${phraseStartBeat.toFixed(6)}:${phraseCounter++}`;
        const phraseStartPlaybackBeat = scoreBeatToPlaybackBeat(
          phraseStartBeat,
          this.fermataHolds
        );
        const phraseEndPlaybackBeat = scoreBeatToPlaybackBeat(
          phraseEndBeat,
          this.fermataHolds
        );
        for (const event of phraseEvents) {
          event.vocalPhraseId = phraseId;
          event.vocalPhraseStartPlaybackBeat = phraseStartPlaybackBeat;
          event.vocalPhraseEndPlaybackBeat = phraseEndPlaybackBeat;
        }
      }
    }

    return merged;
  }



  /**
   * Merge tied notes so a note tied across beats/barlines sustains as a single
   * tone instead of being re-articulated. Operates per part on the flat schedule.
   * @param {Array} schedule
   * @returns {Array}
   */
  mergeTiedNotes(schedule) {
    const byPart = new Map();
    for (const e of schedule) {
      if (!byPart.has(e.partId)) byPart.set(e.partId, []);
      byPart.get(e.partId).push(e);
    }

    const out = [];
    for (const events of byPart.values()) {
      events.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
      const consumed = new Set();
      for (let i = 0; i < events.length; i++) {
        if (consumed.has(i)) continue;
        const e = events[i];
        out.push(e);
        if (!e.tieStart) continue;

        // Absorb subsequent contiguous same-pitch tie-stops, chaining while the
        // absorbed note itself starts another tie.
        let endBeat = e.startBeat + e.durationBeats;
        let openTie = true;
        for (let j = i + 1; j < events.length && openTie; j++) {
          if (consumed.has(j)) continue;
          const n = events[j];
          if (n.midi === e.midi && n.tieStop && Math.abs(n.startBeat - endBeat) < 1e-3) {
            e.durationBeats += n.durationBeats;
            endBeat += n.durationBeats;
            consumed.add(j);
            openTie = n.tieStart;
            if (n.fermata) e.fermata = n.fermata;
            e.legato = e.legato || n.legato;
            e.legatoStop = n.legatoStop;
            e.slurIds = Array.from(new Set([...(e.slurIds || []), ...(n.slurIds || [])]));
            e.slursAfter = [...(n.slursAfter || [])];
            e.tieStart = n.tieStart;
          }
        }
      }
    }
    return out;
  }

  /**
   * Get total beats across all parts (based on absolute measure positions).
   * @returns {number}
   */
  getTotalBeats() {
    let maxBeats = 0;
    for (const part of this.parts) {
      for (const measure of part.measures) {
        const end = (measure.startBeat || 0) + (measure.beats || 0);
        if (end > maxBeats) maxBeats = end;
      }
    }
    return maxBeats;
  }

  /** Return a score position on the fermata-expanded playback timeline. */
  getPlaybackBeat(scoreBeat) {
    if (this.fermataHolds.length === 0) {
      this.fermataHolds = collectFermataHolds(this.parts);
    }
    return scoreBeatToPlaybackBeat(scoreBeat, this.fermataHolds);
  }

  /** Return the score cursor position for an expanded playback beat. */
  getScoreBeat(playbackBeat) {
    return playbackBeatToScoreBeat(playbackBeat, this.fermataHolds);
  }

  /** Total length including time held at fermatas. */
  getTotalPlaybackBeats() {
    return this.getPlaybackBeat(this.getTotalBeats());
  }

  /**
   * Move the transport to a score beat and keep paused/resume coordinates in
   * sync. Callers may use this while stopped or paused.
   * @param {number} scoreBeat
   * @returns {number} clamped score beat
   */
  seek(scoreBeat) {
    const totalBeats = this.getTotalBeats();
    this.currentBeat = Math.max(0, Math.min(totalBeats, Number(scoreBeat) || 0));
    this.pausePlaybackBeat = this.getPlaybackBeat(this.currentBeat);
    this.pauseTime = beatToTime(this.pausePlaybackBeat, this.tempo);
    return this.currentBeat;
  }

  /**
   * Start or resume playback.
   */
  play() {
    if (!this.audioContext) return;

    // Build the expanded timeline before calculating the transport reference.
    this.schedule = this.buildSchedule();
    this.schedule.sort((a, b) =>
      (a.playbackStartBeat ?? a.startBeat) - (b.playbackStartBeat ?? b.startBeat)
    );

    let currentPlaybackBeat;
    if (this.isPaused) {
      currentPlaybackBeat = this.pausePlaybackBeat;
      this.pauseTime = beatToTime(currentPlaybackBeat, this.tempo);
      this.startTime = this.audioContext.currentTime - this.pauseTime;
      this.isPaused = false;
    } else {
      currentPlaybackBeat = this.getPlaybackBeat(this.currentBeat);
      // Add a small lead so the first note lands in the future instead of being
      // dropped by the lookahead scheduler's "already passed" check.
      this.startTime = this.audioContext.currentTime + this.startLead -
                       beatToTime(currentPlaybackBeat, this.tempo);
    }

    // The latency-compensated visual clock can be briefly behind the selected
    // score position immediately after a seek. Never let the first frames move
    // the cursor backward from the requested note/bar onset.
    this.trackingFloorPlaybackBeat = currentPlaybackBeat;
    this.isPlaying = true;
    this.preservedEventIndices.clear();
    this.scheduleIndex = 0;
    for (let i = 0; i < this.schedule.length; i++) {
      const eventBeat = this.schedule[i].playbackStartBeat ?? this.schedule[i].startBeat;
      const eventDuration = this.schedule[i].playbackDurationBeats ?? this.schedule[i].durationBeats;
      if (eventBeat + eventDuration > currentPlaybackBeat + 1e-6) {
        this.scheduleIndex = i;
        break;
      }
      if (i === this.schedule.length - 1) {
        this.scheduleIndex = this.schedule.length;
      }
    }

    this.startLookaheadScheduler();
    this.startBeatTracking();
  }

  /**
   * Start the lookahead scheduler that schedules notes within a short window.
   */
  startLookaheadScheduler() {
    this.stopLookaheadScheduler();
    this.schedulerTimer = setInterval(() => {
      if (!this.isPlaying) return;
      this.scheduleAhead();
      this.cleanupEndedNodes();
    }, this.scheduleInterval);
  }

  /**
   * Stop the lookahead scheduler.
   */
  stopLookaheadScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /**
   * Schedule notes that fall within the lookahead window.
   */
  scheduleAhead() {
    const currentTime = this.audioContext.currentTime;
    const scheduleUntilTime = currentTime + this.lookaheadTime;

    while (this.scheduleIndex < this.schedule.length) {
      const eventIndex = this.scheduleIndex;
      if (this.preservedEventIndices.has(eventIndex)) {
        this.scheduleIndex++;
        continue;
      }

      const event = this.schedule[eventIndex];
      const playbackStartBeat = event.playbackStartBeat ?? event.startBeat;
      const noteStartTime = this.startTime + beatToTime(playbackStartBeat, this.tempo);

      if (noteStartTime > scheduleUntilTime) {
        break; // This note is beyond our lookahead window
      }

      const playbackDuration = event.playbackDurationBeats ?? event.durationBeats;
      const baseDuration = beatToTime(playbackDuration, this.tempo);
      const overlap = event.legatoToNext ? Math.min(0.045, baseDuration * 0.12) : 0;
      const articulation = {
        legato: event.legato,
        legatoFromPrevious: event.legatoFromPrevious,
        legatoToNext: event.legatoToNext,
        fermata: !!event.fermata
      };
      const timing = {
        eventIndex,
        playbackStartBeat,
        playbackEndBeat: playbackStartBeat + playbackDuration,
        playbackDurationBeats: playbackDuration,
        legatoToNext: !!event.legatoToNext,
        vocalPhraseId: event.vocalPhraseId,
        vocalPhraseStartPlaybackBeat: event.vocalPhraseStartPlaybackBeat,
        vocalPhraseEndPlaybackBeat: event.vocalPhraseEndPlaybackBeat
      };

      if (noteStartTime >= currentTime - 0.01) {
        this.dispatchNote(
          event.partId,
          event.frequency,
          noteStartTime,
          baseDuration + overlap,
          articulation,
          timing
        );
      } else {
        // Resume a note that was sounding at the pause/seek point, including a
        // note sustained through a fermata hold.
        const originalEndTime = noteStartTime + baseDuration + overlap;
        if (originalEndTime > currentTime + 0.01) {
          const resumedStart = currentTime + 0.005;
          this.dispatchNote(
            event.partId,
            event.frequency,
            resumedStart,
            originalEndTime - currentTime,
            { ...articulation, legatoFromPrevious: true },
            timing
          );
        }
      }

      this.scheduleIndex++;
    }
  }

  /**
   * Clean up nodes that have finished playing.
   */
  cleanupEndedNodes() {
    const currentTime = this.audioContext.currentTime;
    this.scheduledNodes = this.scheduledNodes.filter(node => {
      if (node.endTime && currentTime > node.endTime + 0.1) {
        // Node has ended, it should already be disconnected via onended
        return false;
      }
      return true;
    });
  }

  /**
   * Pause playback.
   */
  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.isPaused = true;
    this.pauseTime = this.audioContext.currentTime - this.startTime;
    this.pausePlaybackBeat = Math.max(0, this.pauseTime / beatDuration(this.tempo));
    this.stopAllNodes();
    this.stopLookaheadScheduler();
    this.stopBeatTracking();
  }

  /**
   * Stop playback and reset to beginning.
   */
  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this.currentBeat = 0;
    this.trackingFloorPlaybackBeat = 0;
    this.pauseTime = 0;
    this.pausePlaybackBeat = 0;
    this.stopAllNodes();
    this.stopLookaheadScheduler();
    this.stopBeatTracking();
    if (this.onBeatUpdate) {
      this.onBeatUpdate(0);
    }
  }

  /**
   * Stop playback and reset all score-specific transport and part state while
   * keeping the shared AudioContext and user synthesis preferences alive.
   */
  resetForNewScore() {
    this.stop();

    for (const gainNode of this.partGains.values()) {
      try {
        gainNode.disconnect();
      } catch (e) { /* already disconnected */ }
    }
    this.partGains.clear();
    this.partVolumeLevels.clear();
    this.partMuted.clear();
    this.partSoloed.clear();
    this.parts = [];
    this.schedule = [];
    this.scheduleIndex = 0;
    this.fermataHolds = [];
  }

  /**
   * Schedule all notes from the current position (legacy fallback, not used by lookahead).
   */
  scheduleAllNotes() {
    this.stopAllNodes();
    const schedule = this.buildSchedule();
    const currentTime = this.audioContext.currentTime;
    const playbackStartBeat = this.getPlaybackBeat(this.currentBeat);

    for (const event of schedule) {
      if (event.startBeat < this.currentBeat) continue;

      const eventPlaybackBeat = event.playbackStartBeat ?? event.startBeat;
      const beatDelta = eventPlaybackBeat - playbackStartBeat;
      const noteStartTime = currentTime + beatToTime(beatDelta, this.tempo);
      const playbackDuration = event.playbackDurationBeats ?? event.durationBeats;
      const baseDuration = beatToTime(playbackDuration, this.tempo);
      const overlap = event.legatoToNext ? Math.min(0.045, baseDuration * 0.12) : 0;

      this.dispatchNote(event.partId, event.frequency, noteStartTime, baseDuration + overlap, {
        legato: event.legato,
        legatoFromPrevious: event.legatoFromPrevious,
        legatoToNext: event.legatoToNext,
        fermata: !!event.fermata
      }, {
        playbackStartBeat: eventPlaybackBeat,
        playbackEndBeat: eventPlaybackBeat + playbackDuration,
        playbackDurationBeats: playbackDuration,
        legatoToNext: !!event.legatoToNext,
        vocalPhraseId: event.vocalPhraseId,
        vocalPhraseStartPlaybackBeat: event.vocalPhraseStartPlaybackBeat,
        vocalPhraseEndPlaybackBeat: event.vocalPhraseEndPlaybackBeat
      });
    }
  }

  /**
   * Dispatch a note to the appropriate synthesis method based on synthMode.
   */
  dispatchNote(partId, frequency, startTime, duration, articulation, timing) {
    if (isPianoPart(partId, this.parts)) {
      this.schedulePianoNote(partId, frequency, startTime, duration, articulation, timing);
    } else if (this.synthMode === 'vocal') {
      this.scheduleVocalNote(partId, frequency, startTime, duration, articulation, timing);
    } else {
      this.scheduleNote(partId, frequency, startTime, duration, articulation, timing);
    }
  }

  /**
   * Schedule a single note using additive synthesis (multiple oscillators).
   * Each note is rendered with 2-3 slightly detuned oscillators whose waveform
   * mix depends on the voice part, giving each section a distinct timbre and
   * reducing phase-interference artifacts when chords sound simultaneously.
   *
   * @param {string} partId
   * @param {number} frequency
   * @param {number} startTime - AudioContext time
   * @param {number} duration - seconds
   * @param {object} articulation - legato/fermata envelope hints
   * @param {object} timing - source event timing on the playback timeline
   */
  scheduleNote(partId, frequency, startTime, duration, articulation = {}, timing = {}) {
    const gainNode = this.partGains.get(partId);
    if (!gainNode) return;

    const noteGain = this.audioContext.createGain();
    const stopGain = this.audioContext.createGain();
    const safeDuration = Math.max(0.025, duration);
    const peakGain = 0.25;

    // Resolve the timbre layers for this part
    const layers = getTimbreForPart(partId, this.parts);
    const totalLayerGain = layers.reduce((sum, l) => sum + l.gain, 0);

    // Create one oscillator per layer, all sharing the same envelope nodes
    const oscillators = [];
    for (const layer of layers) {
      const osc = this.audioContext.createOscillator();
      const layerGain = this.audioContext.createGain();
      // Normalize layer gains so they sum to 1.0
      layerGain.gain.value = layer.gain / totalLayerGain;
      osc.type = layer.type;
      osc.frequency.setValueAtTime(frequency, startTime);
      if (layer.detuneCents !== 0) {
        osc.detune.setValueAtTime(layer.detuneCents, startTime);
      }
      osc.connect(layerGain);
      layerGain.connect(noteGain);
      oscillators.push({ osc, layerGain });
    }

    // Slurred notes use a faster attack and overlap the next note slightly.
    // Clamp every stage for very short tuplets so automation times stay ordered.
    const requestedAttack = articulation.legatoFromPrevious
      ? 0.006
      : articulation.legato ? 0.012 : 0.02;
    const requestedRelease = articulation.fermata
      ? 0.08
      : articulation.legatoToNext ? 0.025 : 0.05;
    const attack = Math.min(requestedAttack, safeDuration * 0.25);
    const release = Math.min(requestedRelease, safeDuration * 0.35);
    const releaseStart = Math.max(startTime + attack, startTime + safeDuration - release);

    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    noteGain.gain.setValueAtTime(peakGain, releaseStart);
    noteGain.gain.linearRampToValueAtTime(0, startTime + safeDuration);
    stopGain.gain.value = 1;

    // Keep forced-stop fades separate from the musical envelope.
    noteGain.connect(stopGain);
    stopGain.connect(gainNode);

    const noteEndTime = startTime + safeDuration;
    for (const { osc } of oscillators) {
      osc.start(startTime);
      osc.stop(noteEndTime + 0.01);
    }

    const endTime = noteEndTime + 0.01;
    const nodeEntry = {
      oscillator: oscillators[0].osc, // primary oscillator for retimeActiveNode
      oscillators,                     // all layers for stop/disconnect
      noteGain,
      stopGain,
      startTime,
      endTime,
      eventIndex: timing.eventIndex,
      playbackEndBeat: timing.playbackEndBeat,
      playbackDurationBeats: timing.playbackDurationBeats,
      legatoToNext: !!timing.legatoToNext,
      requestedRelease,
      peakGain,
      envelopeStartTime: startTime,
      envelopeStartGain: 0,
      attackEndTime: startTime + attack,
      sustainGain: peakGain,
      releaseStartTime: releaseStart,
      noteEndTime
    };
    this.scheduledNodes.push(nodeEntry);

    // Clean up all layers once the primary oscillator finishes
    oscillators[0].osc.onended = () => {
      try {
        for (const { osc, layerGain } of oscillators) {
          osc.disconnect();
          layerGain.disconnect();
        }
        noteGain.disconnect();
        stopGain.disconnect();
      } catch (e) { /* already disconnected */ }
    };
  }

  /**
   * Schedule a piano-style note for parts identified as piano.
   * Uses a short hammer transient, several decaying partials, and a longer
   * low-register tail instead of the choral or vocal synthesis paths.
   */
  schedulePianoNote(partId, frequency, startTime, duration, articulation = {}, timing = {}) {
    const gainNode = this.partGains.get(partId);
    if (!gainNode) return;

    const ctx = this.audioContext;
    const safeDuration = Math.max(0.04, duration);
    const safeFrequency = Math.max(20, frequency);
    const noteEndTime = startTime + safeDuration;
    const releaseTail = Math.min(
      1.25,
      Math.max(0.32, 0.82 * Math.pow(440 / safeFrequency, 0.16))
    );
    const soundEndTime = noteEndTime + releaseTail;
    const naturalDecay = Math.min(
      4.5,
      Math.max(1.35, 2.8 * Math.pow(440 / safeFrequency, 0.22))
    );
    const toneMerge = ctx.createGain();
    const bodyFilter = ctx.createBiquadFilter();
    const noteGain = ctx.createGain();
    const stopGain = ctx.createGain();
    const peakGain = 0.18;
    const attack = Math.min(0.007, safeDuration * 0.15);

    toneMerge.gain.value = 1;
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.value = Math.min(9000, Math.max(2400, safeFrequency * 9));
    bodyFilter.Q.value = 0.55;

    // Piano strings are slightly inharmonic, and their upper partials decay
    // much faster than the fundamental. Three subtly detuned fundamentals
    // imitate the unison string group used for most of the keyboard.
    const partials = [
      { ratio: 1.0000, detune: -1.2, gain: 0.30, decay: 1.00, residual: 0.055 },
      { ratio: 1.0000, detune:  0.0, gain: 0.38, decay: 1.00, residual: 0.060 },
      { ratio: 1.0000, detune:  1.4, gain: 0.30, decay: 0.96, residual: 0.050 },
      { ratio: 2.0025, detune:  0.0, gain: 0.20, decay: 0.68, residual: 0.018 },
      { ratio: 3.0090, detune:  0.0, gain: 0.095, decay: 0.43, residual: 0.008 },
      { ratio: 4.0210, detune:  0.0, gain: 0.044, decay: 0.29, residual: 0.004 },
      { ratio: 5.0400, detune:  0.0, gain: 0.020, decay: 0.20, residual: 0.002 }
    ];
    const oscillators = [];
    const nyquistLimit = ctx.sampleRate * 0.45;

    for (const partial of partials) {
      const partialFrequency = safeFrequency * partial.ratio;
      if (partialFrequency >= nyquistLimit) continue;

      const osc = ctx.createOscillator();
      const partialGain = ctx.createGain();
      const partialAttack = Math.min(
        attack,
        0.0025 + 0.004 / Math.sqrt(partial.ratio)
      );
      const decayEnd = Math.min(
        soundEndTime - 0.01,
        startTime + naturalDecay * partial.decay
      );
      const residualGain = Math.max(0.0001, partial.gain * partial.residual);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(partialFrequency, startTime);
      if (partial.detune) osc.detune.setValueAtTime(partial.detune, startTime);

      // The upper harmonics provide a tonal hammer edge, then disappear
      // quickly. No white-noise transient is used, eliminating the clap.
      partialGain.gain.setValueAtTime(0, startTime);
      partialGain.gain.linearRampToValueAtTime(
        partial.gain,
        startTime + partialAttack
      );
      if (decayEnd > startTime + partialAttack + 0.005) {
        partialGain.gain.exponentialRampToValueAtTime(residualGain, decayEnd);
      }
      if (soundEndTime > decayEnd + 0.005) {
        partialGain.gain.setValueAtTime(residualGain, decayEnd);
        partialGain.gain.exponentialRampToValueAtTime(0.0001, soundEndTime);
      }

      osc.connect(partialGain);
      partialGain.connect(toneMerge);
      osc.start(startTime);
      osc.stop(soundEndTime + 0.02);
      oscillators.push({ osc, layerGain: partialGain });
    }

    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    noteGain.gain.setValueAtTime(peakGain, noteEndTime);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, soundEndTime);
    noteGain.gain.setValueAtTime(0, soundEndTime + 0.005);
    stopGain.gain.value = 1;

    toneMerge.connect(bodyFilter);
    bodyFilter.connect(noteGain);
    noteGain.connect(stopGain);
    stopGain.connect(gainNode);

    const eventEndBeat = Number(timing.playbackEndBeat);
    const eventDurationBeats = Number(timing.playbackDurationBeats);
    const nodeEntry = {
      oscillator: oscillators[0]?.osc,
      oscillators,
      noteGain,
      stopGain,
      bodyFilter,
      isPiano: true,
      startTime,
      endTime: soundEndTime + 0.02,
      eventIndex: timing.eventIndex,
      eventIndices: new Set(Number.isInteger(timing.eventIndex) ? [timing.eventIndex] : []),
      playbackEndBeat: Number.isFinite(eventEndBeat) ? eventEndBeat : undefined,
      playbackDurationBeats: Number.isFinite(eventDurationBeats)
        ? eventDurationBeats
        : undefined,
      legatoToNext: false,
      requestedRelease: releaseTail,
      peakGain,
      envelopeStartTime: startTime,
      envelopeStartGain: 0,
      attackEndTime: startTime + attack,
      sustainGain: peakGain,
      releaseStartTime: noteEndTime,
      noteEndTime: soundEndTime
    };
    this.scheduledNodes.push(nodeEntry);

    if (oscillators[0]) {
      oscillators[0].osc.onended = () => {
        try {
          for (const { osc, layerGain } of oscillators) {
            osc.disconnect();
            layerGain.disconnect();
          }
          toneMerge.disconnect();
          bodyFilter.disconnect();
          noteGain.disconnect();
          stopGain.disconnect();
        } catch (e) { /* already disconnected */ }
      };
    }
  }

  /**
   * Set the synthesis mode.
   * @param {'oscillator'|'vocal'} mode
   */
  setSynthMode(mode) {
    if (mode !== 'oscillator' && mode !== 'vocal') return;
    if (mode === this.synthMode) return;

    if (this.isPlaying && this.audioContext) {
      const currentPlaybackBeat = this.getCurrentPlaybackBeat();
      this.stopAllNodes();
      this.synthMode = mode;
      this.scheduleIndex = 0;
      while (this.scheduleIndex < this.schedule.length) {
        const event = this.schedule[this.scheduleIndex];
        const eventBeat = event.playbackStartBeat ?? event.startBeat;
        const eventDuration = event.playbackDurationBeats ?? event.durationBeats;
        if (eventBeat + eventDuration > currentPlaybackBeat + 1e-6) break;
        this.scheduleIndex++;
      }
      // Refill the lookahead using the new synthesis mode without replaying
      // events that have already finished.
      this.scheduleAhead();
      return;
    }

    this.synthMode = mode;
    this.vocalPhraseNodes.clear();
  }

  /**
   * Continue an existing vocal phrase at a new pitch. The source and vibrato
   * oscillator stay alive; only the fundamental and musical envelope change.
   * This avoids the click/re-attack caused by starting a new glottal pulse at
   * every slurred note boundary.
   */
  continueVocalPhrase(node, frequency, startTime, articulation = {}, timing = {}) {
    const phraseStartPlaybackBeat = Number(timing.vocalPhraseStartPlaybackBeat);
    const phraseEndPlaybackBeat = Number(timing.vocalPhraseEndPlaybackBeat);
    let phraseEndTime = node.noteEndTime;
    if (Number.isFinite(phraseEndPlaybackBeat) && Number.isFinite(this.startTime)) {
      const transportPhraseEnd = this.startTime +
        beatToTime(phraseEndPlaybackBeat, this.tempo);
      if (transportPhraseEnd > startTime) {
        phraseEndTime = transportPhraseEnd;
      }
    }
    phraseEndTime = Math.max(phraseEndTime, startTime + 0.06);

    const currentFrequency = Number(node.currentFrequency) || frequency;
    // Keep repeated pitches in the same continuous phrase, but avoid scheduling
    // a redundant pitch glide when the fundamental is already at this value.
    const isRepeatedPitch = Math.abs(currentFrequency - frequency) < 0.01;
    const pitch = node.oscillator.frequency;
    const transitionDuration = Math.min(
      0.075,
      Math.max(0.03, beatDuration(this.tempo) * 0.12)
    );
    const transitionEnd = Math.min(
      phraseEndTime - 0.01,
      startTime + transitionDuration
    );

    // The vibrato node is connected to this AudioParam, so this automation
    // changes the base pitch while preserving the existing vibrato phase.
    pitch.cancelScheduledValues(startTime);
    pitch.setValueAtTime(currentFrequency, startTime);
    if (!isRepeatedPitch && transitionEnd > startTime + 0.005) {
      pitch.linearRampToValueAtTime(frequency, transitionEnd);
    } else {
      pitch.setValueAtTime(frequency, startTime);
    }

    const transitionStartBeat = Number(timing.playbackStartBeat);
    if (!isRepeatedPitch && Number.isFinite(transitionStartBeat) &&
        Number.isFinite(phraseEndPlaybackBeat)) {
      const transitionBeats = transitionDuration / beatDuration(this.tempo);
      node.vocalTransitions.push({
        startPlaybackBeat: transitionStartBeat,
        endPlaybackBeat: Math.min(
          phraseEndPlaybackBeat,
          transitionStartBeat + transitionBeats
        ),
        fromFrequency: currentFrequency,
        toFrequency: frequency
      });
    }

    // Keep the phrase envelope continuous at every non-staccato boundary.
    // The vocal source, breath noise, and level remain uninterrupted for a
    // repeated pitch as well as for a pitch glide.
    const currentGain = this.getEnvelopeGainAtTime(node, startTime);
    const gain = node.noteGain.gain;
    const attackEnd = Math.min(startTime + 0.008, phraseEndTime - 0.01);
    const requestedRelease = articulation.fermata
      ? 0.12
      : articulation.legatoToNext ? 0.04 : 0.08;
    const release = Math.min(requestedRelease, Math.max(0.01, phraseEndTime - startTime));
    const releaseStart = Math.max(attackEnd, phraseEndTime - release);
    const dipEndTime = Math.min(startTime + 0.018, releaseStart - 0.035);
    const recoveryEndTime = Math.min(startTime + 0.065, releaseStart - 0.005);
    const dipGain = node.peakGain * 0.82;
    const canDip = isRepeatedPitch &&
      dipEndTime > startTime + 0.003 &&
      recoveryEndTime > dipEndTime + 0.008;

    gain.cancelScheduledValues(startTime);
    gain.setValueAtTime(currentGain, startTime);
    if (canDip) {
      // Repeated notes remain one continuous vocal source. This shallow dip
      // creates a clear boundary without silence, a new attack, or added noise.
      gain.linearRampToValueAtTime(dipGain, dipEndTime);
      gain.linearRampToValueAtTime(node.peakGain, recoveryEndTime);
    } else if (attackEnd > startTime + 0.001) {
      gain.linearRampToValueAtTime(node.peakGain, attackEnd);
    }
    gain.setValueAtTime(node.peakGain, releaseStart);
    gain.linearRampToValueAtTime(0, phraseEndTime);

    // A resumed phrase can be close to its original stop time. Extend the
    // scheduled source stop when the release was clamped to the safe minimum.
    if (phraseEndTime > node.noteEndTime + 0.001) {
      for (const { osc } of node.oscillators || []) {
        try { osc.stop(phraseEndTime + 0.02); } catch (e) { /* already stopped */ }
      }
    }

    node.currentFrequency = frequency;
    if (Number.isInteger(timing.eventIndex)) {
      node.eventIndices?.add(timing.eventIndex);
    }
    node.playbackEndBeat = Number.isFinite(phraseEndPlaybackBeat)
      ? phraseEndPlaybackBeat
      : timing.playbackEndBeat;
    node.playbackDurationBeats = Number.isFinite(phraseEndPlaybackBeat) &&
      Number.isFinite(phraseStartPlaybackBeat)
      ? phraseEndPlaybackBeat - phraseStartPlaybackBeat
      : timing.playbackDurationBeats;
    node.legatoToNext = !!timing.legatoToNext;
    node.requestedRelease = requestedRelease;
    node.endTime = phraseEndTime + 0.02;
    node.envelopeStartTime = startTime;
    node.envelopeStartGain = currentGain;
    node.attackEndTime = attackEnd;
    node.repeatedPitchDip = canDip ? {
      bottomTime: dipEndTime,
      bottomGain: dipGain,
      recoveryEndTime
    } : null;
    node.releaseStartTime = releaseStart;
    node.noteEndTime = phraseEndTime;
  }

  /**
   * Schedule a single note using formant vocal synthesis.
   * Models a human voice with:
   *  - A glottal pulse source (sawtooth with custom harmonics)
   *  - Parallel formant bandpass filters (F1–F5) for vowel shaping
   *  - Vibrato via LFO on pitch (~5.5 Hz, delayed onset)
   *  - Breath noise mixed in through the formant bank
   *  - Natural attack/sustain/release envelope
   *
   * @param {string} partId
   * @param {number} frequency
   * @param {number} startTime - AudioContext time
   * @param {number} duration - seconds
   * @param {object} articulation - legato/fermata envelope hints
   * @param {object} timing - source event timing on the playback timeline
   */
  scheduleVocalNote(partId, frequency, startTime, duration, articulation = {}, timing = {}) {
    const gainNode = this.partGains.get(partId);
    if (!gainNode) return;

    const ctx = this.audioContext;
    const phraseId = timing.vocalPhraseId;
    const phraseStartPlaybackBeat = Number(timing.vocalPhraseStartPlaybackBeat);
    const phraseEndPlaybackBeat = Number(timing.vocalPhraseEndPlaybackBeat);
    const playbackStartBeat = Number(timing.playbackStartBeat);
    const isContinuation = !!phraseId &&
      Number.isFinite(phraseStartPlaybackBeat) &&
      Number.isFinite(playbackStartBeat) &&
      phraseStartPlaybackBeat < playbackStartBeat - 1e-6;
    const existingPhraseNode = phraseId ? this.vocalPhraseNodes.get(phraseId) : null;

    // Contiguous non-staccato vocal notes share one source, preserving glottal
    // phase, vibrato phase, breath noise, and volume across every transition.
    if (isContinuation && existingPhraseNode && existingPhraseNode.endTime > startTime + 0.001) {
      this.continueVocalPhrase(
        existingPhraseNode,
        frequency,
        startTime,
        articulation,
        timing
      );
      return;
    }

    let phraseEndTime = startTime + Math.max(0.06, duration);
    if (Number.isFinite(phraseEndPlaybackBeat) && Number.isFinite(this.startTime)) {
      const transportPhraseEnd = this.startTime +
        beatToTime(phraseEndPlaybackBeat, this.tempo);
      if (transportPhraseEnd > startTime) {
        phraseEndTime = transportPhraseEnd;
      }
    }
    // Keep a resumed short note alive long enough for its envelope to reach
    // zero instead of stopping the source underneath the release ramp.
    phraseEndTime = Math.max(phraseEndTime, startTime + 0.06);
    const safeDuration = phraseEndTime - startTime;
    const voiceKey = resolveVoiceKey(partId, this.parts);
    const formants = VOCAL_FORMANTS[voiceKey] || VOCAL_FORMANTS.default;

    // --- Glottal source: a sawtooth-like periodic wave with rolled-off upper harmonics ---
    const source = ctx.createOscillator();
    // Build a custom periodic wave that simulates glottal pulses: strong
    // fundamental, harmonics rolling off roughly at -12 dB/octave with slight
    // spectral tilt variations per voice type.
    const numHarmonics = 40;
    const real = new Float32Array(numHarmonics + 1);
    const imag = new Float32Array(numHarmonics + 1);
    const tiltFactor = voiceKey === 'bass' ? 1.4 : voiceKey === 'soprano' ? 0.9 : 1.1;
    real[0] = 0;
    imag[0] = 0;
    for (let n = 1; n <= numHarmonics; n++) {
      real[n] = 0;
      // Glottal pulse approximation with spectral tilt
      imag[n] = (1 / Math.pow(n, tiltFactor)) * (n % 2 === 0 ? 0.85 : 1.0);
    }
    const glottalWave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    source.setPeriodicWave(glottalWave);
    source.frequency.setValueAtTime(frequency, startTime);

    // --- Vibrato LFO ---
    const vibrato = ctx.createOscillator();
    const vibratoGain = ctx.createGain();
    const vibratoRate = 5.2 + Math.random() * 0.8; // 5.2–6.0 Hz, slightly randomized
    const vibratoDepth = frequency * 0.012; // ~20 cents variation
    vibrato.type = 'sine';
    vibrato.frequency.setValueAtTime(vibratoRate, startTime);
    vibratoGain.gain.setValueAtTime(0, startTime);
    // Delay vibrato onset — singers add vibrato after the initial attack
    const vibratoOnset = Math.min(0.2, safeDuration * 0.3);
    vibratoGain.gain.setValueAtTime(0, startTime);
    vibratoGain.gain.linearRampToValueAtTime(0, startTime + vibratoOnset);
    if (safeDuration > vibratoOnset + 0.05) {
      vibratoGain.gain.linearRampToValueAtTime(
        vibratoDepth,
        startTime + vibratoOnset + Math.min(0.15, (safeDuration - vibratoOnset) * 0.4)
      );
    }
    vibrato.connect(vibratoGain);
    vibratoGain.connect(source.frequency);

    // --- Formant filter bank (parallel bandpass filters) ---
    const formantMerge = ctx.createGain();
    formantMerge.gain.value = 1.0;
    const formantFilters = [];

    for (const f of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f.freq;
      bp.Q.value = f.freq / f.bw; // Q = center / bandwidth
      const fGain = ctx.createGain();
      fGain.gain.value = f.gain;
      source.connect(bp);
      bp.connect(fGain);
      fGain.connect(formantMerge);
      formantFilters.push({ bp, fGain });
    }

    // --- Breath/aspiration noise ---
    const noiseGain = ctx.createGain();
    // Aspiration is louder during attack and release
    const baseNoiseLevel = 0.04;
    noiseGain.gain.setValueAtTime(baseNoiseLevel * 2.5, startTime);
    const noiseSettleTime = Math.min(0.08, safeDuration * 0.2);
    noiseGain.gain.linearRampToValueAtTime(baseNoiseLevel, startTime + noiseSettleTime);
    // Increase breath during release
    const releaseNoiseStart = startTime + safeDuration - Math.min(0.06, safeDuration * 0.15);
    noiseGain.gain.setValueAtTime(baseNoiseLevel, releaseNoiseStart);
    noiseGain.gain.linearRampToValueAtTime(baseNoiseLevel * 2, startTime + safeDuration);

    // Generate noise via a BufferSourceNode with white noise
    const noiseBuffer = this.getOrCreateNoiseBuffer();
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    // Filter the noise through the same formant region for a natural sound
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = formants[1]?.freq || 1500; // around F2
    noiseFilter.Q.value = 1.5;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(formantMerge);

    // --- Amplitude envelope ---
    const noteGain = ctx.createGain();
    const stopGain = ctx.createGain();
    // Formant filtering removes most of the source spectrum, so compensate
    // the vocal mode's perceived loudness before the shared output limiter.
    const peakGain = 0.6;

    const requestedAttack = articulation.legatoFromPrevious
      ? 0.015
      : articulation.legato ? 0.03 : 0.045;
    const requestedRelease = articulation.fermata
      ? 0.12
      : articulation.legatoToNext ? 0.04 : 0.08;
    const attack = Math.min(requestedAttack, safeDuration * 0.25);
    const release = Math.min(requestedRelease, safeDuration * 0.35);
    const releaseStart = Math.max(startTime + attack, startTime + safeDuration - release);

    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    noteGain.gain.setValueAtTime(peakGain, releaseStart);
    noteGain.gain.linearRampToValueAtTime(0, startTime + safeDuration);
    stopGain.gain.value = 1;

    // --- Connect the chain: formantMerge → noteGain → stopGain → partGain ---
    formantMerge.connect(noteGain);
    noteGain.connect(stopGain);
    stopGain.connect(gainNode);

    // --- Start and stop ---
    const noteEndTime = phraseEndTime;
    source.start(startTime);
    source.stop(noteEndTime + 0.02);
    vibrato.start(startTime);
    vibrato.stop(noteEndTime + 0.02);
    noise.start(startTime);
    noise.stop(noteEndTime + 0.02);

    const endTime = noteEndTime + 0.02;
    const nodeEntry = {
      oscillator: source,
      oscillators: [
        { osc: source, layerGain: formantMerge },
        { osc: vibrato, layerGain: vibratoGain },
        { osc: noise, layerGain: noiseGain }
      ],
      formantFilters,
      noteGain,
      stopGain,
      vibratoGain,
      initialFrequency: frequency,
      currentFrequency: frequency,
      vocalTransitions: [],
      startTime,
      endTime,
      eventIndex: timing.eventIndex,
      eventIndices: new Set(Number.isInteger(timing.eventIndex) ? [timing.eventIndex] : []),
      vocalPhraseId: phraseId,
      vocalPhraseStartPlaybackBeat: Number.isFinite(phraseStartPlaybackBeat)
        ? phraseStartPlaybackBeat
        : timing.playbackStartBeat,
      playbackEndBeat: Number.isFinite(phraseEndPlaybackBeat)
        ? phraseEndPlaybackBeat
        : timing.playbackEndBeat,
      playbackDurationBeats: Number.isFinite(phraseEndPlaybackBeat) &&
        Number.isFinite(phraseStartPlaybackBeat)
        ? phraseEndPlaybackBeat - phraseStartPlaybackBeat
        : timing.playbackDurationBeats,
      legatoToNext: !!timing.legatoToNext,
      requestedRelease,
      peakGain,
      envelopeStartTime: startTime,
      envelopeStartGain: 0,
      attackEndTime: startTime + attack,
      sustainGain: peakGain,
      releaseStartTime: releaseStart,
      noteEndTime
    };
    this.scheduledNodes.push(nodeEntry);
    if (phraseId) {
      this.vocalPhraseNodes.set(phraseId, nodeEntry);
    }

    source.onended = () => {
      if (phraseId && this.vocalPhraseNodes.get(phraseId) === nodeEntry) {
        this.vocalPhraseNodes.delete(phraseId);
      }
      try {
        source.disconnect();
        for (const { bp, fGain } of formantFilters) {
          bp.disconnect();
          fGain.disconnect();
        }
        vibrato.disconnect();
        vibratoGain.disconnect();
        noise.disconnect();
        noiseFilter.disconnect();
        noiseGain.disconnect();
        formantMerge.disconnect();
        noteGain.disconnect();
        stopGain.disconnect();
      } catch (e) { /* already disconnected */ }
    };
  }

  /**
   * Lazily create (and cache) a white noise AudioBuffer for breath synthesis.
   * @returns {AudioBuffer}
   */
  getOrCreateNoiseBuffer() {
    if (this._noiseBuffer) return this._noiseBuffer;
    const ctx = this.audioContext;
    const length = ctx.sampleRate * 2; // 2 seconds of noise, looped
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this._noiseBuffer = buffer;
    return buffer;
  }

  /** Return the scheduled envelope value at an AudioContext time. */
  getEnvelopeGainAtTime(node, time) {
    const startTime = node.envelopeStartTime;
    const startGain = node.envelopeStartGain;
    const attackEnd = node.attackEndTime;
    const sustainGain = node.sustainGain;
    const releaseStart = node.releaseStartTime;
    const noteEnd = node.noteEndTime;
    const repeatedPitchDip = node.repeatedPitchDip;

    if (time <= startTime) return startGain;
    if (repeatedPitchDip && time < repeatedPitchDip.recoveryEndTime) {
      if (time < repeatedPitchDip.bottomTime) {
        const progress = (time - startTime) / (repeatedPitchDip.bottomTime - startTime);
        return startGain + (repeatedPitchDip.bottomGain - startGain) * progress;
      }
      const progress = (time - repeatedPitchDip.bottomTime) /
        (repeatedPitchDip.recoveryEndTime - repeatedPitchDip.bottomTime);
      return repeatedPitchDip.bottomGain +
        (sustainGain - repeatedPitchDip.bottomGain) * progress;
    }
    if (attackEnd > startTime && time < attackEnd) {
      const progress = (time - startTime) / (attackEnd - startTime);
      return startGain + (sustainGain - startGain) * progress;
    }
    if (time < releaseStart) return sustainGain;
    if (noteEnd > releaseStart && time < noteEnd) {
      return sustainGain * (noteEnd - time) / (noteEnd - releaseStart);
    }
    return 0;
  }

  /**
   * Rebuild future pitch glides for a vocal phrase after a tempo change.
   * AudioParam automation is timestamp-based, so queued transitions must be
   * moved to the new transport times along with the gain envelope.
   */
  retimeVocalTransitions(node, now, currentPlaybackBeat, newTempo) {
    if (!node.vocalTransitions?.length) return;

    const transitions = [...node.vocalTransitions]
      .sort((a, b) => a.startPlaybackBeat - b.startPlaybackBeat);
    let currentFrequency = Number(node.initialFrequency) || node.currentFrequency;
    for (const transition of transitions) {
      if (currentPlaybackBeat >= transition.endPlaybackBeat) {
        currentFrequency = transition.toFrequency;
      } else if (currentPlaybackBeat > transition.startPlaybackBeat) {
        const span = transition.endPlaybackBeat - transition.startPlaybackBeat;
        const progress = span > 0
          ? (currentPlaybackBeat - transition.startPlaybackBeat) / span
          : 1;
        currentFrequency = transition.fromFrequency +
          (transition.toFrequency - transition.fromFrequency) * Math.max(0, Math.min(1, progress));
        break;
      } else {
        break;
      }
    }

    const pitch = node.oscillator.frequency;
    pitch.cancelScheduledValues(now);
    pitch.setValueAtTime(currentFrequency, now);
    for (const transition of transitions) {
      if (transition.endPlaybackBeat <= currentPlaybackBeat + 1e-6) continue;
      const startTime = Math.max(
        now,
        this.startTime + beatToTime(transition.startPlaybackBeat, newTempo)
      );
      const endTime = this.startTime + beatToTime(transition.endPlaybackBeat, newTempo);
      if (endTime <= now + 0.005) continue;
      if (startTime > now + 0.001) {
        pitch.setValueAtTime(transition.fromFrequency, startTime);
      }
      pitch.linearRampToValueAtTime(transition.toFrequency, endTime);
    }
  }

  /**
   * Re-time the remainder of an active note without replacing its oscillator.
   * The waveform phase and pitch remain continuous; only future gain automation
   * and the oscillator's stop time move to the new tempo timeline.
   */
  retimeActiveNode(node, now, currentPlaybackBeat, newTempo) {
    const remainingBeats = Math.max(0, node.playbackEndBeat - currentPlaybackBeat);
    const fullDurationBeats = Number(node.playbackDurationBeats) || remainingBeats;
    const fullDuration = beatToTime(fullDurationBeats, newTempo);
    const overlap = node.legatoToNext ? Math.min(0.045, fullDuration * 0.12) : 0;
    const remainingDuration = Math.max(0.01, beatToTime(remainingBeats, newTempo) + overlap);
    const noteEndTime = now + remainingDuration;
    const requestedRelease = Number(node.requestedRelease) || 0.05;
    const release = Math.min(requestedRelease, remainingDuration * 0.35);
    const latestAttackEnd = Math.max(now, noteEndTime - release);
    const currentGain = this.getEnvelopeGainAtTime(node, now);

    // If the original attack is still underway, continue it when there is room.
    // Otherwise hold the exact current level until the newly timed release.
    let attackEndTime = now;
    let sustainGain = currentGain;
    if (now < node.attackEndTime && latestAttackEnd > now + 0.001) {
      attackEndTime = Math.min(node.attackEndTime, latestAttackEnd);
      if (attackEndTime > now + 0.001) {
        sustainGain = node.peakGain;
      } else {
        attackEndTime = now;
      }
    }
    const releaseStartTime = Math.max(attackEndTime, noteEndTime - release);

    const gain = node.noteGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(currentGain, now);
    if (attackEndTime > now) {
      gain.linearRampToValueAtTime(sustainGain, attackEndTime);
    }
    gain.setValueAtTime(sustainGain, releaseStartTime);
    gain.linearRampToValueAtTime(0, noteEndTime);
    if (node.vocalTransitions) {
      this.retimeVocalTransitions(node, now, currentPlaybackBeat, newTempo);
    }
    // Stop all oscillator layers at the new end time
    if (node.oscillators) {
      for (const { osc } of node.oscillators) {
        try { osc.stop(noteEndTime + 0.01); } catch (e) { /* already stopped */ }
      }
    } else {
      node.oscillator.stop(noteEndTime + 0.01);
    }

    node.endTime = noteEndTime + 0.01;
    node.envelopeStartTime = now;
    node.envelopeStartGain = currentGain;
    node.attackEndTime = attackEndTime;
    node.sustainGain = sustainGain;
    node.releaseStartTime = releaseStartTime;
    node.noteEndTime = noteEndTime;
  }

  /**
   * Fade a scheduled oscillator to silence before stopping it.
   * The dedicated stop gain is not used by the note envelope, so its current
   * value is always known and can be ramped without an automation discontinuity.
   * Nodes that have not started can be cancelled immediately because they are silent.
   * @param {object} node
   * @param {number} now - AudioContext time
   * @param {number} fadeDuration - fade length in seconds
   */
  fadeOutNode(node, now, fadeDuration = 0.02) {
    const { oscillator, oscillators, stopGain, startTime, endTime } = node;
    const isSounding = startTime <= now && endTime > now;

    try {
      stopGain.gain.cancelScheduledValues(now);
      if (isSounding) {
        const fadeEnd = now + fadeDuration;
        stopGain.gain.setValueAtTime(stopGain.gain.value, now);
        stopGain.gain.linearRampToValueAtTime(0, fadeEnd);
        const stopTime = fadeEnd + 0.005;
        if (oscillators) {
          for (const { osc } of oscillators) {
            try { osc.stop(stopTime); } catch (e) { /* already stopped */ }
          }
        } else if (oscillator) {
          oscillator.stop(stopTime);
        }
      } else {
        stopGain.gain.setValueAtTime(0, now);
        if (oscillators) {
          for (const { osc } of oscillators) {
            try { osc.stop(now); } catch (e) { /* already stopped */ }
          }
        } else if (oscillator) {
          oscillator.stop(now);
        }
      }
    } catch (e) { /* already stopped */ }
  }

  /**
   * Stop and disconnect all scheduled oscillator nodes.
   */
  stopAllNodes() {
    const now = this.audioContext ? this.audioContext.currentTime : 0;
    for (const node of this.scheduledNodes) {
      this.fadeOutNode(node, now);
    }
    this.scheduledNodes = [];
    this.preservedEventIndices.clear();
    this.vocalPhraseNodes.clear();
  }

  /**
   * Estimate the full path from the end of the Web Audio graph to the speakers.
   * baseLatency covers graph-to-host buffering; outputLatency covers the host
   * subsystem and output device. Both elapse before sound reaches the room.
   * @returns {number} seconds
   */
  getAudibleOutputLatency() {
    if (!this.audioContext) return 0;
    const baseLatency = Math.max(0, Number(this.audioContext.baseLatency) || 0);
    const deviceLatency = Math.max(0, Number(this.audioContext.outputLatency) || 0);
    return baseLatency + deviceLatency;
  }

  /**
   * Start tracking the current beat position using requestAnimationFrame.
   */
  startBeatTracking() {
    this.stopBeatTracking();
    const track = () => {
      if (!this.isPlaying) return;
      // The browser graph-to-host buffer and the host-to-speaker device path
      // are consecutive stages. Counting only one leaves visuals ahead of the
      // sound that a microphone can physically receive.
      const outputLatency = this.getAudibleOutputLatency();
      const elapsed = this.audioContext.currentTime - this.startTime - outputLatency;
      const measuredPlaybackBeat = Math.max(0, elapsed / beatDuration(this.tempo));
      const playbackBeat = Math.max(this.trackingFloorPlaybackBeat, measuredPlaybackBeat);
      this.currentBeat = playbackBeatToScoreBeat(playbackBeat, this.fermataHolds);

      // End on the expanded timeline; during a fermata currentBeat intentionally
      // remains fixed at the marked score position.
      if (playbackBeat >= this.getTotalPlaybackBeats()) {
        this.stop();
        if (this.onPlaybackEnd) {
          this.onPlaybackEnd();
        }
        return;
      }

      if (this.onBeatUpdate) {
        this.onBeatUpdate(this.currentBeat);
      }
      this.animationFrame = requestAnimationFrame(track);
    };
    this.animationFrame = requestAnimationFrame(track);
  }

  /**
   * Stop beat tracking.
   */
  stopBeatTracking() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Get the AudioContext (for use by other modules like metronome).
   * @returns {AudioContext}
   */
  getAudioContext() {
    return this.audioContext;
  }

  /**
   * Get the playback start time reference (for syncing metronome).
   * @returns {number} AudioContext time when beat 0 started
   */
  getStartTime() {
    return this.startTime;
  }

  /**
   * Get the current beat position.
   * @returns {number}
   */
  getCurrentBeat() {
    return this.currentBeat;
  }

  /**
   * Resolve where the audible transport was a short time ago. Microphone
   * analysis describes a capture window in the recent past, so plotting it at
   * the current cursor makes the singer's trail appear ahead of their voice.
   *
   * The hold flag preserves the distinction between a note boundary and time
   * spent inside a fermata, even though both collapse to the same score beat.
   *
   * @param {number} secondsAgo - capture and analysis delay in seconds
   * @returns {{ beat: number, isFermataHold: boolean }}
   */
  getScorePositionSecondsAgo(secondsAgo) {
    if (!this.isPlaying || !this.audioContext) {
      return { beat: this.currentBeat, isFermataHold: false };
    }

    const delay = Math.max(0, Number(secondsAgo) || 0);
    const secondsPerBeat = beatDuration(this.tempo);
    if (secondsPerBeat <= 0) {
      return { beat: this.currentBeat, isFermataHold: false };
    }

    const samplePlaybackBeat = Math.max(
      0,
      this.getCurrentPlaybackBeat() - delay / secondsPerBeat
    );
    let accumulatedHold = 0;
    for (const hold of this.fermataHolds) {
      const holdStart = hold.scoreBeat + accumulatedHold;
      const holdEnd = holdStart + hold.extraBeats;
      if (samplePlaybackBeat >= holdStart && samplePlaybackBeat < holdEnd) {
        return { beat: hold.scoreBeat, isFermataHold: true };
      }
      if (samplePlaybackBeat < holdStart) break;
      accumulatedHold += hold.extraBeats;
    }

    return {
      beat: playbackBeatToScoreBeat(samplePlaybackBeat, this.fermataHolds),
      isFermataHold: false
    };
  }

  /**
   * Backward-compatible numeric form of getScorePositionSecondsAgo.
   * @param {number} secondsAgo
   * @returns {number}
   */
  getScoreBeatSecondsAgo(secondsAgo) {
    return this.getScorePositionSecondsAgo(secondsAgo).beat;
  }

  /**
   * Get the exact position on the fermata-expanded timeline. Unlike currentBeat,
   * this continues advancing while the score cursor waits on a fermata.
   * @returns {number}
   */
  getCurrentPlaybackBeat() {
    if (this.isPlaying && this.audioContext) {
      const outputLatency = this.getAudibleOutputLatency();
      return Math.max(0, (this.audioContext.currentTime - this.startTime - outputLatency) / beatDuration(this.tempo));
    }
    if (this.isPaused) return this.pausePlaybackBeat;
    return this.getPlaybackBeat(this.currentBeat);
  }

  /**
   * Get the master gain node.
   * @returns {GainNode}
   */
  getMasterGain() {
    return this.masterGain;
  }

  /**
   * Get the current position in seconds on the score timeline.
   * @returns {number}
   */
  getScorePositionSeconds() {
    if (this.isPlaying && this.audioContext) {
      const outputLatency = this.getAudibleOutputLatency();
      const elapsed = this.audioContext.currentTime - this.startTime - outputLatency;
      return elapsed;
    }
    if (this.isPaused) {
      return beatToTime(this.pausePlaybackBeat, this.tempo);
    }
    return beatToTime(this.getPlaybackBeat(this.currentBeat), this.tempo);
  }

  /**
   * Render the entire score offline and return a stereo AudioBuffer.
   * Uses the same synthesis code path as live playback — all part volumes,
   * mute/solo state, panning, EQ, and fermata timing are honoured.
   *
   * @param {{ onProgress?: (ratio: number) => void }} [options]
   * @returns {Promise<AudioBuffer>}
   */
  async exportAudio(options = {}) {
    const { onProgress } = options;

    // Build the note schedule using the live state so preset volumes are baked in.
    const schedule = this.buildSchedule();
    schedule.sort((a, b) =>
      (a.playbackStartBeat ?? a.startBeat) - (b.playbackStartBeat ?? b.startBeat)
    );

    const totalPlaybackBeats = this.getTotalPlaybackBeats();
    // Add a short tail so the last note's release fully decays before the file ends.
    const tailSeconds = 2.5;
    const totalSeconds = beatToTime(totalPlaybackBeats, this.tempo) + tailSeconds;
    const sampleRate = 44100;

    const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalSeconds * sampleRate), sampleRate);

    // --- Rebuild the same signal chain on the offline context ---

    const masterGain = offlineCtx.createGain();
    masterGain.gain.value = 0.7;

    const compressor = offlineCtx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 8;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;

    const limiter = offlineCtx.createWaveShaper();
    limiter.curve = this.buildSoftClipCurve();
    limiter.oversample = '4x';

    masterGain.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(offlineCtx.destination);

    // Per-part nodes mirroring the live setParts() chain
    const offlinePartGains = new Map(); // partId -> gainNode on offline ctx

    for (const part of this.parts) {
      const voiceKey = resolveVoiceKey(part.id, this.parts);
      const eqSettings = PART_EQ[voiceKey];
      const panValue = PART_PAN[voiceKey];

      const gainNode = offlineCtx.createGain();
      // Use the live volume level (honours presets + mute + solo).
      const anySoloed = Array.from(this.partSoloed.values()).some(v => v);
      const isMuted   = this.partMuted.get(part.id);
      const isSoloed  = this.partSoloed.get(part.id);
      const isAudible = !isMuted && (!anySoloed || isSoloed);
      const intendedVolume = isAudible
        ? (this.partVolumeLevels.get(part.id) ?? 0.8)
        : 0;
      gainNode.gain.value = intendedVolume;

      const lowShelf = offlineCtx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = eqSettings.lowShelf.frequency;
      lowShelf.gain.value = eqSettings.lowShelf.gain;

      const highShelf = offlineCtx.createBiquadFilter();
      highShelf.type = 'highshelf';
      highShelf.frequency.value = eqSettings.highShelf.frequency;
      highShelf.gain.value = eqSettings.highShelf.gain;

      const panner = offlineCtx.createStereoPanner();
      panner.pan.value = panValue;

      gainNode.connect(lowShelf);
      lowShelf.connect(highShelf);
      highShelf.connect(panner);
      panner.connect(masterGain);

      offlinePartGains.set(part.id, gainNode);
    }

    // --- Offline noise buffer (re-created for the offline context) ---
    const noiseLength = sampleRate * 2;
    const noiseBuffer = offlineCtx.createBuffer(1, noiseLength, sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseLength; i++) noiseData[i] = Math.random() * 2 - 1;

    // --- Schedule all notes ---
    // We drive the same synthesis functions but with the offline context and
    // offline part gains. To avoid duplicating hundreds of lines, we temporarily
    // swap audioContext / partGains / _noiseBuffer, schedule everything, then
    // restore. This is safe because the offline render is synchronous after
    // startRendering() — no interleaved live playback can occur.
    const savedCtx         = this.audioContext;
    const savedPartGains   = this.partGains;
    const savedNoiseBuffer = this._noiseBuffer;
    const savedStartTime   = this.startTime;
    const savedScheduledNodes = this.scheduledNodes;
    const savedVocalPhraseNodes = this.vocalPhraseNodes;

    this.audioContext     = offlineCtx;
    this.partGains        = offlinePartGains;
    this._noiseBuffer     = noiseBuffer;
    this.startTime        = 0;           // t=0 on the offline timeline
    this.scheduledNodes   = [];
    this.vocalPhraseNodes = new Map();

    const lead = 0.05; // small lead so t=0 notes aren't dropped
    for (const event of schedule) {
      const playbackStartBeat = event.playbackStartBeat ?? event.startBeat;
      const noteStartTime = lead + beatToTime(playbackStartBeat, this.tempo);
      const playbackDuration = event.playbackDurationBeats ?? event.durationBeats;
      const baseDuration = beatToTime(playbackDuration, this.tempo);
      const overlap = event.legatoToNext ? Math.min(0.045, baseDuration * 0.12) : 0;
      const articulation = {
        legato: event.legato,
        legatoFromPrevious: event.legatoFromPrevious,
        legatoToNext: event.legatoToNext,
        fermata: !!event.fermata
      };
      const timing = {
        eventIndex: null,
        playbackStartBeat,
        playbackEndBeat: playbackStartBeat + playbackDuration,
        playbackDurationBeats: playbackDuration,
        legatoToNext: !!event.legatoToNext,
        vocalPhraseId: event.vocalPhraseId,
        vocalPhraseStartPlaybackBeat: event.vocalPhraseStartPlaybackBeat,
        vocalPhraseEndPlaybackBeat: event.vocalPhraseEndPlaybackBeat
      };
      this.dispatchNote(event.partId, event.frequency, noteStartTime, baseDuration + overlap, articulation, timing);
    }

    // Restore live state before awaiting so the UI remains responsive
    this.audioContext     = savedCtx;
    this.partGains        = savedPartGains;
    this._noiseBuffer     = savedNoiseBuffer;
    this.startTime        = savedStartTime;
    this.scheduledNodes   = savedScheduledNodes;
    this.vocalPhraseNodes = savedVocalPhraseNodes;

    // Progress polling — OfflineAudioContext fires oncomplete when done
    let progressTimer = null;
    if (onProgress) {
      progressTimer = setInterval(() => {
        // currentTime on an offline context advances as it renders
        const ratio = Math.min(1, offlineCtx.currentTime / totalSeconds);
        onProgress(ratio);
      }, 200);
    }

    const rendered = await offlineCtx.startRendering();
    if (progressTimer) {
      clearInterval(progressTimer);
      if (onProgress) onProgress(1);
    }
    return rendered;
  }

  /**
   * Encode an AudioBuffer to a WAV Blob (PCM 16-bit stereo).
   * @param {AudioBuffer} audioBuffer
   * @returns {Blob}
   */
  static audioBufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate  = audioBuffer.sampleRate;
    const numSamples  = audioBuffer.length;
    const bytesPerSample = 2; // 16-bit PCM
    const dataLength  = numSamples * numChannels * bytesPerSample;
    const buffer      = new ArrayBuffer(44 + dataLength);
    const view        = new DataView(buffer);

    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    const writeUint16 = (offset, v) => view.setUint16(offset, v, true);
    const writeUint32 = (offset, v) => view.setUint32(offset, v, true);

    // RIFF header
    writeString(0,  'RIFF');
    writeUint32(4,  36 + dataLength);
    writeString(8,  'WAVE');
    writeString(12, 'fmt ');
    writeUint32(16, 16);                            // chunk size
    writeUint16(20, 1);                             // PCM format
    writeUint16(22, numChannels);
    writeUint32(24, sampleRate);
    writeUint32(28, sampleRate * numChannels * bytesPerSample); // byte rate
    writeUint16(32, numChannels * bytesPerSample);  // block align
    writeUint16(34, 16);                            // bits per sample
    writeString(36, 'data');
    writeUint32(40, dataLength);

    // Interleaved PCM samples — clamp and convert float32 → int16
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Cleanup and release resources.
   */
  dispose() {
    this.stop();
    this.stopLookaheadScheduler();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
