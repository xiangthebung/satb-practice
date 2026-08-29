/**
 * Shared utilities for the Choir Practice App.
 * Note-frequency mapping, MIDI utilities, color constants for parts.
 */

// A4 = 440 Hz reference
const A4_FREQUENCY = 440;
const A4_MIDI = 69;

// All chromatic note names
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Enharmonic equivalents for flats
const FLAT_TO_SHARP = {
  'Db': 'C#',
  'Eb': 'D#',
  'Fb': 'E',
  'Gb': 'F#',
  'Ab': 'G#',
  'Bb': 'A#',
  'Cb': 'B'
};

// Semitone offset (from C) for each diatonic step letter.
const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Convert an explicit pitch (step letter + chromatic alteration + octave) to a
 * MIDI number. Unlike noteToMidi, this never throws: it works directly from the
 * MusicXML data model, so it correctly handles E#, B#, Cb, Fb and double
 * accidentals (alter = +/-2) that have no entry in the note-name tables.
 * @param {string} step - diatonic letter 'C'..'B'
 * @param {number} alter - semitone alteration (-2..2); 1 = sharp, -1 = flat
 * @param {number} octave
 * @returns {number} MIDI number
 */
export function pitchToMidi(step, alter, octave) {
  const base = STEP_SEMITONES[String(step).toUpperCase()];
  if (base === undefined) {
    throw new Error(`Unknown pitch step: ${step}`);
  }
  return (octave + 1) * 12 + base + (alter || 0);
}

/**
 * Convert an explicit pitch (step + alter + octave) to a frequency in Hz.
 * @param {string} step
 * @param {number} alter
 * @param {number} octave
 * @returns {number} frequency in Hz
 */
export function pitchToFrequency(step, alter, octave) {
  return midiToFrequency(pitchToMidi(step, alter, octave));
}

/**
 * Convert a note name and octave to MIDI number.
 * @param {string} noteName - e.g. 'C', 'C#', 'Db'
 * @param {number} octave - e.g. 4
 * @returns {number} MIDI number
 */
export function noteToMidi(noteName, octave) {
  let normalized = noteName;
  if (FLAT_TO_SHARP[noteName]) {
    normalized = FLAT_TO_SHARP[noteName];
  }
  const noteIndex = NOTE_NAMES.indexOf(normalized);
  if (noteIndex === -1) {
    throw new Error(`Unknown note name: ${noteName}`);
  }
  return (octave + 1) * 12 + noteIndex;
}

/**
 * Convert MIDI number to frequency in Hz.
 *
 * The tuning reference is a parameter rather than a constant because choirs do
 * not all tune to 440: a group singing at 415 or 442 needs the app to agree
 * with the room, and a few cents of disagreement is audible over an evening.
 *
 * @param {number} midi - MIDI note number
 * @param {number} [referenceHz] - frequency of A4, defaults to 440
 * @returns {number} frequency in Hz
 */
export function midiToFrequency(midi, referenceHz = A4_FREQUENCY) {
  const reference = Number(referenceHz);
  const anchor = Number.isFinite(reference) && reference > 0 ? reference : A4_FREQUENCY;
  return anchor * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Concert pitch, the tuning reference everything falls back to. */
export const STANDARD_TUNING_HZ = A4_FREQUENCY;

/**
 * Convert a note name and octave to frequency.
 * @param {string} noteName - e.g. 'A', 'C#', 'Bb'
 * @param {number} octave - e.g. 4
 * @returns {number} frequency in Hz
 */
export function noteToFrequency(noteName, octave) {
  return midiToFrequency(noteToMidi(noteName, octave));
}

/**
 * Convert a frequency to the nearest note name, octave, and cents offset.
 *
 * The tuning reference matters here as much as it does going the other way: a
 * choir singing at 442 is in tune with itself, and the guidance has to agree
 * rather than reporting everyone eight cents sharp all evening.
 *
 * @param {number} frequency - frequency in Hz
 * @param {number} [referenceHz] - frequency of A4, defaults to 440
 * @returns {{ noteName: string, octave: number, cents: number, midi: number }}
 */
export function frequencyToNote(frequency, referenceHz = A4_FREQUENCY) {
  if (frequency <= 0) {
    return null;
  }
  const reference = Number(referenceHz);
  const anchor = Number.isFinite(reference) && reference > 0 ? reference : A4_FREQUENCY;
  const midiFloat = 12 * Math.log2(frequency / anchor) + A4_MIDI;
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const noteIndex = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return {
    noteName: NOTE_NAMES[noteIndex],
    octave,
    cents,
    midi
  };
}

/**
 * Say a written pitch the way a singer would say it out loud.
 *
 * For the live region, which had only the bar number in it: someone reading the
 * score through a screen reader could step through the bars and be told nothing
 * about the music in them. Uses the score's own spelling rather than a
 * frequency, so an F sharp is read as F sharp and not as G flat.
 *
 * @param {string} step diatonic letter
 * @param {number} alter semitone alteration, -2..2
 * @param {number} octave
 * @returns {string} for example "F sharp 4"
 */
export function describePitch(step, alter = 0, octave = 4) {
  const letter = String(step || '').toUpperCase();
  // C is 0, so this has to test for absence rather than for falsiness.
  if (STEP_SEMITONES[letter] === undefined) return '';
  const shift = Math.round(Number(alter) || 0);
  const accidental = ({
    2: ' double sharp',
    1: ' sharp',
    0: '',
    '-1': ' flat',
    '-2': ' double flat'
  })[shift] ?? '';
  return `${letter}${accidental} ${octave}`;
}

/**
 * Colour constants for voice parts.
 * Supports standard SATB plus numbered subdivisions.
 */
const PART_COLORS = {
  soprano: '#4a9eff',
  'soprano 1': '#4a9eff',
  'soprano 2': '#7bb8ff',
  alto: '#4caf50',
  'alto 1': '#4caf50',
  'alto 2': '#81c784',
  tenor: '#ff9800',
  'tenor 1': '#ff9800',
  'tenor 2': '#ffb74d',
  bass: '#f44336',
  'bass 1': '#f44336',
  'bass 2': '#e57373',
  baritone: '#e91e63',
  mezzo: '#9c27b0',
  'mezzo-soprano': '#9c27b0'
};

/**
 * Get the color for a given part name using fuzzy matching.
 * @param {string} partName
 * @returns {string} hex color
 */
export function getPartColor(partName) {
  const lower = partName.toLowerCase().trim();

  // Direct match
  if (PART_COLORS[lower]) {
    return PART_COLORS[lower];
  }

  // Partial match - check if partName contains known voice types
  for (const [key, color] of Object.entries(PART_COLORS)) {
    if (lower.includes(key)) {
      return color;
    }
  }

  // Default color for unknown parts
  return '#9e9e9e';
}
