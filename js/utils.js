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
 * @param {number} midi - MIDI note number
 * @returns {number} frequency in Hz
 */
export function midiToFrequency(midi) {
  return A4_FREQUENCY * Math.pow(2, (midi - A4_MIDI) / 12);
}

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
 * @param {number} frequency - frequency in Hz
 * @returns {{ noteName: string, octave: number, cents: number, midi: number }}
 */
export function frequencyToNote(frequency) {
  if (frequency <= 0) {
    return null;
  }
  const midiFloat = 12 * Math.log2(frequency / A4_FREQUENCY) + A4_MIDI;
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
 * Convert MIDI number to note name and octave.
 * @param {number} midi - MIDI note number
 * @returns {{ noteName: string, octave: number }}
 */
export function midiToNoteName(midi) {
  const noteIndex = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return {
    noteName: NOTE_NAMES[noteIndex],
    octave
  };
}

/**
 * Color constants for voice parts.
 * Supports standard SATB plus numbered subdivisions.
 */
export const PART_COLORS = {
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

/**
 * Standard duration types in MusicXML and their beat values (in quarter-note beats).
 */
export const DURATION_TYPES = {
  'whole': 4,
  'half': 2,
  'quarter': 1,
  'eighth': 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625
};

/**
 * Calculate actual duration in beats considering dots.
 * @param {string} durationType - e.g. 'quarter', 'half'
 * @param {number} dots - number of dots
 * @returns {number} duration in beats
 */
export function calculateDuration(durationType, dots = 0) {
  let baseDuration = DURATION_TYPES[durationType] || 1;
  let totalDuration = baseDuration;
  let dotValue = baseDuration;
  for (let i = 0; i < dots; i++) {
    dotValue /= 2;
    totalDuration += dotValue;
  }
  return totalDuration;
}

// Export constants for testing
export { NOTE_NAMES, A4_FREQUENCY, A4_MIDI, FLAT_TO_SHARP };
