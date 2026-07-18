/**
 * Canvas-based Music Notation Renderer
 * Renders staves with notes for each detected part, playback cursor,
 * and user pitch overlay with accuracy feedback.
 */

import { frequencyToNote, getPartColor, pitchToMidi } from './utils.js';

const STEP_ORDER = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const NOTE_DURATION_BEATS = {
  maxima: 32,
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
  '256th': 0.015625,
  '512th': 0.0078125,
  '1024th': 0.00390625
};
const FLAG_COUNTS = {
  eighth: 1,
  '16th': 2,
  '32nd': 3,
  '64th': 4,
  '128th': 5,
  '256th': 6,
  '512th': 7,
  '1024th': 8
};
const OPEN_NOTE_TYPES = new Set(['maxima', 'long', 'breve', 'whole', 'half']);
const STEMLESS_NOTE_TYPES = new Set(['maxima', 'long', 'breve', 'whole']);
const CLEF_SYMBOLS = {
  G: String.fromCodePoint(0x1D11E),
  F: String.fromCodePoint(0x1D122),
  C: String.fromCodePoint(0x1D121)
};
const MUSIC_FONT_STACK = '"Apple Symbols", "Noto Music", "Bravura", serif';
const PITCH_FEEDBACK_COLORS = {
  correct: '#72d6a0',
  close: '#f2bf62',
  off: '#ff7082',
  neutral: '#64a8ff'
};

/**
 * Convert detector output into a fractional MIDI value without losing cents.
 * @param {object} pitchData
 * @returns {number|null}
 */
function getDetectedMidi(pitchData) {
  const frequency = Number(pitchData?.frequency);
  if (frequency > 0) {
    return 69 + 12 * Math.log2(frequency / 440);
  }

  const midi = Number(pitchData?.midi);
  if (Number.isFinite(midi)) {
    return midi + (Number(pitchData?.cents) || 0) / 100;
  }
  return null;
}

/**
 * Classify a sung pitch against the active score note, rather than against the
 * detector's nearest chromatic note (which can never be more than 50c away).
 * @param {number|null} centsFromTarget
 * @returns {{ accuracy: string, color: string }}
 */
function getPitchFeedback(centsFromTarget, previousAccuracy = 'neutral') {
  if (!Number.isFinite(centsFromTarget)) {
    return { accuracy: 'neutral', color: PITCH_FEEDBACK_COLORS.neutral };
  }

  const absCents = Math.abs(centsFromTarget);
  let accuracy;

  // Separate entry and exit thresholds keep gentle vibrato from repeatedly
  // changing the label and color at a hard boundary.
  if (previousAccuracy === 'correct') {
    accuracy = absCents <= 32 ? 'correct' : absCents <= 65 ? 'close' : 'off';
  } else if (previousAccuracy === 'close') {
    accuracy = absCents <= 20 ? 'correct' : absCents <= 70 ? 'close' : 'off';
  } else if (previousAccuracy === 'off') {
    accuracy = absCents <= 20 ? 'correct' : absCents <= 55 ? 'close' : 'off';
  } else {
    accuracy = absCents <= 25 ? 'correct' : absCents <= 60 ? 'close' : 'off';
  }

  return { accuracy, color: PITCH_FEEDBACK_COLORS[accuracy] };
}

/**
 * Return the visual type, head, stem, and flag information for a note/rest.
 * MusicXML's <type> is preferred; duration is only a fallback for sparse files.
 * @param {object} note
 * @returns {{ type: string, openHead: boolean, hasStem: boolean, flagCount: number }}
 */
export function getNoteRenderInfo(note = {}) {
  let type = typeof note.type === 'string' ? note.type.trim().toLowerCase() : '';

  if (!Object.hasOwn(NOTE_DURATION_BEATS, type)) {
    const duration = Number(note.durationBeats);
    if (duration > 0) {
      const dots = Math.max(0, Number(note.dots) || 0);
      const dotFactor = 2 - Math.pow(0.5, dots);
      const undottedDuration = duration / dotFactor;
      let closestType = 'quarter';
      let closestDistance = Infinity;
      for (const [candidate, beats] of Object.entries(NOTE_DURATION_BEATS)) {
        const distance = Math.abs(Math.log2(undottedDuration / beats));
        if (distance < closestDistance) {
          closestType = candidate;
          closestDistance = distance;
        }
      }
      type = closestType;
    } else {
      type = 'quarter';
    }
  }

  return {
    type,
    openHead: OPEN_NOTE_TYPES.has(type),
    hasStem: !STEMLESS_NOTE_TYPES.has(type),
    flagCount: FLAG_COUNTS[type] || 0
  };
}

/**
 * Normalize a parser or fallback clef into one renderer descriptor.
 * @param {object|string|null} clef
 * @returns {{ sign: string, line: number, octaveChange: number, staff: number }|null}
 */
function normalizeClef(clef) {
  if (!clef) return null;
  if (typeof clef === 'string') {
    if (clef === 'bass') return { sign: 'F', line: 4, octaveChange: 0, staff: 1 };
    return { sign: 'G', line: 2, octaveChange: 0, staff: 1 };
  }

  const sign = String(clef.sign || '').toUpperCase();
  if (!['G', 'F', 'C'].includes(sign)) return null;
  const defaultLine = sign === 'F' ? 4 : sign === 'C' ? 3 : 2;
  return {
    sign,
    line: Number(clef.line) || defaultLine,
    octaveChange: Number(clef.octaveChange) || 0,
    staff: Number(clef.staff) || 1
  };
}

function inferVoiceClef(label) {
  const lower = String(label || '').toLowerCase();
  if (lower.includes('bass') || lower.includes('baritone')) {
    return { sign: 'F', line: 4, octaveChange: 0, staff: 1 };
  }
  if (lower.includes('tenor')) {
    return { sign: 'G', line: 2, octaveChange: -1, staff: 1 };
  }
  if (/soprano|mezzo|alto|contralto/.test(lower)) {
    return { sign: 'G', line: 2, octaveChange: 0, staff: 1 };
  }
  return null;
}

/**
 * Resolve the clef for a rendered section. Source MusicXML is retained, with
 * conventional SATB fallbacks for files that omit or mislabel their clefs.
 * @param {object|string} partOrVoiceType
 * @param {number} partIndex
 * @param {number} totalParts
 * @returns {{ sign: string, line: number, octaveChange: number, staff: number }}
 */
export function getClefDescriptorForPart(partOrVoiceType, partIndex = 0, totalParts = 0) {
  const part = typeof partOrVoiceType === 'object' && partOrVoiceType !== null
    ? partOrVoiceType
    : { voiceType: partOrVoiceType };
  const label = [part.voiceType, part.name, part.originalName, part.abbreviation]
    .filter(Boolean)
    .join(' ');
  const inferred = inferVoiceClef(label);
  const imported = normalizeClef(part.clef);

  // Keep valid source clefs, except for an obvious generic G clef on a named
  // bass. Tenor G clefs receive the conventional octave-below indication.
  if (inferred?.sign === 'F') {
    return imported && imported.sign !== 'G' ? imported : inferred;
  }
  if (inferred?.octaveChange === -1) {
    if (imported?.sign === 'F' || imported?.sign === 'C') return imported;
    return imported ? { ...imported, octaveChange: imported.octaveChange || -1 } : inferred;
  }
  if (imported) return imported;
  if (inferred) return inferred;

  // In a four-section SATB score, ordering is the safest fallback for generic
  // names such as "Voice 1". The third section is tenor and fourth is bass.
  if (totalParts === 4 && partIndex === 2) {
    return { sign: 'G', line: 2, octaveChange: -1, staff: part.staffNumber || 1 };
  }
  if (totalParts === 4 && partIndex === 3) {
    return { sign: 'F', line: 4, octaveChange: 0, staff: part.staffNumber || 1 };
  }
  if (Number(part.staffNumber) > 1) {
    return { sign: 'F', line: 4, octaveChange: 0, staff: Number(part.staffNumber) };
  }
  return { sign: 'G', line: 2, octaveChange: 0, staff: part.staffNumber || 1 };
}

/**
 * Get a note's diatonic distance from the bottom staff line for any G/F/C clef.
 * @param {string} noteName
 * @param {number} octave
 * @param {object|string} clef
 * @returns {number}
 */
export function getStaffPositionForClef(noteName, octave, clef) {
  const descriptor = normalizeClef(clef) || { sign: 'G', line: 2, octaveChange: 0 };
  const step = String(noteName || 'C').charAt(0).toUpperCase();
  const pitchIndex = Number(octave) * 7 + (STEP_ORDER[step] ?? 0) - descriptor.octaveChange * 7;
  const reference = descriptor.sign === 'F'
    ? { step: 'F', octave: 3 }
    : descriptor.sign === 'C'
      ? { step: 'C', octave: 4 }
      : { step: 'G', octave: 4 };
  const referenceIndex = reference.octave * 7 + STEP_ORDER[reference.step];
  const bottomLineIndex = referenceIndex - (descriptor.line - 1) * 2;
  return pitchIndex - bottomLineIndex;
}

/**
 * Legacy helper retained for callers that use the original treble/bass scale.
 * @param {string} noteName - e.g., 'C', 'D#', 'Bb'
 * @param {number} octave
 * @param {string} clef - 'treble' or 'bass'
 * @returns {number} position (higher = higher on staff)
 */
export function getNoteStaffPosition(noteName, octave, clef) {
  const step = String(noteName || 'C').charAt(0).toUpperCase();
  const stepIndex = STEP_ORDER[step] ?? 0;
  if (clef === 'bass') {
    return (octave - 2) * 7 + stepIndex - 2;
  }
  return (octave - 4) * 7 + stepIndex;
}

/**
 * Determine the conventional broad clef family for a voice type.
 * @param {string} voiceType
 * @returns {string} 'treble' or 'bass'
 */
export function getClefForPart(voiceType) {
  return inferVoiceClef(voiceType)?.sign === 'F' ? 'bass' : 'treble';
}

const LAYOUT_BEAT_PRECISION = 1e9;

function normalizeLayoutBeat(beat) {
  return Math.round((Number(beat) || 0) * LAYOUT_BEAT_PRECISION) / LAYOUT_BEAT_PRECISION;
}

function getMeasureBaseKey(measure, measureIndex) {
  const number = measure?.number;
  return number !== undefined && number !== null && String(number) !== ''
    ? `number:${String(number)}`
    : `index:${measureIndex}`;
}

function interpolateAnchors(anchors, beat, fallbackX = 0) {
  if (anchors.length === 0) return fallbackX;
  if (beat <= anchors[0].beat) return anchors[0].x;

  for (let index = 1; index < anchors.length; index++) {
    const right = anchors[index];
    if (beat > right.beat) continue;
    const left = anchors[index - 1];
    const beatSpan = right.beat - left.beat;
    if (beatSpan <= 0) return right.x;
    const progress = (beat - left.beat) / beatSpan;
    return left.x + (right.x - left.x) * progress;
  }
  return anchors[anchors.length - 1].x;
}

function interpolateMeasureBeat(measureLayout, localBeat) {
  const beat = Math.max(0, Math.min(measureLayout.duration, Number(localBeat) || 0));
  return interpolateAnchors(measureLayout.anchors, beat, measureLayout.width);
}

/**
 * Build one horizontal measure grid shared by every rendered section.
 * Measure widths grow only where dense note onsets need more room, while notes
 * at equivalent positions and all measure boundaries retain identical x values.
 *
 * @param {Array} parts
 * @param {{ noteWidth?: number, minNoteSpacing?: number, measurePadding?: number }} options
 * @returns {object}
 */
export function buildHorizontalScoreLayout(parts = [], options = {}) {
  const noteWidth = Math.max(1, Number(options.noteWidth) || 40);
  const minNoteSpacing = Math.max(1, Number(options.minNoteSpacing) || 28);
  const measurePadding = Math.max(1, Number(options.measurePadding) || 18);
  const entriesByKey = new Map();
  const measureKeys = new WeakMap();
  const notePositions = new WeakMap();
  let firstSeen = 0;

  // Start with the most complete section. Its source order becomes canonical,
  // while occurrence suffixes keep repeated or non-numeric measure labels unique.
  const orderedParts = [...(parts || [])].sort((left, right) =>
    (right.measures?.length || 0) - (left.measures?.length || 0)
  );

  for (const part of orderedParts) {
    const occurrences = new Map();
    for (let measureIndex = 0; measureIndex < (part.measures || []).length; measureIndex++) {
      const measure = part.measures[measureIndex];
      const baseKey = getMeasureBaseKey(measure, measureIndex);
      const occurrence = occurrences.get(baseKey) || 0;
      occurrences.set(baseKey, occurrence + 1);
      const key = `${baseKey}:occurrence:${occurrence}`;
      if (measure && typeof measure === 'object') measureKeys.set(measure, key);

      if (!entriesByKey.has(key)) {
        entriesByKey.set(key, {
          key,
          number: measure?.number,
          firstSeen: firstSeen++,
          duration: 0,
          fallbackDuration: 0,
          onsets: new Set(),
          graceCountsByBeat: new Map(),
          sourceMeasures: []
        });
      }

      const entry = entriesByKey.get(key);
      const timeSignature = measure?.timeSignature;
      const numerator = Number(timeSignature?.numerator);
      const denominator = Number(timeSignature?.denominator);
      if (numerator > 0 && denominator > 0) {
        entry.fallbackDuration = Math.max(entry.fallbackDuration, numerator * 4 / denominator);
      }

      const notes = measure?.notes || [];
      const localGraceCounts = new Map();
      let contentEnd = Math.max(0, Number(measure?.beats) || 0);
      for (const note of notes) {
        const onset = Math.max(0, normalizeLayoutBeat(note.startBeatInMeasure));
        const duration = Math.max(0, Number(note.durationBeats) || 0);
        entry.onsets.add(onset);
        contentEnd = Math.max(contentEnd, onset + duration);
        if (note.isGrace && !note.isChord) {
          localGraceCounts.set(onset, (localGraceCounts.get(onset) || 0) + 1);
        }
      }
      for (const [onset, count] of localGraceCounts) {
        entry.graceCountsByBeat.set(
          onset,
          Math.max(entry.graceCountsByBeat.get(onset) || 0, count)
        );
      }
      entry.sourceMeasures.push({ measure, notes });
      entry.duration = Math.max(entry.duration, contentEnd);
    }
  }

  const entries = [...entriesByKey.values()].sort((left, right) => left.firstSeen - right.firstSeen);
  const measures = [];
  const measuresByKey = new Map();
  let startX = 0;
  let startBeat = 0;

  for (const entry of entries) {
    const duration = entry.duration > 0 ? entry.duration : (entry.fallbackDuration || 1);
    const onsets = [...entry.onsets]
      .filter(onset => onset <= duration)
      .sort((left, right) => left - right);
    const positionsByBeat = new Map();
    let previousX = -Infinity;

    for (const onset of onsets) {
      const graceCount = entry.graceCountsByBeat.get(onset) || 0;
      const desiredFirstX = measurePadding + onset * noteWidth;
      const firstX = Number.isFinite(previousX)
        ? Math.max(desiredFirstX, previousX + minNoteSpacing)
        : desiredFirstX;
      const mainX = firstX + graceCount * minNoteSpacing;
      positionsByBeat.set(normalizeLayoutBeat(onset), mainX);
      previousX = mainX;
    }

    // Give every grace-note onset its own slot immediately before the principal
    // note, while grace chords continue to share their initiating grace slot.
    for (const source of entry.sourceMeasures) {
      const graceCounts = new Map();
      const lastGraceX = new Map();
      for (const note of source.notes) {
        const onset = Math.max(0, normalizeLayoutBeat(note.startBeatInMeasure));
        const mainX = positionsByBeat.get(onset) ?? measurePadding;
        if (note.isGrace) {
          if (!note.isChord) {
            const graceIndex = (graceCounts.get(onset) || 0) + 1;
            graceCounts.set(onset, graceIndex);
            const sourceGraceCount = source.notes.filter(candidate =>
              candidate.isGrace && !candidate.isChord &&
              normalizeLayoutBeat(candidate.startBeatInMeasure) === onset
            ).length;
            const x = mainX - (sourceGraceCount - graceIndex + 1) * minNoteSpacing;
            notePositions.set(note, x);
            lastGraceX.set(onset, x);
          } else {
            notePositions.set(note, lastGraceX.get(onset) ?? mainX - minNoteSpacing);
          }
        } else {
          notePositions.set(note, mainX);
        }
      }
    }

    const naturalWidth = measurePadding * 2 + duration * noteWidth;
    const width = Math.max(naturalWidth, Number.isFinite(previousX) ? previousX + measurePadding : 0);
    const anchors = [{ beat: 0, x: positionsByBeat.get(0) ?? measurePadding }];
    for (const onset of onsets) {
      if (onset > 0 && onset < duration) {
        anchors.push({ beat: onset, x: positionsByBeat.get(normalizeLayoutBeat(onset)) });
      }
    }
    anchors.push({ beat: duration, x: width });

    const measureLayout = {
      key: entry.key,
      number: entry.number,
      startX,
      endX: startX + width,
      width,
      startBeat,
      endBeat: startBeat + duration,
      duration,
      anchors,
      positionsByBeat
    };
    measures.push(measureLayout);
    measuresByKey.set(entry.key, measureLayout);
    startX += width;
    startBeat += duration;
  }

  // A single global interpolation map keeps the playback cursor continuous.
  // Internal measure ends are deliberately omitted; the following measure's
  // beat-zero note anchor owns that instant and the cursor glides toward it.
  const timelineByBeat = new Map();
  for (const measureLayout of measures) {
    // Measure starts belong to the barline. Note heads keep their own padded
    // positions, but the transport cursor should land exactly on the barline.
    timelineByBeat.set(measureLayout.startBeat, measureLayout.startX);
    for (const [localBeat, localX] of measureLayout.positionsByBeat) {
      if (localBeat === 0) continue;
      timelineByBeat.set(
        normalizeLayoutBeat(measureLayout.startBeat + localBeat),
        measureLayout.startX + localX
      );
    }
  }
  if (measures.length > 0) timelineByBeat.set(startBeat, startX);
  const timelineAnchors = [...timelineByBeat.entries()]
    .map(([beat, x]) => ({ beat, x }))
    .sort((left, right) => left.beat - right.beat);

  const getMeasure = (measure, measureIndex = 0) => {
    const key = measure && typeof measure === 'object' ? measureKeys.get(measure) : null;
    return (key ? measuresByKey.get(key) : null) || measures[measureIndex] || null;
  };

  const getNoteX = (measure, measureIndex, localBeat, note = null) => {
    const measureLayout = getMeasure(measure, measureIndex);
    if (!measureLayout) return Math.max(0, Number(localBeat) || 0) * noteWidth;
    const noteX = note && typeof note === 'object' ? notePositions.get(note) : null;
    const exact = noteX ?? measureLayout.positionsByBeat.get(normalizeLayoutBeat(localBeat));
    const localX = exact ?? interpolateMeasureBeat(measureLayout, localBeat);
    return measureLayout.startX + localX;
  };

  const beatToX = (beat) => {
    const value = Math.max(0, Number(beat) || 0);
    if (timelineAnchors.length === 0) return value * noteWidth;
    const last = timelineAnchors[timelineAnchors.length - 1];
    if (value > last.beat) return last.x + (value - last.beat) * noteWidth;
    return interpolateAnchors(timelineAnchors, value, value * noteWidth);
  };

  return {
    measures,
    totalWidth: startX,
    totalBeats: startBeat,
    timelineAnchors,
    getMeasure,
    getNoteX,
    beatToX
  };
}

/**
 * NotationRenderer class - renders music notation on an HTML5 Canvas.
 */
export class NotationRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Layout configuration
    this.config = {
      staffHeight: 60,
      staffSpacing: 160,
      lineSpacing: 12, // pixels between staff lines
      noteWidth: 40, // preferred horizontal space per beat
      minNoteSpacing: 30, // minimum center-to-center gap for distinct onsets
      measurePadding: 18, // breathing room between notes and barlines
      marginLeft: 100,
      marginTop: 40,
      marginRight: 40,
      clefWidth: 70,
      measureBarWidth: 2,
      cursorColor: 'rgba(74, 158, 255, 0.6)',
      cursorWidth: 3,
      cursorAnchorRatio: 0.4, // pin the playback cursor left of screen center
      pitchTrailMaxSamples: 240,
      ...options
    };

    this.parts = [];
    this.metadata = null;
    this.horizontalLayout = buildHorizontalScoreLayout([], this.config);
    this.scrollX = 0;
    this.scrollX = 0;
    this.userPitch = null; // { frequency, noteName, octave, cents, accuracy }
    this.currentPitchSample = null;
    this.userPitchTrail = [];
    this.isPitchContinuous = false;
    this.pitchAccuracyState = 'neutral';
    this.selectedPartId = null;
    this.isAutoScrollEnabled = true;
    this.focusSelectedPart = false;
    // Pitch feedback runs roughly 30 times per second while the microphone is
    // active. Keep a compact, score-time index so feedback does not have to
    // walk every measure and note for every analysis frame.
    this.pitchTimelineByPart = new Map();

    // The notation itself is unchanged while the transport moves. Cache it in
    // small horizontal tiles so normal playback only composites the visible
    // score and draws the live cursor/pitch overlay. Tiles avoid creating one
    // enormous canvas for long imported scores.
    this.staticScoreTiles = new Map();
    this.staticTileAccess = 0;
    this.renderFrame = null;
  }

  /**
   * Set the parsed music data for rendering.
   * @param {Array} parts - array of part objects from parser
   * @param {object} metadata - metadata from parser
   */
  setData(parts, metadata) {
    this.parts = Array.isArray(parts) ? parts : [];
    this.metadata = metadata;
    this.horizontalLayout = buildHorizontalScoreLayout(this.parts, this.config);
    this.buildPitchTimelines();
    this.currentBeat = 0;
    this.userPitch = null;
    this.currentPitchSample = null;
    this.userPitchTrail = [];
    this.isPitchContinuous = false;
    this.pitchAccuracyState = 'neutral';
    this.invalidateStaticScore();
    this.resize();
    this.render();
  }

  /**
   * Resize the canvas to fit content.
   * Width matches the parent; height expands to fit all staves so the
   * container can scroll vertically when parts exceed the viewport.
   */
  resize() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const parent = this.canvas.parentElement;
    const width = parent.clientWidth;

    const requiredHeight = this.parts.length > 0
      ? this.config.marginTop + this.parts.length * this.config.staffSpacing + 40
      : parent.clientHeight;
    const height = Math.max(parent.clientHeight, requiredHeight);

    // Changing a canvas dimension clears it, and the static score cache is
    // sized for that exact viewport height. Avoid doing either during resize
    // events that do not change the rendered dimensions.
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.invalidateStaticScore();
  }

  /** Drop cached score tiles after a score or viewport change. */
  invalidateStaticScore() {
    this.staticScoreTiles.clear();
    this.staticTileAccess = 0;
  }

  /**
   * Build lookup data used by live microphone feedback. Each segment contains
   * precisely the sounding notes between two score-time boundaries; clefs are
   * stored as a small ordered change list. This turns per-frame feedback from
   * a complete score scan into two binary searches.
   */
  buildPitchTimelines() {
    this.pitchTimelineByPart.clear();

    for (const part of this.parts) {
      const boundaries = new Map();
      const clefChanges = [];
      const endingNotes = new Map();
      const fermataEndingNotes = new Map();
      const addBoundary = (beat) => {
        if (!boundaries.has(beat)) boundaries.set(beat, { starting: [], ending: [] });
        return boundaries.get(beat);
      };
      const addEndingNote = (collection, beat, candidate) => {
        const notes = collection.get(beat) || [];
        notes.push(candidate);
        collection.set(beat, notes);
      };

      for (const measure of part.measures || []) {
        const measureStart = Number(measure.startBeat) || 0;
        for (const note of measure.notes || []) {
          const startBeat = measureStart + (Number(note.startBeatInMeasure) || 0);
          const noteClef = normalizeClef(note.clef);
          if (noteClef) clefChanges.push({ beat: startBeat, clef: noteClef });

          if (note.isRest || !note.pitch) continue;
          const duration = Number(note.durationBeats) || 0;
          if (duration <= 0) continue;

          let midi;
          try {
            midi = pitchToMidi(note.pitch.step, note.pitch.alter, note.pitch.octave);
          } catch {
            continue;
          }

          const candidate = { note, midi };
          const endBeat = startBeat + duration;
          addBoundary(startBeat).starting.push(candidate);
          addBoundary(endBeat).ending.push(candidate);
          addEndingNote(endingNotes, endBeat, candidate);
          if (note.fermata) addEndingNote(fermataEndingNotes, endBeat, candidate);
        }
      }

      const beats = [...boundaries.keys()].sort((left, right) => left - right);
      const segments = [];
      const active = new Set();
      for (let index = 0; index < beats.length; index++) {
        const beat = beats[index];
        const boundary = boundaries.get(beat);
        for (const candidate of boundary.ending) active.delete(candidate);
        for (const candidate of boundary.starting) active.add(candidate);
        const nextBeat = beats[index + 1];
        if (nextBeat !== undefined && nextBeat > beat) {
          segments.push({ startBeat: beat, endBeat: nextBeat, candidates: [...active] });
        }
      }

      // When multiple notes introduce a clef at the same beat, the final
      // source-order value is the one the renderer historically used.
      clefChanges.sort((left, right) => left.beat - right.beat);
      this.pitchTimelineByPart.set(part.id, {
        segments,
        segmentStarts: segments.map(segment => segment.startBeat),
        clefChanges,
        clefStarts: clefChanges.map(change => change.beat),
        endingNotes,
        endingBeats: [...endingNotes.keys()].sort((left, right) => left - right),
        fermataEndingNotes,
        fermataEndingBeats: [...fermataEndingNotes.keys()].sort((left, right) => left - right)
      });
    }
  }

  /** Return the last index whose ordered value is at or before target. */
  findTimelineIndex(values, target) {
    let low = 0;
    let high = values.length - 1;
    let result = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (values[middle] <= target + 1e-6) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  /** Find an end-boundary collection, allowing for harmless float drift. */
  findTimelineBoundary(timeline, beatsKey, collectionKey, beat) {
    const beats = timeline?.[beatsKey] || [];
    const index = this.findTimelineIndex(beats, beat);
    if (index < 0 || Math.abs(beats[index] - beat) > 1e-6) return [];
    return timeline[collectionKey].get(beats[index]) || [];
  }

  /** Schedule at most one paint for a burst of transport and mic updates. */
  requestRender() {
    if (this.renderFrame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.render();
      return;
    }
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  /**
   * Update the current playback position.
   * @param {number} beat - current beat position
   */
  setCurrentBeat(beat, options = {}) {
    const nextBeat = Number(beat);
    if (!Number.isFinite(nextBeat)) return;

    this.currentBeat = nextBeat;
    if (options.autoScroll !== false && this.isAutoScrollEnabled) {
      this.autoScroll();
    }
    this.requestRender();
  }

  /** Move the viewport directly, for editor-style drag panning. */
  setScrollX(scrollX) {
    const scoreLeft = this.config.marginLeft + this.config.clefWidth;
    const contentWidth = scoreLeft + this.horizontalLayout.totalWidth + this.config.marginRight;
    const maxScroll = Math.max(0, contentWidth - this.canvas.width);
    const nextScroll = Math.max(0, Math.min(maxScroll, Number(scrollX) || 0));
    if (Math.abs(nextScroll - this.scrollX) < 0.01) return;
    this.scrollX = nextScroll;
    this.requestRender();
  }

  /** Emphasize the selected part while leaving an all-parts view available. */
  setFocusSelectedPart(enabled) {
    const nextValue = !!enabled;
    if (nextValue === this.focusSelectedPart) return;
    this.focusSelectedPart = nextValue;
    this.invalidateStaticScore();
    this.requestRender();
  }

  /** Return friendly playback context for the transport, if score data exists. */
  getMeasureContext(beat) {
    const measures = this.horizontalLayout?.measures || [];
    const target = Math.max(0, Number(beat) || 0);
    for (let index = measures.length - 1; index >= 0; index--) {
      const measure = measures[index];
      if (target >= measure.startBeat - 1e-6) {
        return {
          number: measure.number || index + 1,
          beat: Math.max(1, Math.floor(target - measure.startBeat) + 1)
        };
      }
    }
    return null;
  }

  /**
   * Resolve a canvas click to the nearest note or measure onset.
   * The returned beat is always an existing score position, never an
   * interpolated point in the middle of a note.
   * @param {number} screenX - x coordinate in the canvas viewport
   * @returns {number|null}
   */
  getBeatAtScreenX(screenX) {
    const x = Number(screenX);
    if (!Number.isFinite(x) || !this.horizontalLayout?.timelineAnchors?.length) {
      return null;
    }

    const scoreOrigin = this.config.marginLeft + this.config.clefWidth;
    const contentX = x + this.scrollX - scoreOrigin;
    const anchors = this.horizontalLayout.timelineAnchors
      .filter(anchor => anchor.beat < this.horizontalLayout.totalBeats - 1e-9);
    if (anchors.length === 0) return 0;

    let nearest = anchors[0];
    let nearestDistance = Math.abs(contentX - nearest.x);
    for (let index = 1; index < anchors.length; index++) {
      const anchor = anchors[index];
      const distance = Math.abs(contentX - anchor.x);
      if (distance < nearestDistance) {
        nearest = anchor;
        nearestDistance = distance;
      }
    }
    return nearest.beat;
  }

  /**
   * Map a score-space x coordinate back to a continuous beat for timeline
   * scrubbing. Unlike click selection, this intentionally permits positions
   * between note onsets so the score can glide beneath the fixed playhead.
   */
  getBeatAtScoreX(scoreX) {
    const scoreOrigin = this.config.marginLeft + this.config.clefWidth;
    const targetX = Math.max(0, Number(scoreX) - scoreOrigin);
    const anchors = this.horizontalLayout?.timelineAnchors || [];
    if (anchors.length === 0) return 0;
    if (targetX <= anchors[0].x) return anchors[0].beat;

    for (let index = 1; index < anchors.length; index++) {
      const right = anchors[index];
      if (targetX > right.x) continue;
      const left = anchors[index - 1];
      const span = right.x - left.x;
      if (span <= 0) return right.beat;
      const progress = (targetX - left.x) / span;
      return left.beat + (right.beat - left.beat) * progress;
    }
    return this.horizontalLayout.totalBeats;
  }

  /**
   * Move the score only when a requested navigation target is outside the
   * visible score area. This intentionally uses the smallest possible scroll,
   * rather than centering the selected bar.
   * @param {number} beat
   */
  ensureBeatVisible(beat, options = {}) {
    const targetX = this.getScoreX(beat);
    const scoreLeft = this.config.marginLeft + this.config.clefWidth;
    const padding = Math.min(48, Math.max(12, this.canvas.width * 0.08));
    const visibleLeft = this.scrollX + scoreLeft + padding;
    const visibleRight = this.scrollX + this.canvas.width - padding;
    let nextScroll = this.scrollX;

    if (targetX < visibleLeft) {
      nextScroll = targetX - scoreLeft - padding;
    } else if (targetX > visibleRight) {
      nextScroll = targetX - this.canvas.width + padding;
    }

    const contentWidth = scoreLeft + this.horizontalLayout.totalWidth + this.config.marginRight;
    const maxScroll = Math.max(0, contentWidth - this.canvas.width);
    this.scrollX = Math.max(0, Math.min(maxScroll, nextScroll));
    if (options.render !== false) {
      this.render();
    }
  }

  /**
   * Update the user's detected pitch and save the marker at the time represented
   * by the microphone's capture window, not simply at the latest cursor frame.
   * @param {object|null} pitchData - { frequency, noteName, octave, cents, accuracy }
   * @param {number|{ beat: number, isFermataHold?: boolean }} [samplePosition]
   * @returns {object|null} score-aware sample used by the canvas and pitch guide
   */
  setUserPitch(pitchData, samplePosition = this.currentBeat) {
    if (!pitchData) {
      this.userPitch = null;
      this.currentPitchSample = null;
      this.isPitchContinuous = false;
      this.pitchAccuracyState = 'neutral';
      this.requestRender();
      return null;
    }

    const position = samplePosition && typeof samplePosition === 'object'
      ? samplePosition
      : { beat: samplePosition, isFermataHold: false };
    const beat = Number.isFinite(Number(position.beat))
      ? Math.max(0, Number(position.beat))
      : this.currentBeat;
    const selectedPitchData = this.selectPitchCandidate(pitchData, beat, {
      isFermataHold: !!position.isFermataHold
    });

    // A valid smoothed detector frame advances the marker immediately; the
    // detector has already rejected silence and out-of-range measurements.
    if (!selectedPitchData) {
      this.requestRender();
      return this.currentPitchSample;
    }

    this.userPitch = selectedPitchData;
    const sample = this.createPitchSample(selectedPitchData, beat, {
      isFermataHold: !!position.isFermataHold
    });
    this.currentPitchSample = sample;
    if (sample) this.recordUserPitchPosition(sample);
    this.requestRender();
    return sample;
  }

  /**
   * Normalize the restored single-frequency detector payload.
   *
   * Pitch estimation and smoothing are intentionally handled entirely by the
   * detector. The renderer only preserves the score-relative target feedback,
   * trail, and color behavior.
   * @param {object} pitchData
   * @returns {object|null}
   */
  selectPitchCandidate(pitchData) {
    const frequency = Number(pitchData?.frequency);
    if (!Number.isFinite(frequency) || frequency < 50 || frequency > 2000) {
      return null;
    }
    return pitchData;
  }

  /**
   * Select which part's staff receives the live microphone pitch overlay.
   * Changing sections starts a fresh trail because the marker changes staves.
   * @param {string|null} partId
   */
  setSelectedPart(partId) {
    if (partId !== this.selectedPartId) {
      this.selectedPartId = partId;
      this.clearUserPitchTrail();
      this.currentPitchSample = null;
      if (this.focusSelectedPart) this.invalidateStaticScore();
    }
    this.requestRender();
  }

  /**
   * Remove all saved marker positions.
   */
  clearUserPitchTrail() {
    this.userPitchTrail = [];
    this.isPitchContinuous = false;
    this.pitchAccuracyState = 'neutral';
  }

  /**
   * Resolve the selected staff, falling back to the first part when needed.
   * @returns {{ part: object, partIndex: number }|null}
   */
  getSelectedPartContext() {
    if (!this.parts.length) return null;
    const selectedIndex = this.parts.findIndex(part => part.id === this.selectedPartId);
    const partIndex = selectedIndex >= 0 ? selectedIndex : 0;
    return { part: this.parts[partIndex], partIndex };
  }

  /**
   * Return every sounding target at a beat. Chords retain all members so the
   * live pitch can be compared with any expected chord member.
   * @param {object} part
   * @param {number} beat
   * @param {boolean} isFermataHold
   * @returns {Array<{ note: object, midi: number }>}
   */
  findTargetCandidates(part, beat, isFermataHold = false) {
    const timeline = this.pitchTimelineByPart.get(part?.id);
    if (!timeline) return [];

    const boundaryHeldCandidates = this.findTimelineBoundary(
      timeline, 'endingBeats', 'endingNotes', beat
    );
    if (isFermataHold) return boundaryHeldCandidates;

    const heldFermataCandidates = this.findTimelineBoundary(
      timeline, 'fermataEndingBeats', 'fermataEndingNotes', beat
    );
    if (heldFermataCandidates.length) return heldFermataCandidates;

    const segmentIndex = this.findTimelineIndex(timeline.segmentStarts, beat);
    if (segmentIndex < 0) return [];
    const segment = timeline.segments[segmentIndex];
    return beat >= segment.startBeat && beat < segment.endBeat
      ? segment.candidates
      : [];
  }

  /**
   * Find the sounding score note at a beat. Chords select the pitch nearest to
   * the singer so any valid chord member can produce useful feedback.
   * @param {object} part
   * @param {number} beat
   * @param {number|null} detectedMidi
   * @param {boolean} isFermataHold
   * @returns {{ note: object, midi: number }|null}
   */
  findTargetNote(part, beat, detectedMidi, isFermataHold = false) {
    const candidates = this.findTargetCandidates(part, beat, isFermataHold);
    if (!candidates.length) return null;
    if (!Number.isFinite(detectedMidi)) return candidates[0];
    return candidates.reduce((nearest, candidate) =>
      Math.abs(candidate.midi - detectedMidi) < Math.abs(nearest.midi - detectedMidi)
        ? candidate
        : nearest
    );
  }

  /**
   * Resolve the clef active at a score beat independently of pitched targets.
   * This keeps the marker in the correct coordinate system over rests and gaps.
   * @param {object} part
   * @param {number} beat
   * @param {object} fallbackClef
   * @returns {object}
   */
  findClefAtBeat(part, beat, fallbackClef) {
    const timeline = this.pitchTimelineByPart.get(part?.id);
    if (!timeline) return fallbackClef;
    const changeIndex = this.findTimelineIndex(timeline.clefStarts, beat);
    return changeIndex >= 0 ? timeline.clefChanges[changeIndex].clef : fallbackClef;
  }

  /**
   * Convert a detector reading into all geometry and feedback needed to draw it.
   * Correct enharmonic pitches use the score's spelling, so flats and unusual
   * accidentals occupy the same line/space as the imported note.
   * @param {object} pitchData
   * @param {number} beat
   * @param {{ isFermataHold?: boolean }} options
   * @returns {object|null}
   */
  createPitchSample(pitchData, beat, options = {}) {
    const selected = this.getSelectedPartContext();
    if (!selected || !pitchData?.noteName) return null;

    const detectedMidi = getDetectedMidi(pitchData);
    const target = this.findTargetNote(
      selected.part,
      beat,
      detectedMidi,
      !!options.isFermataHold
    );
    const partClef = getClefDescriptorForPart(
      selected.part,
      selected.partIndex,
      this.parts.length
    );
    const clef = normalizeClef(target?.note.clef) ||
      this.findClefAtBeat(selected.part, beat, partClef);

    let step = String(pitchData.noteName).charAt(0).toUpperCase();
    let octave = Number(pitchData.octave);
    let centsFromTarget = null;
    let isRightNote = false;

    if (target && Number.isFinite(detectedMidi)) {
      centsFromTarget = Math.round((detectedMidi - target.midi) * 100);
      isRightNote = Math.round(detectedMidi) === target.midi;

      // frequencyToNote always returns sharp spellings (e.g. A# instead of Bb).
      // When the singer is within a semitone of the written note, borrow the
      // score's diatonic step so the marker sits on the correct staff line/space
      // and any flat or unusual accidental is represented faithfully.
      if (Math.abs(centsFromTarget) <= 100) {
        step = String(target.note.pitch.step).toUpperCase();
        octave = Number(target.note.pitch.octave);
      }
    }

    const feedback = getPitchFeedback(centsFromTarget, this.pitchAccuracyState);
    this.pitchAccuracyState = feedback.accuracy;
    return {
      beat,
      partIndex: selected.partIndex,
      step,
      octave,
      clef,
      cents: Number(pitchData.cents) || 0,
      centsFromTarget,
      hasTarget: !!target,
      isRightNote,
      accuracy: feedback.accuracy,
      color: feedback.color
    };
  }

  /**
   * Save the live marker's literal content-space position. Identical consecutive
   * points are ignored so a paused transport cannot displace useful history.
   * @param {object} sample
   */
  recordUserPitchPosition(sample) {
    const { x, y } = this.getPitchSamplePosition(sample);
    const last = this.userPitchTrail[this.userPitchTrail.length - 1];
    const point = {
      x,
      y,
      color: sample.color,
      breakBefore: !this.isPitchContinuous
    };

    // Do not let small latency-estimate fluctuations draw backward in time.
    if (last && point.x < last.x) return;
    if (last && last.x === point.x && last.y === point.y && last.color === point.color) {
      return;
    }

    this.userPitchTrail.push(point);
    this.isPitchContinuous = true;
    if (this.userPitchTrail.length > this.config.pitchTrailMaxSamples) {
      this.userPitchTrail.splice(
        0,
        this.userPitchTrail.length - this.config.pitchTrailMaxSamples
      );
      if (this.userPitchTrail[0]) this.userPitchTrail[0].breakBefore = true;
    }
  }

  /**
   * Convert a global playback beat to the shared score's content-space x value.
   * @param {number} beat
   * @returns {number}
   */
  getScoreX(beat) {
    const scoreOrigin = this.config.marginLeft + this.config.clefWidth;
    const layoutX = this.horizontalLayout
      ? this.horizontalLayout.beatToX(beat)
      : Math.max(0, Number(beat) || 0) * this.config.noteWidth;
    return scoreOrigin + layoutX;
  }

  /**
   * Keep the playback cursor pinned to a fixed anchor on the left side of
   * center, scrolling the score beneath it like a teleprompter. Near the start
   * the cursor sits at its natural position because the scroll offset is
   * clamped at zero, and it stops advancing once the score end is reached.
   */
  autoScroll() {
    const cursorX = this.getScoreX(this.currentBeat);
    const scoreLeft = this.config.marginLeft + this.config.clefWidth;
    const anchorX = this.canvas.width * this.config.cursorAnchorRatio;
    const contentWidth = scoreLeft + this.horizontalLayout.totalWidth + this.config.marginRight;
    const maxScroll = Math.max(0, contentWidth - this.canvas.width);
    this.scrollX = Math.max(0, Math.min(maxScroll, cursorX - anchorX));
  }

  /**
   * Main render method - draws the entire notation.
   */
  render() {
    if (!this.ctx || !this.canvas) return;

    // A direct render supersedes a queued transport or microphone update.
    if (this.renderFrame !== null) {
      cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }

    const ctx = this.ctx;
    const { width, height } = this.canvas;

    // Clear canvas
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);

    if (!this.parts || this.parts.length === 0) {
      ctx.fillStyle = '#6a6a7a';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No music loaded', width / 2, height / 2);
      return;
    }

    // The score body is expensive to lay out and does not change while the
    // current beat changes. Composite its cached tiles, then paint only the
    // elements that are genuinely dynamic.
    // Staff lines and clefs intentionally remain fixed in the left gutter as
    // notes scroll beneath them. They are cheap to draw, so keep that small
    // layer live and cache only the scrolling notation.
    this.drawPartScaffolds(ctx);
    const scoreOrigin = this.config.marginLeft + this.config.clefWidth;
    ctx.save();
    ctx.beginPath();
    ctx.rect(scoreOrigin, 0, Math.max(0, width - scoreOrigin), height);
    ctx.clip();
    this.drawStaticScore(ctx);
    ctx.restore();
    this.drawPartNames(ctx);

    ctx.save();
    ctx.beginPath();
    ctx.rect(scoreOrigin, 0, Math.max(0, width - scoreOrigin), height);
    ctx.clip();
    ctx.translate(-this.scrollX, 0);

    // Draw the recent sung-pitch trail underneath the live cursor/marker.
    if (this.userPitchTrail.length > 0) {
      this.drawUserPitchTrail(ctx);
    }

    // Draw playback cursor
    this.drawCursor(ctx);

    // Draw current user pitch indicator
    if (this.currentPitchSample) {
      this.drawUserPitch(ctx);
    }

    ctx.restore();
  }

  /** Return the horizontal span required by the cached score tiles. */
  getStaticScoreWidth() {
    const scoreOrigin = this.config.marginLeft + this.config.clefWidth;
    const scoreWidth = scoreOrigin + this.horizontalLayout.totalWidth + this.config.marginRight;
    return Math.max(1, Math.ceil(Math.max(this.canvas.width, scoreWidth)));
  }

  /**
   * Return one lazily-built score tile. Keeping a small LRU cache prevents a
   * lengthy imported score from allocating a single oversized canvas.
   */
  getStaticScoreTile(tileIndex) {
    const tileWidth = 2048;
    const contentWidth = this.getStaticScoreWidth();
    const tileStart = tileIndex * tileWidth;
    if (tileStart >= contentWidth) return null;

    const cached = this.staticScoreTiles.get(tileIndex);
    if (cached) {
      cached.lastUsed = ++this.staticTileAccess;
      return cached.canvas;
    }

    const tile = document.createElement('canvas');
    tile.width = Math.min(tileWidth, contentWidth - tileStart);
    tile.height = this.canvas.height;
    const tileCtx = tile.getContext('2d');
    if (!tileCtx) return null;

    tileCtx.save();
    tileCtx.translate(-tileStart, 0);
    for (let i = 0; i < this.parts.length; i++) {
      const yOffset = this.config.marginTop + i * this.config.staffSpacing;
      this.drawPartStaff(tileCtx, this.parts[i], yOffset, i, {
        includePartName: false,
        includeScaffold: false,
        scrollX: tileStart,
        viewportWidth: tile.width,
        staticViewport: true
      });
    }
    this.drawMeasureNumbers(tileCtx, {
      scrollX: tileStart,
      viewportWidth: tile.width
    });
    tileCtx.restore();

    this.staticScoreTiles.set(tileIndex, {
      canvas: tile,
      lastUsed: ++this.staticTileAccess
    });

    // Six 2048px tiles cover several desktop viewports without allowing a
    // single unusually long score to accumulate unbounded image memory.
    const maxTiles = 6;
    if (this.staticScoreTiles.size > maxTiles) {
      let oldestIndex = null;
      let oldestAccess = Infinity;
      for (const [index, entry] of this.staticScoreTiles) {
        if (entry.lastUsed < oldestAccess) {
          oldestIndex = index;
          oldestAccess = entry.lastUsed;
        }
      }
      if (oldestIndex !== null) this.staticScoreTiles.delete(oldestIndex);
    }

    return tile;
  }

  /** Composite just the score tiles visible in the current canvas viewport. */
  drawStaticScore(ctx) {
    const tileWidth = 2048;
    const contentWidth = this.getStaticScoreWidth();
    const firstTile = Math.floor(Math.max(0, this.scrollX) / tileWidth);
    const finalX = Math.min(contentWidth - 1, this.scrollX + this.canvas.width - 1);
    const lastTile = Math.floor(Math.max(0, finalX) / tileWidth);

    for (let tileIndex = firstTile; tileIndex <= lastTile; tileIndex++) {
      const tile = this.getStaticScoreTile(tileIndex);
      if (tile) ctx.drawImage(tile, tileIndex * tileWidth - this.scrollX, 0);
    }
  }

  /** Draw compact measure labels once in the score layer for rehearsal context. */
  drawMeasureNumbers(ctx, options = {}) {
    const { marginLeft, clefWidth, marginTop } = this.config;
    const scoreOrigin = marginLeft + clefWidth;
    const viewportScrollX = Number.isFinite(options.scrollX) ? options.scrollX : this.scrollX;
    const viewportWidth = Number.isFinite(options.viewportWidth)
      ? options.viewportWidth
      : this.canvas.width;
    ctx.save();
    ctx.fillStyle = '#8394b8';
    ctx.font = '600 10px sans-serif';
    ctx.textAlign = 'left';
    for (let index = 0; index < this.horizontalLayout.measures.length; index++) {
      const measure = this.horizontalLayout.measures[index];
      const x = scoreOrigin + measure.startX + 4;
      const screenX = x - viewportScrollX;
      if (screenX < scoreOrigin || screenX > viewportWidth) continue;
      ctx.fillText(`M. ${measure.number || index + 1}`, x, Math.max(16, marginTop - 18));
    }
    ctx.restore();
  }

  /** Draw part labels in the fixed left gutter above the cached score body. */
  drawPartNames(ctx) {
    const { lineSpacing, marginLeft } = this.config;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    for (let i = 0; i < this.parts.length; i++) {
      const dimmed = this.focusSelectedPart && this.parts[i].id !== this.selectedPartId;
      ctx.save();
      if (dimmed) ctx.globalAlpha = 0.3;
      const yOffset = this.config.marginTop + i * this.config.staffSpacing;
      ctx.fillStyle = getPartColor(this.parts[i].voiceType);
      ctx.fillText(this.parts[i].name, marginLeft - 70, yOffset + lineSpacing * 2 + 4);
      ctx.restore();
    }
  }

  /** Draw the fixed staff lines and clef gutter above the cached note tiles. */
  drawPartScaffolds(ctx) {
    const { lineSpacing, marginLeft, marginRight, clefWidth, measureBarWidth } = this.config;
    const scoreOrigin = marginLeft + clefWidth;
    const contentEnd = scoreOrigin + this.horizontalLayout.totalWidth + marginRight;
    const totalWidth = Math.max(this.canvas.width, contentEnd - this.scrollX);

    ctx.strokeStyle = '#3a4a6a';
    ctx.lineWidth = 1;
    for (let index = 0; index < this.parts.length; index++) {
      const isSelected = this.parts[index].id === this.selectedPartId;
      const dimmed = this.focusSelectedPart && !isSelected;
      const yOffset = this.config.marginTop + index * this.config.staffSpacing;
      ctx.save();
      if (this.focusSelectedPart && isSelected) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
        ctx.fillRect(marginLeft - 12, yOffset - 22, totalWidth - marginLeft + 24, lineSpacing * 4 + 44);
      }
      if (dimmed) ctx.globalAlpha = 0.3;
      for (let line = 0; line < 5; line++) {
        const y = yOffset + line * lineSpacing;
        ctx.beginPath();
        ctx.moveTo(marginLeft, y);
        ctx.lineTo(totalWidth, y);
        ctx.stroke();
      }
      this.drawClef(
        ctx,
        getClefDescriptorForPart(this.parts[index], index, this.parts.length),
        marginLeft + 10,
        yOffset
      );
      ctx.restore();
    }
  }

  /**
   * Draw a single part's staff with notes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} part
   * @param {number} yOffset - vertical position of the staff top
   * @param {number} partIndex - section index, used for SATB clef fallback
   */
  drawPartStaff(ctx, part, yOffset, partIndex = 0, options = {}) {
    const { lineSpacing, marginLeft, marginRight, clefWidth, measureBarWidth } = this.config;
    const color = getPartColor(part.voiceType);
    const clef = getClefDescriptorForPart(part, partIndex, this.parts.length);
    const scoreOrigin = marginLeft + clefWidth;
    const viewportScrollX = Number.isFinite(options.scrollX) ? options.scrollX : this.scrollX;
    const viewportWidth = Number.isFinite(options.viewportWidth)
      ? options.viewportWidth
      : this.canvas.width;
    const staticViewport = options.staticViewport === true;
    const dimmed = this.focusSelectedPart && part.id !== this.selectedPartId;
    if (dimmed) {
      ctx.save();
      ctx.globalAlpha = 0.3;
    }

    // Draw part name
    if (options.includePartName !== false) {
      ctx.fillStyle = color;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(
        part.name,
        marginLeft - 70 + (staticViewport ? 0 : viewportScrollX),
        yOffset + lineSpacing * 2 + 4
      );
    }

    if (options.includeScaffold !== false) {
      // Draw 5 staff lines across the full shared score width. The viewport-sized
      // fallback keeps lines continuous when the score is shorter than the canvas.
      ctx.strokeStyle = '#3a4a6a';
      ctx.lineWidth = 1;
      const contentEnd = scoreOrigin + this.horizontalLayout.totalWidth + marginRight;
      const totalWidth = Math.max(
        viewportWidth + (staticViewport ? 0 : viewportScrollX),
        contentEnd
      );
      for (let line = 0; line < 5; line++) {
        const y = yOffset + line * lineSpacing;
        ctx.beginPath();
        ctx.moveTo(marginLeft + (staticViewport ? 0 : viewportScrollX), y);
        ctx.lineTo(totalWidth, y);
        ctx.stroke();
      }

      // Draw the score's clef (or the SATB fallback) at the start of the staff.
      this.drawClef(ctx, clef, marginLeft + 10 + (staticViewport ? 0 : viewportScrollX), yOffset);
    }

    // Every staff uses the same measure boundaries, including sections with an
    // empty or omitted source measure. This keeps all barlines vertically aligned.
    ctx.strokeStyle = '#4a5a7a';
    ctx.lineWidth = measureBarWidth || 1;
    const sharedMeasures = this.horizontalLayout.measures;
    for (let measureIndex = 1; measureIndex < sharedMeasures.length; measureIndex++) {
      const barX = scoreOrigin + sharedMeasures[measureIndex].startX;
      ctx.beginPath();
      ctx.moveTo(barX, yOffset);
      ctx.lineTo(barX, yOffset + lineSpacing * 4);
      ctx.stroke();
    }
    if (sharedMeasures.length > 0) {
      const finalBarX = scoreOrigin + sharedMeasures[sharedMeasures.length - 1].endX;
      ctx.beginPath();
      ctx.moveTo(finalBarX, yOffset);
      ctx.lineTo(finalBarX, yOffset + lineSpacing * 4);
      ctx.stroke();
    }

    // Build geometry before drawing. Beams need every member's position in
    // order to choose one stem direction and one shared beam line.
    const allLayouts = [];
    const barlineLayouts = [];
    for (let mIdx = 0; mIdx < (part.measures || []).length; mIdx++) {
      const measure = part.measures[mIdx];
      const measureLayout = this.horizontalLayout.getMeasure(measure, mIdx);
      if (!measureLayout) continue;

      const measureLayouts = (measure.notes || []).map((note, noteIndex) => {
        const localBeat = Number(note.startBeatInMeasure) || 0;
        const absoluteBeat = measureLayout.startBeat + localBeat;
        const x = scoreOrigin + this.horizontalLayout.getNoteX(measure, mIdx, localBeat, note);
        const screenX = x - viewportScrollX;
        const visible = screenX >= scoreOrigin && screenX <= viewportWidth + 40;
        const noteClef = normalizeClef(note.clef) || clef;
        let y = yOffset + lineSpacing * 2;
        if (!note.isRest && note.pitch) {
          const position = getStaffPositionForClef(note.pitch.step, note.pitch.octave, noteClef);
          y = yOffset + (4 * lineSpacing) - (position * lineSpacing / 2);
        }
        return {
          note,
          noteIndex,
          measureIndex: mIdx,
          absoluteBeat,
          x,
          y,
          visible,
          appearance: getNoteRenderInfo(note)
        };
      });

      allLayouts.push(...measureLayouts);
      for (const fermata of measure.barlineFermatas || []) {
        const x = scoreOrigin + (fermata.location === 'left'
          ? measureLayout.startX
          : measureLayout.endX);
        const screenX = x - viewportScrollX;
        barlineLayouts.push({
          fermata,
          x,
          visible: screenX >= scoreOrigin && screenX <= viewportWidth + 40
        });
      }
    }

    // Keep one beam state across the ordered part so valid cross-barline beams
    // remain connected instead of turning into flagless singleton notes.
    const beamGroups = this.prepareBeamGroups(allLayouts, yOffset);

    // Note heads and stems are drawn first. A beamed note keeps its stem but
    // suppresses its individual flag; the shared beam is painted afterwards.
    for (const layout of allLayouts) {
      if (!layout.visible) continue;
      const { note, x, y } = layout;
      if (!note.isRest && note.pitch) {
        this.drawLedgerLines(ctx, x, y, yOffset);
        this.drawNoteGlyph(ctx, x, y, note, yOffset, color, {
          stemUp: layout.stemUp,
          stemEndY: layout.stemEndY,
          suppressStem: layout.suppressStem,
          suppressFlags: layout.suppressFlags
        });
      } else if (note.isRest) {
        this.drawRestGlyph(ctx, x, note, yOffset, color);
      }
    }

    for (const group of beamGroups) {
      this.drawBeamGroup(ctx, group, color);
    }
    for (const group of this.collectTupletGroups(allLayouts)) {
      this.drawTupletGroup(ctx, group, yOffset, color);
    }
    this.drawConnectionCurves(ctx, allLayouts, yOffset, color);

    for (const layout of allLayouts) {
      if (layout.visible && layout.note.fermata) {
        this.drawFermata(ctx, layout, yOffset, color);
      }
    }
    for (const boundary of barlineLayouts) {
      if (boundary.visible) this.drawBarlineFermata(ctx, boundary, yOffset, color);
    }
    if (dimmed) ctx.restore();
  }

  /** Prepare explicit MusicXML beam groups and shared stem geometry. */
  prepareBeamGroups(layouts, yOffset) {
    const { lineSpacing } = this.config;
    const groups = [];
    let active = null;

    const finish = () => {
      if (!active || active.length === 0) {
        active = null;
        return;
      }
      const singletonPrimary = active.length === 1
        ? active[0].note.beams?.find(beam => Number(beam.number) === 1)
        : null;
      if (singletonPrimary && !String(singletonPrimary.type || '').includes('hook')) {
        // Malformed/unmatched beam metadata should degrade to the note's normal
        // flag, never to a stem with neither flag nor beam.
        active = null;
        return;
      }

      const sourceDirections = active
        .map(layout => layout.note.stem)
        .filter(stem => stem === 'up' || stem === 'down');
      const stemUp = sourceDirections.length
        ? sourceDirections.filter(stem => stem === 'up').length >= sourceDirections.length / 2
        : active.reduce((sum, layout) => sum + layout.y, 0) / active.length > yOffset + lineSpacing * 2;
      const beamY = stemUp
        ? Math.min(...active.map(layout => layout.y)) - lineSpacing * 3
        : Math.max(...active.map(layout => layout.y)) + lineSpacing * 3;

      for (const layout of active) {
        const scale = layout.note.isGrace ? 0.75 : 1;
        const radiusX = (layout.appearance.type === 'whole' || layout.appearance.type === 'breve' ? 7 : 6) * scale;
        layout.beamed = true;
        layout.suppressFlags = true;
        layout.stemUp = stemUp;
        layout.stemEndY = beamY;
        layout.stemX = layout.x + (stemUp ? radiusX - 1 : -radiusX + 1);
      }
      groups.push({ layouts: active, stemUp, beamY });
      active = null;
    };

    for (const layout of layouts) {
      const primary = layout.note.beams?.find(beam => Number(beam.number) === 1);
      if (layout.note.isChord) {
        // Chord noteheads share the preceding note's stem and beam.
        layout.suppressStem = true;
        layout.suppressFlags = true;
        continue;
      }
      if (!primary || layout.note.isRest || !layout.note.pitch) {
        finish();
        continue;
      }

      const type = String(primary.type || '').toLowerCase();
      if (type === 'begin') {
        finish();
        active = [layout];
      } else if (type === 'continue') {
        if (!active) active = [];
        active.push(layout);
      } else if (type === 'end') {
        if (!active) active = [];
        active.push(layout);
        finish();
      } else if (type.includes('hook')) {
        finish();
        active = [layout];
        finish();
      } else {
        finish();
      }
    }
    finish();
    return groups;
  }

  /** Draw primary/secondary beams and MusicXML forward/backward hooks. */
  drawBeamGroup(ctx, group, color) {
    const visible = group.layouts.filter(layout => layout.visible);
    if (visible.length === 0) return;

    const direction = group.stemUp ? 1 : -1;
    const beamSpacing = 6;
    const drawSegment = (from, to, level) => {
      const y = group.beamY + direction * (level - 1) * beamSpacing;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(from, y);
      ctx.lineTo(to, y);
      ctx.stroke();
    };

    if (visible.length > 1) {
      drawSegment(visible[0].stemX, visible[visible.length - 1].stemX, 1);
    } else {
      const primary = visible[0].note.beams?.find(beam => Number(beam.number) === 1);
      if (String(primary?.type || '').includes('hook')) {
        const backward = String(primary.type).includes('backward');
        drawSegment(visible[0].stemX, visible[0].stemX + (backward ? -11 : 11), 1);
      }
    }

    const maxLevel = Math.max(1, ...group.layouts.flatMap(layout =>
      (layout.note.beams || []).map(beam => Number(beam.number) || 1)
    ));
    for (let level = 2; level <= maxLevel; level++) {
      for (let index = 0; index < group.layouts.length - 1; index++) {
        const left = group.layouts[index];
        const right = group.layouts[index + 1];
        if (!left.visible || !right.visible) continue;
        const leftType = String(left.note.beams?.find(beam => Number(beam.number) === level)?.type || '');
        const rightType = String(right.note.beams?.find(beam => Number(beam.number) === level)?.type || '');
        const connectsRight = ['begin', 'continue'].includes(leftType) && ['continue', 'end'].includes(rightType);
        if (connectsRight) drawSegment(left.stemX, right.stemX, level);
      }

      for (const layout of group.layouts) {
        if (!layout.visible) continue;
        const type = String(layout.note.beams?.find(beam => Number(beam.number) === level)?.type || '');
        if (!type.includes('hook')) continue;
        const backward = type.includes('backward');
        drawSegment(layout.stemX, layout.stemX + (backward ? -10 : 10), level);
      }
    }
    ctx.lineCap = 'butt';
  }

  /** Collect explicit tuplets, with a ratio-based fallback for sparse files. */
  collectTupletGroups(layouts) {
    const groups = [];
    const used = new Set();

    for (let startIndex = 0; startIndex < layouts.length; startIndex++) {
      const startLayout = layouts[startIndex];
      const starts = (startLayout.note.tuplets || []).filter(tuplet => tuplet.type === 'start');
      for (const marker of starts) {
        const voice = startLayout.note.voice;
        let stopIndex = -1;
        for (let index = startIndex; index < layouts.length; index++) {
          const candidate = layouts[index];
          if (candidate.note.voice !== voice) continue;
          const stops = candidate.note.tuplets || [];
          if (stops.some(tuplet => tuplet.type === 'stop' && Number(tuplet.number) === Number(marker.number))) {
            stopIndex = index;
            break;
          }
        }

        const fallbackCount = startLayout.note.timeModification?.actualNotes || 1;
        const endIndex = stopIndex >= 0
          ? stopIndex
          : Math.min(layouts.length - 1, startIndex + fallbackCount - 1);
        const members = layouts.slice(startIndex, endIndex + 1)
          .filter(layout => layout.note.voice === voice && !layout.note.isChord);
        if (members.length === 0) continue;
        members.forEach(layout => used.add(layout));
        groups.push({ layouts: members, marker, explicit: true });
      }
    }

    for (let index = 0; index < layouts.length;) {
      const first = layouts[index];
      const ratio = first.note.timeModification;
      if (used.has(first) || first.note.isChord || !ratio?.actualNotes || !ratio?.normalNotes || ratio.actualNotes === ratio.normalNotes) {
        index++;
        continue;
      }

      const members = [first];
      let cursor = index + 1;
      while (cursor < layouts.length && members.length < ratio.actualNotes) {
        const candidate = layouts[cursor];
        const candidateRatio = candidate.note.timeModification;
        const previous = members[members.length - 1];
        const contiguous = Math.abs(
          candidate.absoluteBeat - (previous.absoluteBeat + (previous.note.durationBeats || 0))
        ) < 1e-4;
        if (candidate.note.isChord) {
          cursor++;
          continue;
        }
        if (used.has(candidate) || candidate.note.voice !== first.note.voice || !contiguous ||
            candidateRatio?.actualNotes !== ratio.actualNotes || candidateRatio?.normalNotes !== ratio.normalNotes) {
          break;
        }
        members.push(candidate);
        cursor++;
      }

      if (members.length === ratio.actualNotes) {
        members.forEach(layout => used.add(layout));
        groups.push({
          layouts: members,
          marker: { type: 'start', number: 1, bracket: null, showNumber: 'actual', placement: null },
          explicit: false
        });
        index = cursor;
      } else {
        index++;
      }
    }
    return groups;
  }

  /** Draw one tuplet number and, when needed, its bracket. */
  drawTupletGroup(ctx, group, yOffset, color) {
    const members = group.layouts.filter(layout => layout.visible);
    if (members.length === 0) return;

    const first = members[0];
    const last = members[members.length - 1];
    const ratio = group.layouts[0].note.timeModification;
    const actual = ratio?.actualNotes || group.layouts.length;
    const normal = ratio?.normalNotes || 0;
    const showNumber = group.marker.showNumber || 'actual';
    const label = showNumber === 'none'
      ? ''
      : showNumber === 'both' && normal
        ? `${actual}:${normal}`
        : String(actual);
    const placement = group.marker.placement || 'above';
    const below = placement === 'below';
    const direction = below ? 1 : -1;
    const extremes = members.map(layout => {
      if (layout.stemEndY == null) return layout.y;
      return below ? Math.max(layout.y, layout.stemEndY) : Math.min(layout.y, layout.stemEndY);
    });
    const y = (below ? Math.max(...extremes) : Math.min(...extremes)) + direction * 12;
    const x1 = first.x - 6;
    const x2 = last.x + 6;
    const center = (x1 + x2) / 2;
    const bracket = group.marker.bracket === 'yes' ||
      (group.marker.bracket !== 'no' && !group.layouts.every(layout => layout.beamed));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.2;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (bracket) {
      const gap = label ? Math.max(12, ctx.measureText(label).width + 7) : 0;
      ctx.beginPath();
      ctx.moveTo(x1, y + direction * 5);
      ctx.lineTo(x1, y);
      ctx.lineTo(center - gap / 2, y);
      ctx.moveTo(center + gap / 2, y);
      ctx.lineTo(x2, y);
      ctx.lineTo(x2, y + direction * 5);
      ctx.stroke();
    }
    if (label) ctx.fillText(label, center, y);
    ctx.restore();
  }

  /** Draw legato slurs and ties after all note geometry is known. */
  drawConnectionCurves(ctx, layouts, yOffset, color) {
    const activeSlurs = new Map();
    const activeTies = new Map();
    const pitchKey = layout => {
      const pitch = layout.note.pitch || {};
      return `${layout.note.voice || 1}:${pitch.step || ''}:${pitch.alter || 0}:${pitch.octave || ''}`;
    };

    for (const layout of layouts) {
      if (layout.note.isRest || !layout.note.pitch) continue;
      const slurs = layout.note.slurs || [];
      for (const slur of slurs.filter(item => item.type === 'stop' || item.type === 'continue')) {
        const key = `${layout.note.voice || 1}:${slur.number || 1}`;
        const start = activeSlurs.get(key);
        if (start) {
          this.drawConnectionCurve(ctx, start.layout, layout, slur.placement || start.marker.placement || 'above', color, false, start.marker.lineType);
          activeSlurs.delete(key);
        }
      }
      for (const slur of slurs.filter(item => item.type === 'start' || item.type === 'continue')) {
        activeSlurs.set(`${layout.note.voice || 1}:${slur.number || 1}`, { layout, marker: slur });
      }

      const key = pitchKey(layout);
      if (layout.note.tie?.stop && activeTies.has(key)) {
        const start = activeTies.get(key);
        const stopMarker = (layout.note.ties || []).find(tie => tie.type === 'stop');
        const defaultPlacement = start.layout.stemUp === false ? 'above' : 'below';
        this.drawConnectionCurve(
          ctx,
          start.layout,
          layout,
          stopMarker?.placement || start.marker?.placement || defaultPlacement,
          color,
          true,
          start.marker?.lineType
        );
        activeTies.delete(key);
      }
      if (layout.note.tie?.start) {
        const startMarker = (layout.note.ties || []).find(tie => tie.type === 'start');
        activeTies.set(key, { layout, marker: startMarker });
      }
    }
  }

  /** Draw one slur/tie Bezier curve. */
  drawConnectionCurve(ctx, start, end, placement, color, isTie = false, lineType = 'solid') {
    if (!start.visible || !end.visible || end.x <= start.x) return;
    const below = placement === 'below';
    const direction = below ? 1 : -1;
    const inset = isTie ? 4 : 1;
    const startX = start.x + inset;
    const endX = end.x - inset;
    const startY = start.y + direction * (isTie ? 6 : 8);
    const endY = end.y + direction * (isTie ? 6 : 8);
    const span = endX - startX;
    const depth = isTie ? Math.min(12, 6 + span * 0.06) : Math.min(28, 11 + Math.sqrt(span));
    const controlY = (below ? Math.max(startY, endY) : Math.min(startY, endY)) + direction * depth;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = isTie ? 1.4 : 1.6;
    if (lineType === 'dashed') ctx.setLineDash([5, 4]);
    else if (lineType === 'dotted') ctx.setLineDash([1.5, 3]);
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(
      startX + span * 0.28, controlY,
      endX - span * 0.28, controlY,
      endX, endY
    );
    ctx.stroke();
    ctx.restore();
  }

  /** Draw an upright or inverted fermata above a note/rest. */
  drawFermata(ctx, layout, yOffset, color) {
    const fermata = layout.note.fermata;
    const below = fermata.placement === 'below' || fermata.type === 'inverted';
    const stemExtreme = layout.stemEndY == null
      ? layout.y
      : below ? Math.max(layout.y, layout.stemEndY) : Math.min(layout.y, layout.stemEndY);
    this.drawFermataSymbol(ctx, layout.x, stemExtreme + (below ? 16 : -16), fermata, color);
  }

  /** Draw a measure-boundary fermata and ensure its barline is visible. */
  drawBarlineFermata(ctx, boundary, yOffset, color) {
    const { lineSpacing } = this.config;
    const fermata = boundary.fermata;
    const below = fermata.placement === 'below' || fermata.type === 'inverted';
    ctx.save();
    ctx.strokeStyle = '#4a5a7a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(boundary.x, yOffset);
    ctx.lineTo(boundary.x, yOffset + lineSpacing * 4);
    ctx.stroke();
    ctx.restore();
    const centerY = below ? yOffset + lineSpacing * 4 + 16 : yOffset - 16;
    this.drawFermataSymbol(ctx, boundary.x, centerY, fermata, color);
  }

  /** Draw normal, angled, or square fermata shapes with a central dot. */
  drawFermataSymbol(ctx, x, centerY, fermata, color) {
    const below = fermata.placement === 'below' || fermata.type === 'inverted';
    const shape = String(fermata.shape || 'normal').toLowerCase();
    const radius = 7;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    if (shape.includes('square')) {
      const direction = below ? 1 : -1;
      ctx.moveTo(x - radius, centerY);
      ctx.lineTo(x - radius, centerY + direction * radius);
      ctx.lineTo(x + radius, centerY + direction * radius);
      ctx.lineTo(x + radius, centerY);
    } else if (shape.includes('angled')) {
      const direction = below ? 1 : -1;
      ctx.moveTo(x - radius, centerY);
      ctx.lineTo(x, centerY + direction * radius);
      ctx.lineTo(x + radius, centerY);
    } else if (below) {
      ctx.arc(x, centerY, radius, 0, Math.PI);
    } else {
      ctx.arc(x, centerY, radius, Math.PI, Math.PI * 2);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, centerY + (below ? -2 : 2), 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Draw an actual G, F, or C clef plus any octave-transposition mark. */
  drawClef(ctx, clef, x, yOffset) {
    const { lineSpacing } = this.config;
    const descriptor = normalizeClef(clef) || { sign: 'G', line: 2, octaveChange: 0 };
    const symbol = CLEF_SYMBOLS[descriptor.sign] || descriptor.sign;

    ctx.save();
    ctx.fillStyle = '#e0e0e0';
    ctx.font = `42px ${MUSIC_FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(symbol, x, yOffset + lineSpacing * 2);

    if (descriptor.octaveChange) {
      const octaves = Math.abs(descriptor.octaveChange);
      const label = octaves === 1 ? '8' : String(octaves * 7 + 1);
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const labelY = descriptor.octaveChange < 0
        ? yOffset + lineSpacing * 4 + 12
        : yOffset - 4;
      ctx.fillText(label, x + 14, labelY);
    }
    ctx.restore();
  }

  /** Draw ledger lines above or below a staff for one note head. */
  drawLedgerLines(ctx, noteX, noteY, yOffset) {
    const { lineSpacing } = this.config;
    ctx.strokeStyle = '#5a6a8a';
    ctx.lineWidth = 1;

    for (let y = yOffset + 5 * lineSpacing; y <= noteY + lineSpacing / 4; y += lineSpacing) {
      ctx.beginPath();
      ctx.moveTo(noteX - 10, y);
      ctx.lineTo(noteX + 10, y);
      ctx.stroke();
    }
    for (let y = yOffset - lineSpacing; y >= noteY - lineSpacing / 4; y -= lineSpacing) {
      ctx.beginPath();
      ctx.moveTo(noteX - 10, y);
      ctx.lineTo(noteX + 10, y);
      ctx.stroke();
    }
  }

  /** Draw a pitched note with the correct head, stem, flags, and dots. */
  drawNoteGlyph(ctx, noteX, noteY, note, yOffset, color, options = {}) {
    const { lineSpacing } = this.config;
    const appearance = getNoteRenderInfo(note);
    const scale = note.isGrace ? 0.75 : 1;
    const radiusX = (appearance.type === 'whole' || appearance.type === 'breve' ? 7 : 6) * scale;
    const radiusY = 4.5 * scale;

    // Key signatures are not drawn yet, so show every altered pitch directly
    // beside its notehead. Repeating the glyph keeps double accidentals legible
    // even when the canvas font does not include dedicated double-sharp/flat symbols.
    const alter = Math.trunc(Number(note.pitch?.alter) || 0);
    if (alter !== 0) {
      const accidental = (alter > 0 ? '♯' : '♭').repeat(Math.abs(alter));
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = `${Math.round(21 * scale)}px "Times New Roman", "Noto Music", serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(accidental, noteX - radiusX - 2 * scale, noteY);
      ctx.restore();
    }

    ctx.beginPath();
    ctx.ellipse(noteX, noteY, radiusX, radiusY, -0.2, 0, Math.PI * 2);
    if (appearance.openHead) {
      // Mask the staff line through an open head before outlining it.
      ctx.fillStyle = '#1a1a2e';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (['maxima', 'long', 'breve'].includes(appearance.type)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(noteX - radiusX - 3, noteY - 7 * scale);
      ctx.lineTo(noteX - radiusX - 3, noteY + 7 * scale);
      ctx.moveTo(noteX + radiusX + 3, noteY - 7 * scale);
      ctx.lineTo(noteX + radiusX + 3, noteY + 7 * scale);
      ctx.stroke();
    }

    if (appearance.hasStem && !options.suppressStem && note.stem !== 'none') {
      const sourceStemUp = note.stem === 'up' ? true : note.stem === 'down' ? false : null;
      const stemUp = typeof options.stemUp === 'boolean'
        ? options.stemUp
        : sourceStemUp ?? noteY > yOffset + lineSpacing * 2;
      const stemX = noteX + (stemUp ? radiusX - 1 : -radiusX + 1);
      const stemEndY = Number.isFinite(options.stemEndY)
        ? options.stemEndY
        : noteY + (stemUp ? -lineSpacing * 3 : lineSpacing * 3) * scale;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(stemX, noteY);
      ctx.lineTo(stemX, stemEndY);
      ctx.stroke();

      if (!options.suppressFlags) {
        for (let flag = 0; flag < appearance.flagCount; flag++) {
          const flagY = stemEndY + (stemUp ? flag * 5.5 : -flag * 5.5) * scale;
          ctx.beginPath();
          ctx.moveTo(stemX, flagY);
          if (stemUp) {
            ctx.bezierCurveTo(
              stemX + 12 * scale, flagY + 4 * scale,
              stemX + 11 * scale, flagY + 12 * scale,
              stemX + 4 * scale, flagY + 16 * scale
            );
          } else {
            ctx.bezierCurveTo(
              stemX - 12 * scale, flagY - 4 * scale,
              stemX - 11 * scale, flagY - 12 * scale,
              stemX - 4 * scale, flagY - 16 * scale
            );
          }
          ctx.stroke();
        }
      }
    }

    const staffPosition = Math.round((yOffset + 4 * lineSpacing - noteY) / (lineSpacing / 2));
    const dotY = staffPosition % 2 === 0 ? noteY - lineSpacing / 2 : noteY;
    this.drawDots(ctx, noteX + radiusX + 4, dotY, note.dots, color);
  }

  /** Draw a duration-specific rest instead of a generic dash. */
  drawRestGlyph(ctx, noteX, note, yOffset, color) {
    const { lineSpacing } = this.config;
    const appearance = getNoteRenderInfo(note);
    const centerY = yOffset + lineSpacing * 2;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    if (['maxima', 'long', 'breve', 'whole'].includes(appearance.type)) {
      // Whole rest: filled block hanging below the 2nd staff line (4th from bottom)
      const restY = yOffset + lineSpacing;
      ctx.fillRect(noteX - 7, restY, 14, lineSpacing / 2);
      if (appearance.type !== 'whole') {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(noteX - 9, restY - 3);
        ctx.lineTo(noteX - 9, restY + 9);
        ctx.moveTo(noteX + 9, restY - 3);
        ctx.lineTo(noteX + 9, restY + 9);
        ctx.stroke();
      }
    } else if (appearance.type === 'half') {
      // Half rest: filled block sitting ON TOP of the middle (3rd) line
      const middleLineY = yOffset + lineSpacing * 2;
      ctx.fillRect(noteX - 7, middleLineY - lineSpacing / 2, 14, lineSpacing / 2);
    } else if (appearance.type === 'quarter') {
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(noteX - 3, centerY - 13);
      ctx.lineTo(noteX + 3, centerY - 6);
      ctx.lineTo(noteX - 2, centerY);
      ctx.lineTo(noteX + 4, centerY + 6);
      ctx.lineTo(noteX - 3, centerY + 13);
      ctx.stroke();
    } else {
      const flags = Math.max(1, appearance.flagCount);
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(noteX + 2, centerY - 14);
      ctx.lineTo(noteX - 2, centerY + 14);
      ctx.stroke();
      for (let flag = 0; flag < flags; flag++) {
        const flagY = centerY - 12 + flag * 6;
        ctx.beginPath();
        ctx.moveTo(noteX + 2, flagY);
        ctx.bezierCurveTo(noteX + 10, flagY + 1, noteX + 9, flagY + 8, noteX, flagY + 11);
        ctx.stroke();
      }
    }

    this.drawDots(ctx, noteX + 10, centerY, note.dots, color);

  }

  /** Draw one or more augmentation dots. */
  drawDots(ctx, startX, y, count, color) {
    const dots = Math.max(0, Number(count) || 0);
    ctx.fillStyle = color;
    for (let dot = 0; dot < dots; dot++) {
      ctx.beginPath();
      ctx.arc(startX + dot * 5, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }



  /**
   * Draw the playback position cursor.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawCursor(ctx) {
    if (this.currentBeat <= 0) return;

    const { marginTop, staffSpacing, cursorColor, cursorWidth } = this.config;
    const cursorX = this.getScoreX(this.currentBeat);

    ctx.strokeStyle = cursorColor;
    ctx.lineWidth = cursorWidth;
    ctx.beginPath();
    ctx.moveTo(cursorX, marginTop - 10);
    ctx.lineTo(cursorX, marginTop + this.parts.length * staffSpacing - 20);
    ctx.stroke();
  }

  /**
   * Convert one stored microphone sample into canvas coordinates.
   * @param {object} sample
   * @returns {{ x: number, y: number, yOffset: number }}
   */
  getPitchSamplePosition(sample) {
    const { marginTop, staffSpacing, lineSpacing } = this.config;
    const yOffset = marginTop + sample.partIndex * staffSpacing;
    const staffPosition = getStaffPositionForClef(sample.step, sample.octave, sample.clef);
    return {
      x: this.getScoreX(sample.beat),
      y: yOffset + (4 * lineSpacing) - (staffPosition * lineSpacing / 2),
      yOffset
    };
  }

  /**
   * Draw the saved microphone samples as a soft, segmented voice contour.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawUserPitchTrail(ctx) {
    if (this.userPitchTrail.length < 2) return;

    const { marginLeft, clefWidth } = this.config;
    ctx.save();

    // Keep history out of the fixed name and clef gutter while scrolling.
    ctx.beginPath();
    ctx.rect(
      marginLeft + clefWidth + this.scrollX,
      0,
      Math.max(0, this.canvas.width - marginLeft - clefWidth),
      this.canvas.height
    );
    ctx.clip();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // A soft continuous trace reads as a voice contour instead of a stream of
    // rapidly flashing measurements. Silence starts a fresh segment.
    const pointCount = this.userPitchTrail.length;
    for (let index = 1; index < pointCount; index++) {
      const previous = this.userPitchTrail[index - 1];
      const point = this.userPitchTrail[index];
      if (point.breakBefore) continue;

      const recency = (index + 1) / pointCount;
      ctx.globalAlpha = 0.12 + recency * 0.58;
      ctx.strokeStyle = point.color;
      ctx.lineWidth = 2 + recency * 1.25;
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Draw the latest detected pitch at its capture-aligned score position. Its
   * vertical spelling and feedback color are derived from the active score note.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawUserPitch(ctx) {
    const sample = this.currentPitchSample;
    if (!sample) return;

    const { x, y: noteY, yOffset } = this.getPitchSamplePosition(sample);
    this.drawLedgerLines(ctx, x, noteY, yOffset);

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = sample.color;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = sample.color;
    ctx.shadowBlur = sample.accuracy === 'correct' ? 12 : 6;
    ctx.beginPath();
    ctx.arc(x, noteY, sample.accuracy === 'correct' ? 6 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Scroll to a specific beat position.
   * @param {number} beat
   */
  scrollToBeat(beat) {
    this.scrollX = Math.max(0, this.getScoreX(beat) - this.canvas.width * 0.3);
    this.render();
  }

  /**
   * Reset the renderer state.
   */
  reset() {
    this.scrollX = 0;
    this.currentBeat = 0;
    this.userPitch = null;
    this.currentPitchSample = null;
    this.userPitchTrail = [];
    this.isPitchContinuous = false;
    this.pitchAccuracyState = 'neutral';
    this.render();
  }
}
