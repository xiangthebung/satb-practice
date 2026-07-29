/**
 * Parser integration tests.
 *
 * The unit suite deliberately has no dependencies, which means it can only test
 * the parser's pure helpers. This file supplies a DOM so the whole parse can run
 * against the real sample scores and against a synthetic score written to
 * exercise the features that the samples happen not to contain.
 *
 * Run with: node tests/parse-samples.js
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

import { parseMusicXML } from '../public/js/musicxml-parser.js';
import {
  DEFAULT_VELOCITY,
  buildDynamicsTimeline,
  collectPartDynamics,
  velocityAt
} from '../public/js/dynamics.js';
import { compileTempoMap, beatToSeconds } from '../public/js/tempo-map.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SAMPLES = join(ROOT, 'public', 'sample-pieces');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Parse MusicXML text through a Node DOM. */
function parse(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return parseMusicXML(xml, doc);
}

console.log('=== Choir Practice - Parser Integration ===');

/* --------------------------------------------------------- bundled samples */

section('Bundled sample scores:');

const sampleFiles = readdirSync(SAMPLES).filter(name => /\.(musicxml|xml)$/i.test(name));

test('every bundled sample is listed', () => {
  assert(sampleFiles.length >= 3, `expected at least 3 samples, found ${sampleFiles.length}`);
});

const parsedSamples = new Map();

for (const fileName of sampleFiles) {
  test(`${fileName} parses into singable parts`, () => {
    const result = parse(readFileSync(join(SAMPLES, fileName), 'utf8'));
    parsedSamples.set(fileName, result);

    assert(result.parts.length > 0, 'should find at least one part');
    assert(result.metadata.title, 'should read a title');

    for (const part of result.parts) {
      assert(part.id, 'every part needs an id');
      assert(Array.isArray(part.measures), 'every part needs measures');
      assert(part.measures.length > 0, `${part.name} should have measures`);
    }
  });
}

test('measure positions are shared across every part', () => {
  for (const [fileName, result] of parsedSamples) {
    const reference = result.parts[0].measures.map(measure => measure.startBeat);
    for (const part of result.parts) {
      const starts = part.measures.map(measure => measure.startBeat);
      assert.deepEqual(
        starts, reference,
        `${fileName}: ${part.name} should share the measure grid`
      );
    }
  }
});

test('every score reports a tempo map beginning at beat zero', () => {
  for (const [fileName, result] of parsedSamples) {
    const map = result.metadata.tempoMap;
    assert(Array.isArray(map) && map.length > 0, `${fileName}: expected a tempo map`);
    assert.equal(map[0].beat, 0, `${fileName}: the map must start at beat 0`);
    assert(map[0].bpm > 0, `${fileName}: opening tempo must be positive`);
    assert.equal(result.metadata.baseTempo, map[0].bpm);
    // The single-value field is kept for older call sites.
    assert.equal(result.metadata.tempo, map[0].bpm);
  }
});

test('every score reports a performance order', () => {
  for (const [fileName, result] of parsedSamples) {
    const plan = result.metadata.repeatPlan;
    assert(Array.isArray(plan.order), `${fileName}: expected a performance order`);
    assert.equal(
      plan.order.length, result.metadata.measureStructure.length,
      `${fileName}: without repeats, every bar is performed once`
    );
  }
});

test('every score reports a feature summary', () => {
  for (const [fileName, result] of parsedSamples) {
    const features = result.metadata.features;
    assert(features, `${fileName}: expected a feature summary`);
    assert.equal(typeof features.hasDynamics, 'boolean');
    assert.equal(typeof features.hasRepeats, 'boolean');
    assert(features.measureCount > 0, `${fileName}: expected a measure count`);
    assert(Array.isArray(features.unperformed));
  }
});

test('lyrics are read from the samples that have them', () => {
  let scoresWithLyrics = 0;
  for (const result of parsedSamples.values()) {
    const hasLyrics = result.parts.some(part =>
      part.measures.some(measure => measure.notes.some(note => note.lyrics?.length))
    );
    if (hasLyrics) scoresWithLyrics++;
  }
  assert(scoresWithLyrics > 0, 'at least one sample should carry lyrics');
});

test('the sample with printed dynamics is recognised', () => {
  const stanford = parsedSamples.get('Quick! We have but a second.musicxml');
  assert(stanford, 'expected the Stanford sample to be present');
  assert.equal(
    stanford.metadata.features.hasDynamics, true,
    'this score prints dynamics, so they must be parsed'
  );

  // The markings must also produce a loudness curve that actually varies.
  const part = stanford.parts.find(candidate => {
    const { marks } = collectPartDynamics(candidate);
    return marks.length > 0;
  });
  assert(part, 'at least one part should carry the dynamic markings');

  const { marks, wedges } = collectPartDynamics(part);
  const timeline = buildDynamicsTimeline({ marks, wedges });
  const levels = new Set(timeline.nodes.map(node => node.velocity.toFixed(4)));
  assert(levels.size > 1, 'the score should not play at a single flat level');
});

test('an octave-transposing clef is preserved', () => {
  const draw = parsedSamples.get('Draw On, Sweet Night.musicxml');
  assert(draw, 'expected the Wilbye sample to be present');
  const octaveClefs = draw.parts.filter(part => part.clef?.octaveChange === -1);
  assert(
    octaveClefs.length > 0,
    'the tenor line is written with an octave-down clef and must keep it'
  );
});

/* ------------------------------------------------------- synthetic coverage */

section('Synthetic score - features the samples do not contain:');

/** Build one measure of MusicXML. */
function measureXml(number, body, attributes = '') {
  return `<measure number="${number}"${attributes}>${body}</measure>`;
}

// A whole note lasts four quarters, so at four divisions per quarter its
// <duration> is sixteen.
const WHOLE_NOTE_DURATION = 16;
const NOTE = (step, octave, duration = WHOLE_NOTE_DURATION, extra = '') =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
  `<duration>${duration}</duration><type>whole</type>${extra}</note>`;

const REPEAT_SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Structure Test</work-title></work>
  <identification>
    <creator type="composer">A. Composer</creator>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    ${measureXml(1, `
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type>
        <sound tempo="90"/>
      </direction>
      <direction placement="below">
        <direction-type><dynamics><p/></dynamics></direction-type>
      </direction>
      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>
      ${NOTE('C', 5, WHOLE_NOTE_DURATION, `
        <lyric number="1"><syllabic>single</syllabic><text>One</text></lyric>
        <lyric number="2"><syllabic>single</syllabic><text>Two</text></lyric>
      `)}
    `)}
    ${measureXml(2, `
      <direction placement="below">
        <direction-type><wedge type="crescendo" number="1"/></direction-type>
      </direction>
      ${NOTE('D', 5)}
    `)}
    ${measureXml(3, `
      <direction placement="below">
        <direction-type><wedge type="stop" number="1"/></direction-type>
      </direction>
      <direction placement="below">
        <direction-type><dynamics><ff/></dynamics></direction-type>
      </direction>
      <direction placement="above">
        <direction-type><words>rit.</words></direction-type>
        <sound tempo="60"/>
      </direction>
      <barline location="left"><ending number="1" type="start"/></barline>
      ${NOTE('E', 5, WHOLE_NOTE_DURATION, '<notations><articulations><accent/></articulations></notations>')}
      <barline location="right">
        <bar-style>light-heavy</bar-style>
        <ending number="1" type="stop"/>
        <repeat direction="backward"/>
      </barline>
    `)}
    ${measureXml(4, `
      <barline location="left"><ending number="2" type="start"/></barline>
      ${NOTE('F', 5, WHOLE_NOTE_DURATION, '<notations><fermata type="upright"/></notations>')}
      <barline location="right"><bar-style>light-heavy</bar-style><ending number="2" type="stop"/></barline>
    `)}
  </part>
  <part id="P2">
    ${measureXml(1, `
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
        <transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>
      </attributes>
      <barline location="left"><repeat direction="forward"/></barline>
      ${NOTE('C', 3)}
    `)}
    ${measureXml(2, NOTE('G', 2))}
    ${measureXml(3, `
      <barline location="left"><ending number="1" type="start"/></barline>
      ${NOTE('C', 3)}
      <barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>
    `)}
    ${measureXml(4, `
      <barline location="left"><ending number="2" type="start"/></barline>
      ${NOTE('C', 3)}
      <barline location="right"><ending number="2" type="stop"/></barline>
    `)}
  </part>
</score-partwise>`;

const structured = parse(REPEAT_SCORE);

test('the score metadata is read', () => {
  assert.equal(structured.metadata.title, 'Structure Test');
  assert.equal(structured.metadata.composer, 'A. Composer');
  assert.equal(structured.parts.length, 2);
});

test('a metronome mark sets the opening tempo', () => {
  assert.equal(structured.metadata.baseTempo, 90);
});

test('a later tempo direction becomes a tempo change', () => {
  const map = structured.metadata.tempoMap;
  assert.equal(map.length, 2, `expected two tempo entries, got ${map.length}`);
  assert.equal(map[0].bpm, 90);
  assert.equal(map[1].bpm, 60);
  // Bar 3 begins at beat 8 in 4/4.
  assert.equal(map[1].beat, 8);
  assert.equal(structured.metadata.features.hasTempoChanges, true);
});

test('the tempo change is reflected in elapsed time', () => {
  const compiled = compileTempoMap(structured.metadata.tempoMap);
  // Two bars at 90 BPM: 8 beats * (60/90) = 5.333s.
  assert(Math.abs(beatToSeconds(compiled, 8) - 8 * (60 / 90)) < 1e-9);
  // The third bar runs at 60 BPM, so it takes a full 4 seconds.
  assert(Math.abs(beatToSeconds(compiled, 12) - (8 * (60 / 90) + 4)) < 1e-9);
});

test('repeat barlines are read from the score', () => {
  const structure = structured.metadata.measureStructure;
  assert.equal(structure.length, 4);
  const forward = structure[0].barlines.find(barline => barline.repeat?.direction === 'forward');
  const backward = structure[2].barlines.find(barline => barline.repeat?.direction === 'backward');
  assert(forward, 'bar 1 should open a repeat');
  assert(backward, 'bar 3 should close it');
});

test('barline styles are preserved for drawing', () => {
  const structure = structured.metadata.measureStructure;
  assert.equal(structure[0].barlines[0].style, 'heavy-light');
  assert(structure[3].barlines.some(barline => barline.style === 'light-heavy'));
});

test('the repeat is expanded with its numbered endings', () => {
  const plan = structured.metadata.repeatPlan;
  assert.equal(plan.hasRepeats, true);
  // Bars 1-2-3, back to 1-2, then the second ending in bar 4.
  assert.deepEqual(plan.order, [0, 1, 2, 0, 1, 3]);
  assert.equal(structured.metadata.features.repeatsExpanded, true);
});

test('both verses of the lyrics are kept', () => {
  const soprano = structured.parts[0];
  const note = soprano.measures[0].notes.find(candidate => candidate.lyrics?.length);
  assert(note, 'the first note should carry lyrics');
  assert.equal(note.lyrics.length, 2);
  assert.deepEqual(note.lyrics.map(lyric => lyric.text), ['One', 'Two']);
  // The single-verse field still points at the first verse.
  assert.equal(note.lyric.text, 'One');
  assert.equal(structured.metadata.features.verseCount, 2);
  assert.equal(structured.metadata.features.hasMultipleVerses, true);
});

test('dynamics and hairpins are positioned on the timeline', () => {
  const soprano = structured.parts[0];
  const { marks, wedges } = collectPartDynamics(soprano);

  assert.equal(marks.length, 2, `expected p and ff, got ${marks.length}`);
  assert.equal(marks[0].beat, 0);
  assert.equal(marks[1].beat, 8);
  assert.equal(wedges.length, 1);
  assert.equal(wedges[0].startBeat, 4);
  assert.equal(wedges[0].endBeat, 8);
  assert.equal(wedges[0].type, 'crescendo');

  const timeline = buildDynamicsTimeline({ marks, wedges });
  const opening = velocityAt(timeline, 0);
  const middle = velocityAt(timeline, 6);
  const loud = velocityAt(timeline, 8);
  assert(opening < middle, 'the hairpin should be growing by bar 2');
  assert(middle < loud, 'the hairpin should arrive at the ff');
  assert(opening < DEFAULT_VELOCITY, 'a piano marking should sit below the default');
});

test('an accent is preserved on its note', () => {
  const soprano = structured.parts[0];
  const accented = soprano.measures[2].notes.find(note => note.accent);
  assert(accented, 'bar 3 should carry an accented note');
});

test('a fermata is still recognised alongside the new markings', () => {
  const soprano = structured.parts[0];
  assert(soprano.measures[3].notes.some(note => note.fermata));
});

test('a transposing part records its semitone offset', () => {
  const bass = structured.parts[1];
  assert(bass.transpose, 'the bass part declares a transposition');
  assert.equal(bass.transpose.semitones, -12);
  assert.equal(structured.metadata.features.hasTranspose, true);
});

test('a part with no transposition reports none', () => {
  assert.equal(structured.parts[0].transpose, null);
});

test('words directions are captured for display', () => {
  const soprano = structured.parts[0];
  const words = soprano.measures[2].directions.find(direction => direction.words);
  assert(words, 'the rit. marking should be readable');
  assert.equal(words.words, 'rit.');
});

/* --------------------------------------------------- navigation and pickups */

section('Synthetic score - pickup bars and unexpanded jumps:');

const JUMP_SCORE = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Alto</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
      <direction><sound dacapo="yes"/></direction>
    </measure>
  </part>
</score-partwise>`;

const jumps = parse(JUMP_SCORE);

test('a pickup bar is flagged and keeps its own length', () => {
  const alto = jumps.parts[0];
  assert.equal(alto.measures[0].isPickup, true);
  assert.equal(alto.measures[0].beats, 1);
  assert.equal(alto.measures[1].startBeat, 1);
});

test('a repeat jump is reported rather than silently ignored', () => {
  assert.deepEqual(jumps.metadata.repeatPlan.navigationMarks, ['dacapo']);
  assert(
    jumps.metadata.features.unperformed.some(item => /D\.C\./.test(item)),
    'the app must be able to tell the singer this jump is not played'
  );
});

/* ------------------------------------------------------------------ summary */

console.log('\n=== Results ===');
console.log(`  Total: ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}\n`);

if (failed > 0) process.exit(1);
console.log('All parser integration tests passed!');
