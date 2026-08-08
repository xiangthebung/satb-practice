/**
 * A score where two voices share a staff, built for the browser tests.
 *
 * This is the awkward engraving case: two parts, each a compound "X / Y" label
 * carrying two voices on one staff, with lyrics under both. Voices sharing a staff
 * routinely carry forced down-stems, which hang three spaces below the notehead,
 * and those stems used to be drawn straight through the words. One browser test
 * measures the lyric band against the painted canvas to keep that fixed, and this
 * is the shape it needs.
 *
 * It used to ship as a fourth bundled sample called "Warm-up in four parts", and
 * it was removed from the app: it is a harmony exercise rather than a piece, and
 * a rehearsal tool should offer music. Nothing about the test needed it to be
 * *shipped*, only to exist — so it is a fixture now, loaded through the app's own
 * file input, and the samples the app offers are four real pieces.
 *
 * The music is written for this repository — root-position triads, one syllable
 * per half note — so no third-party music and no third-party engraving appears
 * anywhere in it.
 */


const DIVISIONS = 4; // per quarter note, so a half note is 8
const HALF = DIVISIONS * 2;

/**
 * Eight bars of I–IV–V–I twice, two half notes a bar.
 *
 * Voicing is ordinary four-part writing: soprano and alto on the upper staff,
 * tenor and bass on the lower, no voice crossing, no parallel fifths worth
 * apologising for. It is meant to be unremarkable — a warm-up, not a piece.
 */
const CHORDS = [
  // [soprano, alto, tenor, bass]
  ['E4', 'C4', 'G3', 'C3'],
  ['E4', 'C4', 'G3', 'C3'],
  ['F4', 'C4', 'A3', 'F3'],
  ['F4', 'C4', 'A3', 'F3'],
  ['D4', 'B3', 'G3', 'G3'],
  ['D4', 'B3', 'G3', 'G3'],
  ['E4', 'C4', 'G3', 'C3'],
  ['E4', 'C4', 'G3', 'C3'],
  ['E4', 'C4', 'A3', 'A3'],
  ['E4', 'C4', 'A3', 'A3'],
  ['F4', 'C4', 'A3', 'F3'],
  ['F4', 'C4', 'A3', 'F3'],
  ['D4', 'B3', 'G3', 'G3'],
  ['F4', 'B3', 'G3', 'G3'],
  ['E4', 'C4', 'G3', 'C3'],
  ['E4', 'C4', 'G3', 'C3'],
];

/** One syllable per half note. Hyphens mark the words that carry over. */
const SYLLABLES = [
  { text: 'Sing' },
  { text: 'a' },
  { text: 'stead', syllabic: 'begin' },
  { text: 'y', syllabic: 'end' },
  { text: 'line,' },
  { text: 'and' },
  { text: 'let' },
  { text: 'the' },
  { text: 'oth', syllabic: 'begin' },
  { text: 'er', syllabic: 'end' },
  { text: 'voic', syllabic: 'begin' },
  { text: 'es', syllabic: 'end' },
  { text: 'find' },
  { text: 'you' },
  { text: 'here' },
  { text: 'now.' },
];

const escape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `E4` -> `{ step: 'E', octave: 4 }`. No accidentals are needed in C major. */
function splitPitch(name) {
  const match = /^([A-G])(\d)$/.exec(name);
  if (!match) throw new Error(`unsupported pitch: ${name}`);
  return { step: match[1], octave: Number(match[2]) };
}

function renderNote({ pitch, voice, stem, syllable, indent }) {
  const { step, octave } = splitPitch(pitch);
  const pad = ' '.repeat(indent);
  const lyric = syllable
    ? [
        `${pad}  <lyric number="1">`,
        syllable.syllabic ? `${pad}    <syllabic>${syllable.syllabic}</syllabic>` : null,
        `${pad}    <text>${escape(syllable.text)}</text>`,
        `${pad}  </lyric>`,
      ]
        .filter(Boolean)
        .join('\n')
    : null;

  return [
    `${pad}<note>`,
    `${pad}  <pitch>`,
    `${pad}    <step>${step}</step>`,
    `${pad}    <octave>${octave}</octave>`,
    `${pad}  </pitch>`,
    `${pad}  <duration>${HALF}</duration>`,
    `${pad}  <voice>${voice}</voice>`,
    `${pad}  <type>half</type>`,
    `${pad}  <stem>${stem}</stem>`,
    lyric,
    `${pad}</note>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * One part: two voices on a single staff.
 *
 * Voice 1 takes stems up and voice 2 stems down, which is what puts a stem into
 * the lyric band and makes this score the one the browser test measures.
 */
function renderPart({ id, clef, upperIndex, lowerIndex }) {
  const measures = [];

  for (let bar = 0; bar < 8; bar++) {
    const slots = [bar * 2, bar * 2 + 1];
    const lines = [`  <measure number="${bar + 1}">`];

    if (bar === 0) {
      lines.push(
        '    <attributes>',
        `      <divisions>${DIVISIONS}</divisions>`,
        '      <key>',
        '        <fifths>0</fifths>',
        '      </key>',
        '      <time>',
        '        <beats>4</beats>',
        '        <beat-type>4</beat-type>',
        '      </time>',
        '      <staves>1</staves>',
        '      <clef>',
        `        <sign>${clef.sign}</sign>`,
        `        <line>${clef.line}</line>`,
        clef.octaveChange ? `        <clef-octave-change>${clef.octaveChange}</clef-octave-change>` : null,
        '      </clef>',
        '    </attributes>',
      );
      if (bar === 0) {
        lines.push(
          '    <direction placement="above">',
          '      <direction-type>',
          '        <words font-weight="bold">Steady</words>',
          '      </direction-type>',
          '      <sound tempo="72"/>',
          '    </direction>',
        );
      }
    }

    // Upper voice, stems up.
    for (const slot of slots) {
      lines.push(
        renderNote({
          pitch: CHORDS[slot][upperIndex],
          voice: 1,
          stem: 'up',
          syllable: SYLLABLES[slot],
          indent: 4,
        }),
      );
    }

    // Rewind the measure and lay the lower voice over the same beats.
    lines.push(`    <backup>`, `      <duration>${HALF * 2}</duration>`, `    </backup>`);

    for (const slot of slots) {
      lines.push(
        renderNote({
          pitch: CHORDS[slot][lowerIndex],
          voice: 2,
          stem: 'down',
          syllable: SYLLABLES[slot],
          indent: 4,
        }),
      );
    }

    if (bar === 7) {
      lines.push(
        '    <barline location="right">',
        '      <bar-style>light-heavy</bar-style>',
        '    </barline>',
      );
    }

    lines.push('  </measure>');
    measures.push(lines.filter(Boolean).join('\n'));
  }

  return `<part id="${id}">\n${measures.join('\n')}\n</part>`;
}

export const TWO_VOICES_ON_ONE_STAFF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>Two voices on one staff</work-title>
  </work>
  <identification>
    <creator type="composer">Xiang Li</creator>
    <rights>Public domain. Written for this repository as a test and demo fixture.</rights>
    <encoding>
      <software>e2e/fixtures/two-voices-on-one-staff.js</software>
      <encoding-description>Generated. Edit the script, not this file.</encoding-description>
    </encoding>
  </identification>
  <part-list>
    <score-part id="P1">
      <part-name>Soprano / Alto</part-name>
    </score-part>
    <score-part id="P2">
      <part-name>Tenor / Bass</part-name>
    </score-part>
  </part-list>
${renderPart({ id: 'P1', clef: { sign: 'G', line: 2 }, upperIndex: 0, lowerIndex: 1 })
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
${renderPart({
  id: 'P2',
  clef: { sign: 'G', line: 2, octaveChange: -1 },
  upperIndex: 2,
  lowerIndex: 3,
})
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
</score-partwise>
`;
