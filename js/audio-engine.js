/**
 * Web Audio playback engine.
 *
 * Turns a parsed score into sound. Three synthesis paths share one scheduler:
 *
 *   vocal       Each part is a *section* of singers. A glottal pulse source
 *               feeds a cascade of peaking filters that impose vowel formants,
 *               with per-singer detune, independent vibrato and shared pitch
 *               drift. Contiguous non-staccato notes keep one continuous source
 *               so a phrase glides instead of re-attacking on every note.
 *   tone        A clean, stable reference pitch for ear training.
 *   piano       Inharmonic struck-string model for accompaniment staves.
 *
 * Everything lands on a shared output bus: per-part tone and pan, a convolution
 * room, gentle glue compression and a soft-clip ceiling. The bus is built by
 * the same code for live playback and for offline WAV export, so an export
 * sounds like what the singer just heard.
 *
 * Timing note: notes are placed on a "playback" timeline built by
 * js/playback-timeline.js, which expands the written score by its repeats and
 * fermata holds and projects the written tempo map onto it. Score beats drive
 * the cursor; playback beats drive the audio clock. The two are no longer the
 * same shape, because a repeated bar has one score position and several
 * playback positions, so every conversion goes through the timeline.
 */

import {
  STANDARD_TUNING_HZ,
  midiToFrequency,
  noteToMidi,
  pitchToMidi
} from './utils.js';
import { buildPlaybackTimeline } from './playback-timeline.js';
import { tempoScale } from './tempo-map.js';
import {
  DEFAULT_VELOCITY,
  accentMultiplier,
  buildPartDynamics,
  velocityAt
} from './dynamics.js';
import {
  formantsFor,
  glottalHarmonics,
  harmonicCountFor,
  profileFor,
  registerPosition,
  resolveVoiceClass,
  vowelFromSyllable
} from './timbre.js';

/**
 * How much of its written value a note actually sounds for.
 *
 * The gap a detached articulation leaves is the articulation, so shortening the
 * note is how it is realised rather than something to be ignored.
 *
 * @param {{staccato?: boolean, staccatissimo?: boolean, strongAccent?: boolean}} event
 * @returns {number} 0..1
 */
export function articulationLengthFactor(event = {}) {
  if (event.staccatissimo) return 0.35;
  if (event.staccato) return 0.55;
  // Marcato is a hard, slightly detached attack rather than a full-length note.
  if (event.strongAccent) return 0.82;
  return 1;
}

/**
 * Loudness multiplier at the start of a note, 1 meaning the unmarked level.
 * @param {object} [articulation]
 * @returns {number}
 */
export function dynamicLevel(articulation = {}) {
  const level = Number(articulation.velocity);
  return Number.isFinite(level) && level > 0 ? level : 1;
}

/**
 * Loudness multiplier a note should arrive at, for a note inside a hairpin.
 * Falls back to the starting level, which holds the note steady.
 * @param {object} [articulation]
 * @returns {number}
 */
export function dynamicEndLevel(articulation = {}) {
  const level = Number(articulation.velocityEnd);
  return Number.isFinite(level) && level > 0 ? level : dynamicLevel(articulation);
}

/**
 * Hold or ramp a gain across the sustain part of an envelope.
 *
 * A note whose level does not change is held flat, exactly as before. One inside
 * a hairpin is ramped, so a crescendo is audible across a long note instead of
 * only stepping between one note and the next.
 *
 * @param {AudioParam} gainParam
 * @param {number} fromGain
 * @param {number} toGain
 * @param {number} fromTime
 * @param {number} toTime
 */
export function rampSustain(gainParam, fromGain, toGain, fromTime, toTime) {
  if (toTime <= fromTime + 1e-4) {
    gainParam.setValueAtTime(fromGain, Math.max(fromTime, toTime));
    return;
  }
  if (Math.abs(toGain - fromGain) < 1e-4) {
    gainParam.setValueAtTime(fromGain, toTime);
    return;
  }
  gainParam.linearRampToValueAtTime(toGain, toTime);
}

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
const FERMATA_DURATION_MULTIPLIER = 2;

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

/* ================================================================== levels */

/**
 * Gain staging. These are the numbers to reach for when the mix is too loud,
 * too quiet, or one path sticks out against another.
 *
 * The chain per note is: source RMS → formant trim → note peak → part volume
 * → master. Sources are RMS-normalized rather than peak-normalized so that
 * loudness stays even across the range instead of falling away in the bass.
 */
const GLOTTAL_RMS = 0.30;      // RMS of one singer's raw glottal source
const FORMANT_TRIM = 0.50;     // compensates the cascaded formant boosts
const VOCAL_PEAK_GAIN = 0.55;  // envelope peak for a voice part
const TONE_PEAK_GAIN = 0.38;   // envelope peak for the reference-tone mode
const PIANO_PEAK_GAIN = 0.26;  // envelope peak for accompaniment staves
const MASTER_LEVEL = 0.82;     // final output trim after the ceiling
const DEFAULT_PART_VOLUME = 0.8;

/** Reverb send multiplier at 100% room. Wet:dry lands near 0.75 at the top. */
const ROOM_WET_MAX = 2.5;
/** Room amount 0..1, matching the default of the Room control. */
const DEFAULT_ROOM_AMOUNT = 0.34;

/** Relative detune positions for a section, scaled by SECTION_DETUNE_CENTS. */
const SECTION_SPREAD = {
  1: [0],
  2: [-1, 1],
  3: [-1, 0.1, 1],
  4: [-1, -0.34, 0.34, 1]
};
const SECTION_DETUNE_CENTS = 7;

/* =========================================================== bus components */

/**
 * Build a soft-clip transfer curve for the output ceiling.
 *
 * The curve is exactly linear below the knee, so ordinary material passes
 * through untouched, and saturates smoothly above it. A plain tanh curve (what
 * this used to be) starts bending at low levels and audibly dulls every dense
 * chord.
 *
 * @param {number} [knee] - amplitude below which the curve is transparent
 * @returns {Float32Array}
 */
function buildSoftClipCurve(knee = 0.72) {
  const samples = 8192;
  const curve = new Float32Array(samples);
  const span = 1 - knee;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    const magnitude = Math.abs(x);
    const shaped = magnitude <= knee
      ? magnitude
      : knee + span * Math.tanh((magnitude - knee) / span);
    curve[i] = Math.sign(x) * shaped;
  }
  return curve;
}

/**
 * Synthesize a stereo room impulse response.
 *
 * A handful of discrete early reflections give the ear the size of the room,
 * then a diffuse noise tail decays exponentially while being progressively
 * low-passed, because high frequencies are absorbed faster than low ones.
 * The result is normalized by its L2 norm, which is the convolution gain for
 * broadband input, so the wet level does not change when the decay length does.
 *
 * @param {BaseAudioContext} ctx
 * @param {{seconds?: number, preDelay?: number}} [options]
 * @returns {AudioBuffer}
 */
function buildRoomImpulse(ctx, { seconds = 2.4, preDelay = 0.016 } = {}) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(2, length, rate);
  const reflections = [
    { time: 0.0000, gain: 0.90 },
    { time: 0.0091, gain: -0.62 },
    { time: 0.0143, gain: 0.55 },
    { time: 0.0217, gain: -0.44 },
    { time: 0.0298, gain: 0.36 },
    { time: 0.0411, gain: -0.28 }
  ];

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    // Offsetting one channel decorrelates the two sides, which is what makes
    // the tail sound wide rather than like a mono blob in the middle.
    const offset = Math.floor((preDelay + channel * 0.0023) * rate);

    let smoothed = 0;
    for (let i = offset; i < length; i++) {
      const elapsed = (i - offset) / rate;
      const progress = elapsed / seconds;
      const decay = Math.exp(-6.9 * progress); // about -60 dB at `seconds`
      const coefficient = 0.72 - 0.58 * Math.min(1, progress * 1.4);
      smoothed += coefficient * ((Math.random() * 2 - 1) - smoothed);
      data[i] = smoothed * decay;
    }
    for (const reflection of reflections) {
      const index = offset + Math.floor(reflection.time * rate);
      if (index < length) data[index] += reflection.gain * (channel === 0 ? 1 : 0.86);
    }

    // One gentle pole softens the reflection taps, which would otherwise read
    // as bright clicks rather than as walls.
    let previous = 0;
    for (let i = 0; i < length; i++) {
      previous += 0.6 * (data[i] - previous);
      data[i] = previous;
    }

    let energy = 0;
    for (let i = 0; i < length; i++) energy += data[i] * data[i];
    const norm = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i++) data[i] *= norm;
  }

  return buffer;
}

/** Stop a set of scheduled sources, ignoring any that already stopped. */
function stopSources(sources, time) {
  for (const source of sources || []) {
    try {
      source.stop(time);
    } catch (error) { /* already stopped */ }
  }
}

/** Disconnect a set of nodes, ignoring any that are already detached. */
function disconnectAll(nodes) {
  for (const node of nodes || []) {
    try {
      node.disconnect();
    } catch (error) { /* already disconnected */ }
  }
}

/**
 * AudioEngine - schedules and synthesizes score playback.
 */
export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.parts = [];
    this.partIndex = new Map();       // partId -> part
    this.partVolumeLevels = new Map(); // partId -> intended volume (0-1)
    this.partMuted = new Map();       // partId -> boolean
    this.partSoloed = new Set();      // partIds currently soloed
    this.masterLevel = 1;             // overall output trim, 0-1
    this.transposeSemitones = 0;      // singer's own transposition
    this.tuningHz = STANDARD_TUNING_HZ;
    this.sectionSize = 3;             // singers synthesized per voice part
    this.roomAmount = DEFAULT_ROOM_AMOUNT;

    // A render target bundles the context, its output bus, per-part inputs and
    // the buffers/waves cached for it. Live playback and offline export each
    // get one, which is what keeps an exported file identical to playback.
    this.live = this.createRenderTarget(null);
    this.target = this.live;

    this.tempo = 120;
    this.isPlaying = false;
    this.isPaused = false;
    this.startTime = 0;
    this.pauseTime = 0;
    this.pausePlaybackBeat = 0;
    this.currentBeat = 0;
    this.trackingFloorPlaybackBeat = 0;
    this.scheduledNodes = [];
    this.lookaheadTime = 0.1;   // seconds of scheduling lookahead
    this.scheduleInterval = 25; // ms between scheduling passes
    this.startLead = 0.08;      // seconds before the first note sounds
    this.schedulerTimer = null;
    this.onBeatUpdate = null;   // callback(currentBeat)
    this.onPlaybackEnd = null;  // callback when playback reaches the end
    this.onLoopEnd = null;      // callback when a loop range wants to repeat
    /**
     * Rehearsal loop, in performance positions. Null means loop the whole
     * performance. Stored in playback beats rather than score beats because a
     * repeated bar has one score position and several performance positions,
     * and the singer means the one they were listening to.
     */
    this.loopRange = null;
    this.animationFrame = null;
    this.schedule = [];
    this.scheduleIndex = 0;
    this.preservedEventIndices = new Set();
    this.fermataMultiplier = FERMATA_DURATION_MULTIPLIER;
    this.fermataHolds = [];
    this.synthMode = 'vocal'; // 'oscillator' or 'vocal'

    // Score structure supplied by the parser: the written tempo map and the
    // order bars are performed in. Held separately from `parts` so a score can
    // be re-timed without being re-parsed.
    this.scoreStructure = { tempoMap: [], measures: [], order: null };
    /** Play written repeats. Turning this off rehearses the page as printed. */
    this.playRepeats = true;
    /** Follow the written dynamics. Off gives one steady level throughout. */
    this.followDynamics = true;
    /** Bars counted in before the music starts. */
    this.countInBars = 0;
    this.timeline = buildPlaybackTimeline({});
  }

  /* =====================================================================
     Timeline
     ===================================================================== */

  /**
   * Attach the score structure the timeline needs.
   *
   * Called with the parser's metadata. Safe to call with nothing, in which case
   * the score plays straight through at a steady tempo.
   *
   * @param {object|null} metadata
   */
  setScoreStructure(metadata) {
    this.scoreStructure = {
      tempoMap: Array.isArray(metadata?.tempoMap) ? metadata.tempoMap : [],
      measures: Array.isArray(metadata?.measureStructure) ? metadata.measureStructure : [],
      order: Array.isArray(metadata?.repeatPlan?.order) ? metadata.repeatPlan.order : null
    };
    this.rebuildTimeline();
  }

  /* =====================================================================
     Count-in
     ===================================================================== */

  /**
   * Number of bars to count in before the music starts. Zero disables it.
   * @param {number} bars
   */
  setCountInBars(bars) {
    const value = Math.round(Number(bars) || 0);
    this.countInBars = Math.max(0, Math.min(4, value));
  }

  /**
   * Length of the count-in in beats.
   *
   * Counted in the bar the music is about to start from rather than a fixed
   * four, so starting mid-piece in 6/8 counts six eighths and not four quarters.
   *
   * @returns {number} quarter-note beats
   */
  getCountInBeats() {
    if (this.countInBars <= 0) return 0;
    const measures = this.scoreStructure.measures;
    const scoreBeat = this.currentBeat;
    const measure = measures.find(candidate => {
      const start = Number(candidate.startBeat) || 0;
      const length = Number(candidate.beats) || 0;
      return scoreBeat >= start - 1e-6 && scoreBeat < start + length - 1e-6;
    }) || measures[0];

    const barBeats = Number(measure?.beats) > 0 ? Number(measure.beats) : 4;
    return barBeats * this.countInBars;
  }

  /**
   * Length of the count-in in seconds, at the tempo where the music begins.
   * @returns {number}
   */
  getCountInSeconds() {
    const beats = this.getCountInBeats();
    if (beats <= 0) return 0;
    const startPlaybackBeat = this.getPlaybackBeat(this.currentBeat);
    return beats * this.timeline.secondsPerBeatAt(startPlaybackBeat);
  }

  /** Follow or ignore the written dynamic markings. */
  setFollowDynamics(enabled) {
    this.followDynamics = Boolean(enabled);
  }

  /* =====================================================================
     Rehearsal loop
     ===================================================================== */

  /**
   * Set the loop range from two performance positions.
   *
   * The order the singer marked them in does not matter, and a range with no
   * length is treated as no range at all rather than as a zero-length loop that
   * would spin on the spot.
   *
   * @param {number|null} startPlaybackBeat
   * @param {number|null} endPlaybackBeat
   */
  setLoopRange(startPlaybackBeat, endPlaybackBeat) {
    const total = this.getTotalPlaybackBeats();
    const first = Number(startPlaybackBeat);
    const second = Number(endPlaybackBeat);
    if (!Number.isFinite(first) || !Number.isFinite(second)) {
      this.loopRange = null;
      return;
    }

    const start = Math.max(0, Math.min(total, Math.min(first, second)));
    const end = Math.max(0, Math.min(total, Math.max(first, second)));
    // A quarter note is the shortest loop worth having; anything shorter is a
    // mis-click rather than an intention.
    this.loopRange = end - start > 0.25 ? { start, end } : null;
  }

  /** Remove the loop range, so looping covers the whole performance again. */
  clearLoopRange() {
    this.loopRange = null;
  }

  /** The active loop range, or null when the whole performance is the loop. */
  getLoopRange() {
    return this.loopRange ? { ...this.loopRange } : null;
  }

  /** Performance position a loop pass should end at, or null for the score end. */
  getLoopEndPlaybackBeat() {
    return this.loopRange ? this.loopRange.end : null;
  }

  /** Performance position a loop pass should start from. */
  getLoopStartPlaybackBeat() {
    return this.loopRange ? this.loopRange.start : 0;
  }

  /** Play or ignore the written repeat signs. */
  setPlayRepeats(enabled) {
    const next = Boolean(enabled);
    if (next === this.playRepeats) return;
    this.playRepeats = next;
    this.rebuildTimeline();
  }

  /**
   * Rebuild the playback timeline from the current score, holds and tempo.
   *
   * Anything that changes the shape of the performance has to go through here:
   * the fermata length, the repeat setting, or a new score.
   */
  rebuildTimeline() {
    this.fermataHolds = collectFermataHolds(this.parts, this.fermataMultiplier);
    const measures = this.scoreStructure.measures.length
      ? this.scoreStructure.measures
      : this.measuresFromParts();

    this.timeline = buildPlaybackTimeline({
      measures,
      order: this.playRepeats ? this.scoreStructure.order : null,
      tempoMap: this.scoreStructure.tempoMap,
      fermataHolds: this.fermataHolds,
      totalScoreBeats: this.getTotalBeats(),
      scale: tempoScale(this.tempo, this.scoreStructure.tempoMap[0]?.bpm ?? this.tempo)
    });
    return this.timeline;
  }

  /**
   * Derive measure boundaries from the parts when the parser did not supply
   * them, so a score loaded by an older code path still lays out correctly.
   * @returns {Array<{startBeat: number, beats: number}>}
   */
  measuresFromParts() {
    const longest = this.parts.reduce(
      (best, part) => ((part.measures?.length || 0) > (best?.measures?.length || 0) ? part : best),
      null
    );
    return (longest?.measures || []).map(measure => ({
      startBeat: Number(measure.startBeat) || 0,
      beats: Number(measure.beats) || 0
    }));
  }

  /** The tempo the timeline treats as "written", used to derive the scale. */
  getBaseTempo() {
    return this.scoreStructure.tempoMap[0]?.bpm ?? this.tempo;
  }

  /* =====================================================================
     Graph construction
     ===================================================================== */

  /**
   * Create an empty render target for a context.
   * @param {BaseAudioContext|null} ctx
   */
  createRenderTarget(ctx) {
    return {
      ctx,
      bus: null,
      partGains: new Map(),  // partId -> input GainNode
      partChains: new Map(), // partId -> nodes to release with the score
      phraseNodes: new Map(), // vocal phrase id -> continuous voice node
      noiseBuffer: null,
      driftBuffer: null,
      waves: new Map()
    };
  }

  /**
   * Build the shared output bus.
   *
   * Signal flow:
   *   parts (dry) → rumble filter → glue compressor ┐
   *   parts (send) → room convolver → wet level ────┤→ ceiling → master → out
   *   metronome ────────────────────────────────────┘
   *
   * Reverb and the metronome deliberately bypass the compressor: a dense
   * reverb tail otherwise pumps the whole ensemble, and a click that hits the
   * compressor ducks the voices on every beat.
   *
   * @param {BaseAudioContext} ctx
   */
  createOutputBus(ctx) {
    const dry = ctx.createGain();
    dry.gain.value = 1;

    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 30;
    rumble.Q.value = 0.7;

    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 14;
    glue.ratio.value = 2.2;
    glue.attack.value = 0.012;
    glue.release.value = 0.24;

    const send = ctx.createGain();
    send.gain.value = 1;

    const convolver = ctx.createConvolver();
    convolver.normalize = false; // the impulse response is normalized already
    convolver.buffer = buildRoomImpulse(ctx);

    const wet = ctx.createGain();
    wet.gain.value = this.roomAmount * ROOM_WET_MAX;

    const click = ctx.createGain();
    click.gain.value = 1;

    const sum = ctx.createGain();
    sum.gain.value = 1;

    const ceiling = ctx.createWaveShaper();
    ceiling.curve = buildSoftClipCurve();
    ceiling.oversample = '4x';

    const master = ctx.createGain();
    master.gain.value = MASTER_LEVEL;

    dry.connect(rumble);
    rumble.connect(glue);
    glue.connect(sum);
    send.connect(convolver);
    convolver.connect(wet);
    wet.connect(sum);
    click.connect(sum);
    sum.connect(ceiling);
    ceiling.connect(master);
    master.connect(ctx.destination);

    return {
      dry,
      send,
      wet,
      click,
      master,
      nodes: [dry, rumble, glue, send, convolver, wet, click, sum, ceiling, master]
    };
  }

  /**
   * Initialize the live AudioContext and output bus.
   * Must be called from a user gesture for `resume` to succeed.
   * @param {{resume?: boolean}} [options]
   */
  async init({ resume = true } = {}) {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.live.ctx = this.audioContext;
      this.live.bus = this.createOutputBus(this.audioContext);
      // Kept for callers that reach for the master node directly.
      this.masterGain = this.live.bus.dry;
    }
    if (resume && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  /**
   * Build the per-part signal chain on a render target.
   *
   * Per part: volume → low shelf → high shelf → pan → bus dry, plus a
   * post-pan reverb send so muting a part also mutes its share of the room.
   *
   * @param {object} target
   * @param {Array} parts
   * @param {(partId: string) => number} levelFor - initial gain, 0..1
   */
  buildPartChains(target, parts, levelFor) {
    const ctx = target.ctx;
    if (!ctx || !target.bus) return;

    for (const part of parts) {
      if (target.partGains.has(part.id)) continue;
      const profile = profileFor(this.voiceClassForPart(part));

      const input = ctx.createGain();
      input.gain.value = Math.max(0, Math.min(1, levelFor(part.id)));

      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = profile.lowShelf.freq;
      lowShelf.gain.value = profile.lowShelf.gain;

      const highShelf = ctx.createBiquadFilter();
      highShelf.type = 'highshelf';
      highShelf.frequency.value = profile.highShelf.freq;
      highShelf.gain.value = profile.highShelf.gain;

      const panner = ctx.createStereoPanner();
      panner.pan.value = profile.pan;

      const send = ctx.createGain();
      send.gain.value = profile.reverb;

      input.connect(lowShelf);
      lowShelf.connect(highShelf);
      highShelf.connect(panner);
      panner.connect(target.bus.dry);
      panner.connect(send);
      send.connect(target.bus.send);

      target.partGains.set(part.id, input);
      target.partChains.set(part.id, [input, lowShelf, highShelf, panner, send]);
    }
  }

  /** Resolve the synthesis voice class for a part object. */
  voiceClassForPart(part) {
    if (!part) return 'default';
    return part.isPiano ? 'piano' : resolveVoiceClass(part.voiceType);
  }

  /**
   * Set the reverb amount.
   * @param {number} percent - 0 to 100
   */
  setRoomAmount(percent) {
    const amount = Math.max(0, Math.min(1, (Number(percent) || 0) / 100));
    this.roomAmount = amount;
    const wet = this.live.bus?.wet;
    if (wet && this.audioContext) {
      wet.gain.setTargetAtTime(amount * ROOM_WET_MAX, this.audioContext.currentTime, 0.05);
    }
  }

  /**
   * Set the fermata duration multiplier and recalculate holds.
   * @param {number} multiplier - e.g. 1.5 means 50% longer, 2 means double
   */
  setFermataMultiplier(multiplier) {
    this.fermataMultiplier = Math.max(1, multiplier);
    // Holds change the length of the performance, so the timeline is rebuilt.
    this.rebuildTimeline();
  }

  /**
   * Set the parts data and create the mixer chain for each part.
   * @param {Array} parts - parsed parts from the MusicXML parser
   */
  setParts(parts) {
    this.parts = parts;
    this.partIndex = new Map(parts.map(part => [part.id, part]));
    this.rebuildTimeline();

    // A small ensemble can afford a fuller section per part; a divisi score
    // with many staves needs to keep the node count down.
    const voiceParts = parts.filter(part => !part.isPiano).length;
    this.sectionSize = voiceParts <= 4 ? 3 : 2;

    for (const part of parts) {
      if (!this.partVolumeLevels.has(part.id)) {
        this.partVolumeLevels.set(part.id, DEFAULT_PART_VOLUME);
        this.partMuted.set(part.id, false);
      }
    }
    this.buildPartChains(
      this.live,
      parts,
      partId => this.partVolumeLevels.get(partId) ?? DEFAULT_PART_VOLUME
    );
  }

  /**
   * Set volume for a specific part.
   * @param {string} partId
   * @param {number} volume - 0 to 100
   */
  setPartVolume(partId, volume) {
    const gainNode = this.live.partGains.get(partId);
    const normalizedVolume = Math.max(0, Math.min(1, volume / 100));
    this.partVolumeLevels.set(partId, normalizedVolume);
    if (!gainNode || !this.audioContext) return;
    // A muted part keeps its stored level so unmuting restores it exactly.
    if (!this.partMuted.get(partId)) {
      gainNode.gain.setTargetAtTime(normalizedVolume, this.audioContext.currentTime, 0.015);
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
   * Solo or unsolo a part.
   *
   * Solo is a faster way to say "just this line" than muting everything else,
   * and it is temporary: clearing it puts the singer's own mute choices back
   * exactly as they were, which is why mute state is never overwritten here.
   *
   * @param {string} partId
   * @param {boolean} soloed
   */
  setPartSoloed(partId, soloed) {
    if (soloed) this.partSoloed.add(partId);
    else this.partSoloed.delete(partId);
    this.updatePartAudibility();
  }

  /** Drop every solo, restoring the mute choices underneath. */
  clearSolo() {
    if (this.partSoloed.size === 0) return;
    this.partSoloed.clear();
    this.updatePartAudibility();
  }

  /** True while any part is soloed. */
  hasSolo() {
    return this.partSoloed.size > 0;
  }

  /** Reapply every part's gain from its volume, mute and solo state. */
  updatePartAudibility() {
    if (!this.audioContext) return;
    const now = this.audioContext.currentTime;
    for (const partId of this.live.partGains.keys()) {
      const gainNode = this.live.partGains.get(partId);
      gainNode.gain.setTargetAtTime(this.getEffectivePartVolume(partId), now, 0.015);
    }
  }

  /**
   * Audible gain for a part, honouring solo first and then mute.
   *
   * Solo overrides mute rather than combining with it: asking to hear one line
   * on its own should work even if that line happened to be muted.
   *
   * @param {string} partId
   * @returns {number} 0..1
   */
  getEffectivePartVolume(partId) {
    const intended = this.partVolumeLevels.get(partId) ?? DEFAULT_PART_VOLUME;
    if (this.partSoloed.size > 0) {
      return this.partSoloed.has(partId) ? intended : 0;
    }
    if (this.partMuted.get(partId)) return 0;
    return intended;
  }

  /**
   * Set the overall output level.
   * @param {number} percent 0 to 100
   */
  setMasterVolume(percent) {
    const level = Math.max(0, Math.min(1, (Number(percent) || 0) / 100));
    this.masterLevel = level;
    const master = this.live.bus?.master;
    if (master && this.audioContext) {
      master.gain.setTargetAtTime(MASTER_LEVEL * level, this.audioContext.currentTime, 0.02);
    }
  }

  /**
   * Shift the whole score by a number of semitones.
   *
   * Singers routinely rehearse a piece a tone lower than it is written. The
   * notation is unaffected: only what comes out of the speakers moves.
   *
   * @param {number} semitones
   */
  setTranspose(semitones) {
    const shift = Math.round(Number(semitones) || 0);
    this.transposeSemitones = Math.max(-12, Math.min(12, shift));
  }

  /**
   * Set the tuning reference for A4 in hertz.
   *
   * Choirs that tune to something other than 440 need the reference pitch to
   * match, otherwise the app and the room disagree by a few cents all evening.
   *
   * @param {number} hertz
   */
  setTuning(hertz) {
    const reference = Number(hertz);
    this.tuningHz = Number.isFinite(reference) && reference > 0
      ? Math.max(390, Math.min(490, reference))
      : STANDARD_TUNING_HZ;
  }

  /**
   * The MIDI note a written note actually sounds as.
   *
   * Two shifts stack here: the part's own transposition, which is a property of
   * the score, and the singer's, which is a rehearsal choice.
   *
   * @param {number} writtenMidi
   * @param {number} [partSemitones] the part's declared transposition
   * @returns {number}
   */
  soundingMidi(writtenMidi, partSemitones = 0) {
    return writtenMidi + partSemitones + this.transposeSemitones;
  }

  /**
   * Frequency for a MIDI note under the current tuning.
   * @param {number} midi
   * @returns {number} hertz
   */
  frequencyForMidi(midi) {
    return midiToFrequency(midi, this.tuningHz);
  }

  /**
   * Set the playback tempo.
   * If playing, re-anchors the transport so the current beat position is
   * preserved and future notes are scheduled at the new tempo.
   * @param {number} bpm
   */
  setTempo(bpm) {
    const newTempo = Math.max(40, Math.min(240, bpm));
    if (newTempo === this.tempo) return;
    const newScale = tempoScale(newTempo, this.getBaseTempo());

    if (this.isPlaying && this.audioContext) {
      // Re-anchor the transport at one exact AudioContext timestamp so the
      // current playback beat remains continuous across the tempo change.
      const now = this.audioContext.currentTime;
      const elapsed = now - this.startTime;
      const currentPlaybackBeat = Math.max(0, this.timeline.secondsToBeat(elapsed));
      this.currentBeat = this.timeline.playbackBeatToScoreBeat(currentPlaybackBeat);

      // The rehearsal tempo is a scale on the written map, so changing it
      // rescales every remaining note rather than replacing one constant.
      this.timeline.setScale(newScale);
      this.startTime = now - this.timeline.beatToSeconds(currentPlaybackBeat);

      // Keep voices that are already sounding. Re-time their remaining
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
            this.retimeActiveNode(node, now, currentPlaybackBeat);
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
      this.timeline.setScale(newScale);
      // Keep the paused resume point at the same musical position.
      this.pauseTime = this.timeline.beatToSeconds(this.pausePlaybackBeat);
    }
  }

  /* =====================================================================
     Schedule building
     ===================================================================== */

  /**
   * Build a schedule of all notes with their start times and durations.
   * @returns {Array} playable events on the fermata-expanded timeline
   */
  buildSchedule() {
    const schedule = [];
    // The timeline decides where every note lands, so make sure it reflects the
    // parts and hold length currently loaded before anything is placed on it.
    this.rebuildTimeline();

    for (const part of this.parts) {
      const activeSlurs = new Set();
      // A melisma holds one syllable across several notes, so the vowel
      // carries forward until the next lyric appears.
      let currentVowel = 'a';

      for (const measure of part.measures) {
        const measureStart = measure.startBeat || 0;
        for (const note of measure.notes) {
          const lyricText = note.lyric?.text;
          if (lyricText && String(lyricText).trim()) {
            currentVowel = vowelFromSyllable(lyricText, currentVowel);
          }

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
            // Resolve the note to a MIDI number first. Working from
            // step + alter + octave is robust to accidentals like E#, B# and
            // double sharps and flats that have no entry in a note-name table.
            let midi = null;
            try {
              const p = note.pitch;
              midi = p.step !== undefined
                ? pitchToMidi(p.step, p.alter || 0, p.octave)
                : noteToMidi(p.noteName, p.octave);
            } catch (err) {
              console.warn('Skipping note with unresolved pitch:', note.pitch, err.message);
              midi = null;
            }

            // A transposing part writes one pitch and sounds another. The
            // renderer keeps the written pitch, so the shift belongs here,
            // alongside the singer's own transposition and tuning reference.
            const partTranspose = Number(part.transpose?.semitones) || 0;
            // The event carries the sounding pitch, not the written one, so the
            // synthesis picks the right register for what is actually heard.
            const soundingMidi = midi === null
              ? null
              : this.soundingMidi(midi, partTranspose);
            const frequency = soundingMidi === null
              ? null
              : this.frequencyForMidi(soundingMidi);

            if (frequency && frequency > 0) {
              schedule.push({
                partId: part.id,
                frequency,
                midi: soundingMidi,
                vowel: currentVowel,
                startBeat: measureStart + (note.startBeatInMeasure || 0),
                durationBeats: note.durationBeats,
                voice: note.voice ?? null,
                tieStart: !!(note.tie && note.tie.start),
                tieStop: !!(note.tie && note.tie.stop),
                staccato: !!note.staccato,
                staccatissimo: !!note.staccatissimo,
                accent: !!note.accent,
                strongAccent: !!note.strongAccent,
                tenuto: !!note.tenuto,
                // A dynamic marking written on the note itself, rather than as
                // a separate direction below the staff.
                noteVelocity: note.noteDynamics?.velocity ?? null,
                noteAccent: note.noteDynamics?.accent ?? null,
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

    // Loudness is resolved after tying, so a note tied across a hairpin is one
    // sound that grows rather than two sounds at two levels.
    this.applyDynamics(merged);

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

        // Phrase bounds stay in score coordinates here. They are converted to
        // performance positions during expansion, because a phrase inside a
        // repeated section is a different phrase on each pass.
        const phraseStartBeat = first.startBeat;
        const phraseEndBeat = phraseEvents[phraseEvents.length - 1].startBeat +
          phraseEvents[phraseEvents.length - 1].durationBeats;
        const phraseKey = `${first.partId}:${phraseStartBeat.toFixed(6)}:${phraseCounter++}`;
        for (const event of phraseEvents) {
          event.vocalPhraseKey = phraseKey;
          event.vocalPhraseStartBeat = phraseStartBeat;
          event.vocalPhraseEndBeat = phraseEndBeat;
        }
      }
    }

    return this.expandScheduleToPerformance(merged);
  }

  /**
   * Place every note on the performance timeline, once per pass through the
   * music that contains it.
   *
   * Up to this point the schedule describes the written page: one entry per
   * note, positioned in score beats. The performance can visit a stretch of the
   * page more than once and skip other stretches entirely, so this is where a
   * note in a repeated section becomes two sounding events and a note inside a
   * first-time-only ending becomes one or none.
   *
   * A note is placed by the pass that contains its onset. Its length is measured
   * through the timeline, so any fermata inside it lengthens it, and it is
   * clipped at the end of the pass so a note near a repeat sign cannot bleed
   * over the music that follows the jump.
   *
   * @param {Array} events schedule entries in score coordinates
   * @returns {Array} schedule entries in performance coordinates
   */
  expandScheduleToPerformance(events) {
    const timeline = this.timeline;
    const ranges = timeline.ranges;
    const expanded = [];

    for (const range of ranges) {
      const isFinalRange = range.index === ranges.length - 1;

      for (const event of events) {
        // The pass that contains the onset owns the note.
        if (event.startBeat < range.scoreStart - 1e-6) continue;
        if (event.startBeat >= range.scoreEnd - 1e-6) continue;

        const startPlaybackBeat = timeline.onsetPlaybackBeat(range.index, event.startBeat);
        if (startPlaybackBeat === null) continue;

        // Let the last pass run past its nominal end so a final note is not
        // clipped by rounding; anywhere else, the jump cuts it off.
        const scoreEnd = isFinalRange && ranges.length === 1
          ? event.startBeat + event.durationBeats
          : Math.min(event.startBeat + event.durationBeats, range.scoreEnd);
        const endPlaybackBeat = timeline.endPlaybackBeat(range.index, scoreEnd) ??
          startPlaybackBeat;

        const occurrence = ranges.length > 1
          ? { ...event, occurrenceIndex: range.index }
          : event;
        occurrence.playbackStartBeat = startPlaybackBeat;
        occurrence.playbackDurationBeats = Math.max(0, endPlaybackBeat - startPlaybackBeat);

        // A vocal phrase is continuous within one pass only, and is clipped to
        // the pass for the same reason the note is.
        if (occurrence.vocalPhraseKey) {
          const phraseStart = timeline.onsetPlaybackBeat(
            range.index,
            Math.max(range.scoreStart, occurrence.vocalPhraseStartBeat)
          );
          const phraseEnd = timeline.endPlaybackBeat(
            range.index,
            Math.min(range.scoreEnd, occurrence.vocalPhraseEndBeat)
          );
          occurrence.vocalPhraseId = ranges.length > 1
            ? `${occurrence.vocalPhraseKey}#${range.index}`
            : occurrence.vocalPhraseKey;
          occurrence.vocalPhraseStartPlaybackBeat = phraseStart ?? startPlaybackBeat;
          occurrence.vocalPhraseEndPlaybackBeat = phraseEnd ?? endPlaybackBeat;
        }

        expanded.push(occurrence);
      }
    }

    return expanded;
  }

  /**
   * Resolve how loud every note is, from the score's written dynamics.
   *
   * Each note gets a level at its start and a level at its end. When those
   * differ the note is inside a hairpin and its envelope ramps, which is what
   * makes a crescendo audible across a long held note rather than only between
   * one note and the next.
   *
   * Levels are expressed relative to the unmarked default, so a score with no
   * dynamics at all sounds exactly as it did before any of this existed.
   *
   * @param {Array} events schedule entries, in score coordinates
   */
  applyDynamics(events) {
    // Learning the notes is easier at a steady level, so following the written
    // dynamics can be switched off without losing them from the score.
    if (!this.followDynamics) {
      for (const event of events) {
        event.velocity = 1;
        event.velocityEnd = 1;
      }
      return;
    }

    const timelines = new Map();
    for (const part of this.parts) {
      timelines.set(part.id, buildPartDynamics(part));
    }

    for (const event of events) {
      const timeline = timelines.get(event.partId);
      const endBeat = event.startBeat + event.durationBeats;

      const startLevel = event.noteVelocity ??
        (timeline ? velocityAt(timeline, event.startBeat) : DEFAULT_VELOCITY);
      const endLevel = event.noteVelocity ??
        (timeline ? velocityAt(timeline, endBeat) : DEFAULT_VELOCITY);

      // A written accent belongs to the attack, so it lifts the start of the
      // note without changing where a hairpin is heading.
      const emphasis = accentMultiplier({
        accent: event.accent,
        strongAccent: event.strongAccent,
        tenuto: event.tenuto,
        accentVelocity: event.noteAccent
      });

      event.velocity = this.normaliseVelocity(startLevel * emphasis);
      event.velocityEnd = this.normaliseVelocity(endLevel);
    }
  }

  /**
   * Turn a written loudness into a gain multiplier on the synthesis peak.
   *
   * The unmarked default maps to 1, so the levels this engine was tuned at stay
   * exactly where they were, and the range is capped because the output bus
   * would otherwise be pushed into its soft-clip ceiling by a marked fortissimo
   * with an accent on top of it.
   *
   * @param {number} velocity
   * @returns {number}
   */
  normaliseVelocity(velocity) {
    const level = Number(velocity);
    if (!Number.isFinite(level) || level <= 0) return 1;
    return Math.max(0.25, Math.min(1.75, level / DEFAULT_VELOCITY));
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

  /**
   * Where a score position sits in the performance.
   *
   * With repeats a score beat can occur several times, so an optional hint says
   * which pass is wanted: seeking forwards from inside a repeat should not jump
   * back to the first time through.
   *
   * @param {number} scoreBeat
   * @param {{ after?: number }} [options]
   * @returns {number} playback beat
   */
  getPlaybackBeat(scoreBeat, options = {}) {
    return this.timeline.scoreBeatToPlaybackBeat(scoreBeat, options);
  }

  /** Total performance length, including repeats and time held at fermatas. */
  getTotalPlaybackBeats() {
    return this.timeline.totalPlaybackBeats;
  }

  /** Total performance length in seconds at the current rehearsal tempo. */
  getTotalSeconds() {
    return this.timeline.totalSeconds;
  }

  /** Convert a performance position to elapsed seconds. */
  playbackBeatToSeconds(playbackBeat) {
    return this.timeline.beatToSeconds(playbackBeat);
  }

  /** Where the cursor belongs for a performance position. */
  playbackBeatToScoreBeat(playbackBeat) {
    return this.timeline.playbackBeatToScoreBeat(playbackBeat);
  }

  /** Score positions the current performance never reaches. */
  getUnperformedRanges() {
    return this.timeline.unperformedRanges();
  }

  /**
   * Move the transport to a score beat and keep paused/resume coordinates in
   * sync. Callers may use this while stopped or paused.
   *
   * @param {number} scoreBeat
   * @param {{ after?: number }} [options] which repeat pass to resume on
   * @returns {number} clamped score beat
   */
  seek(scoreBeat, options = {}) {
    const totalBeats = this.getTotalBeats();
    this.currentBeat = Math.max(0, Math.min(totalBeats, Number(scoreBeat) || 0));
    this.pausePlaybackBeat = this.getPlaybackBeat(this.currentBeat, options);
    this.pauseTime = this.timeline.beatToSeconds(this.pausePlaybackBeat);
    return this.currentBeat;
  }

  /**
   * Move the transport to a performance position directly.
   *
   * The seek bar measures the performance rather than the page, because with
   * repeats the page position moves backwards partway through.
   *
   * @param {number} playbackBeat
   * @returns {number} the score beat now under the cursor
   */
  seekToPlaybackBeat(playbackBeat) {
    const clamped = Math.max(0, Math.min(this.getTotalPlaybackBeats(), Number(playbackBeat) || 0));
    this.pausePlaybackBeat = clamped;
    this.pauseTime = this.timeline.beatToSeconds(clamped);
    this.currentBeat = this.timeline.playbackBeatToScoreBeat(clamped);
    return this.currentBeat;
  }

  /* =====================================================================
     Transport
     ===================================================================== */

  /** Start or resume playback. */
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
      this.pauseTime = this.timeline.beatToSeconds(currentPlaybackBeat);
      this.startTime = this.audioContext.currentTime - this.pauseTime;
      this.isPaused = false;
    } else {
      // A stopped transport resumes at the pass the caller last selected, so a
      // seek inside a repeat is not undone by pressing play.
      currentPlaybackBeat = this.pausePlaybackBeat > 0 &&
        Math.abs(this.timeline.playbackBeatToScoreBeat(this.pausePlaybackBeat) - this.currentBeat) < 1e-6
        ? this.pausePlaybackBeat
        : this.getPlaybackBeat(this.currentBeat);
      // Add a small lead so the first note lands in the future instead of being
      // dropped by the lookahead scheduler's "already passed" check, plus the
      // count-in, which is simply silence in front of the music.
      this.startTime = this.audioContext.currentTime + this.startLead +
                       this.getCountInSeconds() -
                       this.timeline.beatToSeconds(currentPlaybackBeat);
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

  /** Start the lookahead scheduler that schedules notes within a short window. */
  startLookaheadScheduler() {
    this.stopLookaheadScheduler();
    this.schedulerTimer = setInterval(() => {
      if (!this.isPlaying) return;
      this.scheduleAhead();
      this.cleanupEndedNodes();
    }, this.scheduleInterval);
  }

  /** Stop the lookahead scheduler. */
  stopLookaheadScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /**
   * Describe how one schedule event should be voiced.
   * Shared by live scheduling and offline export so both interpret
   * articulation, staccato shortening and phrase membership identically.
   *
   * @param {object} event - schedule entry
   * @param {number} eventIndex - index into this.schedule, or null offline
   * @returns {{duration: number, articulation: object, timing: object}}
   */
  describeEvent(event, eventIndex) {
    const playbackStartBeat = event.playbackStartBeat ?? event.startBeat;
    const notatedBeats = event.playbackDurationBeats ?? event.durationBeats;
    // An articulation that detaches a note is a shortening, not a marking to be
    // ignored: the note sounds for part of its written value and the silence
    // that follows is the articulation. Marcato is a shorter, harder attack;
    // staccatissimo is shorter still than staccato.
    const soundingBeats = notatedBeats * articulationLengthFactor(event);
    // Measured across the timeline rather than multiplied by one tempo, so a
    // note that straddles a tempo change or a fermata gets the right length.
    const baseDuration = this.timeline.durationSeconds(playbackStartBeat, soundingBeats);
    const overlap = event.legatoToNext ? Math.min(0.045, baseDuration * 0.12) : 0;

    return {
      duration: baseDuration + overlap,
      articulation: {
        legato: event.legato,
        legatoFromPrevious: event.legatoFromPrevious,
        legatoToNext: event.legatoToNext,
        staccato: !!event.staccato,
        staccatissimo: !!event.staccatissimo,
        accent: !!event.accent,
        strongAccent: !!event.strongAccent,
        tenuto: !!event.tenuto,
        fermata: !!event.fermata,
        // Gain multipliers on the synthesis peak, 1 meaning the unmarked level.
        velocity: Number.isFinite(event.velocity) ? event.velocity : 1,
        velocityEnd: Number.isFinite(event.velocityEnd) ? event.velocityEnd : null
      },
      timing: {
        eventIndex,
        midi: event.midi,
        vowel: event.vowel || 'a',
        playbackStartBeat,
        playbackEndBeat: playbackStartBeat + soundingBeats,
        playbackDurationBeats: soundingBeats,
        legatoToNext: !!event.legatoToNext,
        vocalPhraseId: event.vocalPhraseId,
        vocalPhraseStartPlaybackBeat: event.vocalPhraseStartPlaybackBeat,
        vocalPhraseEndPlaybackBeat: event.vocalPhraseEndPlaybackBeat
      }
    };
  }

  /** Schedule notes that fall within the lookahead window. */
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
      const { duration, articulation, timing } = this.describeEvent(event, eventIndex);
      const noteStartTime = this.startTime + this.timeline.beatToSeconds(timing.playbackStartBeat);

      if (noteStartTime > scheduleUntilTime) {
        break; // this note is beyond the lookahead window
      }

      if (noteStartTime >= currentTime - 0.01) {
        this.dispatchNote(
          event.partId,
          event.frequency,
          noteStartTime,
          duration,
          articulation,
          timing
        );
      } else {
        // Resume a note that was sounding at the pause/seek point, including a
        // note sustained through a fermata hold.
        const originalEndTime = noteStartTime + duration;
        if (originalEndTime > currentTime + 0.01) {
          this.dispatchNote(
            event.partId,
            event.frequency,
            currentTime + 0.005,
            originalEndTime - currentTime,
            { ...articulation, legatoFromPrevious: true },
            timing
          );
        }
      }

      this.scheduleIndex++;
    }
  }

  /** Clean up nodes that have finished playing. */
  cleanupEndedNodes() {
    const currentTime = this.audioContext.currentTime;
    this.scheduledNodes = this.scheduledNodes.filter(node => {
      // Ended nodes disconnect themselves through their primary source's
      // onended handler; this only drops the bookkeeping entry.
      return !(node.endTime && currentTime > node.endTime + 0.1);
    });
  }

  /** Pause playback. */
  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.isPaused = true;
    this.pauseTime = this.audioContext.currentTime - this.startTime;
    this.pausePlaybackBeat = Math.max(0, this.timeline.secondsToBeat(this.pauseTime));
    this.stopAllNodes();
    this.stopLookaheadScheduler();
    this.stopBeatTracking();
  }

  /** Stop playback and reset to the beginning. */
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
   * keeping the shared AudioContext, output bus and user preferences alive.
   */
  resetForNewScore() {
    this.stop();

    for (const chain of this.live.partChains.values()) {
      disconnectAll(chain);
    }
    this.live.partChains.clear();
    this.live.partGains.clear();
    this.live.phraseNodes.clear();
    this.partVolumeLevels.clear();
    this.partMuted.clear();
    this.partIndex.clear();
    this.parts = [];
    this.schedule = [];
    this.scheduleIndex = 0;
    this.fermataHolds = [];
    this.scoreStructure = { tempoMap: [], measures: [], order: null };
    this.timeline = buildPlaybackTimeline({});
  }

  /* =====================================================================
     Cached buffers and waveforms
     ===================================================================== */

  /** White noise for breath and hammer transients. */
  getNoiseBuffer(target) {
    if (target.noiseBuffer) return target.noiseBuffer;
    const ctx = target.ctx;
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    target.noiseBuffer = buffer;
    return buffer;
  }

  /**
   * A slow, smooth random wander used for pitch drift. Stored at a low sample
   * rate because nothing above a few hertz matters here.
   */
  getDriftBuffer(target) {
    if (target.driftBuffer) return target.driftBuffer;
    const ctx = target.ctx;
    const rate = 8000;
    const length = rate * 4;
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    let value = 0;
    let smoothed = 0;
    let peak = 0;
    for (let i = 0; i < length; i++) {
      // Leaky integration of noise: a wander that always returns to centre.
      value = value * 0.996 + (Math.random() * 2 - 1) * 0.05;
      smoothed += 0.02 * (value - smoothed);
      data[i] = smoothed;
      peak = Math.max(peak, Math.abs(smoothed));
    }
    if (peak > 0) {
      for (let i = 0; i < length; i++) data[i] /= peak;
    }
    target.driftBuffer = buffer;
    return buffer;
  }

  /** Build a PeriodicWave from sine-phase harmonic amplitudes. */
  createWave(target, amplitudes) {
    const real = new Float32Array(amplitudes.length);
    const imag = new Float32Array(amplitudes.length);
    for (let n = 1; n < amplitudes.length; n++) imag[n] = amplitudes[n];
    return target.ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  }

  /**
   * Glottal source waveform, cached per harmonic count and spectral tilt.
   * @param {object} target
   * @param {number} harmonics
   * @param {number} tilt
   */
  getGlottalWave(target, harmonics, tilt) {
    // Bucket the parameters so neighbouring notes share a cached wave.
    const bucketedHarmonics = Math.max(6, Math.round(harmonics / 4) * 4);
    const bucketedTilt = Math.round(tilt * 20) / 20;
    const key = `glottal:${bucketedHarmonics}:${bucketedTilt}`;
    const cached = target.waves.get(key);
    if (cached) return cached;

    const wave = this.createWave(
      target,
      glottalHarmonics(bucketedHarmonics, bucketedTilt, { rms: GLOTTAL_RMS })
    );
    target.waves.set(key, wave);
    return wave;
  }

  /**
   * A unit sine at a given starting phase, so section members can share a
   * vibrato rate without locking into the same wobble.
   * @param {object} target
   * @param {number} phase - 0..1 turns
   */
  getPhaseWave(target, phase) {
    const step = ((Math.round(phase * 16) % 16) + 16) % 16;
    const key = `phase:${step}`;
    const cached = target.waves.get(key);
    if (cached) return cached;

    const angle = (step / 16) * Math.PI * 2;
    const real = new Float32Array([0, Math.sin(angle)]);
    const imag = new Float32Array([0, Math.cos(angle)]);
    const wave = target.ctx.createPeriodicWave(real, imag, { disableNormalization: true });
    target.waves.set(key, wave);
    return wave;
  }

  /** The reference-tone waveform: a fundamental with a few soft harmonics. */
  getToneWave(target) {
    const key = 'tone';
    const cached = target.waves.get(key);
    if (cached) return cached;

    const partials = [0, 1, 0.26, 0.11, 0.045, 0.018];
    let power = 0;
    for (const amplitude of partials) power += (amplitude * amplitude) / 2;
    const scale = 0.35 / Math.sqrt(power);
    const wave = this.createWave(target, partials.map(amplitude => amplitude * scale));
    target.waves.set(key, wave);
    return wave;
  }

  /* =====================================================================
     Synthesis
     ===================================================================== */

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
    this.live.phraseNodes.clear();
  }

  /** Dispatch a note to the synthesis path for its part and the current mode. */
  dispatchNote(partId, frequency, startTime, duration, articulation, timing) {
    if (this.partIndex.get(partId)?.isPiano) {
      this.schedulePianoNote(partId, frequency, startTime, duration, articulation, timing);
    } else if (this.synthMode === 'vocal') {
      this.scheduleVocalNote(partId, frequency, startTime, duration, articulation, timing);
    } else {
      this.scheduleToneNote(partId, frequency, startTime, duration, articulation, timing);
    }
  }

  /** Backwards-compatible alias for the reference-tone path. */
  scheduleNote(partId, frequency, startTime, duration, articulation, timing) {
    this.scheduleToneNote(partId, frequency, startTime, duration, articulation, timing);
  }

  /**
   * Resolve the sounding end of a vocal phrase on the transport timeline.
   * A phrase is one continuous source, so it lives until its last note ends
   * rather than until the note being scheduled ends.
   *
   * @param {number} startTime
   * @param {number} duration - sounding length of this note in seconds
   * @param {number} phraseEndPlaybackBeat - phrase end, or NaN when unphrased
   */
  resolvePhraseEnd(startTime, duration, phraseEndPlaybackBeat) {
    let end = startTime + Math.max(0.06, duration);
    if (Number.isFinite(phraseEndPlaybackBeat) && Number.isFinite(this.startTime)) {
      const transportPhraseEnd = this.startTime +
        this.timeline.beatToSeconds(phraseEndPlaybackBeat);
      if (transportPhraseEnd > startTime) end = transportPhraseEnd;
    }
    // Keep a resumed short note alive long enough for its envelope to reach
    // zero instead of stopping the source underneath the release ramp.
    return Math.max(end, startTime + 0.06);
  }

  /**
   * Schedule a sung note.
   *
   * One node is a *section*: several detuned singers sharing a pitch signal,
   * each with their own vibrato, feeding one vocal tract (a cascade of peaking
   * filters set to the vowel's formants). Contiguous notes reuse the node and
   * glide, so the source, vibrato and breath stay continuous across a phrase.
   *
   * @param {string} partId
   * @param {number} frequency
   * @param {number} startTime - AudioContext time
   * @param {number} duration - seconds
   * @param {object} articulation - legato/staccato/fermata hints
   * @param {object} timing - event timing, pitch and vowel
   */
  scheduleVocalNote(partId, frequency, startTime, duration, articulation = {}, timing = {}) {
    const target = this.target;
    const ctx = target.ctx;
    const partGain = target.partGains.get(partId);
    if (!ctx || !partGain) return;

    // A staccato note is deliberately detached, so it is never part of a
    // phrase. Ignoring its (single-note) phrase bounds is what stops the
    // shortened note being stretched back to its full notated length.
    const phraseId = articulation.staccato ? null : timing.vocalPhraseId;
    const phraseStartPlaybackBeat = phraseId
      ? Number(timing.vocalPhraseStartPlaybackBeat)
      : NaN;
    const phraseEndPlaybackBeat = phraseId
      ? Number(timing.vocalPhraseEndPlaybackBeat)
      : NaN;
    const playbackStartBeat = Number(timing.playbackStartBeat);
    const isContinuation = !!phraseId &&
      Number.isFinite(phraseStartPlaybackBeat) &&
      Number.isFinite(playbackStartBeat) &&
      phraseStartPlaybackBeat < playbackStartBeat - 1e-6;
    const existingPhraseNode = phraseId ? target.phraseNodes.get(phraseId) : null;

    if (isContinuation && existingPhraseNode && existingPhraseNode.endTime > startTime + 0.001) {
      this.continueVocalPhrase(existingPhraseNode, frequency, startTime, articulation, timing);
      return;
    }

    const part = this.partIndex.get(partId);
    const voiceClass = this.voiceClassForPart(part);
    const profile = profileFor(voiceClass);
    const register = registerPosition(Number(timing.midi), profile);
    const vowel = timing.vowel || 'a';

    const phraseEndTime = this.resolvePhraseEnd(startTime, duration, phraseEndPlaybackBeat);
    const safeDuration = phraseEndTime - startTime;
    const nyquist = ctx.sampleRate / 2;

    const sources = [];
    const graph = [];

    /* --- amplitude envelope timings ------------------------------------- */
    // Choral onsets are soft; a slurred entry is softer still, and a staccato
    // note needs a defined edge to read as detached.
    const requestedAttack = articulation.staccato ? 0.014
      : articulation.legatoFromPrevious ? 0.022
        : articulation.legato ? 0.038 : 0.055;
    const requestedRelease = articulation.fermata ? 0.26
      : articulation.staccato ? 0.05
        : articulation.legatoToNext ? 0.05 : 0.18;
    const attack = Math.min(requestedAttack, safeDuration * 0.3);
    const release = Math.min(requestedRelease, safeDuration * 0.4);
    const releaseStart = Math.max(startTime + attack, phraseEndTime - release);
    // Voices naturally gain weight towards the top of their range, and the
    // written dynamic scales that. A note under a hairpin also has a level to
    // arrive at, so the sustain can move instead of sitting flat.
    const registerGain = VOCAL_PEAK_GAIN * (0.88 + 0.24 * register);
    const peakGain = registerGain * dynamicLevel(articulation);
    const sustainEndGain = registerGain * dynamicEndLevel(articulation);

    /* --- shared pitch control ------------------------------------------- */
    const pitchSource = ctx.createConstantSource();
    pitchSource.offset.value = frequency;
    sources.push(pitchSource);

    // Slow shared wander. A section drifts together; independent per-singer
    // drift sounds seasick rather than human.
    const drift = ctx.createBufferSource();
    const driftBuffer = this.getDriftBuffer(target);
    drift.buffer = driftBuffer;
    drift.loop = true;
    drift.playbackRate.value = 0.24 + Math.random() * 0.2;
    const driftDepth = ctx.createGain();
    driftDepth.gain.value = frequency * 0.0018; // about 3 cents
    drift.connect(driftDepth);
    driftDepth.connect(pitchSource.offset);
    sources.push(drift);
    graph.push(driftDepth);

    /* --- the section ---------------------------------------------------- */
    const singerCount = Math.max(1, Math.min(4, this.sectionSize));
    const spread = SECTION_SPREAD[singerCount] || SECTION_SPREAD[1];
    const harmonics = harmonicCountFor(frequency, ctx.sampleRate);
    const tilt = Math.max(0.85, profile.tilt - 0.18 * register);
    const wave = this.getGlottalWave(target, harmonics, tilt);

    const sourceMerge = ctx.createGain();
    // Incoherent sources sum in power, so 1/sqrt(n) keeps the section at the
    // level of a single voice regardless of how many singers it has.
    sourceMerge.gain.value = 1 / Math.sqrt(singerCount);
    graph.push(sourceMerge);

    for (let i = 0; i < singerCount; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      // The fundamental comes entirely from the shared pitch signal, so a
      // phrase glide only has to automate one AudioParam.
      osc.frequency.value = 0;
      osc.detune.value = spread[i] * SECTION_DETUNE_CENTS + (Math.random() - 0.5) * 3;
      pitchSource.connect(osc.frequency);

      const vibrato = ctx.createOscillator();
      vibrato.setPeriodicWave(this.getPhaseWave(target, Math.random()));
      vibrato.frequency.value = profile.vibrato.rate * (0.92 + Math.random() * 0.16);
      const vibratoDepth = ctx.createGain();
      vibratoDepth.gain.value = 0;
      vibrato.connect(vibratoDepth);
      vibratoDepth.connect(osc.detune);

      // Singers add vibrato after the note has settled, and not at all on
      // notes too short to hold.
      const onset = Math.min(profile.vibrato.onset * (0.85 + Math.random() * 0.3), safeDuration * 0.5);
      vibratoDepth.gain.setValueAtTime(0, startTime);
      if (safeDuration > onset + 0.1) {
        const depth = profile.vibrato.depth * (0.8 + Math.random() * 0.4);
        vibratoDepth.gain.setValueAtTime(0, startTime + onset);
        vibratoDepth.gain.linearRampToValueAtTime(
          depth,
          startTime + onset + Math.min(0.3, (safeDuration - onset) * 0.5)
        );
      }

      const level = ctx.createGain();
      level.gain.value = 0.85 + Math.random() * 0.3;
      osc.connect(level);
      level.connect(sourceMerge);

      // No two singers start on the same sample. This smears the onset, which
      // is most of what separates a section from one loud soloist.
      const entry = startTime + (i === 0 ? 0 : Math.random() * 0.018);
      osc.start(entry);
      vibrato.start(entry);
      sources.push(osc, vibrato);
      graph.push(vibratoDepth, level);
    }

    /* --- vocal tract ---------------------------------------------------- */
    const tiltFilter = ctx.createBiquadFilter();
    tiltFilter.type = 'lowpass';
    tiltFilter.frequency.value = Math.min(
      nyquist * 0.9,
      Math.max(2200, frequency * (7 + 5 * register))
    );
    tiltFilter.Q.value = 0.4;

    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'highpass';
    rumbleFilter.frequency.value = Math.min(180, Math.max(45, frequency * 0.55));
    rumbleFilter.Q.value = 0.6;

    sourceMerge.connect(tiltFilter);
    tiltFilter.connect(rumbleFilter);

    const formants = formantsFor(voiceClass, vowel, frequency);
    const formantFilters = [];
    let chainTail = rumbleFilter;
    for (const formant of formants) {
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = formant.freq;
      peak.Q.value = formant.q;
      peak.gain.value = formant.gain;
      chainTail.connect(peak);
      chainTail = peak;
      formantFilters.push(peak);
    }

    // The singer's formant belongs to the voice, not the vowel, so it sits
    // outside the morphing set.
    if (profile.singerFormant.gain > 0 && profile.singerFormant.freq < nyquist * 0.9) {
      const singerFormant = ctx.createBiquadFilter();
      singerFormant.type = 'peaking';
      singerFormant.frequency.value = profile.singerFormant.freq;
      singerFormant.Q.value = profile.singerFormant.q;
      singerFormant.gain.value = profile.singerFormant.gain;
      chainTail.connect(singerFormant);
      chainTail = singerFormant;
      graph.push(singerFormant);
    }

    const tractOut = ctx.createGain();
    tractOut.gain.value = FORMANT_TRIM;
    chainTail.connect(tractOut);
    graph.push(tiltFilter, rumbleFilter, ...formantFilters, tractOut);

    // Coarticulation: the mouth opens into the vowel rather than starting
    // there. Sweeping F1 up into place is a small detail that removes a lot of
    // the "synthesizer" quality from an entry.
    const jawSweepEnd = Math.min(startTime + 0.08, releaseStart);
    if (formantFilters.length && jawSweepEnd > startTime + 0.005) {
      const f1 = formantFilters[0];
      f1.frequency.setValueAtTime(formants[0].freq * 0.86, startTime);
      f1.frequency.linearRampToValueAtTime(formants[0].freq, jawSweepEnd);
    }

    /* --- breath --------------------------------------------------------- */
    if (profile.breath > 0) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.getNoiseBuffer(target);
      noise.loop = true;
      noise.playbackRate.value = 0.9 + Math.random() * 0.2;

      const breathBand = ctx.createBiquadFilter();
      breathBand.type = 'bandpass';
      breathBand.frequency.value = Math.min(nyquist * 0.8, Math.max(1200, formants[2].freq * 0.9));
      breathBand.Q.value = 0.7;

      const breathGain = ctx.createGain();
      const settle = Math.min(0.12, safeDuration * 0.35);
      // An audible intake at the start of the phrase, then a thin aspiration
      // underneath, then a little more air as the phrase is released.
      breathGain.gain.setValueAtTime(profile.breath * 3.2, startTime);
      breathGain.gain.linearRampToValueAtTime(profile.breath, startTime + settle);
      breathGain.gain.setValueAtTime(profile.breath, releaseStart);
      breathGain.gain.linearRampToValueAtTime(profile.breath * 2, phraseEndTime);

      noise.connect(breathBand);
      breathBand.connect(breathGain);
      // Breath enters the tract so it takes on the vowel's colour.
      breathGain.connect(tiltFilter);
      noise.start(startTime, Math.random() * 1.5);
      sources.push(noise);
      graph.push(breathBand, breathGain);
    }

    /* --- envelope and output -------------------------------------------- */
    const noteGain = ctx.createGain();
    const stopGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    // A hairpin is heard within the note, not only between notes.
    rampSustain(noteGain.gain, peakGain, sustainEndGain, startTime + attack, releaseStart);
    noteGain.gain.linearRampToValueAtTime(0, phraseEndTime);
    stopGain.gain.value = 1;

    tractOut.connect(noteGain);
    noteGain.connect(stopGain);
    stopGain.connect(partGain);
    graph.push(noteGain, stopGain);

    pitchSource.start(startTime);
    drift.start(startTime, Math.random() * (driftBuffer.duration * 0.8));
    stopSources(sources, phraseEndTime + 0.03);

    const node = {
      sources,
      graph,
      pitchParam: pitchSource.offset,
      noteGain,
      stopGain,
      formantFilters,
      voiceClass,
      vowel,
      initialFrequency: frequency,
      currentFrequency: frequency,
      vocalTransitions: [],
      startTime,
      endTime: phraseEndTime + 0.03,
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
      // The level before the written dynamic is applied. Later notes in the same
      // phrase scale this by their own marking.
      registerGain,
      envelopeStartTime: startTime,
      envelopeStartGain: 0,
      attackEndTime: startTime + attack,
      sustainGain: peakGain,
      sustainEndGain,
      releaseStartTime: releaseStart,
      noteEndTime: phraseEndTime
    };
    this.registerNode(target, node, phraseId);
  }

  /**
   * Continue an existing vocal phrase at a new pitch and syllable.
   *
   * The source, vibrato and breath stay alive; only the fundamental, the vowel
   * and the musical envelope move. This is what removes the click and the
   * fresh attack that otherwise land on every note of a legato line.
   */
  continueVocalPhrase(node, frequency, startTime, articulation = {}, timing = {}) {
    const phraseStartPlaybackBeat = Number(timing.vocalPhraseStartPlaybackBeat);
    const phraseEndPlaybackBeat = Number(timing.vocalPhraseEndPlaybackBeat);
    let phraseEndTime = node.noteEndTime;
    if (Number.isFinite(phraseEndPlaybackBeat) && Number.isFinite(this.startTime)) {
      const transportPhraseEnd = this.startTime +
        this.timeline.beatToSeconds(phraseEndPlaybackBeat);
      if (transportPhraseEnd > startTime) phraseEndTime = transportPhraseEnd;
    }
    phraseEndTime = Math.max(phraseEndTime, startTime + 0.06);

    const currentFrequency = Number(node.currentFrequency) || frequency;
    // Keep repeated pitches in the same continuous phrase, but avoid scheduling
    // a redundant glide when the fundamental is already at this value.
    const isRepeatedPitch = Math.abs(currentFrequency - frequency) < 0.01;
    const pitch = node.pitchParam;
    // A vocal transition is a property of the singer, so its length follows the
    // tempo in force where the note actually falls.
    const localSecondsPerBeat = this.timeline.secondsPerBeatAt(
      Number(timing.playbackStartBeat) || 0
    );
    const transitionDuration = Math.min(
      0.075,
      Math.max(0.03, localSecondsPerBeat * 0.12)
    );
    const transitionEnd = Math.min(phraseEndTime - 0.01, startTime + transitionDuration);

    if (pitch) {
      pitch.cancelScheduledValues(startTime);
      pitch.setValueAtTime(currentFrequency, startTime);
      if (!isRepeatedPitch && transitionEnd > startTime + 0.005) {
        pitch.linearRampToValueAtTime(frequency, transitionEnd);
      } else {
        pitch.setValueAtTime(frequency, startTime);
      }
    }

    const transitionStartBeat = Number(timing.playbackStartBeat);
    if (!isRepeatedPitch && Number.isFinite(transitionStartBeat) &&
        Number.isFinite(phraseEndPlaybackBeat)) {
      const transitionBeats = localSecondsPerBeat > 0
        ? transitionDuration / localSecondsPerBeat
        : 0;
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

    /* --- envelope ------------------------------------------------------- */
    const currentGain = this.getEnvelopeGainAtTime(node, startTime);
    const gain = node.noteGain.gain;
    const attackEnd = Math.min(startTime + 0.008, phraseEndTime - 0.01);
    const requestedRelease = articulation.fermata ? 0.26
      : articulation.legatoToNext ? 0.05 : 0.18;
    const release = Math.min(requestedRelease, Math.max(0.01, phraseEndTime - startTime));
    const releaseStart = Math.max(attackEnd, phraseEndTime - release);
    const dipEndTime = Math.min(startTime + 0.018, releaseStart - 0.035);
    const recoveryEndTime = Math.min(startTime + 0.065, releaseStart - 0.005);
    // Each note in a phrase carries its own written dynamic, applied to the
    // phrase's register level so the section stays balanced within itself.
    const baseGain = Number.isFinite(node.registerGain) ? node.registerGain : node.peakGain;
    const notePeakGain = baseGain * dynamicLevel(articulation);
    const noteSustainEndGain = baseGain * dynamicEndLevel(articulation);
    const dipGain = notePeakGain * 0.82;
    const canDip = isRepeatedPitch &&
      dipEndTime > startTime + 0.003 &&
      recoveryEndTime > dipEndTime + 0.008;

    gain.cancelScheduledValues(startTime);
    gain.setValueAtTime(currentGain, startTime);
    if (canDip) {
      // Repeated notes remain one continuous vocal source. This shallow dip
      // creates a clear boundary without silence, a new attack, or added noise.
      gain.linearRampToValueAtTime(dipGain, dipEndTime);
      gain.linearRampToValueAtTime(notePeakGain, recoveryEndTime);
    } else if (attackEnd > startTime + 0.001) {
      gain.linearRampToValueAtTime(notePeakGain, attackEnd);
    }
    rampSustain(gain, notePeakGain, noteSustainEndGain, attackEnd, releaseStart);
    gain.linearRampToValueAtTime(0, phraseEndTime);

    /* --- vowel ---------------------------------------------------------- */
    // The next syllable moves the tract rather than restarting it. The jaw
    // floor also depends on pitch, so this runs even when the vowel repeats.
    const vowel = timing.vowel || node.vowel || 'a';
    const formants = formantsFor(node.voiceClass, vowel, frequency);
    const morphEnd = Math.min(phraseEndTime - 0.01, startTime + 0.06);
    node.formantFilters?.forEach((filter, index) => {
      const formant = formants[index];
      if (!formant) return;
      filter.frequency.cancelScheduledValues(startTime);
      if (morphEnd > startTime + 0.005) {
        // A ramp with no preceding event interpolates from the parameter's
        // last scheduled value, which is exactly where the sweep should start.
        filter.frequency.linearRampToValueAtTime(formant.freq, morphEnd);
      } else {
        filter.frequency.setValueAtTime(formant.freq, startTime);
      }
      filter.gain.setValueAtTime(formant.gain, startTime);
    });
    node.vowel = vowel;

    // A resumed phrase can be close to its original stop time. Extend the
    // scheduled source stop when the release was clamped to the safe minimum.
    if (phraseEndTime > node.noteEndTime + 0.001) {
      stopSources(node.sources, phraseEndTime + 0.03);
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
    node.endTime = phraseEndTime + 0.03;
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
   * Schedule a clean reference tone.
   *
   * This mode exists for ear training, so it favours an unambiguous pitch:
   * one oscillator, no unison detuning to beat against, a soft low-pass and a
   * touch of late vibrato so long notes are not sterile.
   */
  scheduleToneNote(partId, frequency, startTime, duration, articulation = {}, timing = {}) {
    const target = this.target;
    const ctx = target.ctx;
    const partGain = target.partGains.get(partId);
    if (!ctx || !partGain) return;

    const part = this.partIndex.get(partId);
    const profile = profileFor(this.voiceClassForPart(part));
    const register = registerPosition(Number(timing.midi), profile);
    const safeDuration = Math.max(0.05, duration);
    const noteEndTime = startTime + safeDuration;
    const nyquist = ctx.sampleRate / 2;

    const sources = [];
    const graph = [];

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.getToneWave(target));
    osc.frequency.setValueAtTime(frequency, startTime);
    sources.push(osc);

    const shape = ctx.createBiquadFilter();
    shape.type = 'lowpass';
    shape.frequency.value = Math.min(nyquist * 0.9, Math.max(1500, frequency * 8));
    shape.Q.value = 0.5;
    graph.push(shape);

    const vibratoOnset = 0.35;
    if (safeDuration > vibratoOnset + 0.15) {
      const vibrato = ctx.createOscillator();
      vibrato.setPeriodicWave(this.getPhaseWave(target, Math.random()));
      vibrato.frequency.value = 5;
      const vibratoDepth = ctx.createGain();
      vibratoDepth.gain.setValueAtTime(0, startTime);
      vibratoDepth.gain.setValueAtTime(0, startTime + vibratoOnset);
      vibratoDepth.gain.linearRampToValueAtTime(7, startTime + vibratoOnset + 0.25);
      vibrato.connect(vibratoDepth);
      vibratoDepth.connect(osc.detune);
      vibrato.start(startTime);
      sources.push(vibrato);
      graph.push(vibratoDepth);
    }

    const requestedAttack = articulation.staccato ? 0.006
      : articulation.legatoFromPrevious ? 0.008
        : articulation.legato ? 0.012 : 0.018;
    const requestedRelease = articulation.fermata ? 0.16
      : articulation.staccato ? 0.04
        : articulation.legatoToNext ? 0.03 : 0.09;
    const attack = Math.min(requestedAttack, safeDuration * 0.25);
    const release = Math.min(requestedRelease, safeDuration * 0.35);
    const releaseStart = Math.max(startTime + attack, noteEndTime - release);
    const registerGain = TONE_PEAK_GAIN * (0.9 + 0.2 * register);
    const peakGain = registerGain * dynamicLevel(articulation);
    const sustainEndGain = registerGain * dynamicEndLevel(articulation);

    const noteGain = ctx.createGain();
    const stopGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    rampSustain(noteGain.gain, peakGain, sustainEndGain, startTime + attack, releaseStart);
    noteGain.gain.linearRampToValueAtTime(0, noteEndTime);
    stopGain.gain.value = 1;

    osc.connect(shape);
    shape.connect(noteGain);
    noteGain.connect(stopGain);
    stopGain.connect(partGain);
    graph.push(noteGain, stopGain);

    osc.start(startTime);
    stopSources(sources, noteEndTime + 0.02);

    this.registerNode(target, {
      sources,
      graph,
      pitchParam: osc.frequency,
      noteGain,
      stopGain,
      startTime,
      endTime: noteEndTime + 0.02,
      eventIndex: timing.eventIndex,
      eventIndices: new Set(Number.isInteger(timing.eventIndex) ? [timing.eventIndex] : []),
      playbackEndBeat: timing.playbackEndBeat,
      playbackDurationBeats: timing.playbackDurationBeats,
      legatoToNext: !!timing.legatoToNext,
      requestedRelease,
      peakGain,
      registerGain,
      envelopeStartTime: startTime,
      envelopeStartGain: 0,
      attackEndTime: startTime + attack,
      sustainGain: peakGain,
      sustainEndGain,
      releaseStartTime: releaseStart,
      noteEndTime
    });
  }

  /**
   * Schedule a struck-string note for accompaniment staves.
   *
   * A piano string is not a harmonic oscillator: stiffness stretches its
   * partials sharp, and the upper ones die away far sooner than the
   * fundamental. Modelling both is what stops this sounding like an organ.
   */
  schedulePianoNote(partId, frequency, startTime, duration, articulation = {}, timing = {}) {
    const target = this.target;
    const ctx = target.ctx;
    const partGain = target.partGains.get(partId);
    if (!ctx || !partGain) return;

    const safeDuration = Math.max(0.04, duration);
    const safeFrequency = Math.max(20, frequency);
    const noteEndTime = startTime + safeDuration;
    const nyquist = ctx.sampleRate / 2;

    // The damper stops the string when the key is released: fast at the top of
    // the keyboard, slower in the bass where the strings carry more energy.
    const damperTime = Math.min(0.6, Math.max(0.09, 0.24 * Math.pow(440 / safeFrequency, 0.35)));
    const soundEndTime = noteEndTime + damperTime;
    // Free decay of a held string.
    const decayTime = Math.min(9, Math.max(1.2, 3.2 * Math.pow(440 / safeFrequency, 0.5)));
    // Inharmonicity coefficient: short, stiff treble strings stretch most.
    const inharmonicity = Math.min(
      6e-4,
      Math.max(8e-6, 2.2e-5 * Math.pow(safeFrequency / 110, 1.25))
    );

    const sources = [];
    const graph = [];

    const stringMerge = ctx.createGain();
    stringMerge.gain.value = 1;
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = Math.min(nyquist * 0.9, Math.max(2600, safeFrequency * 10));
    body.Q.value = 0.6;
    graph.push(stringMerge, body);

    const partialCount = Math.min(8, Math.max(1, Math.floor((nyquist * 0.9) / safeFrequency)));
    for (let n = 1; n <= partialCount; n++) {
      const ratio = n * Math.sqrt(1 + inharmonicity * n * n);
      const partialFrequency = safeFrequency * ratio;
      if (partialFrequency >= nyquist * 0.95) break;

      // Upper partials are quieter and shorter-lived than the fundamental.
      const amplitude = Math.pow(n, -1.35) * (n % 2 === 0 ? 0.82 : 1);
      const partialDecay = decayTime / (0.55 + 0.6 * n);
      // The fundamental is really a group of two or three strings tuned very
      // slightly apart; that mistuning is the shimmer of a piano tone.
      const unison = n === 1 ? [-1.1, 1.3] : [0];

      for (const detune of unison) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(partialFrequency, startTime);
        if (detune) osc.detune.setValueAtTime(detune, startTime);

        const partialGain = ctx.createGain();
        const level = (amplitude / Math.sqrt(unison.length)) * 0.5;
        const attackTime = Math.min(0.006, 0.002 + 0.004 / Math.sqrt(n));
        const decayEnd = Math.min(soundEndTime - 0.01, startTime + partialDecay);
        const floor = Math.max(0.00005, level * 0.02);

        partialGain.gain.setValueAtTime(0, startTime);
        partialGain.gain.linearRampToValueAtTime(level, startTime + attackTime);
        if (decayEnd > startTime + attackTime + 0.005) {
          partialGain.gain.exponentialRampToValueAtTime(floor, decayEnd);
        }
        if (soundEndTime > decayEnd + 0.005) {
          partialGain.gain.setValueAtTime(floor, decayEnd);
          partialGain.gain.exponentialRampToValueAtTime(0.00005, soundEndTime);
        }

        osc.connect(partialGain);
        partialGain.connect(stringMerge);
        osc.start(startTime);
        sources.push(osc);
        graph.push(partialGain);
      }
    }

    // Hammer contact: a few milliseconds of filtered noise. Kept very quiet,
    // because this is the difference between a defined attack and a clap.
    const hammer = ctx.createBufferSource();
    hammer.buffer = this.getNoiseBuffer(target);
    hammer.loop = true;
    const hammerFilter = ctx.createBiquadFilter();
    hammerFilter.type = 'lowpass';
    hammerFilter.frequency.value = Math.min(nyquist * 0.8, Math.max(900, safeFrequency * 6));
    hammerFilter.Q.value = 0.7;
    const hammerGain = ctx.createGain();
    hammerGain.gain.setValueAtTime(0, startTime);
    hammerGain.gain.linearRampToValueAtTime(0.03, startTime + 0.002);
    hammerGain.gain.exponentialRampToValueAtTime(0.0002, startTime + 0.03);
    hammerGain.gain.setValueAtTime(0, startTime + 0.035);
    hammer.connect(hammerFilter);
    hammerFilter.connect(hammerGain);
    hammerGain.connect(stringMerge);
    hammer.start(startTime, Math.random() * 1.5);
    hammer.stop(startTime + 0.05);
    sources.push(hammer);
    graph.push(hammerFilter, hammerGain);

    const noteGain = ctx.createGain();
    const stopGain = ctx.createGain();
    // A struck string is set going once and then decays, so the written dynamic
    // sets how hard it was struck rather than shaping a sustain.
    const peakGain = PIANO_PEAK_GAIN * dynamicLevel(articulation);
    const attack = Math.min(0.005, safeDuration * 0.15);

    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
    noteGain.gain.setValueAtTime(peakGain, noteEndTime);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, soundEndTime);
    noteGain.gain.setValueAtTime(0, soundEndTime + 0.005);
    stopGain.gain.value = 1;

    stringMerge.connect(body);
    body.connect(noteGain);
    noteGain.connect(stopGain);
    stopGain.connect(partGain);
    graph.push(noteGain, stopGain);

    stopSources(sources.filter(source => source !== hammer), soundEndTime + 0.02);

    const eventEndBeat = Number(timing.playbackEndBeat);
    const eventDurationBeats = Number(timing.playbackDurationBeats);
    this.registerNode(target, {
      sources,
      graph,
      pitchParam: null,
      noteGain,
      stopGain,
      isPiano: true,
      startTime,
      endTime: soundEndTime + 0.02,
      eventIndex: timing.eventIndex,
      eventIndices: new Set(Number.isInteger(timing.eventIndex) ? [timing.eventIndex] : []),
      playbackEndBeat: Number.isFinite(eventEndBeat) ? eventEndBeat : undefined,
      playbackDurationBeats: Number.isFinite(eventDurationBeats) ? eventDurationBeats : undefined,
      legatoToNext: false,
      requestedRelease: damperTime,
      peakGain,
      envelopeStartTime: startTime,
      envelopeStartGain: 0,
      attackEndTime: startTime + attack,
      sustainGain: peakGain,
      sustainEndGain: peakGain,
      releaseStartTime: noteEndTime,
      noteEndTime: soundEndTime
    });
  }

  /**
   * Track a scheduled voice and arrange for it to release its nodes.
   * @param {object} target - render target that owns the nodes
   * @param {object} node - node record
   * @param {string} [phraseId] - vocal phrase this node carries, if any
   */
  registerNode(target, node, phraseId) {
    this.scheduledNodes.push(node);
    if (phraseId) target.phraseNodes.set(phraseId, node);

    const release = () => {
      if (phraseId && target.phraseNodes.get(phraseId) === node) {
        target.phraseNodes.delete(phraseId);
      }
      disconnectAll(node.sources);
      disconnectAll(node.graph);
    };

    // The first source outlives or matches every other in the node, so its
    // completion is the safe moment to tear the little graph down.
    const primary = node.sources?.[0];
    if (primary) primary.onended = release;
    else release();
  }

  /* =====================================================================
     Envelope maintenance
     ===================================================================== */

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
    // The sustain is not necessarily flat: a note inside a hairpin ramps from
    // its starting level to the level it is heading for.
    const sustainEndGain = Number.isFinite(node.sustainEndGain)
      ? node.sustainEndGain
      : sustainGain;
    const sustainAt = (at) => {
      if (releaseStart <= attackEnd) return sustainEndGain;
      const progress = Math.max(0, Math.min(1, (at - attackEnd) / (releaseStart - attackEnd)));
      return sustainGain + (sustainEndGain - sustainGain) * progress;
    };

    if (time < releaseStart) return sustainAt(time);
    if (noteEnd > releaseStart && time < noteEnd) {
      return sustainEndGain * (noteEnd - time) / (noteEnd - releaseStart);
    }
    return 0;
  }

  /**
   * Rebuild future pitch glides for a vocal phrase after a tempo change.
   * AudioParam automation is timestamp-based, so queued transitions must be
   * moved to the new transport times along with the gain envelope.
   */
  retimeVocalTransitions(node, now, currentPlaybackBeat) {
    if (!node.vocalTransitions?.length || !node.pitchParam) return;

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
          (transition.toFrequency - transition.fromFrequency) *
          Math.max(0, Math.min(1, progress));
        break;
      } else {
        break;
      }
    }

    const pitch = node.pitchParam;
    pitch.cancelScheduledValues(now);
    pitch.setValueAtTime(currentFrequency, now);
    for (const transition of transitions) {
      if (transition.endPlaybackBeat <= currentPlaybackBeat + 1e-6) continue;
      const startTime = Math.max(
        now,
        this.startTime + this.timeline.beatToSeconds(transition.startPlaybackBeat)
      );
      const endTime = this.startTime + this.timeline.beatToSeconds(transition.endPlaybackBeat);
      if (endTime <= now + 0.005) continue;
      if (startTime > now + 0.001) {
        pitch.setValueAtTime(transition.fromFrequency, startTime);
      }
      pitch.linearRampToValueAtTime(transition.toFrequency, endTime);
    }
  }

  /**
   * Re-time the remainder of an active note without replacing its sources.
   * Waveform phase and pitch remain continuous; only future gain automation
   * and the scheduled stop times move to the new tempo timeline.
   */
  retimeActiveNode(node, now, currentPlaybackBeat) {
    const remainingBeats = Math.max(0, node.playbackEndBeat - currentPlaybackBeat);
    const fullDurationBeats = Number(node.playbackDurationBeats) || remainingBeats;
    // Both lengths are measured along the rescaled timeline, so a note that
    // spans a written tempo change keeps its shape after a rehearsal-tempo change.
    const fullDuration = this.timeline.durationSeconds(
      node.playbackStartBeat ?? currentPlaybackBeat,
      fullDurationBeats
    );
    const overlap = node.legatoToNext ? Math.min(0.045, fullDuration * 0.12) : 0;
    const remainingDuration = Math.max(
      0.01,
      this.timeline.durationSeconds(currentPlaybackBeat, remainingBeats) + overlap
    );
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
    // Preserve a hairpin across the tempo change: the note still arrives at the
    // level it was heading for, over the rescaled remaining time.
    const sustainEndGain = Number.isFinite(node.sustainEndGain)
      ? node.sustainEndGain
      : sustainGain;
    rampSustain(gain, sustainGain, sustainEndGain, attackEndTime, releaseStartTime);
    gain.linearRampToValueAtTime(0, noteEndTime);
    if (node.vocalTransitions) {
      this.retimeVocalTransitions(node, now, currentPlaybackBeat);
    }
    stopSources(node.sources, noteEndTime + 0.03);

    node.endTime = noteEndTime + 0.03;
    node.envelopeStartTime = now;
    node.envelopeStartGain = currentGain;
    node.attackEndTime = attackEndTime;
    node.sustainGain = sustainGain;
    node.repeatedPitchDip = null;
    node.releaseStartTime = releaseStartTime;
    node.noteEndTime = noteEndTime;
  }

  /**
   * Fade a scheduled voice to silence before stopping it.
   * The dedicated stop gain is not touched by the note envelope, so its value
   * is always known and can be ramped without an automation discontinuity.
   * @param {object} node
   * @param {number} now - AudioContext time
   * @param {number} [fadeDuration] - fade length in seconds
   */
  fadeOutNode(node, now, fadeDuration = 0.02) {
    const { sources, stopGain, startTime, endTime } = node;
    const isSounding = startTime <= now && endTime > now;

    try {
      stopGain.gain.cancelScheduledValues(now);
      if (isSounding) {
        const fadeEnd = now + fadeDuration;
        stopGain.gain.setValueAtTime(stopGain.gain.value, now);
        stopGain.gain.linearRampToValueAtTime(0, fadeEnd);
        stopSources(sources, fadeEnd + 0.005);
      } else {
        // Nodes that have not started are silent, so they can be cut at once.
        stopGain.gain.setValueAtTime(0, now);
        stopSources(sources, now);
      }
    } catch (error) { /* already stopped */ }
  }

  /** Stop and release every scheduled voice. */
  stopAllNodes() {
    const now = this.audioContext ? this.audioContext.currentTime : 0;
    for (const node of this.scheduledNodes) {
      this.fadeOutNode(node, now);
    }
    this.scheduledNodes = [];
    this.preservedEventIndices.clear();
    this.live.phraseNodes.clear();
  }

  /* =====================================================================
     Position tracking
     ===================================================================== */

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

  /** Start tracking the current beat position using requestAnimationFrame. */
  startBeatTracking() {
    this.stopBeatTracking();
    const track = () => {
      if (!this.isPlaying) return;
      // The browser graph-to-host buffer and the host-to-speaker device path
      // are consecutive stages. Counting only one leaves visuals ahead of the
      // sound that a microphone can physically receive.
      const outputLatency = this.getAudibleOutputLatency();
      const elapsed = this.audioContext.currentTime - this.startTime - outputLatency;
      const measuredPlaybackBeat = Math.max(0, this.timeline.secondsToBeat(elapsed));
      const playbackBeat = Math.max(this.trackingFloorPlaybackBeat, measuredPlaybackBeat);
      this.currentBeat = this.timeline.playbackBeatToScoreBeat(playbackBeat);
      this.currentPlaybackBeat = playbackBeat;

      // A loop range ends the pass early and asks to be taken round again.
      // Rehearsing a hard passage is the main thing a singer does with this, so
      // the check comes before the end-of-score check.
      const loopEnd = this.getLoopEndPlaybackBeat();
      if (loopEnd !== null && playbackBeat >= loopEnd) {
        if (this.onLoopEnd) this.onLoopEnd();
        return;
      }

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

  /** Stop beat tracking. */
  stopBeatTracking() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Get the AudioContext (for use by other modules like the metronome).
   * @returns {AudioContext}
   */
  getAudioContext() {
    return this.audioContext;
  }

  /**
   * The node the metronome should connect to. Clicks join after the glue
   * compressor so a click can never duck the ensemble.
   * @returns {GainNode|null}
   */
  getClickBus() {
    return this.live.bus?.click ?? this.live.bus?.dry ?? null;
  }

  /**
   * Get the playback start time reference (for syncing the metronome).
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
    // Step back in seconds rather than beats: with a tempo change inside the
    // capture window, a fixed number of beats is the wrong distance.
    const nowSeconds = this.timeline.beatToSeconds(this.getCurrentPlaybackBeat());
    const samplePlaybackBeat = this.timeline.secondsToBeat(Math.max(0, nowSeconds - delay));

    return {
      beat: this.timeline.playbackBeatToScoreBeat(samplePlaybackBeat),
      isFermataHold: this.timeline.isHoldAtPlaybackBeat(samplePlaybackBeat)
    };
  }

  /**
   * Get the exact position on the fermata-expanded timeline. Unlike currentBeat,
   * this continues advancing while the score cursor waits on a fermata.
   * @returns {number}
   */
  getCurrentPlaybackBeat() {
    if (this.isPlaying && this.audioContext) {
      const outputLatency = this.getAudibleOutputLatency();
      return Math.max(
        0,
        this.timeline.secondsToBeat(
          this.audioContext.currentTime - this.startTime - outputLatency
        )
      );
    }
    if (this.isPaused) return this.pausePlaybackBeat;
    return this.getPlaybackBeat(this.currentBeat);
  }

  /**
   * Get the master input node.
   * @returns {GainNode|null}
   */
  getMasterGain() {
    return this.live.bus?.dry ?? null;
  }

  /* =====================================================================
     Offline render
     ===================================================================== */

  /**
   * Render the entire score offline and return a stereo AudioBuffer.
   *
   * The bus, part chains and synthesis are built by the same code as live
   * playback — only the context differs — so part volumes, mute state, panning,
   * tone, room and fermata timing all carry over exactly.
   *
   * @param {{ onProgress?: (ratio: number) => void }} [options]
   * @returns {Promise<AudioBuffer>}
   */
  async exportAudio(options = {}) {
    const { onProgress } = options;

    // Build the note schedule from live state so the current mix is baked in.
    const schedule = this.buildSchedule();
    schedule.sort((a, b) =>
      (a.playbackStartBeat ?? a.startBeat) - (b.playbackStartBeat ?? b.startBeat)
    );

    const lead = 0.05;
    // Leave room for the final release plus the room decay.
    const tailSeconds = 4;
    const totalSeconds = lead + this.timeline.totalSeconds + tailSeconds;
    const sampleRate = 44100;
    const offlineCtx = new OfflineAudioContext(
      2,
      Math.ceil(totalSeconds * sampleRate),
      sampleRate
    );

    const target = this.createRenderTarget(offlineCtx);
    target.bus = this.createOutputBus(offlineCtx);
    this.buildPartChains(target, this.parts, partId => this.getEffectivePartVolume(partId));

    // Scheduling is synchronous, so the live state can be borrowed and put
    // back before anything else touches the engine.
    const savedTarget = this.target;
    const savedStartTime = this.startTime;
    const savedScheduledNodes = this.scheduledNodes;
    this.target = target;
    this.startTime = lead;
    this.scheduledNodes = [];

    try {
      for (const event of schedule) {
        const { duration, articulation, timing } = this.describeEvent(event, null);
        const noteStartTime = lead + this.timeline.beatToSeconds(timing.playbackStartBeat);
        this.dispatchNote(
          event.partId,
          event.frequency,
          noteStartTime,
          duration,
          articulation,
          timing
        );
      }
    } finally {
      this.target = savedTarget;
      this.startTime = savedStartTime;
      this.scheduledNodes = savedScheduledNodes;
    }

    let progressTimer = null;
    if (onProgress) {
      progressTimer = setInterval(() => {
        onProgress(Math.min(1, offlineCtx.currentTime / totalSeconds));
      }, 200);
    }

    try {
      const rendered = await offlineCtx.startRendering();
      if (onProgress) onProgress(1);
      return rendered;
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  /**
   * Encode an AudioBuffer to a WAV Blob (PCM 16-bit).
   * @param {AudioBuffer} audioBuffer
   * @returns {Blob}
   */
  static audioBufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numSamples = audioBuffer.length;
    const bytesPerSample = 2; // 16-bit PCM
    const dataLength = numSamples * numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    const writeUint16 = (offset, v) => view.setUint16(offset, v, true);
    const writeUint32 = (offset, v) => view.setUint32(offset, v, true);

    // RIFF header
    writeString(0, 'RIFF');
    writeUint32(4, 36 + dataLength);
    writeString(8, 'WAVE');
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

    // Reading each channel once is far cheaper than calling getChannelData
    // inside the sample loop.
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }
}
