/**
 * Node.js test script for utility functions and new modules.
 * No external dependencies required - uses Node.js assert.
 */

import { strict as assert } from 'node:assert';
import {
  noteToMidi,
  midiToFrequency,
  noteToFrequency,
  frequencyToNote,
  midiToNoteName,
  calculateDuration,
  getPartColor,
  pitchToMidi,
  pitchToFrequency,
  NOTE_NAMES,
  A4_FREQUENCY,
  A4_MIDI,
  PART_COLORS
} from '../js/utils.js';

import {
  analysePitchYin,
  detectPitchAutocorrelation,
  centsDifference,
  classifyAccuracy,
  PitchDetector
} from '../js/pitch-detector.js';

import {
  beatDuration,
  beatToTime
} from '../js/audio-engine.js';

import {
  bpmToInterval,
  calculateTapTempo,
  getNextBeatTime
} from '../js/metronome.js';

import {
  getNoteStaffPosition,
  getClefForPart
} from '../js/notation-renderer.js';

import {
  layoutMeasure
} from '../js/musicxml-parser.js';

import {
  AudioEngine
} from '../js/audio-engine.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
  }
}

function approxEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}

console.log('=== Choir Practice Tool - Unit Tests ===\n');

// --- Note to MIDI tests ---
console.log('Note to MIDI:');

test('C4 should be MIDI 60', () => {
  assert.equal(noteToMidi('C', 4), 60);
});

test('A4 should be MIDI 69', () => {
  assert.equal(noteToMidi('A', 4), 69);
});

test('C#4 should be MIDI 61', () => {
  assert.equal(noteToMidi('C#', 4), 61);
});

test('Db4 should be MIDI 61 (enharmonic)', () => {
  assert.equal(noteToMidi('Db', 4), 61);
});

test('B3 should be MIDI 59', () => {
  assert.equal(noteToMidi('B', 3), 59);
});

test('C0 should be MIDI 12', () => {
  assert.equal(noteToMidi('C', 0), 12);
});

test('G#5 should be MIDI 80', () => {
  assert.equal(noteToMidi('G#', 5), 80);
});

test('Bb2 should be MIDI 46', () => {
  assert.equal(noteToMidi('Bb', 2), 46);
});

console.log('');

// --- Pitch (step/alter/octave) to MIDI tests ---
// These cover accidentals the string-based noteToMidi can't resolve and which
// previously threw inside the audio engine, silently killing playback.
console.log('Pitch to MIDI (step + alter + octave):');

test('C4 natural should be MIDI 60', () => {
  assert.equal(pitchToMidi('C', 0, 4), 60);
});

test('E#4 should be MIDI 65 (enharmonic F4)', () => {
  assert.equal(pitchToMidi('E', 1, 4), 65);
});

test('B#3 should be MIDI 60 (enharmonic C4)', () => {
  assert.equal(pitchToMidi('B', 1, 3), 60);
});

test('Cb4 should be MIDI 59 (enharmonic B3)', () => {
  assert.equal(pitchToMidi('C', -1, 4), 59);
});

test('double-sharp F##4 should be MIDI 67 (enharmonic G4)', () => {
  assert.equal(pitchToMidi('F', 2, 4), 67);
});

test('double-flat Bbb4 should be MIDI 69 (enharmonic A4)', () => {
  assert.equal(pitchToMidi('B', -2, 4), 69);
});

test('pitchToFrequency A4 (alter 0) should be 440 Hz', () => {
  assert.equal(pitchToFrequency('A', 0, 4), 440);
});

test('pitchToFrequency E#4 should equal F4 frequency', () => {
  assert(approxEqual(pitchToFrequency('E', 1, 4), noteToFrequency('F', 4), 0.001));
});

console.log('');

// --- MIDI to Frequency tests ---
console.log('MIDI to Frequency:');

test('MIDI 69 (A4) should be 440 Hz', () => {
  assert.equal(midiToFrequency(69), 440);
});

test('MIDI 60 (C4) should be ~261.63 Hz', () => {
  assert(approxEqual(midiToFrequency(60), 261.63, 0.01));
});

test('MIDI 57 (A3) should be 220 Hz', () => {
  assert(approxEqual(midiToFrequency(57), 220, 0.01));
});

test('MIDI 81 (A5) should be 880 Hz', () => {
  assert(approxEqual(midiToFrequency(81), 880, 0.01));
});

console.log('');

// --- Note to Frequency tests ---
console.log('Note to Frequency:');

test('A4 should be 440 Hz', () => {
  assert.equal(noteToFrequency('A', 4), 440);
});

test('A3 should be 220 Hz', () => {
  assert(approxEqual(noteToFrequency('A', 3), 220, 0.01));
});

test('C4 should be ~261.63 Hz', () => {
  assert(approxEqual(noteToFrequency('C', 4), 261.63, 0.01));
});

console.log('');

// --- Frequency to Note tests ---
console.log('Frequency to Note:');

test('440 Hz should be A4', () => {
  const result = frequencyToNote(440);
  assert.equal(result.noteName, 'A');
  assert.equal(result.octave, 4);
  assert.equal(result.cents, 0);
});

test('261.63 Hz should be approximately C4', () => {
  const result = frequencyToNote(261.63);
  assert.equal(result.noteName, 'C');
  assert.equal(result.octave, 4);
  assert(Math.abs(result.cents) <= 1);
});

test('880 Hz should be A5', () => {
  const result = frequencyToNote(880);
  assert.equal(result.noteName, 'A');
  assert.equal(result.octave, 5);
  assert.equal(result.cents, 0);
});

test('0 Hz should return null', () => {
  assert.equal(frequencyToNote(0), null);
});

test('negative frequency should return null', () => {
  assert.equal(frequencyToNote(-100), null);
});

console.log('');

// --- MIDI to Note Name tests ---
console.log('MIDI to Note Name:');

test('MIDI 60 should be C4', () => {
  const result = midiToNoteName(60);
  assert.equal(result.noteName, 'C');
  assert.equal(result.octave, 4);
});

test('MIDI 69 should be A4', () => {
  const result = midiToNoteName(69);
  assert.equal(result.noteName, 'A');
  assert.equal(result.octave, 4);
});

console.log('');

// --- Duration calculation tests ---
console.log('Duration Calculation:');

test('quarter note should be 1 beat', () => {
  assert.equal(calculateDuration('quarter', 0), 1);
});

test('half note should be 2 beats', () => {
  assert.equal(calculateDuration('half', 0), 2);
});

test('whole note should be 4 beats', () => {
  assert.equal(calculateDuration('whole', 0), 4);
});

test('eighth note should be 0.5 beats', () => {
  assert.equal(calculateDuration('eighth', 0), 0.5);
});

test('dotted quarter should be 1.5 beats', () => {
  assert.equal(calculateDuration('quarter', 1), 1.5);
});

test('dotted half should be 3 beats', () => {
  assert.equal(calculateDuration('half', 1), 3);
});

test('double-dotted quarter should be 1.75 beats', () => {
  assert.equal(calculateDuration('quarter', 2), 1.75);
});

console.log('');

// --- Part color tests ---
console.log('Part Colors:');

test('soprano should return blue', () => {
  assert.equal(getPartColor('Soprano'), '#4a9eff');
});

test('alto should return green', () => {
  assert.equal(getPartColor('Alto'), '#4caf50');
});

test('tenor should return orange', () => {
  assert.equal(getPartColor('Tenor'), '#ff9800');
});

test('bass should return red', () => {
  assert.equal(getPartColor('Bass'), '#f44336');
});

test('Tenor 2 should return light orange', () => {
  assert.equal(getPartColor('Tenor 2'), '#ffb74d');
});

test('unknown part should return default gray', () => {
  assert.equal(getPartColor('Oboe'), '#9e9e9e');
});

test('case insensitive matching', () => {
  assert.equal(getPartColor('SOPRANO'), '#4a9eff');
  assert.equal(getPartColor('tenor 1'), '#ff9800');
});

console.log('');

// ============================================
// NEW TESTS: Pitch Detection Math
// ============================================
console.log('Pitch Detection - Autocorrelation:');

test('autocorrelation detects 440Hz sine wave', () => {
  const sampleRate = 44100;
  const frequency = 440;
  const bufferSize = 2048;
  const buffer = new Float32Array(bufferSize);

  // Generate a 440Hz sine wave
  for (let i = 0; i < bufferSize; i++) {
    buffer[i] = 0.5 * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  }

  const detected = detectPitchAutocorrelation(buffer, sampleRate);
  assert(detected > 0, 'Should detect a pitch');
  assert(approxEqual(detected, 440, 5), `Expected ~440Hz, got ${detected}Hz`);
});

test('autocorrelation detects 220Hz sine wave', () => {
  const sampleRate = 44100;
  const frequency = 220;
  const bufferSize = 2048;
  const buffer = new Float32Array(bufferSize);

  for (let i = 0; i < bufferSize; i++) {
    buffer[i] = 0.5 * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  }

  const detected = detectPitchAutocorrelation(buffer, sampleRate);
  assert(detected > 0, 'Should detect a pitch');
  assert(approxEqual(detected, 220, 5), `Expected ~220Hz, got ${detected}Hz`);
});

test('YIN reports high confidence for a clean sung-pitch-like tone', () => {
  const sampleRate = 44100;
  const buffer = new Float32Array(4096);
  for (let i = 0; i < buffer.length; i++) {
    const phase = 2 * Math.PI * 196 * i / sampleRate;
    buffer[i] = 0.45 * Math.sin(phase) + 0.1 * Math.sin(phase * 2);
  }

  const result = analysePitchYin(buffer, sampleRate);
  assert(result, 'Should return an estimate');
  assert(approxEqual(result.frequency, 196, 3));
  assert(result.confidence > 0.9, `Expected high confidence, got ${result.confidence}`);
});

test('YIN rejects deterministic broadband noise', () => {
  const buffer = new Float32Array(4096);
  let seed = 123456789;
  for (let i = 0; i < buffer.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    buffer[i] = ((seed / 0x100000000) * 2 - 1) * 0.25;
  }
  assert.equal(analysePitchYin(buffer, 44100), null);
});

test('pitch stabiliser confirms an octave jump before showing it', () => {
  const detector = new PitchDetector();
  assert(approxEqual(detector.stabiliseFrequency(220), 220, 0.01));
  assert.equal(detector.stabiliseFrequency(440), null);
  assert(approxEqual(detector.stabiliseFrequency(440), 440, 0.01));
});

test('autocorrelation returns -1 for silence', () => {
  const buffer = new Float32Array(2048);
  const detected = detectPitchAutocorrelation(buffer, 44100);
  assert.equal(detected, -1);
});

test('autocorrelation returns -1 for very quiet signal', () => {
  const buffer = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) {
    buffer[i] = 0.001 * Math.sin(2 * Math.PI * 440 * i / 44100);
  }
  const detected = detectPitchAutocorrelation(buffer, 44100);
  assert.equal(detected, -1);
});

console.log('');

// --- Cents difference tests ---
console.log('Pitch Detection - Cents Difference:');

test('same frequency should be 0 cents', () => {
  assert.equal(centsDifference(440, 440), 0);
});

test('one semitone up should be ~100 cents', () => {
  const cents = centsDifference(466.16, 440); // A#4 vs A4
  assert(approxEqual(cents, 100, 1));
});

test('one semitone down should be ~-100 cents', () => {
  const cents = centsDifference(415.30, 440); // G#4 vs A4
  assert(approxEqual(cents, -100, 1));
});

test('octave up should be 1200 cents', () => {
  const cents = centsDifference(880, 440);
  assert(approxEqual(cents, 1200, 0.1));
});

test('zero frequencies should return 0', () => {
  assert.equal(centsDifference(0, 440), 0);
  assert.equal(centsDifference(440, 0), 0);
});

console.log('');

// --- Accuracy classification tests ---
console.log('Pitch Detection - Accuracy Classification:');

test('0 cents should be correct', () => {
  assert.equal(classifyAccuracy(0), 'correct');
});

test('25 cents should be correct', () => {
  assert.equal(classifyAccuracy(25), 'correct');
});

test('50 cents should be correct', () => {
  assert.equal(classifyAccuracy(50), 'correct');
});

test('75 cents should be close', () => {
  assert.equal(classifyAccuracy(75), 'close');
});

test('100 cents should be close', () => {
  assert.equal(classifyAccuracy(100), 'close');
});

test('150 cents should be off', () => {
  assert.equal(classifyAccuracy(150), 'off');
});

test('-30 cents should be correct', () => {
  assert.equal(classifyAccuracy(-30), 'correct');
});

test('-80 cents should be close', () => {
  assert.equal(classifyAccuracy(-80), 'close');
});

console.log('');

// ============================================
// NEW TESTS: Audio Engine Scheduling
// ============================================
console.log('Audio Engine - Scheduling Calculations:');

test('beatDuration at 120 BPM should be 0.5s', () => {
  assert.equal(beatDuration(120), 0.5);
});

test('beatDuration at 60 BPM should be 1.0s', () => {
  assert.equal(beatDuration(60), 1.0);
});

test('beatDuration at 240 BPM should be 0.25s', () => {
  assert.equal(beatDuration(240), 0.25);
});

test('beatDuration at 0 BPM should be 0', () => {
  assert.equal(beatDuration(0), 0);
});

test('beatToTime: 4 beats at 120 BPM should be 2.0s', () => {
  assert.equal(beatToTime(4, 120), 2.0);
});

test('beatToTime: 1 beat at 60 BPM should be 1.0s', () => {
  assert.equal(beatToTime(1, 60), 1.0);
});

test('beatToTime: 0 beats should be 0s', () => {
  assert.equal(beatToTime(0, 120), 0);
});

test('beatToTime: 2.5 beats at 120 BPM should be 1.25s', () => {
  assert.equal(beatToTime(2.5, 120), 1.25);
});

console.log('');

// ============================================
// NEW TESTS: Metronome Interval Math
// ============================================
console.log('Metronome - Interval Calculations:');

test('bpmToInterval at 120 BPM should be 500ms', () => {
  assert.equal(bpmToInterval(120), 500);
});

test('bpmToInterval at 60 BPM should be 1000ms', () => {
  assert.equal(bpmToInterval(60), 1000);
});

test('bpmToInterval at 240 BPM should be 250ms', () => {
  assert.equal(bpmToInterval(240), 250);
});

test('bpmToInterval at 0 BPM should be 0', () => {
  assert.equal(bpmToInterval(0), 0);
});

test('bpmToInterval at 80 BPM should be 750ms', () => {
  assert.equal(bpmToInterval(80), 750);
});

console.log('');

console.log('Metronome - Tap Tempo:');

test('calculateTapTempo with empty array should return 0', () => {
  assert.equal(calculateTapTempo([]), 0);
});

test('calculateTapTempo with 500ms intervals should return 120 BPM', () => {
  assert.equal(calculateTapTempo([500, 500, 500]), 120);
});

test('calculateTapTempo with 1000ms intervals should return 60 BPM', () => {
  assert.equal(calculateTapTempo([1000, 1000]), 60);
});

test('calculateTapTempo with 250ms intervals should return 240 BPM', () => {
  assert.equal(calculateTapTempo([250, 250, 250, 250]), 240);
});

test('calculateTapTempo with mixed intervals averages correctly', () => {
  // Average of [400, 600] = 500ms = 120 BPM
  assert.equal(calculateTapTempo([400, 600]), 120);
});

test('calculateTapTempo with null should return 0', () => {
  assert.equal(calculateTapTempo(null), 0);
});

console.log('');

console.log('Metronome - Next Beat Time:');

test('getNextBeatTime calculates next beat after last', () => {
  const next = getNextBeatTime(1.0, 0.5, 0.5);
  assert.equal(next, 1.0);
});

test('getNextBeatTime snaps forward if behind', () => {
  const next = getNextBeatTime(2.0, 0.5, 0.5);
  assert.equal(next, 2.0);
});

test('getNextBeatTime returns next if not yet due', () => {
  const next = getNextBeatTime(1.0, 0.9, 0.5);
  assert.equal(next, 1.4);
});

console.log('');

// ============================================
// NEW TESTS: Notation Renderer
// ============================================
console.log('Notation Renderer - Staff Positions:');

test('C4 in treble clef should be at position 0', () => {
  assert.equal(getNoteStaffPosition('C', 4, 'treble'), 0);
});

test('D4 in treble clef should be at position 1', () => {
  assert.equal(getNoteStaffPosition('D', 4, 'treble'), 1);
});

test('E4 in treble clef should be at position 2', () => {
  assert.equal(getNoteStaffPosition('E', 4, 'treble'), 2);
});

test('G4 in treble clef should be at position 4', () => {
  assert.equal(getNoteStaffPosition('G', 4, 'treble'), 4);
});

test('C5 in treble clef should be at position 7', () => {
  assert.equal(getNoteStaffPosition('C', 5, 'treble'), 7);
});

test('A5 in treble clef should be at position 12', () => {
  assert.equal(getNoteStaffPosition('A', 5, 'treble'), 12);
});

test('E2 in bass clef should be at position 0', () => {
  assert.equal(getNoteStaffPosition('E', 2, 'bass'), 0);
});

test('A2 in bass clef should be at position 3', () => {
  assert.equal(getNoteStaffPosition('A', 2, 'bass'), 3);
});

test('C3 in bass clef should be at position 5', () => {
  assert.equal(getNoteStaffPosition('C', 3, 'bass'), 5);
});

console.log('');

console.log('Notation Renderer - Clef Detection:');

test('soprano should use treble clef', () => {
  assert.equal(getClefForPart('soprano'), 'treble');
});

test('alto should use treble clef', () => {
  assert.equal(getClefForPart('alto'), 'treble');
});

test('tenor should use treble clef', () => {
  assert.equal(getClefForPart('tenor'), 'treble');
});

test('bass should use bass clef', () => {
  assert.equal(getClefForPart('bass'), 'bass');
});

test('baritone should use bass clef', () => {
  assert.equal(getClefForPart('baritone'), 'bass');
});

test('Bass 2 should use bass clef', () => {
  assert.equal(getClefForPart('Bass 2'), 'bass');
});

console.log('');

// ============================================
// NEW TESTS: Measure layout timing (all note types)
// ============================================
console.log('Measure Layout - Duration as source of truth:');

test('four quarter notes fill a 4/4 measure (4 beats)', () => {
  // divisions = 1 quarter note per division unit => each quarter has duration 1
  const events = [
    { kind: 'note', duration: 1, type: 'quarter' },
    { kind: 'note', duration: 1, type: 'quarter' },
    { kind: 'note', duration: 1, type: 'quarter' },
    { kind: 'note', duration: 1, type: 'quarter' }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 4);
  assert.deepEqual(notes.map(n => n.startBeatInMeasure), [0, 1, 2, 3]);
  assert.deepEqual(notes.map(n => n.durationBeats), [1, 1, 1, 1]);
});

test('eighth-note triplet sounds 1/3 beat each (type is ignored for timing)', () => {
  // divisions=6 => quarter=6. A triplet eighth has duration 2 (6/3), type "eighth".
  const events = [
    { kind: 'note', duration: 2, type: 'eighth' },
    { kind: 'note', duration: 2, type: 'eighth' },
    { kind: 'note', duration: 2, type: 'eighth' }
  ];
  const { notes, beats } = layoutMeasure(events, 6);
  assert(Math.abs(beats - 1) < 1e-9, `triplet should total 1 beat, got ${beats}`);
  assert(Math.abs(notes[0].durationBeats - 1 / 3) < 1e-9);
  assert(Math.abs(notes[1].startBeatInMeasure - 1 / 3) < 1e-9);
  assert(Math.abs(notes[2].startBeatInMeasure - 2 / 3) < 1e-9);
});

test('dotted half + quarter fill 4 beats', () => {
  const events = [
    { kind: 'note', duration: 3, type: 'half', dots: 1 },
    { kind: 'note', duration: 1, type: 'quarter' }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 4);
  assert.equal(notes[0].durationBeats, 3);
  assert.equal(notes[1].startBeatInMeasure, 3);
});

test('chord notes share the same onset and do not advance time', () => {
  // C-E-G chord (quarter) then a quarter note.
  const events = [
    { kind: 'note', duration: 1, type: 'quarter', pitch: { step: 'C', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', isChord: true, pitch: { step: 'E', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', isChord: true, pitch: { step: 'G', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', pitch: { step: 'D', alter: 0, octave: 4 } }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 2, 'chord occupies one beat, plus one more = 2');
  assert.deepEqual(notes.map(n => n.startBeatInMeasure), [0, 0, 0, 1]);
});

test('grace note takes no time', () => {
  const events = [
    { kind: 'note', duration: 0, type: 'eighth', isGrace: true, pitch: { step: 'B', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', pitch: { step: 'C', alter: 0, octave: 5 } }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 1);
  assert.equal(notes[0].durationBeats, 0);
  assert.equal(notes[0].startBeatInMeasure, 0);
  assert.equal(notes[1].startBeatInMeasure, 0);
});

test('backup rewinds the cursor so a second voice aligns to measure start', () => {
  // Voice 1: whole note (4 beats). Backup 4. Voice 2: 4 quarter notes.
  const events = [
    { kind: 'note', duration: 4, type: 'whole', voice: 1, pitch: { step: 'C', alter: 0, octave: 5 } },
    { kind: 'backup', duration: 4 },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2, pitch: { step: 'C', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2, pitch: { step: 'D', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2, pitch: { step: 'E', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2, pitch: { step: 'F', alter: 0, octave: 4 } }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 4);
  assert.equal(notes[0].startBeatInMeasure, 0); // voice 1 whole note
  // notes[1..4] are voice 2's four quarter notes, realigned to the measure start
  assert.deepEqual(notes.slice(1).map(n => n.startBeatInMeasure), [0, 1, 2, 3]);
});

test('forward inserts a gap (implicit rest)', () => {
  const events = [
    { kind: 'forward', duration: 2 },
    { kind: 'note', duration: 2, type: 'half', pitch: { step: 'G', alter: 0, octave: 4 } }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(notes[0].startBeatInMeasure, 2);
  assert.equal(beats, 4);
});

console.log('');

// ============================================
// NEW TESTS: Schedule building (absolute position, chords, ties)
// ============================================
console.log('Audio Engine - Schedule from absolute positions:');

function makeMeasure(startBeat, beats, notes) {
  return { startBeat, beats, notes };
}

test('schedule places notes at measure.startBeat + startBeatInMeasure', () => {
  const engine = new AudioEngine();
  engine.parts = [{
    id: 'P1',
    measures: [
      makeMeasure(0, 4, [
        { isRest: false, pitch: { step: 'C', alter: 0, octave: 4 }, durationBeats: 1, startBeatInMeasure: 0 },
        { isRest: false, pitch: { step: 'D', alter: 0, octave: 4 }, durationBeats: 1, startBeatInMeasure: 1 }
      ]),
      makeMeasure(4, 4, [
        { isRest: false, pitch: { step: 'E', alter: 0, octave: 4 }, durationBeats: 1, startBeatInMeasure: 0 }
      ])
    ]
  }];
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 3);
  assert.deepEqual(schedule.map(e => e.startBeat).sort((a, b) => a - b), [0, 1, 4]);
});

test('chord notes are all scheduled at the same onset', () => {
  const engine = new AudioEngine();
  engine.parts = [{
    id: 'P1',
    measures: [
      makeMeasure(0, 4, [
        { isRest: false, pitch: { step: 'C', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0 },
        { isRest: false, isChord: true, pitch: { step: 'E', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0 },
        { isRest: false, isChord: true, pitch: { step: 'G', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0 }
      ])
    ]
  }];
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 3, 'all three chord tones should sound');
  assert(schedule.every(e => e.startBeat === 0));
});

test('rests and zero-duration grace notes are not scheduled', () => {
  const engine = new AudioEngine();
  engine.parts = [{
    id: 'P1',
    measures: [
      makeMeasure(0, 4, [
        { isRest: true, durationBeats: 1, startBeatInMeasure: 0 },
        { isRest: false, isGrace: true, pitch: { step: 'B', alter: 0, octave: 4 }, durationBeats: 0, startBeatInMeasure: 1 },
        { isRest: false, pitch: { step: 'C', alter: 0, octave: 5 }, durationBeats: 1, startBeatInMeasure: 1 }
      ])
    ]
  }];
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 1);
  assert.equal(schedule[0].startBeat, 1);
});

test('tied notes merge into one sustained note', () => {
  const engine = new AudioEngine();
  engine.parts = [{
    id: 'P1',
    measures: [
      makeMeasure(0, 4, [
        { isRest: false, pitch: { step: 'C', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0, tie: { start: true, stop: false } }
      ]),
      makeMeasure(4, 4, [
        { isRest: false, pitch: { step: 'C', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0, tie: { start: false, stop: true } }
      ])
    ]
  }];
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 1, 'tied pair becomes a single event');
  assert.equal(schedule[0].startBeat, 0);
  assert.equal(schedule[0].durationBeats, 8);
});

test('a tie between different pitches is not merged', () => {
  const engine = new AudioEngine();
  engine.parts = [{
    id: 'P1',
    measures: [
      makeMeasure(0, 4, [
        { isRest: false, pitch: { step: 'C', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0, tie: { start: true, stop: false } }
      ]),
      makeMeasure(4, 4, [
        { isRest: false, pitch: { step: 'D', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0, tie: { start: false, stop: true } }
      ])
    ]
  }];
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 2);
});

test('getTotalBeats uses absolute measure positions', () => {
  const engine = new AudioEngine();
  engine.parts = [{
    id: 'P1',
    measures: [makeMeasure(0, 4, []), makeMeasure(4, 3, [])]
  }];
  assert.equal(engine.getTotalBeats(), 7);
});

console.log('');

// --- Summary ---
console.log('=== Results ===');
console.log(`  Total: ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!');
}
