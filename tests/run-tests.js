/**
 * Unit tests for the pure logic behind the app: pitch and note maths, score
 * layout, mix presets, archive reading, and the small formatting helpers.
 *
 * Run with: node tests/run-tests.js
 * No dependencies — Node's own assert module is enough.
 */

import { strict as assert } from 'node:assert';

import {
  noteToMidi,
  midiToFrequency,
  noteToFrequency,
  frequencyToNote,
  getPartColor,
  pitchToMidi,
  pitchToFrequency
} from '../public/js/utils.js';

import {
  parseCssColor,
  colorToCss,
  contrastRatio,
  ensureContrast,
  mixColors,
  relativeLuminance
} from '../public/js/theme.js';

import {
  DEFAULT_OTHERS_LEVEL,
  MIX_PRESETS,
  detectMixPreset,
  getMixVolumes,
  getPresetVolume,
  isMixPreset
} from '../public/js/mix.js';

import {
  analysePitchYin,
  classifyAccuracy,
  PitchDetector
} from '../public/js/pitch-detector.js';

import {
  AudioEngine,
  articulationLengthFactor,
  beatDuration,
  beatToTime,
  collectFermataHolds,
  dynamicEndLevel,
  dynamicLevel,
  playbackBeatToScoreBeat,
  scoreBeatToPlaybackBeat
} from '../public/js/audio-engine.js';

import {
  CLICK_PATTERNS,
  Metronome,
  beatIntervalSeconds,
  clickGridStep,
  isClickPattern
} from '../public/js/metronome.js';

import {
  SETTINGS_DEFAULTS,
  describeCountIn,
  describeTranspose,
  describeTuning
} from '../public/js/ui/settings.js';

import {
  buildHorizontalScoreLayout,
  classifyPitchAgainstTarget,
  collectPartVerses,
  collectStaffAttributes,
  getClefBottomLineIndex,
  getClefDescriptorForPart,
  getKeyCancellation,
  getKeySignatureAlters,
  getKeySignatureLayout,
  getLowestStaffPosition,
  getNoteRenderInfo,
  getPartLabel,
  getStaffPositionForClef,
  isScoreElementVisible,
  NotationRenderer
} from '../public/js/notation-renderer.js';

import {
  layoutMeasure,
  listZipEntries,
  readZipEntryText,
  selectScoreEntryName,
  isMxlFile,
  expandCompoundVoiceNames,
  buildPartNameUpdates,
  detectPianoPart
} from '../public/js/musicxml-parser.js';

import {
  DEFAULT_VELOCITY,
  DYNAMIC_VELOCITIES,
  accentMultiplier,
  buildDynamicsTimeline,
  buildPartDynamics,
  collectPartDynamics,
  interpretDynamicNames,
  stepLevel,
  velocityAt,
  velocityFromSoundDynamics
} from '../public/js/dynamics.js';

import {
  buildRepeatPlan,
  groupIntoRuns,
  isStraightThrough
} from '../public/js/repeats.js';

import { PlaybackTimeline, buildPlaybackTimeline } from '../public/js/playback-timeline.js';

import {
  beatToSeconds,
  buildTempoMap,
  compileTempoMap,
  constantTempoMap,
  secondsToBeat,
  tempoAtBeat,
  tempoScale
} from '../public/js/tempo-map.js';

import {
  accidentalWidth,
  clefGlyphWidth,
  staffLineOffset,
  timeSignatureWidth
} from '../public/js/glyphs.js';

import { describePosition, formatTime } from '../public/js/ui/transport.js';
import { getExportBaseName } from '../public/js/exporters.js';

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

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function approxEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}

console.log('=== Choir Practice - Unit Tests ===');

/* ============================================================== note maths */

section('Note to MIDI:');

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

test('Bb2 should be MIDI 46', () => {
  assert.equal(noteToMidi('Bb', 2), 46);
});

section('Pitch to MIDI (step + alter + octave):');

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

test('double-sharp F##4 should be MIDI 67', () => {
  assert.equal(pitchToMidi('F', 2, 4), 67);
});

test('double-flat Bbb4 should be MIDI 69', () => {
  assert.equal(pitchToMidi('B', -2, 4), 69);
});

test('pitchToFrequency A4 should be 440 Hz', () => {
  assert.equal(pitchToFrequency('A', 0, 4), 440);
});

test('pitchToFrequency E#4 should equal F4', () => {
  assert(approxEqual(pitchToFrequency('E', 1, 4), noteToFrequency('F', 4), 0.001));
});

section('Frequencies:');

test('MIDI 69 (A4) should be 440 Hz', () => {
  assert.equal(midiToFrequency(69), 440);
});

test('MIDI 60 (C4) should be ~261.63 Hz', () => {
  assert(approxEqual(midiToFrequency(60), 261.63, 0.01));
});

test('440 Hz should be A4 with no cents offset', () => {
  const result = frequencyToNote(440);
  assert.equal(result.noteName, 'A');
  assert.equal(result.octave, 4);
  assert.equal(result.cents, 0);
});

test('0 Hz should return null', () => {
  assert.equal(frequencyToNote(0), null);
});

test('negative frequency should return null', () => {
  assert.equal(frequencyToNote(-100), null);
});

section('Part colours:');

test('each SATB voice has its own colour', () => {
  const colors = new Set([
    getPartColor('Soprano'),
    getPartColor('Alto'),
    getPartColor('Tenor'),
    getPartColor('Bass')
  ]);
  assert.equal(colors.size, 4);
});

test('subdivided voices are distinguishable', () => {
  assert.notEqual(getPartColor('Tenor 1'), getPartColor('Tenor 2'));
});

test('unknown parts fall back to a neutral colour', () => {
  assert.equal(getPartColor('Oboe'), '#9e9e9e');
});

test('matching is case insensitive', () => {
  assert.equal(getPartColor('SOPRANO'), getPartColor('soprano'));
});

/* ============================================================ theme colours */

section('Theme colours:');

test('hex colours parse, including shorthand and alpha', () => {
  assert.deepEqual(parseCssColor('#ffffff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor('#000'), { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(parseCssColor('#00000080').a, 128 / 255);
});

test('rgb and rgba colours parse', () => {
  assert.deepEqual(parseCssColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.equal(parseCssColor('rgba(10, 20, 30, 0.5)').a, 0.5);
});

test('unparseable colours return null', () => {
  assert.equal(parseCssColor('not-a-colour'), null);
  assert.equal(parseCssColor(''), null);
});

test('white on black is the maximum contrast ratio', () => {
  const ratio = contrastRatio(parseCssColor('#fff'), parseCssColor('#000'));
  assert(approxEqual(ratio, 21, 0.01), `expected 21, got ${ratio}`);
});

test('luminance increases with brightness', () => {
  assert(relativeLuminance(parseCssColor('#888')) > relativeLuminance(parseCssColor('#222')));
});

test('mixing halfway lands between two colours', () => {
  const mixed = mixColors(parseCssColor('#000'), parseCssColor('#fff'), 0.5);
  assert.equal(colorToCss(mixed), 'rgb(128, 128, 128)');
});

test('a light voice colour is darkened to stay legible on white paper', () => {
  const adjusted = ensureContrast('#4a9eff', '#ffffff', 3.4);
  const ratio = contrastRatio(parseCssColor(adjusted), parseCssColor('#ffffff'));
  assert(ratio >= 3.4, `expected at least 3.4, got ${ratio}`);
});

test('a dark voice colour is lightened to stay legible on dark paper', () => {
  const adjusted = ensureContrast('#0f3460', '#141417', 3.4);
  const ratio = contrastRatio(parseCssColor(adjusted), parseCssColor('#141417'));
  assert(ratio >= 3.4, `expected at least 3.4, got ${ratio}`);
});

test('a colour that already has contrast is left alone', () => {
  assert.equal(ensureContrast('#000000', '#ffffff', 3.4), 'rgb(0, 0, 0)');
});

/* ============================================================ mix presets */

section('Mix presets:');

const mixParts = [{ id: 'S' }, { id: 'A' }, { id: 'T' }, { id: 'B' }];

test('only-mine silences the other voices', () => {
  const volumes = getMixVolumes('only-mine', mixParts, 'T');
  assert.deepEqual(volumes, { S: 0, A: 0, T: 100, B: 0 });
});

test('mostly-mine keeps others at the chosen level', () => {
  const volumes = getMixVolumes('mostly-mine', mixParts, 'A', 40);
  assert.deepEqual(volumes, { S: 40, A: 100, T: 40, B: 40 });
});

test('without-mine mutes only your part', () => {
  const volumes = getMixVolumes('without-mine', mixParts, 'B');
  assert.deepEqual(volumes, { S: 100, A: 100, T: 100, B: 0 });
});

test('everyone plays every voice at full volume', () => {
  const volumes = getMixVolumes('everyone', mixParts, 'S');
  assert.deepEqual(volumes, { S: 100, A: 100, T: 100, B: 100 });
});

test('the default others level is used when none is given', () => {
  assert.equal(getPresetVolume('mostly-mine', false), DEFAULT_OTHERS_LEVEL);
});

test('a preset round-trips through detection', () => {
  for (const preset of MIX_PRESETS) {
    const volumes = getMixVolumes(preset.id, mixParts, 'T', 25);
    assert.equal(
      detectMixPreset(volumes, mixParts, 'T', 25),
      preset.id,
      `${preset.id} should be detected`
    );
  }
});

test('a hand-adjusted volume reports a custom mix', () => {
  const volumes = getMixVolumes('everyone', mixParts, 'T');
  volumes.A = 62;
  assert.equal(detectMixPreset(volumes, mixParts, 'T'), null);
});

test('unknown preset ids are rejected', () => {
  assert.equal(isMixPreset('mostly-mine'), true);
  assert.equal(isMixPreset('sing-along'), false);
});

/* ======================================================== measure layout */

section('Measure layout - duration as source of truth:');

test('four quarter notes fill a 4/4 measure', () => {
  const events = [
    { kind: 'note', duration: 1, type: 'quarter' },
    { kind: 'note', duration: 1, type: 'quarter' },
    { kind: 'note', duration: 1, type: 'quarter' },
    { kind: 'note', duration: 1, type: 'quarter' }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 4);
  assert.deepEqual(notes.map(n => n.startBeatInMeasure), [0, 1, 2, 3]);
});

test('eighth-note triplets sound one third of a beat each', () => {
  const events = [
    { kind: 'note', duration: 2, type: 'eighth' },
    { kind: 'note', duration: 2, type: 'eighth' },
    { kind: 'note', duration: 2, type: 'eighth' }
  ];
  const { notes, beats } = layoutMeasure(events, 6);
  assert(Math.abs(beats - 1) < 1e-9, `triplet should total 1 beat, got ${beats}`);
  assert(Math.abs(notes[0].durationBeats - 1 / 3) < 1e-9);
  assert(Math.abs(notes[2].startBeatInMeasure - 2 / 3) < 1e-9);
});

test('dotted half plus quarter fills 4 beats', () => {
  const events = [
    { kind: 'note', duration: 3, type: 'half', dots: 1 },
    { kind: 'note', duration: 1, type: 'quarter' }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 4);
  assert.equal(notes[1].startBeatInMeasure, 3);
});

test('chord notes share an onset and do not advance time', () => {
  const events = [
    { kind: 'note', duration: 1, type: 'quarter', pitch: { step: 'C', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', isChord: true, pitch: { step: 'E', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', isChord: true, pitch: { step: 'G', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', pitch: { step: 'D', alter: 0, octave: 4 } }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 2);
  assert.deepEqual(notes.map(n => n.startBeatInMeasure), [0, 0, 0, 1]);
});

test('grace notes take no time', () => {
  const events = [
    { kind: 'note', duration: 0, type: 'eighth', isGrace: true, pitch: { step: 'B', alter: 0, octave: 4 } },
    { kind: 'note', duration: 1, type: 'quarter', pitch: { step: 'C', alter: 0, octave: 5 } }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 1);
  assert.equal(notes[1].startBeatInMeasure, 0);
});

test('backup realigns a second voice to the measure start', () => {
  const events = [
    { kind: 'note', duration: 4, type: 'whole', voice: 1 },
    { kind: 'backup', duration: 4 },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2 },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2 },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2 },
    { kind: 'note', duration: 1, type: 'quarter', voice: 2 }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(beats, 4);
  assert.deepEqual(notes.slice(1).map(n => n.startBeatInMeasure), [0, 1, 2, 3]);
});

test('forward inserts an implicit rest', () => {
  const events = [
    { kind: 'forward', duration: 2 },
    { kind: 'note', duration: 2, type: 'half' }
  ];
  const { notes, beats } = layoutMeasure(events, 1);
  assert.equal(notes[0].startBeatInMeasure, 2);
  assert.equal(beats, 4);
});

/* ============================================================ part naming */

section('Part naming:');

test('compound part names expand to one name per voice', () => {
  assert.deepEqual(expandCompoundVoiceNames('Soprano / Alto'), ['Soprano', 'Alto']);
  assert.deepEqual(expandCompoundVoiceNames('Mezzo-Soprano'), []);
});

test('split voices are rejoined for export', () => {
  const updates = buildPartNameUpdates([
    { id: 'P1_v2', sourcePartId: 'P1', name: 'Alto', voiceNumber: 2 },
    { id: 'P1_v1', sourcePartId: 'P1', name: 'Soprano', voiceNumber: 1 }
  ]);
  assert.equal(updates.get('P1'), 'Soprano / Alto');
});

test('a stave label drops the parser voice suffix', () => {
  assert.equal(getPartLabel({ name: 'Voices (Voice 2)' }), 'Voices 2');
  assert.equal(getPartLabel({ name: 'Tenor' }), 'Tenor');
  assert.equal(getPartLabel({ name: '', voiceType: 'bass' }), 'bass');
});

test('piano parts are detected from name or MIDI program', () => {
  assert.equal(detectPianoPart('Piano'), true);
  assert.equal(detectPianoPart('Reduction', [], [], [1]), true);
  assert.equal(detectPianoPart('Soprano'), false);
});

/* ====================================================== compressed scores */

section('Compressed MusicXML (.mxl):');

/** Build a minimal ZIP archive in memory for the archive reader tests. */
function buildZip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, entry.method, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.uncompressedSize ?? entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, entry.method, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.uncompressedSize ?? entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

async function deflateRaw(text) {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const SCORE_XML = '<score-partwise><part-list/></score-partwise>';
const CONTAINER_XML =
  '<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>';

test('a ZIP archive is recognised by its signature', () => {
  const archive = buildZip([
    { name: 'score.musicxml', method: 0, data: new TextEncoder().encode(SCORE_XML) }
  ]);
  assert.equal(isMxlFile(archive), true);
  assert.equal(isMxlFile(new TextEncoder().encode('<score-partwise/>')), false);
});

test('archive members are listed from the central directory', () => {
  const archive = buildZip([
    { name: 'META-INF/container.xml', method: 0, data: new TextEncoder().encode(CONTAINER_XML) },
    { name: 'score.musicxml', method: 0, data: new TextEncoder().encode(SCORE_XML) }
  ]);
  const entries = listZipEntries(archive);
  assert.deepEqual(entries.map(entry => entry.name), ['META-INF/container.xml', 'score.musicxml']);
  assert.equal(entries[1].method, 0);
});

test('the container root file selects the score member', () => {
  const entries = [
    { name: 'META-INF/container.xml' },
    { name: 'other.xml' },
    { name: 'score.musicxml' }
  ];
  assert.equal(selectScoreEntryName(entries, CONTAINER_XML), 'score.musicxml');
});

test('without a container, the first XML member outside META-INF is used', () => {
  const entries = [{ name: 'META-INF/container.xml' }, { name: 'nested/piece.xml' }];
  assert.equal(selectScoreEntryName(entries, null), 'nested/piece.xml');
});

test('an archive with no score member returns null', () => {
  assert.equal(selectScoreEntryName([{ name: 'META-INF/container.xml' }], null), null);
});

test('a truncated archive reports a readable error', () => {
  assert.throws(() => listZipEntries(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), /archive/i);
});

test('an entry pointing past the end of the file is rejected', () => {
  const archive = buildZip([
    { name: 'score.musicxml', method: 0, data: new TextEncoder().encode(SCORE_XML) }
  ]);
  // Claim a payload far larger than the file actually contains.
  const view = new DataView(archive.buffer);
  const centralStart = archive.length - 22 - (46 + 'score.musicxml'.length);
  view.setUint32(centralStart + 20, 999999, true);
  assert.throws(() => listZipEntries(archive), /damaged/i);
});

test('ZIP64 archives are reported rather than misread', () => {
  const archive = buildZip([
    { name: 'score.musicxml', method: 0, data: new TextEncoder().encode(SCORE_XML) }
  ]);
  const view = new DataView(archive.buffer);
  const centralStart = archive.length - 22 - (46 + 'score.musicxml'.length);
  view.setUint32(centralStart + 24, 0xffffffff, true);
  assert.throws(() => listZipEntries(archive), /ZIP64/i);
});

await asyncTest('a stored archive member is read back verbatim', async () => {
  const archive = buildZip([
    { name: 'score.musicxml', method: 0, data: new TextEncoder().encode(SCORE_XML) }
  ]);
  const [entry] = listZipEntries(archive);
  assert.equal(await readZipEntryText(archive, entry), SCORE_XML);
});

await asyncTest('a deflated archive member is decompressed', async () => {
  const compressed = await deflateRaw(SCORE_XML);
  const archive = buildZip([
    {
      name: 'score.musicxml',
      method: 8,
      data: compressed,
      uncompressedSize: SCORE_XML.length
    }
  ]);
  const [entry] = listZipEntries(archive);
  assert.equal(await readZipEntryText(archive, entry), SCORE_XML);
});

await asyncTest('an unsupported compression method is reported', async () => {
  const archive = buildZip([
    { name: 'score.musicxml', method: 9, data: new Uint8Array([1, 2, 3]) }
  ]);
  const [entry] = listZipEntries(archive);
  await assert.rejects(() => readZipEntryText(archive, entry), /compression/i);
});

/* ============================================================ audio engine */

section('Audio engine - timing:');

test('beatDuration at 120 BPM is 0.5s', () => {
  assert.equal(beatDuration(120), 0.5);
});

test('beatDuration at 0 BPM is 0', () => {
  assert.equal(beatDuration(0), 0);
});

test('beatToTime: 4 beats at 120 BPM is 2s', () => {
  assert.equal(beatToTime(4, 120), 2);
});

test('beatToTime: 2.5 beats at 120 BPM is 1.25s', () => {
  assert.equal(beatToTime(2.5, 120), 1.25);
});

section('Audio engine - schedule:');

function makeMeasure(startBeat, beats, notes) {
  return { startBeat, beats, notes };
}

test('notes are placed at measure start plus their offset', () => {
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

test('every chord tone sounds at the same onset', () => {
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
  assert.equal(schedule.length, 3);
  assert(schedule.every(event => event.startBeat === 0));
});

test('rests and zero-length grace notes are not scheduled', () => {
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

test('tied notes of the same pitch merge into one sustained note', () => {
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
  assert.equal(schedule.length, 1);
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
  assert.equal(engine.buildSchedule().length, 2);
});

test('getTotalBeats uses absolute measure positions', () => {
  const engine = new AudioEngine();
  engine.parts = [{ id: 'P1', measures: [makeMeasure(0, 4, []), makeMeasure(4, 3, [])] }];
  assert.equal(engine.getTotalBeats(), 7);
});

section('Audio engine - repeats in the schedule:');

/** One note per bar, so each scheduled event identifies its bar. */
function oneNotePerBar(count) {
  const measures = [];
  for (let index = 0; index < count; index++) {
    measures.push(makeMeasure(index * 4, 4, [{
      isRest: false,
      pitch: { step: 'C', alter: 0, octave: 4 + index },
      durationBeats: 4,
      startBeatInMeasure: 0
    }]));
  }
  return measures;
}

/** Measure boundaries in the shape the engine expects from the parser. */
function barStructure(count) {
  const measures = [];
  for (let index = 0; index < count; index++) {
    measures.push({ index, number: index + 1, startBeat: index * 4, beats: 4 });
  }
  return measures;
}

test('without repeats each note is scheduled once', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(2) }]);
  engine.setScoreStructure({
    tempoMap: [{ beat: 0, bpm: 120 }],
    measureStructure: barStructure(2),
    repeatPlan: { order: [0, 1] }
  });
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 2);
  assert.deepEqual(schedule.map(event => event.playbackStartBeat).sort((a, b) => a - b), [0, 4]);
});

test('a repeated section is scheduled on every pass', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(2) }]);
  engine.setScoreStructure({
    tempoMap: [{ beat: 0, bpm: 120 }],
    measureStructure: barStructure(2),
    repeatPlan: { order: [0, 1, 0, 1] }
  });
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 4, 'two bars played twice is four sounding notes');
  assert.deepEqual(
    schedule.map(event => event.playbackStartBeat).sort((a, b) => a - b),
    [0, 4, 8, 12]
  );
  // The same written note appears twice, at the same score position.
  const firstNote = schedule.filter(event => event.startBeat === 0);
  assert.equal(firstNote.length, 2);
  assert.deepEqual(firstNote.map(event => event.playbackStartBeat).sort((a, b) => a - b), [0, 8]);
  assert.equal(engine.getTotalPlaybackBeats(), 16);
  // The written score is still only two bars long.
  assert.equal(engine.getTotalBeats(), 8);
});

test('a bar skipped by a volta is not scheduled', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(3) }]);
  engine.setScoreStructure({
    tempoMap: [{ beat: 0, bpm: 120 }],
    measureStructure: barStructure(3),
    repeatPlan: { order: [0, 2] }
  });
  const schedule = engine.buildSchedule();
  assert.equal(schedule.length, 2);
  assert.deepEqual(schedule.map(event => event.startBeat).sort((a, b) => a - b), [0, 8]);
  assert.deepEqual(engine.getUnperformedRanges(), [{ scoreStart: 4, scoreEnd: 8 }]);
});

test('turning repeats off plays the page as printed', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(2) }]);
  engine.setScoreStructure({
    tempoMap: [{ beat: 0, bpm: 120 }],
    measureStructure: barStructure(2),
    repeatPlan: { order: [0, 1, 0, 1] }
  });
  assert.equal(engine.buildSchedule().length, 4);
  engine.setPlayRepeats(false);
  assert.equal(engine.buildSchedule().length, 2);
  assert.equal(engine.getTotalPlaybackBeats(), 8);
});

test('a written tempo change lengthens the performance', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(2) }]);
  engine.setScoreStructure({
    tempoMap: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }],
    measureStructure: barStructure(2),
    repeatPlan: { order: [0, 1] }
  });
  engine.buildSchedule();
  // Four beats at 120 is 2s, four at 60 is 4s.
  assert(approxEqual(engine.getTotalSeconds(), 6, 1e-9));
});

test('the rehearsal tempo scales a score that changes tempo', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(2) }]);
  engine.setScoreStructure({
    tempoMap: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }],
    measureStructure: barStructure(2),
    repeatPlan: { order: [0, 1] }
  });
  engine.setTempo(60);
  // Halving the opening tempo doubles everything, including the slow section.
  assert(approxEqual(engine.getTotalSeconds(), 12, 1e-9));
  assert.equal(engine.timeline.tempoAtPlaybackBeat(0), 60);
  assert.equal(engine.timeline.tempoAtPlaybackBeat(5), 30);
});

test('seeking to a performance position reports the score position', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(2) }]);
  engine.setScoreStructure({
    tempoMap: [{ beat: 0, bpm: 120 }],
    measureStructure: barStructure(2),
    repeatPlan: { order: [0, 1, 0, 1] }
  });
  assert.equal(engine.seekToPlaybackBeat(9), 1);
  assert.equal(engine.pausePlaybackBeat, 9);
  // Seeking by score beat prefers the pass at or after the current position.
  engine.seek(1, { after: 5 });
  assert.equal(engine.pausePlaybackBeat, 9);
});

section('Audio engine - written dynamics:');

/** A part with a marking, a hairpin, and a note under each. */
function dynamicScorePart() {
  return {
    id: 'P1',
    measures: [
      {
        startBeat: 0,
        beats: 4,
        directions: [{ startBeatInMeasure: 0, dynamics: { velocity: DYNAMIC_VELOCITIES.p } }],
        notes: [{
          isRest: false,
          pitch: { step: 'C', alter: 0, octave: 4 },
          durationBeats: 4,
          startBeatInMeasure: 0
        }]
      },
      {
        startBeat: 4,
        beats: 4,
        directions: [{ startBeatInMeasure: 0, wedge: { type: 'crescendo', number: 1 } }],
        notes: [{
          isRest: false,
          pitch: { step: 'D', alter: 0, octave: 4 },
          durationBeats: 4,
          startBeatInMeasure: 0
        }]
      },
      {
        startBeat: 8,
        beats: 4,
        directions: [
          { startBeatInMeasure: 0, wedge: { type: 'stop', number: 1 } },
          { startBeatInMeasure: 0, dynamics: { velocity: DYNAMIC_VELOCITIES.ff } }
        ],
        notes: [{
          isRest: false,
          pitch: { step: 'E', alter: 0, octave: 4 },
          durationBeats: 4,
          startBeatInMeasure: 0
        }]
      }
    ]
  };
}

test('an unmarked score plays at the level the engine was tuned for', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(2) }]);
  const schedule = engine.buildSchedule();
  for (const event of schedule) {
    assert.equal(event.velocity, 1, 'no marking should mean no change');
  }
});

test('dynamics can be switched off for learning the notes', () => {
  const engine = new AudioEngine();
  engine.setParts([dynamicScorePart()]);
  engine.setFollowDynamics(false);
  for (const event of engine.buildSchedule()) {
    assert.equal(event.velocity, 1);
    assert.equal(event.velocityEnd, 1);
  }
  engine.setFollowDynamics(true);
  const levels = new Set(engine.buildSchedule().map(event => event.velocity));
  assert(levels.size > 1, 'switching them back on restores the shape');
});

test('a written marking changes how loud a note is', () => {
  const engine = new AudioEngine();
  engine.setParts([dynamicScorePart()]);
  const schedule = engine.buildSchedule().sort((a, b) => a.startBeat - b.startBeat);

  assert(schedule[0].velocity < 1, 'a piano marking should be quieter than unmarked');
  assert(schedule[2].velocity > 1, 'a fortissimo marking should be louder than unmarked');
  assert(schedule[2].velocity > schedule[0].velocity);
});

test('a note under a hairpin grows across its own length', () => {
  const engine = new AudioEngine();
  engine.setParts([dynamicScorePart()]);
  const schedule = engine.buildSchedule().sort((a, b) => a.startBeat - b.startBeat);
  const underHairpin = schedule[1];
  assert(
    underHairpin.velocityEnd > underHairpin.velocity,
    `the note should get louder as it sounds, got ${underHairpin.velocity} to ${underHairpin.velocityEnd}`
  );
});

test('a note outside a hairpin holds its level', () => {
  const engine = new AudioEngine();
  engine.setParts([dynamicScorePart()]);
  const schedule = engine.buildSchedule().sort((a, b) => a.startBeat - b.startBeat);
  assert.equal(schedule[0].velocity, schedule[0].velocityEnd);
});

test('levels stay inside a range the output bus can take', () => {
  const engine = new AudioEngine();
  engine.setParts([{
    id: 'P1',
    measures: [{
      startBeat: 0,
      beats: 4,
      directions: [{ startBeatInMeasure: 0, dynamics: { velocity: DYNAMIC_VELOCITIES.ffff } }],
      notes: [{
        isRest: false,
        pitch: { step: 'C', alter: 0, octave: 4 },
        durationBeats: 4,
        startBeatInMeasure: 0,
        accent: true,
        strongAccent: true
      }]
    }]
  }]);
  const [event] = engine.buildSchedule();
  assert(event.velocity <= 1.75, `expected a cap, got ${event.velocity}`);
  assert(event.velocity > 1);
});

test('an accent lifts the attack without changing where a hairpin arrives', () => {
  const engine = new AudioEngine();
  const part = dynamicScorePart();
  part.measures[1].notes[0].accent = true;
  engine.setParts([part]);
  const accented = engine.buildSchedule()
    .sort((a, b) => a.startBeat - b.startBeat)[1];

  const plain = new AudioEngine();
  plain.setParts([dynamicScorePart()]);
  const unaccented = plain.buildSchedule()
    .sort((a, b) => a.startBeat - b.startBeat)[1];

  assert(accented.velocity > unaccented.velocity, 'the attack should be stronger');
  assert.equal(accented.velocityEnd, unaccented.velocityEnd, 'the destination is unchanged');
});

section('Audio engine - articulation lengths:');

test('a plain note sounds for its written value', () => {
  assert.equal(articulationLengthFactor({}), 1);
  assert.equal(articulationLengthFactor({ tenuto: true }), 1);
});

test('an unmarked note plays at the reference level', () => {
  assert.equal(dynamicLevel({}), 1);
  assert.equal(dynamicEndLevel({}), 1);
});

test('a note with no destination holds its starting level', () => {
  assert.equal(dynamicEndLevel({ velocity: 0.5 }), 0.5);
  assert.equal(dynamicEndLevel({ velocity: 0.5, velocityEnd: 1.2 }), 1.2);
});

test('an unusable level falls back rather than silencing the note', () => {
  assert.equal(dynamicLevel({ velocity: 0 }), 1);
  assert.equal(dynamicLevel({ velocity: NaN }), 1);
});

test('detached articulations shorten the note', () => {
  assert(articulationLengthFactor({ staccato: true }) < 1);
  assert(
    articulationLengthFactor({ staccatissimo: true }) <
    articulationLengthFactor({ staccato: true }),
    'staccatissimo is shorter than staccato'
  );
  assert(articulationLengthFactor({ strongAccent: true }) < 1, 'marcato is slightly detached');
});

test('the shortest marking wins when several are written', () => {
  assert.equal(
    articulationLengthFactor({ staccato: true, staccatissimo: true, strongAccent: true }),
    articulationLengthFactor({ staccatissimo: true })
  );
});

test('a staccato note is scheduled shorter than it is written', () => {
  const engine = new AudioEngine();
  engine.setParts([{
    id: 'P1',
    measures: [{
      startBeat: 0,
      beats: 4,
      notes: [{
        isRest: false,
        pitch: { step: 'C', alter: 0, octave: 4 },
        durationBeats: 4,
        startBeatInMeasure: 0,
        staccato: true
      }]
    }]
  }]);
  const [event] = engine.buildSchedule();
  const described = engine.describeEvent(event, 0);
  assert(
    described.timing.playbackDurationBeats < event.durationBeats,
    'the silence after it is the articulation'
  );
  assert.equal(described.articulation.staccato, true);
});

section('Audio engine - transposing parts:');

test('a transposing part sounds at its transposed pitch', () => {
  const engine = new AudioEngine();
  engine.setParts([{
    id: 'P1',
    transpose: { semitones: -12 },
    measures: [{
      startBeat: 0,
      beats: 4,
      notes: [{
        isRest: false,
        pitch: { step: 'C', alter: 0, octave: 4 },
        durationBeats: 4,
        startBeatInMeasure: 0
      }]
    }]
  }]);
  const [event] = engine.buildSchedule();
  assert.equal(event.midi, 48, 'written C4 should sound C3');
  assert(approxEqual(event.frequency, midiToFrequency(48), 1e-6));
});

test('a part with no transposition is unchanged', () => {
  const engine = new AudioEngine();
  engine.setParts([{ id: 'P1', measures: oneNotePerBar(1) }]);
  const [event] = engine.buildSchedule();
  assert.equal(event.midi, 60);
});

section('Audio engine - fermata timeline:');

const fermataParts = [{
  id: 'P1',
  measures: [
    makeMeasure(0, 4, [
      { isRest: false, pitch: { step: 'C', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0, fermata: { type: 'upright' } }
    ]),
    makeMeasure(4, 4, [
      { isRest: false, pitch: { step: 'D', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0 }
    ])
  ]
}];

test('a fermata adds hold time at the end of its note', () => {
  const holds = collectFermataHolds(fermataParts, 2);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].scoreBeat, 4);
  assert.equal(holds[0].extraBeats, 4);
});

test('a longer hold multiplier extends the hold', () => {
  assert.equal(collectFermataHolds(fermataParts, 3)[0].extraBeats, 8);
});

test('score beats map onto the expanded playback timeline', () => {
  const holds = collectFermataHolds(fermataParts, 2);
  assert.equal(scoreBeatToPlaybackBeat(2, holds), 2);
  assert.equal(scoreBeatToPlaybackBeat(4, holds), 8);
  assert.equal(scoreBeatToPlaybackBeat(6, holds), 10);
});

test('playback beats inside a hold map back to the fermata beat', () => {
  const holds = collectFermataHolds(fermataParts, 2);
  assert.equal(playbackBeatToScoreBeat(2, holds), 2);
  assert.equal(playbackBeatToScoreBeat(6, holds), 4);
  assert.equal(playbackBeatToScoreBeat(10, holds), 6);
});

/*
 * A fermata over a note and a fermata over a rest are two different marks that
 * happen to share a glyph, and the sound has to tell them apart.
 *
 * Every hold used to be a silence: the note sounded its written length and the
 * score then waited out the hold with nothing in it. On the last bar of "Happy
 * Birthday" that is a full second of silence between the final chord and the end
 * of the piece, which is heard — correctly — as the sound being cut off. Measured
 * on the offline render, the audio went quiet 1.05s before the playhead reached
 * the final barline.
 */
test('a fermata over a note is sung, and one over a rest is waited', () => {
  const [sung] = collectFermataHolds(fermataParts, 2);
  assert.equal(sung.sustained, true, 'a fermata written over a note holds the note');

  const restParts = [{
    id: 'P1',
    measures: [
      makeMeasure(0, 4, [
        { isRest: true, durationBeats: 4, startBeatInMeasure: 0, fermata: { type: 'upright' } }
      ])
    ]
  }];
  const [waited] = collectFermataHolds(restParts, 2);
  assert.equal(waited.sustained, false, 'a fermata written over a rest holds the silence');
});

test('one part still singing makes the whole hold sung', () => {
  // Soprano holds the chord; the bass has a rest under the same mark. The
  // ensemble is not silent, so the hold is not a silence.
  const mixed = [
    {
      id: 'P1',
      measures: [makeMeasure(0, 4, [
        { isRest: true, durationBeats: 4, startBeatInMeasure: 0, fermata: { type: 'upright' } }
      ])]
    },
    {
      id: 'P2',
      measures: [makeMeasure(0, 4, [
        { isRest: false, pitch: { step: 'C', alter: 0, octave: 4 }, durationBeats: 4, startBeatInMeasure: 0, fermata: { type: 'upright' } }
      ])]
    }
  ];
  const holds = collectFermataHolds(mixed, 2);
  assert.equal(holds.length, 1, 'simultaneous marks collapse into one ensemble hold');
  assert.equal(holds[0].sustained, true);
});

test('a note under a fermata sounds through the hold, and its neighbours do not', () => {
  const timeline = buildPlaybackTimeline({
    measures: [{ startBeat: 0, beats: 4 }, { startBeat: 4, beats: 4 }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    fermataHolds: [{ scoreBeat: 4, extraBeats: 4, sustained: true }]
  });

  // The written bar is four beats; the hold adds four more on the playback axis.
  assert.equal(timeline.endPlaybackBeat(0, 4), 4, 'the plain end is the written one');
  assert.equal(
    timeline.heldEndPlaybackBeat(0, 4),
    8,
    'a held note reaches the far side of the hold instead of stopping inside it'
  );
  // And the bar after it still starts where the hold leaves off.
  assert.equal(timeline.onsetPlaybackBeat(0, 4), 8);
});

test('a waited hold is left silent even for a note that ends on it', () => {
  const timeline = buildPlaybackTimeline({
    measures: [{ startBeat: 0, beats: 4 }, { startBeat: 4, beats: 4 }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    fermataHolds: [{ scoreBeat: 4, extraBeats: 4, sustained: false }]
  });

  assert.equal(
    timeline.heldEndPlaybackBeat(0, 4),
    4,
    'a fermata over a rest or a barline still buys silence'
  );
});

/* ============================================================== metronome */

section('Metronome:');

test('beat interval at 120 BPM is half a second', () => {
  assert.equal(beatIntervalSeconds(120), 0.5);
});

test('beat interval at 0 BPM is 0', () => {
  assert.equal(beatIntervalSeconds(0), 0);
});

test('measure starts drive the accent, including a pickup bar', () => {
  const metronome = new Metronome({ currentTime: 0 }, null);
  metronome.setMeasureStartBeats([0, 1, 5, 9]);
  assert.equal(metronome.isDownbeatAtScoreBeat(0, 0), true);
  assert.equal(metronome.isDownbeatAtScoreBeat(1, 1), true);
  assert.equal(metronome.isDownbeatAtScoreBeat(2, 2), false);
  assert.equal(metronome.isDownbeatAtScoreBeat(5, 5), true);
});

test('clicks walk the performance, so a repeat is counted twice', () => {
  const timeline = buildPlaybackTimeline({
    measures: [{ startBeat: 0, beats: 4 }, { startBeat: 4, beats: 4 }],
    order: [0, 1, 0, 1],
    tempoMap: [{ beat: 0, bpm: 120 }]
  });

  const clicks = [];
  let from = 0;
  let inclusive = true;
  for (let guard = 0; guard < 40; guard++) {
    const position = timeline.nextGridPosition(from, 1, { inclusive });
    if (!position) break;
    clicks.push(position);
    from = position.playbackBeat;
    inclusive = false;
  }

  assert.equal(clicks.length, 16, 'two 4/4 bars played twice is sixteen clicks');
  assert.deepEqual(clicks.map(click => click.playbackBeat).slice(0, 4), [0, 1, 2, 3]);
  // The ninth click is the downbeat of the repeat, back at the top of the page.
  assert.equal(clicks[8].playbackBeat, 8);
  assert.equal(clicks[8].scoreBeat, 0);
});

test('clicks are not repeated while a fermata is held', () => {
  const timeline = buildPlaybackTimeline({
    measures: [{ startBeat: 0, beats: 4 }, { startBeat: 4, beats: 4 }],
    tempoMap: [{ beat: 0, bpm: 120 }],
    fermataHolds: [{ scoreBeat: 4, extraBeats: 4 }]
  });

  const clicks = [];
  let from = 0;
  let inclusive = true;
  for (let guard = 0; guard < 40; guard++) {
    const position = timeline.nextGridPosition(from, 1, { inclusive });
    if (!position) break;
    clicks.push(position);
    from = position.playbackBeat;
    inclusive = false;
  }

  // Eight written beats, so eight clicks: the four held beats are silent.
  assert.equal(clicks.length, 8);
  assert.deepEqual(clicks.map(click => click.scoreBeat), [0, 1, 2, 3, 4, 5, 6, 7]);
  // The beat after the hold is pushed back by the length of the hold.
  assert.equal(clicks[4].playbackBeat, 8);
});

test('a bar skipped by a volta is not clicked', () => {
  const timeline = buildPlaybackTimeline({
    measures: [{ startBeat: 0, beats: 4 }, { startBeat: 4, beats: 4 }, { startBeat: 8, beats: 4 }],
    order: [0, 2],
    tempoMap: [{ beat: 0, bpm: 120 }]
  });
  const scoreBeats = [];
  let from = 0;
  let inclusive = true;
  for (let guard = 0; guard < 40; guard++) {
    const position = timeline.nextGridPosition(from, 1, { inclusive });
    if (!position) break;
    scoreBeats.push(position.scoreBeat);
    from = position.playbackBeat;
    inclusive = false;
  }
  assert.deepEqual(scoreBeats, [0, 1, 2, 3, 8, 9, 10, 11]);
});

test('click patterns map to a grid spacing', () => {
  // In 4/4 the counted beat is a quarter.
  assert.equal(clickGridStep('beat', 4), 1);
  assert.equal(clickGridStep('eighths', 4), 0.5);
  assert.equal(clickGridStep('triplets', 4), 1 / 3);
  assert.equal(clickGridStep('sixteenths', 4), 0.25);
  // In 6/8 the counted beat is an eighth.
  assert.equal(clickGridStep('beat', 8), 0.5);
  assert.equal(clickGridStep('eighths', 8), 0.25);
});

test('bars only walks the beat grid and filters it', () => {
  // Bar lengths change, so a fixed spacing would drift out of the music.
  assert.equal(clickGridStep('bars', 4), clickGridStep('beat', 4));
  assert.equal(clickGridStep('bars', 8), clickGridStep('beat', 8));
});

test('an unknown pattern falls back to the beat', () => {
  assert.equal(clickGridStep('nonsense', 4), 1);
  assert.equal(isClickPattern('beat'), true);
  assert.equal(isClickPattern('nonsense'), false);
});

test('the click level scales and can be silenced', () => {
  const metronome = new Metronome({ currentTime: 0 }, null);
  metronome.setVolume(50);
  assert.equal(metronome.volume, 0.5);
  metronome.setVolume(0);
  assert.equal(metronome.volume, 0);
  metronome.setVolume(999);
  assert.equal(metronome.volume, 1);
});

test('the pattern is stored and validated', () => {
  const metronome = new Metronome({ currentTime: 0 }, null);
  metronome.setTimeSignature(6, 8);
  metronome.setPattern('triplets');
  assert.equal(metronome.pattern, 'triplets');
  assert(approxEqual(metronome.getGridStep(), 0.5 / 3, 1e-9));
  metronome.setPattern('nonsense');
  assert.equal(metronome.pattern, 'beat');
});

test('a finer grid clicks subdivisions', () => {
  const timeline = buildPlaybackTimeline({
    measures: [{ startBeat: 0, beats: 4 }],
    tempoMap: [{ beat: 0, bpm: 120 }]
  });
  const positions = [];
  let from = 0;
  let inclusive = true;
  for (let guard = 0; guard < 20; guard++) {
    const position = timeline.nextGridPosition(from, 0.5, { inclusive });
    if (!position) break;
    positions.push(position.playbackBeat);
    from = position.playbackBeat;
    inclusive = false;
  }
  assert.deepEqual(positions, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
});

test('the grid runs out at the end of the performance', () => {
  const timeline = buildPlaybackTimeline({
    measures: [{ startBeat: 0, beats: 4 }],
    tempoMap: [{ beat: 0, bpm: 120 }]
  });
  assert.equal(timeline.nextGridPosition(4, 1), null);
});

test('without score data the accent falls back to the time signature', () => {
  const metronome = new Metronome({ currentTime: 0 }, null);
  metronome.setTimeSignature(3, 4);
  metronome.setMeasureStartBeats(null);
  assert.equal(metronome.isDownbeatAtScoreBeat(0, 0), true);
  assert.equal(metronome.isDownbeatAtScoreBeat(1, 1), false);
  assert.equal(metronome.isDownbeatAtScoreBeat(3, 3), true);
});

/* ======================================================= notation renderer */

section('Notation glyphs - anchors and metrics:');

test('staff lines are counted from the bottom', () => {
  // MusicXML numbers line 1 as the bottom line; the renderer measures down from
  // the top, so the two have to be reconciled in one place.
  assert.equal(staffLineOffset(1), 4);
  assert.equal(staffLineOffset(2), 3);
  assert.equal(staffLineOffset(3), 2);
  assert.equal(staffLineOffset(4), 1);
  assert.equal(staffLineOffset(5), 0);
});

test('an unreadable line falls back to the bottom line', () => {
  assert.equal(staffLineOffset(undefined), 4);
  assert.equal(staffLineOffset(NaN), 4);
});

test('glyph widths scale with the staff', () => {
  assert.equal(clefGlyphWidth('G', 10), clefGlyphWidth('G', 20) / 2);
  assert.equal(accidentalWidth(1, 10), accidentalWidth(1, 20) / 2);
});

test('a double flat needs the most room and a sharp more than a flat', () => {
  const space = 11;
  assert(accidentalWidth(-2, space) > accidentalWidth(-1, space));
  assert(accidentalWidth(1, space) > accidentalWidth(-1, space));
  assert(accidentalWidth(0, space) > 0);
});

test('an unknown clef is measured as a G clef', () => {
  assert.equal(clefGlyphWidth('Q', 11), clefGlyphWidth('G', 11));
  assert.equal(clefGlyphWidth(undefined, 11), clefGlyphWidth('G', 11));
});

test('a time signature widens for two-digit numbers', () => {
  const space = 11;
  const simple = timeSignatureWidth({ numerator: 4, denominator: 4 }, space);
  const compound = timeSignatureWidth({ numerator: 12, denominator: 8 }, space);
  assert(compound > simple);
  assert(simple > 0);
});

section('Notation renderer - staff positions:');

const TREBLE = { sign: 'G', line: 2, octaveChange: 0 };
const BASS = { sign: 'F', line: 4, octaveChange: 0 };

test('E4 sits on the bottom treble line', () => {
  assert.equal(getStaffPositionForClef('E', 4, TREBLE), 0);
});

test('G4 sits on the second treble line', () => {
  assert.equal(getStaffPositionForClef('G', 4, TREBLE), 2);
});

test('C4 sits below the treble staff', () => {
  assert.equal(getStaffPositionForClef('C', 4, TREBLE), -2);
});

test('G2 sits on the bottom bass line', () => {
  assert.equal(getStaffPositionForClef('G', 2, BASS), 0);
});

test('C3 sits in the bass staff', () => {
  assert.equal(getStaffPositionForClef('C', 3, BASS), 3);
});

test('an octave-down tenor clef shifts pitches up one octave on the staff', () => {
  const tenor = { sign: 'G', line: 2, octaveChange: -1 };
  assert.equal(
    getStaffPositionForClef('E', 3, tenor),
    getStaffPositionForClef('E', 4, TREBLE)
  );
});

section('Notation renderer - clef choice:');

test('bass voices use an F clef', () => {
  assert.equal(getClefDescriptorForPart({ voiceType: 'bass' }).sign, 'F');
  assert.equal(getClefDescriptorForPart({ voiceType: 'baritone' }).sign, 'F');
});

test('tenor voices use a G clef sounding an octave lower', () => {
  const clef = getClefDescriptorForPart({ voiceType: 'tenor' });
  assert.equal(clef.sign, 'G');
  assert.equal(clef.octaveChange, -1);
});

test('soprano and alto voices use a plain G clef', () => {
  assert.equal(getClefDescriptorForPart({ voiceType: 'soprano' }).octaveChange, 0);
  assert.equal(getClefDescriptorForPart({ voiceType: 'alto' }).sign, 'G');
});

test('an imported clef is preserved for unnamed parts', () => {
  const clef = getClefDescriptorForPart({ name: 'Voice 1', clef: { sign: 'C', line: 3 } });
  assert.equal(clef.sign, 'C');
  assert.equal(clef.line, 3);
});

test('generic four-part scores fall back to SATB ordering', () => {
  assert.equal(getClefDescriptorForPart({ name: 'Voice 4' }, 3, 4).sign, 'F');
  assert.equal(getClefDescriptorForPart({ name: 'Voice 3' }, 2, 4).octaveChange, -1);
});

section('Notation renderer - key signatures:');

test('sharps and flats are assigned in the traditional order', () => {
  assert.deepEqual(getKeySignatureAlters(2), { F: 1, C: 1 });
  assert.deepEqual(getKeySignatureAlters(-3), { B: -1, E: -1, A: -1 });
  assert.deepEqual(getKeySignatureAlters(0), {});
});

test('a treble key signature uses the engraved staff positions', () => {
  const flats = getKeySignatureLayout(-3, TREBLE).map(item => `${item.step}${item.position}`);
  assert.deepEqual(flats, ['B4', 'E7', 'A3']);
  const sharps = getKeySignatureLayout(3, TREBLE).map(item => `${item.step}${item.position}`);
  assert.deepEqual(sharps, ['F8', 'C5', 'G9']);
});

test('a bass key signature sits a third lower on the staff', () => {
  const sharps = getKeySignatureLayout(3, BASS).map(item => `${item.step}${item.position}`);
  assert.deepEqual(sharps, ['F6', 'C3', 'G7']);
});

test('an octave-transposing clef keeps the written positions', () => {
  const tenor = { sign: 'G', line: 2, octaveChange: -1 };
  assert.deepEqual(getKeySignatureLayout(-2, tenor), getKeySignatureLayout(-2, TREBLE));
});

test('no key means no accidentals to draw', () => {
  assert.deepEqual(getKeySignatureLayout(0, TREBLE), []);
});

test('the bottom line of each clef is identified', () => {
  assert.equal(getClefBottomLineIndex(TREBLE), 30); // E4
  assert.equal(getClefBottomLineIndex(BASS), 18); // G2
});

section('Notation renderer - key changes:');

test('moving further round the same side cancels nothing', () => {
  assert.deepEqual(getKeyCancellation(2, 4, TREBLE), []);
  assert.deepEqual(getKeyCancellation(-1, -3, TREBLE), []);
});

test('retreating on the same side cancels only what is dropped', () => {
  const naturals = getKeyCancellation(4, 2, TREBLE).map(item => item.step);
  assert.deepEqual(naturals, ['G', 'D']);
});

test('crossing between sharps and flats cancels the whole old signature', () => {
  const naturals = getKeyCancellation(3, -2, TREBLE).map(item => item.step);
  assert.deepEqual(naturals, ['F', 'C', 'G']);
});

test('returning to no key cancels everything that was in force', () => {
  assert.deepEqual(getKeyCancellation(-2, 0, TREBLE).map(item => item.step), ['B', 'E']);
});

test('cancelling naturals sit where the old accidentals stood', () => {
  const treble = getKeyCancellation(2, 0, TREBLE);
  assert.deepEqual(treble.map(item => item.position), [8, 5]);
  const bass = getKeyCancellation(2, 0, BASS);
  assert.deepEqual(bass.map(item => item.position), [6, 3]);
});

section('Notation renderer - staff attributes:');

/** A part built from bare measure descriptions. */
function attributePart(measures) {
  return {
    id: 'P1',
    measures: measures.map((measure, index) => ({
      startBeat: index * 4,
      beats: 4,
      notes: [],
      ...measure
    }))
  };
}

test('the opening key and time are reported even when the score omits them', () => {
  const { keys, times } = collectStaffAttributes(attributePart([{}, {}]));
  assert.deepEqual(keys, [{ startBeat: 0, measureIndex: 0, fifths: 0 }]);
  assert.deepEqual(times, [{ startBeat: 0, measureIndex: 0, numerator: 4, denominator: 4 }]);
});

test('only genuine changes are recorded, not every restatement', () => {
  const part = attributePart([
    { keySignature: { fifths: 2 }, timeSignature: { numerator: 3, denominator: 4 } },
    { keySignature: { fifths: 2 }, timeSignature: { numerator: 3, denominator: 4 } },
    { keySignature: { fifths: -1 }, timeSignature: { numerator: 3, denominator: 4 } },
    { keySignature: { fifths: -1 }, timeSignature: { numerator: 6, denominator: 8 } }
  ]);
  const { keys, times } = collectStaffAttributes(part);
  assert.deepEqual(keys.map(key => key.fifths), [2, -1]);
  assert.equal(keys[1].measureIndex, 2);
  assert.equal(keys[1].startBeat, 8);
  assert.deepEqual(times.map(time => `${time.numerator}/${time.denominator}`), ['3/4', '6/8']);
  assert.equal(times[1].measureIndex, 3);
});

test('a key stated part way through still gives the opening a signature', () => {
  const part = attributePart([{}, { keySignature: { fifths: 3 } }]);
  const { keys } = collectStaffAttributes(part);
  assert.equal(keys.length, 2);
  assert.equal(keys[0].startBeat, 0);
  assert.equal(keys[0].fifths, 3, 'the opening inherits the first stated key');
});

section('Notation renderer - room below a staff:');

/** A part holding one note per entry, described by step and octave. */
function pitchPart(notes) {
  return {
    id: 'P1',
    measures: [{
      startBeat: 0,
      beats: 4,
      notes: notes.map(note => ({ type: 'quarter', ...note }))
    }]
  };
}

test('a part sitting inside its staff needs no room below it', () => {
  const part = pitchPart([{ pitch: { step: 'G', octave: 4 }, stem: 'up' }]);
  assert.equal(getLowestStaffPosition(part, TREBLE), 0);
});

test('notes below the staff are measured from the lowest of them', () => {
  const part = pitchPart([
    { pitch: { step: 'G', octave: 4 }, stem: 'up' },
    { pitch: { step: 'B', octave: 3 }, stem: 'up' }
  ]);
  assert.equal(getLowestStaffPosition(part, TREBLE), -3);
});

test('a down stem reaches three spaces below its head', () => {
  // B4 stands on the middle line, position 4; its down stem ends six half-spaces
  // lower, two below the bottom line.
  const part = pitchPart([{ pitch: { step: 'B', octave: 4 }, stem: 'down' }]);
  assert.equal(getLowestStaffPosition(part, TREBLE), -2);
});

test('a forced up stem keeps a low note out of the reckoning', () => {
  const part = pitchPart([{ pitch: { step: 'B', octave: 4 }, stem: 'up' }]);
  assert.equal(getLowestStaffPosition(part, TREBLE), 0);
});

test('stem direction falls back to the note position', () => {
  const high = pitchPart([{ pitch: { step: 'C', octave: 5 } }]); // above the middle line
  assert.equal(getLowestStaffPosition(high, TREBLE), -1);
  const low = pitchPart([{ pitch: { step: 'A', octave: 4 } }]); // below the middle line
  assert.equal(getLowestStaffPosition(low, TREBLE), 0);
});

test('a stemless note contributes only its head', () => {
  const part = pitchPart([{ pitch: { step: 'B', octave: 4 }, type: 'whole' }]);
  assert.equal(getLowestStaffPosition(part, TREBLE), 0);
});

test('rests are ignored', () => {
  const part = pitchPart([{ isRest: true }]);
  assert.equal(getLowestStaffPosition(part, TREBLE), 0);
});

section('Notation renderer - verses:');

/** A part whose notes carry the given lyric arrays. */
function lyricPart(lyricSets) {
  return {
    id: 'P1',
    measures: [{
      startBeat: 0,
      beats: 4,
      notes: lyricSets.map(lyrics => ({
        type: 'quarter',
        pitch: { step: 'G', octave: 4 },
        lyrics
      }))
    }]
  };
}

test('a wordless part reports no verses', () => {
  const { verses, hasUnnumbered } = collectPartVerses(lyricPart([null, undefined, []]));
  assert.equal(verses.size, 0);
  assert.equal(hasUnnumbered, false);
});

test('numbered verses are collected', () => {
  const part = lyricPart([
    [{ number: 1, text: 'one' }, { number: 2, text: 'two' }],
    [{ number: 3, text: 'three' }]
  ]);
  const { verses } = collectPartVerses(part);
  assert.deepEqual([...verses].sort(), [1, 2, 3]);
});

test('a lone syllable is flagged so a single-verse score never blanks', () => {
  const { verses, hasUnnumbered } = collectPartVerses(lyricPart([[{ number: 1, text: 'sing' }]]));
  assert.deepEqual([...verses], [1]);
  assert.equal(hasUnnumbered, true);
});

test('empty syllables do not count as words', () => {
  const { verses, hasUnnumbered } = collectPartVerses(lyricPart([[{ number: 2, text: '   ' }]]));
  assert.equal(verses.size, 0);
  assert.equal(hasUnnumbered, false);
});

const partSingsSelectedVerse = NotationRenderer.prototype.partSingsSelectedVerse;

test('a part is measured for words only in the verse on show', () => {
  const view = {
    verse: 2,
    partVerses: new Map([
      ['S', { verses: new Set([1, 2]), hasUnnumbered: false }],
      ['A', { verses: new Set([1]), hasUnnumbered: false }],
      ['T', { verses: new Set([1]), hasUnnumbered: true }]
    ])
  };
  assert.equal(partSingsSelectedVerse.call(view, { id: 'S' }), true);
  assert.equal(partSingsSelectedVerse.call(view, { id: 'A' }), false);
  assert.equal(
    partSingsSelectedVerse.call(view, { id: 'T' }),
    true,
    'an unnumbered verse shows whatever the picker says'
  );
  assert.equal(partSingsSelectedVerse.call(view, { id: 'B' }), false);
});

section('Notation renderer - printed accidentals:');

function accidentalContext(fifths) {
  return {
    keyAlters: getKeySignatureAlters(fifths),
    measureAlters: new Map(),
    tiedAlters: new Map()
  };
}

const resolveAccidental = NotationRenderer.prototype.resolveAccidental;

test('a pitch already in the key signature needs no accidental', () => {
  const context = accidentalContext(-3);
  const eFlat = { pitch: { step: 'E', alter: -1, octave: 4 } };
  assert.equal(resolveAccidental.call(null, eFlat, context), false);
});

test('a pitch outside the key signature is spelled', () => {
  const context = accidentalContext(-3);
  const fSharp = { pitch: { step: 'F', alter: 1, octave: 4 } };
  assert.equal(resolveAccidental.call(null, fSharp, context), true);
});

test('cancelling a key signature accidental prints a natural', () => {
  const context = accidentalContext(-3);
  const eNatural = { pitch: { step: 'E', alter: 0, octave: 4 } };
  assert.equal(resolveAccidental.call(null, eNatural, context), true);
});

test('an accidental is not repeated later in the same bar', () => {
  const context = accidentalContext(0);
  const note = () => ({ pitch: { step: 'F', alter: 1, octave: 4 } });
  assert.equal(resolveAccidental.call(null, note(), context), true);
  assert.equal(resolveAccidental.call(null, note(), context), false);
});

test('the same letter in another octave still needs its own accidental', () => {
  const context = accidentalContext(0);
  assert.equal(resolveAccidental.call(null, { pitch: { step: 'F', alter: 1, octave: 4 } }, context), true);
  assert.equal(resolveAccidental.call(null, { pitch: { step: 'F', alter: 1, octave: 5 } }, context), true);
});

test('a tied continuation does not repeat the accidental', () => {
  const context = accidentalContext(0);
  const start = { pitch: { step: 'G', alter: 1, octave: 4 }, tie: { start: true, stop: false } };
  const stop = { pitch: { step: 'G', alter: 1, octave: 4 }, tie: { start: false, stop: true } };
  assert.equal(resolveAccidental.call(null, start, context), true);
  context.measureAlters = new Map(); // new bar
  assert.equal(resolveAccidental.call(null, stop, context), false);
});

test('accidentals are measured against the printed signature', () => {
  // The gutter shows the opening signature, so a natural must still be printed
  // even if the source file declares a different key later on.
  const context = accidentalContext(-3);
  const eNatural = { pitch: { step: 'E', alter: 0, octave: 4 } };
  const eFlat = { pitch: { step: 'E', alter: -1, octave: 4 } };
  assert.equal(resolveAccidental.call(null, eNatural, context), true);
  // Within the same bar the natural stays in force, so E flat is respelled.
  assert.equal(resolveAccidental.call(null, eFlat, context), true);
});

section('Notation renderer - note appearance:');

test('the written type decides the head and stem', () => {
  assert.deepEqual(getNoteRenderInfo({ type: 'whole' }), {
    type: 'whole', openHead: true, hasStem: false, flagCount: 0
  });
  assert.deepEqual(getNoteRenderInfo({ type: '16th' }), {
    type: '16th', openHead: false, hasStem: true, flagCount: 2
  });
});

test('a missing type is inferred from the sounding duration', () => {
  assert.equal(getNoteRenderInfo({ durationBeats: 2 }).type, 'half');
  assert.equal(getNoteRenderInfo({ durationBeats: 0.5 }).type, 'eighth');
  assert.equal(getNoteRenderInfo({ durationBeats: 1.5, dots: 1 }).type, 'quarter');
});

section('Notation renderer - shared measure grid:');

test('every section shares one measure grid, whatever its density', () => {
  const dense = {
    id: 'S',
    measures: [
      { number: 1, beats: 4, notes: [0, 1, 2, 3].map(beat => ({ startBeatInMeasure: beat, durationBeats: 1 })) },
      { number: 2, beats: 4, notes: [{ startBeatInMeasure: 0, durationBeats: 4 }] }
    ]
  };
  const sparse = {
    id: 'B',
    measures: [
      { number: 1, beats: 4, notes: [{ startBeatInMeasure: 0, durationBeats: 4 }] },
      { number: 2, beats: 4, notes: [{ startBeatInMeasure: 0, durationBeats: 4 }] }
    ]
  };
  const layout = buildHorizontalScoreLayout([dense, sparse]);

  assert.equal(layout.measures.length, 2);
  assert.equal(layout.totalBeats, 8);
  for (let index = 0; index < 2; index++) {
    assert.equal(
      layout.getMeasure(dense.measures[index], index).startX,
      layout.getMeasure(sparse.measures[index], index).startX,
      `measure ${index + 1} should start at the same x for both sections`
    );
  }
});

test('the timeline maps beats to increasing x positions', () => {
  const part = {
    id: 'S',
    measures: [
      { number: 1, beats: 4, notes: [{ startBeatInMeasure: 0, durationBeats: 2 }, { startBeatInMeasure: 2, durationBeats: 2 }] }
    ]
  };
  const layout = buildHorizontalScoreLayout([part]);
  assert(layout.beatToX(0) < layout.beatToX(2));
  assert(layout.beatToX(2) < layout.beatToX(4));
});

section('Notation renderer - viewport culling:');

test('cached tiles paint elements right after a tile seam', () => {
  assert.equal(isScoreElementVisible(2056, 2048, 2048, 170, true), true);
});

test('cached tiles include glyph overhang before a tile seam', () => {
  assert.equal(isScoreElementVisible(2028, 2048, 2048, 170, true), true);
});

test('a live viewport reserves the fixed clef and label gutter', () => {
  assert.equal(isScoreElementVisible(120, 0, 1200, 170, false), false);
  assert.equal(isScoreElementVisible(180, 0, 1200, 170, false), true);
});

section('Notation renderer - pitch feedback:');

test('a pitch close to the written note reads as correct', () => {
  assert.equal(classifyPitchAgainstTarget(10), 'correct');
  assert.equal(classifyPitchAgainstTarget(-18), 'correct');
});

test('a drifting pitch reads as close, then off', () => {
  assert.equal(classifyPitchAgainstTarget(45), 'close');
  assert.equal(classifyPitchAgainstTarget(140), 'off');
});

test('no target note means no judgement', () => {
  assert.equal(classifyPitchAgainstTarget(null), 'neutral');
});

test('hysteresis keeps vibrato from flickering between states', () => {
  // Already on pitch: a small wobble past the entry threshold stays correct.
  assert.equal(classifyPitchAgainstTarget(30, 'correct'), 'correct');
  // Coming from off, the same reading is not yet accepted as correct.
  assert.equal(classifyPitchAgainstTarget(30, 'off'), 'close');
});

section('Notation renderer - pitch timeline:');

function createPitchTimelineHarness(parts) {
  return {
    parts,
    pitchTimelineByPart: new Map(),
    findTimelineIndex: NotationRenderer.prototype.findTimelineIndex,
    findTimelineBoundary: NotationRenderer.prototype.findTimelineBoundary
  };
}

test('the timeline finds sounding notes and fermata-held notes', () => {
  const part = {
    id: 'P1',
    measures: [{
      startBeat: 0,
      notes: [
        {
          isRest: false,
          pitch: { step: 'C', alter: 0, octave: 4 },
          durationBeats: 1,
          startBeatInMeasure: 0,
          clef: { sign: 'G', line: 2 }
        },
        {
          isRest: false,
          pitch: { step: 'D', alter: 0, octave: 4 },
          durationBeats: 1,
          startBeatInMeasure: 1,
          fermata: { type: 'upright' },
          clef: { sign: 'F', line: 4 }
        }
      ]
    }]
  };
  const harness = createPitchTimelineHarness([part]);
  NotationRenderer.prototype.buildPitchTimelines.call(harness);

  const active = NotationRenderer.prototype.findTargetCandidates.call(harness, part, 0.5);
  const held = NotationRenderer.prototype.findTargetCandidates.call(harness, part, 2, true);
  const boundary = NotationRenderer.prototype.findTargetCandidates.call(harness, part, 2);

  assert.equal(active.length, 1);
  assert.equal(active[0].note.pitch.step, 'C');
  assert.equal(held[0].note.pitch.step, 'D');
  assert.equal(boundary[0].note.pitch.step, 'D');
});

test('the timeline resolves the clef in force at a beat', () => {
  const part = {
    id: 'P1',
    measures: [{
      startBeat: 0,
      notes: [
        { isRest: true, durationBeats: 1, startBeatInMeasure: 0, clef: { sign: 'G', line: 2 } },
        { isRest: true, durationBeats: 1, startBeatInMeasure: 1, clef: { sign: 'F', line: 4 } }
      ]
    }]
  };
  const harness = createPitchTimelineHarness([part]);
  NotationRenderer.prototype.buildPitchTimelines.call(harness);
  const clef = NotationRenderer.prototype.findClefAtBeat.call(
    harness, part, 1.5, { sign: 'G', line: 2 }
  );
  assert.equal(clef.sign, 'F');
  assert.equal(clef.line, 4);
});

/* ========================================================= pitch detection */

section('Pitch detection:');

/** Generate a steady sine tone for the detector tests. */
function sineBuffer(frequency, { sampleRate = 44100, length = 2048, amplitude = 0.5 } = {}) {
  const buffer = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buffer[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  }
  return buffer;
}

test('a 440 Hz sine wave is detected', () => {
  const detected = analysePitchYin(sineBuffer(440), 44100);
  assert(detected, 'should return an estimate');
  assert(approxEqual(detected.frequency, 440, 5), `expected ~440Hz, got ${detected.frequency}Hz`);
});

test('a 220 Hz sine wave is detected', () => {
  assert(approxEqual(analysePitchYin(sineBuffer(220), 44100).frequency, 220, 5));
});

test('a sung-like tone reports high confidence', () => {
  const sampleRate = 44100;
  const buffer = new Float32Array(4096);
  for (let i = 0; i < buffer.length; i++) {
    const phase = 2 * Math.PI * 196 * i / sampleRate;
    buffer[i] = 0.45 * Math.sin(phase) + 0.1 * Math.sin(phase * 2);
  }
  const result = analysePitchYin(buffer, sampleRate);
  assert(result, 'should return an estimate');
  assert(approxEqual(result.frequency, 196, 3));
  assert(result.confidence > 0.9, `expected high confidence, got ${result.confidence}`);
});

test('broadband noise is rejected', () => {
  const buffer = new Float32Array(4096);
  let seed = 123456789;
  for (let i = 0; i < buffer.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    buffer[i] = ((seed / 0x100000000) * 2 - 1) * 0.25;
  }
  assert.equal(analysePitchYin(buffer, 44100), null);
});

test('silence returns no pitch', () => {
  assert.equal(analysePitchYin(new Float32Array(2048), 44100), null);
});

test('a very quiet signal returns no pitch', () => {
  assert.equal(analysePitchYin(sineBuffer(440, { amplitude: 0.001 }), 44100), null);
});

test('an invalid sample rate is rejected', () => {
  assert.equal(analysePitchYin(sineBuffer(440), 0), null);
});

test('an octave jump is confirmed before it is shown', () => {
  const detector = new PitchDetector();
  assert(approxEqual(detector.stabiliseFrequency(220), 220, 0.01));
  assert.equal(detector.stabiliseFrequency(440), null);
  assert(approxEqual(detector.stabiliseFrequency(440), 440, 0.01));
});

test('clearing the stable pitch forgets the previous reading', () => {
  const detector = new PitchDetector();
  detector.stabiliseFrequency(220);
  detector.clearStablePitch();
  // Without history, a distant frequency is accepted immediately again.
  assert(approxEqual(detector.stabiliseFrequency(440), 440, 0.01));
});

section('Pitch detection - accuracy:');

test('accuracy is classified by distance', () => {
  assert.equal(classifyAccuracy(0), 'correct');
  assert.equal(classifyAccuracy(-30), 'correct');
  assert.equal(classifyAccuracy(75), 'close');
  assert.equal(classifyAccuracy(150), 'off');
});

/* =================================================== transport and exports */

section('Transport formatting:');

test('seconds are formatted as m:ss', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9), '0:09');
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(600), '10:00');
});

test('negative and invalid times fall back to zero', () => {
  assert.equal(formatTime(-5), '0:00');
  assert.equal(formatTime(NaN), '0:00');
});

test('the position is described for assistive technology', () => {
  assert.equal(describePosition(30, 210, 'bar 5'), '0:30 of 3:30, bar 5');
  assert.equal(describePosition(0, 60), '0:00 of 1:00');
});

section('Settings descriptions:');

test('a transposition is described the way a singer would say it', () => {
  assert.equal(describeTranspose(0), 'As written');
  assert.equal(describeTranspose(1), '1 semitone up');
  assert.equal(describeTranspose(-2), '2 semitones down');
  assert.equal(describeTranspose(12), 'An octave up');
  assert.equal(describeTranspose(-12), 'An octave down');
});

test('a count-in length is described in bars', () => {
  assert.equal(describeCountIn(0), 'Off');
  assert.equal(describeCountIn(1), '1 bar');
  assert.equal(describeCountIn(2), '2 bars');
});

test('the tuning reference is described in hertz', () => {
  assert.equal(describeTuning(440), 'A = 440 Hz');
  assert.equal(describeTuning(442), 'A = 442 Hz');
});

test('the shipped defaults are all present and usable', () => {
  assert.equal(isClickPattern(SETTINGS_DEFAULTS.clickPattern), true);
  assert.equal(SETTINGS_DEFAULTS.transpose, 0);
  assert.equal(SETTINGS_DEFAULTS.tuning, 440);
  assert.equal(SETTINGS_DEFAULTS.followDynamics, true);
  assert.equal(SETTINGS_DEFAULTS.playRepeats, true);
  assert(CLICK_PATTERNS.some(pattern => pattern.id === SETTINGS_DEFAULTS.clickPattern));
});

section('Export file names:');

test('score extensions are replaced, not appended', () => {
  assert.equal(getExportBaseName('Motet.musicxml'), 'Motet');
  assert.equal(getExportBaseName('Motet.mxl'), 'Motet');
  assert.equal(getExportBaseName('Motet.xml'), 'Motet');
});

test('a dotted name keeps its other dots', () => {
  assert.equal(getExportBaseName('Bach.BWV.227.musicxml'), 'Bach.BWV.227');
});

test('a missing name falls back to a default', () => {
  assert.equal(getExportBaseName(''), 'score');
  assert.equal(getExportBaseName(null), 'score');
});

/* ============================================================== tempo maps */

section('Tempo maps - normalising written markings:');

test('a map always starts at beat zero', () => {
  const map = buildTempoMap([{ beat: 8, bpm: 90 }], { baseTempo: 120 });
  assert.equal(map[0].beat, 0);
  assert.equal(map[0].bpm, 120);
  assert.equal(map[1].bpm, 90);
});

test('an empty map falls back to the base tempo', () => {
  assert.deepEqual(buildTempoMap([], { baseTempo: 96 }), [{ beat: 0, bpm: 96 }]);
});

test('a marking at beat zero becomes the opening tempo', () => {
  const map = buildTempoMap([{ beat: 0, bpm: 72 }], { baseTempo: 120 });
  assert.deepEqual(map, [{ beat: 0, bpm: 72 }]);
});

test('out-of-order markings are sorted', () => {
  const map = buildTempoMap([{ beat: 16, bpm: 60 }, { beat: 4, bpm: 90 }, { beat: 0, bpm: 120 }]);
  assert.deepEqual(map.map(entry => entry.beat), [0, 4, 16]);
});

test('the later of two markings on the same beat wins', () => {
  const map = buildTempoMap([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 80 }, { beat: 4, bpm: 100 }]);
  assert.equal(map[1].bpm, 100);
});

test('a marking that repeats the current tempo is dropped', () => {
  const map = buildTempoMap([{ beat: 0, bpm: 100 }, { beat: 4, bpm: 100 }, { beat: 8, bpm: 60 }]);
  assert.deepEqual(map.map(entry => entry.bpm), [100, 60]);
});

test('invalid entries are ignored', () => {
  const map = buildTempoMap([
    { beat: 0, bpm: 100 },
    { beat: -1, bpm: 80 },
    { beat: 4, bpm: 0 },
    { beat: NaN, bpm: 90 }
  ]);
  assert.deepEqual(map, [{ beat: 0, bpm: 100 }]);
});

section('Tempo maps - beats and seconds:');

const steadyTempo = constantTempoMap(120);
// Half speed from beat 8 onward: 4 beats at 120 then a slower section.
const changingTempo = compileTempoMap([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }]);

test('a constant map behaves like a single multiplication', () => {
  assert.equal(beatToSeconds(steadyTempo, 4), 2);
  assert.equal(secondsToBeat(steadyTempo, 2), 4);
  assert.equal(steadyTempo.isConstant, true);
});

test('seconds accumulate across a tempo change', () => {
  // 8 beats at 120 BPM is 4s; the next 4 beats at 60 BPM add another 4s.
  assert(approxEqual(beatToSeconds(changingTempo, 8), 4, 1e-9));
  assert(approxEqual(beatToSeconds(changingTempo, 12), 8, 1e-9));
});

test('the conversion round-trips in both directions', () => {
  for (const beat of [0, 3.5, 8, 9.25, 12]) {
    const seconds = beatToSeconds(changingTempo, beat);
    assert(
      approxEqual(secondsToBeat(changingTempo, seconds), beat, 1e-9),
      `beat ${beat} should survive the round trip`
    );
  }
});

test('the tempo in force is reported per beat', () => {
  assert.equal(tempoAtBeat(changingTempo, 0), 120);
  assert.equal(tempoAtBeat(changingTempo, 7.99), 120);
  assert.equal(tempoAtBeat(changingTempo, 8), 60);
  assert.equal(tempoAtBeat(changingTempo, 100), 60);
});

test('a beat before the start clamps to zero seconds', () => {
  assert.equal(beatToSeconds(changingTempo, -5), 0);
});

test('the rehearsal tempo becomes a scale on the written map', () => {
  assert.equal(tempoScale(60, 120), 0.5);
  assert.equal(tempoScale(120, 120), 1);
  // A written accelerando still accelerates when practised slowly.
  assert.equal(tempoScale(90, 120), 0.75);
});

test('an unusable scale falls back to unchanged', () => {
  assert.equal(tempoScale(0, 120), 1);
  assert.equal(tempoScale(120, 0), 1);
});

/* ====================================================== playback timeline */

section('Playback timeline - a straight-through score:');

/** Four bars of 4/4. */
function fourBars() {
  return [
    { startBeat: 0, beats: 4 },
    { startBeat: 4, beats: 4 },
    { startBeat: 8, beats: 4 },
    { startBeat: 12, beats: 4 }
  ];
}

const plainTimeline = buildPlaybackTimeline({
  measures: fourBars(),
  tempoMap: [{ beat: 0, bpm: 120 }]
});

test('score and playback positions agree when nothing repeats', () => {
  assert.equal(plainTimeline.totalScoreBeats, 16);
  assert.equal(plainTimeline.totalPlaybackBeats, 16);
  assert.equal(plainTimeline.isUnfolded, false);
  for (const beat of [0, 3.5, 10, 16]) {
    assert.equal(plainTimeline.playbackBeatToScoreBeat(beat), beat);
    assert.equal(plainTimeline.scoreBeatToPlaybackBeat(beat), beat);
  }
});

test('time follows a single tempo', () => {
  assert.equal(plainTimeline.beatToSeconds(0), 0);
  assert.equal(plainTimeline.beatToSeconds(4), 2);
  assert.equal(plainTimeline.totalSeconds, 8);
  assert.equal(plainTimeline.secondsToBeat(2), 4);
});

test('the rehearsal scale stretches the whole performance', () => {
  const timeline = buildPlaybackTimeline({
    measures: fourBars(),
    tempoMap: [{ beat: 0, bpm: 120 }]
  });
  timeline.setScale(0.5);
  assert.equal(timeline.totalSeconds, 16);
  assert.equal(timeline.tempoAtPlaybackBeat(0), 60);
  timeline.setScale(2);
  assert.equal(timeline.totalSeconds, 4);
  assert.equal(timeline.tempoAtPlaybackBeat(0), 240);
});

test('an unusable scale is ignored', () => {
  const timeline = buildPlaybackTimeline({ measures: fourBars() });
  timeline.setScale(0);
  assert.equal(timeline.scale, 1);
  timeline.setScale(NaN);
  assert.equal(timeline.scale, 1);
});

test('an empty score produces a usable empty timeline', () => {
  const timeline = buildPlaybackTimeline({});
  assert.equal(timeline.totalPlaybackBeats, 0);
  assert.equal(timeline.totalScoreBeats, 0);
  assert.equal(timeline.playbackBeatToScoreBeat(5), 0);
  assert.equal(timeline.totalSeconds, 0);
});

section('Playback timeline - fermata holds:');

const heldTimeline = buildPlaybackTimeline({
  measures: fourBars(),
  tempoMap: [{ beat: 0, bpm: 120 }],
  // The note ending at beat 4 is held for an extra four beats.
  fermataHolds: [{ scoreBeat: 4, extraBeats: 4 }]
});

test('a hold lengthens the performance without moving the score', () => {
  assert.equal(heldTimeline.totalScoreBeats, 16);
  assert.equal(heldTimeline.totalPlaybackBeats, 20);
});

test('the score position stands still through a hold', () => {
  assert.equal(heldTimeline.playbackBeatToScoreBeat(4), 4);
  assert.equal(heldTimeline.playbackBeatToScoreBeat(6), 4);
  assert.equal(heldTimeline.playbackBeatToScoreBeat(8), 4);
  assert.equal(heldTimeline.playbackBeatToScoreBeat(9), 5);
});

test('a hold is reported while it is being waited out', () => {
  assert.equal(heldTimeline.isHoldAtPlaybackBeat(3.9), false);
  assert.equal(heldTimeline.isHoldAtPlaybackBeat(6), true);
  assert.equal(heldTimeline.isHoldAtPlaybackBeat(8), false);
});

test('a score beat after a hold resumes later in the performance', () => {
  // The fermata is written on the note ending at beat 4, so seeking to beat 4
  // means the note that follows the hold, not the hold itself.
  assert.equal(heldTimeline.scoreBeatToPlaybackBeat(4), 8);
  assert.equal(heldTimeline.scoreBeatToPlaybackBeat(5), 9);
  // A note ending at beat 4 still stops before the hold begins.
  assert.equal(heldTimeline.endPlaybackBeat(0, 4), 4);
});

test('a hold takes real time at the prevailing tempo', () => {
  // Four extra beats at 120 BPM is two more seconds.
  assert.equal(heldTimeline.totalSeconds, 10);
});

section('Playback timeline - repeats:');

const repeatedTimeline = buildPlaybackTimeline({
  measures: fourBars().slice(0, 2),
  order: [0, 1, 0, 1],
  tempoMap: [{ beat: 0, bpm: 120 }]
});

test('a repeated section is performed twice', () => {
  assert.equal(repeatedTimeline.totalScoreBeats, 8);
  assert.equal(repeatedTimeline.totalPlaybackBeats, 16);
  assert.equal(repeatedTimeline.isUnfolded, true);
});

test('the cursor returns to the top of the repeat', () => {
  assert.equal(repeatedTimeline.playbackBeatToScoreBeat(7), 7);
  assert.equal(repeatedTimeline.playbackBeatToScoreBeat(8), 0);
  assert.equal(repeatedTimeline.playbackBeatToScoreBeat(9), 1);
});

test('a repeated bar has more than one moment in the performance', () => {
  assert.deepEqual(repeatedTimeline.occurrences(1), [1, 9]);
  assert.deepEqual(repeatedTimeline.occurrences(0), [0, 8]);
});

test('seeking picks the occurrence at or after the current position', () => {
  assert.equal(repeatedTimeline.scoreBeatToPlaybackBeat(1), 1);
  assert.equal(repeatedTimeline.scoreBeatToPlaybackBeat(1, { after: 5 }), 9);
  // Past the last occurrence, fall back to the first rather than nothing.
  assert.equal(repeatedTimeline.scoreBeatToPlaybackBeat(1, { after: 99 }), 1);
});

test('a repeat doubles the elapsed time', () => {
  assert.equal(repeatedTimeline.totalSeconds, 8);
});

test('a fermata inside a repeat is held on every pass', () => {
  const timeline = buildPlaybackTimeline({
    measures: fourBars().slice(0, 2),
    order: [0, 1, 0, 1],
    tempoMap: [{ beat: 0, bpm: 120 }],
    fermataHolds: [{ scoreBeat: 8, extraBeats: 2 }]
  });
  assert.equal(timeline.totalPlaybackBeats, 20);
  assert.equal(timeline.playbackBeatToScoreBeat(9), 8);
  assert.equal(timeline.playbackBeatToScoreBeat(10), 0);
});

section('Playback timeline - skipped bars:');

const voltaTimeline = buildPlaybackTimeline({
  measures: fourBars(),
  // Bars 1, 2 and 4: the third bar is a first-time-only ending.
  order: [0, 1, 3],
  tempoMap: [{ beat: 0, bpm: 120 }]
});

test('a skipped bar is left out of the performance', () => {
  assert.equal(voltaTimeline.totalScoreBeats, 16);
  assert.equal(voltaTimeline.totalPlaybackBeats, 12);
});

test('the cursor jumps over the skipped bar', () => {
  assert.equal(voltaTimeline.playbackBeatToScoreBeat(7), 7);
  assert.equal(voltaTimeline.playbackBeatToScoreBeat(8), 12);
  assert.equal(voltaTimeline.playbackBeatToScoreBeat(11), 15);
});

test('skipped score positions are reported', () => {
  assert.deepEqual(voltaTimeline.unperformedRanges(), [{ scoreStart: 8, scoreEnd: 12 }]);
  assert.deepEqual(voltaTimeline.occurrences(9), []);
});

test('seeking into a skipped bar lands on the nearest performed moment', () => {
  assert.equal(voltaTimeline.scoreBeatToPlaybackBeat(9), 8);
});

test('a score with nothing skipped reports no gaps', () => {
  assert.deepEqual(plainTimeline.unperformedRanges(), []);
  assert(plainTimeline instanceof PlaybackTimeline);
});

section('Playback timeline - tempo changes:');

const movingTimeline = buildPlaybackTimeline({
  measures: fourBars().slice(0, 2),
  tempoMap: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]
});

test('each section runs at its own written tempo', () => {
  assert.equal(movingTimeline.tempoAtPlaybackBeat(0), 120);
  assert.equal(movingTimeline.tempoAtPlaybackBeat(5), 60);
});

test('elapsed time accumulates across the change', () => {
  // Four beats at 120 is 2s; the next four at 60 add 4s.
  assert.equal(movingTimeline.beatToSeconds(4), 2);
  assert.equal(movingTimeline.totalSeconds, 6);
  assert.equal(movingTimeline.secondsToBeat(2), 4);
  assert.equal(movingTimeline.secondsToBeat(6), 8);
});

test('a note straddling a tempo change takes time from both sides', () => {
  // Two beats from beat 3: one at 120 (0.5s) and one at 60 (1s).
  assert(approxEqual(movingTimeline.durationSeconds(3, 2), 1.5, 1e-9));
  assert(approxEqual(movingTimeline.durationSeconds(0, 4), 2, 1e-9));
});

test('a tempo change inside a repeat applies on every pass', () => {
  const timeline = buildPlaybackTimeline({
    measures: fourBars().slice(0, 2),
    order: [0, 1, 0, 1],
    tempoMap: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]
  });
  assert.equal(timeline.totalSeconds, 12);
  assert.equal(timeline.tempoAtPlaybackBeat(9), 120);
  assert.equal(timeline.tempoAtPlaybackBeat(13), 60);
});

test('a held fermata runs at the tempo written where it sits', () => {
  const timeline = buildPlaybackTimeline({
    measures: fourBars().slice(0, 2),
    tempoMap: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }],
    fermataHolds: [{ scoreBeat: 8, extraBeats: 2 }]
  });
  // The hold sits in the 60 BPM section, so two beats cost two seconds.
  assert.equal(timeline.totalSeconds, 8);
});

test('the conversion round-trips with a scale applied', () => {
  const timeline = buildPlaybackTimeline({
    measures: fourBars(),
    tempoMap: [{ beat: 0, bpm: 120 }, { beat: 6, bpm: 200 }],
    fermataHolds: [{ scoreBeat: 10, extraBeats: 3 }]
  });
  timeline.setScale(0.8);
  for (const beat of [0, 2.5, 6, 9.75, 13, 19]) {
    const seconds = timeline.beatToSeconds(beat);
    assert(
      approxEqual(timeline.secondsToBeat(seconds), beat, 1e-9),
      `playback beat ${beat} should survive the round trip`
    );
  }
});

/* ================================================================= repeats */

section('Repeat structure:');

/** Describe a measure by the barline markings on it. */
function repeatMeasure(barlines = []) {
  return { barlines };
}

function forwardRepeat() {
  return { location: 'left', style: 'heavy-light', repeat: { direction: 'forward', times: null }, ending: null };
}

function backwardRepeat(times = null) {
  return { location: 'right', style: 'light-heavy', repeat: { direction: 'backward', times }, ending: null };
}

function endingStart(numbers) {
  return { location: 'left', style: null, repeat: null, ending: { numbers, type: 'start' } };
}

function endingStop(numbers) {
  return { location: 'right', style: null, repeat: null, ending: { numbers, type: 'stop' } };
}

test('a score with no repeats is performed straight through', () => {
  const plan = buildRepeatPlan([repeatMeasure(), repeatMeasure(), repeatMeasure()]);
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.equal(plan.hasRepeats, false);
  assert.equal(isStraightThrough(plan.order, 3), true);
});

test('a backward repeat with no forward sign repeats from the start', () => {
  const plan = buildRepeatPlan([
    repeatMeasure(),
    repeatMeasure([backwardRepeat()]),
    repeatMeasure()
  ]);
  assert.deepEqual(plan.order, [0, 1, 0, 1, 2]);
  assert.equal(plan.hasRepeats, true);
});

test('a forward repeat marks where the repeat returns to', () => {
  const plan = buildRepeatPlan([
    repeatMeasure(),
    repeatMeasure([forwardRepeat()]),
    repeatMeasure([backwardRepeat()]),
    repeatMeasure()
  ]);
  assert.deepEqual(plan.order, [0, 1, 2, 1, 2, 3]);
});

test('a repeat count greater than two is honoured', () => {
  const plan = buildRepeatPlan([
    repeatMeasure([forwardRepeat()]),
    repeatMeasure([backwardRepeat(3)])
  ]);
  assert.deepEqual(plan.order, [0, 1, 0, 1, 0, 1]);
});

test('numbered endings are sung on their own passes only', () => {
  // |: A | 1. B :| 2. C |
  const plan = buildRepeatPlan([
    repeatMeasure([forwardRepeat()]),
    repeatMeasure([endingStart([1]), endingStop([1]), backwardRepeat()]),
    repeatMeasure([endingStart([2]), endingStop([2])])
  ]);
  assert.deepEqual(plan.order, [0, 1, 0, 2]);
});

test('an ending spanning several bars is skipped whole', () => {
  const plan = buildRepeatPlan([
    repeatMeasure([forwardRepeat()]),
    repeatMeasure([endingStart([1])]),
    repeatMeasure([endingStop([1]), backwardRepeat()]),
    repeatMeasure([endingStart([2])]),
    repeatMeasure([endingStop([2])])
  ]);
  assert.deepEqual(plan.order, [0, 1, 2, 0, 3, 4]);
});

test('an ending listed for both passes is sung twice', () => {
  const plan = buildRepeatPlan([
    repeatMeasure([forwardRepeat()]),
    repeatMeasure([endingStart([1, 2]), endingStop([1, 2]), backwardRepeat()])
  ]);
  assert.deepEqual(plan.order, [0, 1, 0, 1]);
});

test('repeat jumps that are not expanded are reported', () => {
  const plan = buildRepeatPlan([
    repeatMeasure(),
    { barlines: [], navigation: ['dacapo'] }
  ]);
  assert.deepEqual(plan.navigationMarks, ['dacapo']);
});

test('a runaway repeat structure is capped rather than hanging', () => {
  const plan = buildRepeatPlan(
    [repeatMeasure([forwardRepeat()]), repeatMeasure([backwardRepeat(9999)])],
    { maxMeasures: 20 }
  );
  assert.equal(plan.truncated, true);
  assert.equal(plan.order.length, 20);
});

test('an empty score produces an empty plan', () => {
  const plan = buildRepeatPlan([]);
  assert.deepEqual(plan.order, []);
  assert.equal(plan.hasRepeats, false);
});

test('performance order collapses into contiguous runs', () => {
  assert.deepEqual(groupIntoRuns([0, 1, 2, 1, 2, 3]), [
    { startIndex: 0, endIndex: 2, length: 3 },
    { startIndex: 1, endIndex: 3, length: 3 }
  ]);
  assert.deepEqual(groupIntoRuns([]), []);
});

test('a reordered performance is not straight through', () => {
  assert.equal(isStraightThrough([0, 1, 0, 1], 2), false);
  assert.equal(isStraightThrough([0, 1], 2), true);
});

/* ================================================================ dynamics */

section('Dynamics - reading markings:');

test('standard markings map to increasing levels', () => {
  const order = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];
  for (let index = 1; index < order.length; index++) {
    assert(
      DYNAMIC_VELOCITIES[order[index]] > DYNAMIC_VELOCITIES[order[index - 1]],
      `${order[index]} should be louder than ${order[index - 1]}`
    );
  }
});

test('a dynamics element is read from its child names', () => {
  assert.equal(interpretDynamicNames(['mf']).velocity, DYNAMIC_VELOCITIES.mf);
  assert.equal(interpretDynamicNames(['pp']).velocity, DYNAMIC_VELOCITIES.pp);
});

test('sforzando is an emphasis, not a level', () => {
  const result = interpretDynamicNames(['sfz']);
  assert.equal(result.velocity, null);
  assert(result.accent > 1);
});

test('forte-piano lands loud then settles quiet', () => {
  const result = interpretDynamicNames(['fp']);
  assert.equal(result.velocity, DYNAMIC_VELOCITIES.f);
  assert.equal(result.settle, DYNAMIC_VELOCITIES.p);
});

test('a non-standard marking falls back to its text', () => {
  assert.equal(interpretDynamicNames(['other-dynamics'], 'ff').velocity, DYNAMIC_VELOCITIES.ff);
});

test('an unreadable marking yields nothing', () => {
  const result = interpretDynamicNames(['wibble'], 'louder please');
  assert.equal(result.velocity, null);
  assert.equal(result.accent, null);
});

test('a sound element percentage converts to a level', () => {
  const quiet = velocityFromSoundDynamics(40);
  const loud = velocityFromSoundDynamics(120);
  assert(quiet < loud);
  assert(quiet > 0 && loud <= 1);
  assert.equal(velocityFromSoundDynamics(0), null);
  assert.equal(velocityFromSoundDynamics('nonsense'), null);
});

test('a hairpin with no destination moves one standard level', () => {
  assert.equal(stepLevel(DYNAMIC_VELOCITIES.p, 'crescendo'), DYNAMIC_VELOCITIES.mp);
  assert.equal(stepLevel(DYNAMIC_VELOCITIES.mf, 'diminuendo'), DYNAMIC_VELOCITIES.mp);
});

test('stepping past the ends of the range clamps', () => {
  assert.equal(stepLevel(DYNAMIC_VELOCITIES.fff, 'crescendo'), DYNAMIC_VELOCITIES.fff);
  assert.equal(stepLevel(DYNAMIC_VELOCITIES.ppp, 'diminuendo'), DYNAMIC_VELOCITIES.ppp);
});

section('Dynamics - the loudness timeline:');

test('a score with no markings sings at one level', () => {
  const timeline = buildDynamicsTimeline({});
  assert.equal(velocityAt(timeline, 0), DEFAULT_VELOCITY);
  assert.equal(velocityAt(timeline, 100), DEFAULT_VELOCITY);
});

test('a marking holds until the next one', () => {
  const timeline = buildDynamicsTimeline({
    marks: [
      { beat: 0, velocity: DYNAMIC_VELOCITIES.p },
      { beat: 8, velocity: DYNAMIC_VELOCITIES.f }
    ]
  });
  assert.equal(velocityAt(timeline, 0), DYNAMIC_VELOCITIES.p);
  assert.equal(velocityAt(timeline, 7.9), DYNAMIC_VELOCITIES.p);
  assert.equal(velocityAt(timeline, 8), DYNAMIC_VELOCITIES.f);
  assert.equal(velocityAt(timeline, 40), DYNAMIC_VELOCITIES.f);
});

test('a hairpin ramps between the markings at each end', () => {
  const timeline = buildDynamicsTimeline({
    marks: [
      { beat: 0, velocity: DYNAMIC_VELOCITIES.p },
      { beat: 8, velocity: DYNAMIC_VELOCITIES.f }
    ],
    wedges: [{ startBeat: 0, endBeat: 8, type: 'crescendo' }]
  });
  const midpoint = velocityAt(timeline, 4);
  assert(
    midpoint > DYNAMIC_VELOCITIES.p && midpoint < DYNAMIC_VELOCITIES.f,
    `expected a level between p and f, got ${midpoint}`
  );
  assert(approxEqual(
    midpoint,
    (DYNAMIC_VELOCITIES.p + DYNAMIC_VELOCITIES.f) / 2,
    1e-6
  ));
});

test('a hairpin with no destination still gets louder', () => {
  const timeline = buildDynamicsTimeline({
    marks: [{ beat: 0, velocity: DYNAMIC_VELOCITIES.mp }],
    wedges: [{ startBeat: 4, endBeat: 8, type: 'crescendo' }]
  });
  assert.equal(velocityAt(timeline, 4), DYNAMIC_VELOCITIES.mp);
  assert(velocityAt(timeline, 8) > DYNAMIC_VELOCITIES.mp);
});

test('a diminuendo gets quieter', () => {
  const timeline = buildDynamicsTimeline({
    marks: [{ beat: 0, velocity: DYNAMIC_VELOCITIES.f }],
    wedges: [{ startBeat: 0, endBeat: 4, type: 'diminuendo' }]
  });
  assert(velocityAt(timeline, 4) < DYNAMIC_VELOCITIES.f);
});

test('forte-piano drops shortly after its attack', () => {
  const timeline = buildDynamicsTimeline({
    marks: [{ beat: 4, velocity: DYNAMIC_VELOCITIES.f, settle: DYNAMIC_VELOCITIES.p }]
  });
  assert.equal(velocityAt(timeline, 4), DYNAMIC_VELOCITIES.f);
  assert.equal(velocityAt(timeline, 5), DYNAMIC_VELOCITIES.p);
});

test('a mark with no settle level does not fall silent', () => {
  // Number(null) is 0, so an unguarded finite check would write near-silence.
  const timeline = buildDynamicsTimeline({
    marks: [{ beat: 0, velocity: DYNAMIC_VELOCITIES.p, settle: null }]
  });
  assert.equal(timeline.nodes.length, 1);
  assert.equal(velocityAt(timeline, 2), DYNAMIC_VELOCITIES.p);
});

test('a mark with no level at all is skipped', () => {
  const timeline = buildDynamicsTimeline({
    marks: [{ beat: 4, velocity: null, settle: null }]
  });
  assert.equal(velocityAt(timeline, 4), DEFAULT_VELOCITY);
});

test('a zero-length hairpin is ignored', () => {
  const timeline = buildDynamicsTimeline({
    marks: [{ beat: 0, velocity: DYNAMIC_VELOCITIES.mf }],
    wedges: [{ startBeat: 4, endBeat: 4, type: 'crescendo' }]
  });
  assert.equal(velocityAt(timeline, 4), DYNAMIC_VELOCITIES.mf);
});

test('levels stay inside the usable envelope range', () => {
  const timeline = buildDynamicsTimeline({
    marks: [{ beat: 0, velocity: 99 }, { beat: 4, velocity: -3 }]
  });
  assert(velocityAt(timeline, 0) <= 1);
  assert(velocityAt(timeline, 4) > 0);
});

section('Dynamics - reading a part:');

/** A part whose directions carry a piano, a hairpin, and a closing forte. */
function dynamicPart() {
  return {
    id: 'S',
    measures: [
      {
        startBeat: 0,
        beats: 4,
        notes: [],
        directions: [{ startBeatInMeasure: 0, dynamics: { velocity: DYNAMIC_VELOCITIES.p } }]
      },
      {
        startBeat: 4,
        beats: 4,
        notes: [],
        directions: [{ startBeatInMeasure: 0, wedge: { type: 'crescendo', number: 1 } }]
      },
      {
        startBeat: 8,
        beats: 4,
        notes: [],
        directions: [
          { startBeatInMeasure: 0, wedge: { type: 'stop', number: 1 } },
          { startBeatInMeasure: 0, dynamics: { velocity: DYNAMIC_VELOCITIES.f } }
        ]
      }
    ]
  };
}

test('markings and hairpins are read from a part in score order', () => {
  const { marks, wedges } = collectPartDynamics(dynamicPart());
  assert.deepEqual(marks.map(mark => mark.beat), [0, 8]);
  assert.deepEqual(wedges, [{ startBeat: 4, endBeat: 8, type: 'crescendo' }]);
});

test('a part timeline grows from piano to forte across the hairpin', () => {
  const timeline = buildPartDynamics(dynamicPart());
  assert.equal(velocityAt(timeline, 0), DYNAMIC_VELOCITIES.p);
  assert(velocityAt(timeline, 6) > DYNAMIC_VELOCITIES.p);
  assert.equal(velocityAt(timeline, 8), DYNAMIC_VELOCITIES.f);
});

test('a hairpin left open runs to the end of the music', () => {
  const part = {
    id: 'S',
    measures: [
      {
        startBeat: 0,
        beats: 4,
        notes: [],
        directions: [{ startBeatInMeasure: 0, wedge: { type: 'diminuendo', number: 1 } }]
      },
      { startBeat: 4, beats: 4, notes: [], directions: [] }
    ]
  };
  const { wedges } = collectPartDynamics(part);
  assert.deepEqual(wedges, [{ startBeat: 0, endBeat: 8, type: 'diminuendo' }]);
});

test('a part with no directions reports nothing to apply', () => {
  const { marks, wedges, accents } = collectPartDynamics({ measures: [{ startBeat: 0, beats: 4 }] });
  assert.deepEqual(marks, []);
  assert.deepEqual(wedges, []);
  assert.deepEqual(accents, []);
});

test('a sforzando direction is collected as an emphasis', () => {
  const part = {
    measures: [{
      startBeat: 0,
      beats: 4,
      directions: [{ startBeatInMeasure: 2, dynamics: { accent: 1.4 } }]
    }]
  };
  const { accents, marks } = collectPartDynamics(part);
  assert.deepEqual(accents, [{ beat: 2, multiplier: 1.4 }]);
  assert.deepEqual(marks, []);
});

section('Dynamics - note emphasis:');

test('an unmarked note is not emphasised', () => {
  assert.equal(accentMultiplier({}), 1);
});

test('accents make a note stronger', () => {
  assert(accentMultiplier({ accent: true }) > 1);
  assert(accentMultiplier({ strongAccent: true }) > accentMultiplier({ accent: true }));
});

test('an absent sforzando does not cancel the written accent', () => {
  // Number(null) is 0, so an unguarded finite check would multiply it away.
  assert.equal(
    accentMultiplier({ accent: true, accentVelocity: null }),
    accentMultiplier({ accent: true })
  );
  assert(accentMultiplier({ accent: true, accentVelocity: null }) > 1);
});

test('stacked emphasis is capped', () => {
  const stacked = accentMultiplier({
    accent: true,
    strongAccent: true,
    tenuto: true,
    accentVelocity: 1.5
  });
  assert(stacked <= 1.6, `expected a cap, got ${stacked}`);
});

/* ============================================== positioned directions */

section('Measure layout - directions:');

test('a direction takes the beat the cursor is on', () => {
  const events = [
    { kind: 'note', duration: 1, type: 'quarter' },
    { kind: 'direction', offset: 0, words: 'dolce' },
    { kind: 'note', duration: 1, type: 'quarter' }
  ];
  const { directions, beats } = layoutMeasure(events, 1);
  assert.equal(directions.length, 1);
  assert.equal(directions[0].startBeatInMeasure, 1);
  assert.equal(directions[0].words, 'dolce');
  // A direction sounds instantly and must not extend the bar.
  assert.equal(beats, 2);
});

test('a direction offset shifts where it applies', () => {
  const events = [
    { kind: 'direction', offset: 2, wedge: { type: 'crescendo', number: 1 } },
    { kind: 'note', duration: 4, type: 'whole' }
  ];
  const { directions } = layoutMeasure(events, 1);
  assert.equal(directions[0].startBeatInMeasure, 2);
});

test('a direction after a backup lands with the voice it belongs to', () => {
  const events = [
    { kind: 'note', duration: 4, type: 'whole', voice: 1 },
    { kind: 'backup', duration: 4 },
    { kind: 'direction', offset: 0, dynamics: { velocity: 0.4 } },
    { kind: 'note', duration: 4, type: 'whole', voice: 2 }
  ];
  const { directions } = layoutMeasure(events, 1);
  assert.equal(directions[0].startBeatInMeasure, 0);
});

test('a negative resolved position is clamped to the bar start', () => {
  const events = [{ kind: 'direction', offset: -8, words: 'rit.' }];
  const { directions } = layoutMeasure(events, 1);
  assert.equal(directions[0].startBeatInMeasure, 0);
});

/* ================================================================ summary */

console.log('\n=== Results ===');
console.log(`  Total: ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}\n`);

if (failed > 0) {
  process.exit(1);
}
console.log('All tests passed!');
