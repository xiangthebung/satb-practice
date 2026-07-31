/**
 * Generate `sample-pieces/Happy Birthday.musicxml` — David Bauguess's SATB setting.
 *
 * Why this file exists.
 *
 * The three other bundled samples had no first score between them. "Draw on, sweet
 * night" is six voices over seventy bars of imitative counterpoint and "Quick! We have
 * but a second" is 104 bars at crotchet=150: both are the reason the app exists and
 * neither is somewhere to start. The warm-up is easy only because it is not a piece —
 * sixteen half notes, no tune to hold on to, nothing to check yourself against.
 *
 * So this is the missing rung, and it is a real arrangement rather than an exercise. A
 * singer learning to hold an inner line against three others should be spending their
 * attention on the line, and the fastest way to arrange that is a melody they cannot
 * get lost in.
 *
 * LICENCE
 *
 * The arrangement is David Bauguess's, and his own notice on the score reads:
 *
 *   "This arrangement may be freely reproduced. A PDF file is available at
 *    tinyurl.com/yazlt88y or from davidbauguess@yahoo.com"
 *
 * That notice is carried through into the file's `<rights>` verbatim, and the score
 * credits him as arranger. The song underneath is public domain: the tune is Mildred
 * J. Hill's "Good Morning to All" (1893), and the words were held unprotected in
 * `Marya v. Warner/Chappell Music` (C.D. Cal. 2015), with a settlement approved in
 * June 2016 placing them in the public domain in the US; the EU term expired in 2016
 * too. Worth writing down, because a previous sample had to be deleted from this
 * repository for exactly this reason — see `make-warmup-sample.js`.
 *
 * HOW THE NOTES GOT HERE
 *
 * From the published PDF, which is a MuseScore 2.3.2 export whose text is drawn as
 * vector paths — so there is nothing to extract and nothing to copy. Reading four
 * staves of noteheads off a raster by eye is how a transcription ends up a third out
 * in an inner voice, so instead the page was rendered at 4x and the staff lines,
 * barlines and noteheads were found in the pixels: staff lines as rows dark across the
 * page, noteheads as solid cores surviving an erosion that thin stems and beams do
 * not, and each head's height above the top line converted to a diatonic step.
 *
 * The check that makes it trustworthy is the soprano. Happy Birthday's melody is
 * fixed, so a detector that reproduces the tune exactly — which this one did, all
 * fourteen notes of the first system including both half notes — can be believed about
 * the alto, tenor and bass. The harmony it produced is coherent for the same reason it
 * is worth having: Ab6, Fm, Eb7, Bbm7, Db, Eb7/G, Ab6. Nothing in it is a guess.
 *
 * WHAT IT ASKS OF A SINGER
 *
 *   Soprano  Eb4-F5   the tune, with divisi thirds above it in the last two bars
 *   Alto     C4-Ab4
 *   Tenor    Eb3-Eb4
 *   Bass     Ab2-Ab3
 *
 * Ab major, 3/4, one-beat upbeat, nine bars. The final bar is two beats, which is not
 * a mistake: it completes the bar the upbeat borrowed from. Two tempi, crotchet=85
 * relaxing to 72 for the second half, and a fermata at each of the last two phrase
 * ends. Bauguess replaces "dear [name]" with "happy birthday", which is why the third
 * line has four syllables where the song normally has two.
 *
 * The divisi are written as chords in one voice rather than as split parts, so
 * "Alto" stays a single selectable part in the balance panel instead of becoming
 * "Alto 1 / Alto 2" for the sake of four bars.
 *
 * Run with: node tools/make-happy-birthday-sample.js
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIVISIONS = 4; // per quarter, so an eighth is 2 and a bar of 3/4 is 12

const DURATIONS = {
  eighth: { type: 'eighth', duration: DIVISIONS / 2 },
  quarter: { type: 'quarter', duration: DIVISIONS },
  half: { type: 'half', duration: DIVISIONS * 2 },
};

/**
 * The piece, bar by bar. `pitches` is `[soprano, alto, tenor, bass]`, and any of the
 * four may be an array, which is a divisi chord written low to high.
 *
 * Sounding pitches throughout: the tenor's octave-down clef is a drawing instruction,
 * not a transposition.
 *
 * Bar 1 is the upbeat — one beat, two eighths, `implicit="yes"`.
 */
const MEASURES = [
  // 1. upbeat. All four in octaves on the dominant.
  [
    { dur: 'eighth', beam: 'begin', pitches: ['Eb4', 'Eb4', 'Eb3', 'Eb3'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['Eb4', 'Eb4', 'Eb3', 'Eb3'], text: 'py', syllabic: 'end' },
  ],
  // 2. Ab6 - Ab - Fm
  [
    { dur: 'quarter', pitches: ['F4', 'C4', 'Eb3', 'Ab2'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['Eb4', 'C4', 'Ab3', 'Ab2'], text: 'day', syllabic: 'end' },
    { dur: 'quarter', pitches: ['Ab4', 'C4', 'F3', 'Ab2'], text: 'to' },
  ],
  // 3. Eb7 throughout, the first phrase ending on the dominant
  [
    { dur: 'half', pitches: ['G4', 'Db4', 'Eb3', 'Bb2'], text: 'you.' },
    { dur: 'eighth', beam: 'begin', pitches: ['Eb4', 'Db4', 'G3', 'Eb3'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['Eb4', 'Db4', 'G3', 'Eb3'], text: 'py', syllabic: 'end' },
  ],
  // 4. Bbm7 - Eb7/G - Eb7
  [
    { dur: 'quarter', pitches: ['F4', 'Db4', 'Bb3', 'Ab3'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['Eb4', 'Db4', 'Bb3', 'G3'], text: 'day', syllabic: 'end' },
    { dur: 'quarter', pitches: ['Bb4', 'Db4', 'G3', 'Eb3'], text: 'to' },
  ],
  // 5. Ab, then everyone back into octaves on Eb for the upbeat
  [
    { dur: 'half', pitches: ['Ab4', 'Eb4', 'C4', 'Ab3'], text: 'you.' },
    { dur: 'eighth', beam: 'begin', pitches: ['Eb4', 'Eb4', 'Eb4', 'Eb3'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['Eb4', 'Eb4', 'Eb4', 'Eb3'], text: 'py', syllabic: 'end' },
  ],
  // 6. crotchet=72 from here. The soprano's octave leap to Eb5 is the top of the piece.
  [
    { dur: 'quarter', pitches: ['Eb5', ['Eb4', 'Ab4'], 'C4', 'Ab3'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['C5', 'Ab4', 'Eb4', 'Ab2'], text: 'day,', syllabic: 'end' },
    { dur: 'eighth', beam: 'begin', pitches: ['Ab4', 'Eb4', 'Ab3', 'C3'], text: 'hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['Ab4', 'Eb4', 'Ab3', 'C3'], text: 'py', syllabic: 'end' },
  ],
  // 7. Db under the fermata, then Bbm7 with the parts opening into thirds
  [
    { dur: 'quarter', pitches: ['G4', 'Eb4', 'Ab3', 'Db3'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['F4', 'Db4', 'Ab3', 'Db3'], text: 'day.', syllabic: 'end', fermata: true },
    { dur: 'eighth', beam: 'begin', pitches: [['Db5', 'F5'], ['F4', 'Ab4'], 'Bb3', 'Db3'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: [['Db5', 'F5'], ['F4', 'Ab4'], 'Bb3', 'Db3'], text: 'py', syllabic: 'end' },
  ],
  // 8. Ab6 - Db add9 - Eb7
  [
    { dur: 'quarter', pitches: [['C5', 'Eb5'], ['F4', 'Ab4'], 'Ab3', 'Eb3'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['Ab4', 'F4', 'Db4', 'Eb3'], text: 'day', syllabic: 'end' },
    { dur: 'quarter', pitches: ['Bb4', ['Eb4', 'G4'], 'Db4', 'Eb3'], text: 'to' },
  ],
  // 9. Ab6, held. Two beats, which is the beat the upbeat borrowed.
  [
    {
      dur: 'half',
      pitches: ['Ab4', ['Eb4', 'F4'], 'C4', ['Ab2', 'Eb3']],
      text: 'you!',
      fermata: true,
    },
  ],
];

/** Tempo marks, as `measure index -> printed crotchet value`. */
const TEMPI = { 0: 85, 5: 72 };

/**
 * The four parts, in score order.
 *
 * Named exactly "Soprano", "Alto", "Tenor", "Bass" because the app matches part names
 * to voice types with `VOICE_TYPE_PATTERNS` in `musicxml-parser.js`, and the voice
 * type is what picks the part's colour out of `PART_COLORS` and what the balance panel
 * lists. A cleverer label would render in grey and sort last.
 *
 * The tenor gets a treble clef with `clef-octave-change` of -1, which is standard SATB
 * open score and what the source uses: it draws where a tenor reads while the pitches
 * stay where a tenor sounds.
 */
const PARTS = [
  { id: 'P1', name: 'Soprano', index: 0, clef: { sign: 'G', line: 2 } },
  { id: 'P2', name: 'Alto', index: 1, clef: { sign: 'G', line: 2 } },
  { id: 'P3', name: 'Tenor', index: 2, clef: { sign: 'G', line: 2, octaveChange: -1 } },
  { id: 'P4', name: 'Bass', index: 3, clef: { sign: 'F', line: 4 } },
];

const escape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** `Bb3` -> `{ step: 'B', alter: -1, octave: 3 }`. Only flats occur in Ab major. */
function splitPitch(name) {
  const match = /^([A-G])(b?)(\d)$/.exec(name);
  if (!match) throw new Error(`unsupported pitch: ${name}`);
  return { step: match[1], alter: match[2] === 'b' ? -1 : 0, octave: Number(match[3]) };
}

/**
 * One `<note>`. `chordMember` is true for every head after the first in a divisi, which
 * is what `<chord/>` means: sounds with the previous note rather than after it.
 *
 * The lyric and the beam go on the first head only. A syllable repeated on both notes
 * of a chord is drawn twice, and a beam belongs to the note, not to each head of it.
 */
function renderNote({ pitch, event, chordMember, indent }) {
  const { step, alter, octave } = splitPitch(pitch);
  const { type, duration } = DURATIONS[event.dur];
  const pad = ' '.repeat(indent);

  return [
    `${pad}<note>`,
    chordMember ? `${pad}  <chord/>` : null,
    `${pad}  <pitch>`,
    `${pad}    <step>${step}</step>`,
    alter ? `${pad}    <alter>${alter}</alter>` : null,
    `${pad}    <octave>${octave}</octave>`,
    `${pad}  </pitch>`,
    `${pad}  <duration>${duration}</duration>`,
    `${pad}  <voice>1</voice>`,
    `${pad}  <type>${type}</type>`,
    // No <stem>: one voice to a staff, so the renderer's own position rule gives the
    // right answer and a hard-coded direction could only ever be wrong.
    !chordMember && event.beam ? `${pad}  <beam number="1">${event.beam}</beam>` : null,
    event.fermata
      ? [`${pad}  <notations>`, `${pad}    <fermata type="upright"/>`, `${pad}  </notations>`].join('\n')
      : null,
    !chordMember
      ? [
          `${pad}  <lyric number="1">`,
          event.syllabic ? `${pad}    <syllabic>${event.syllabic}</syllabic>` : null,
          `${pad}    <text>${escape(event.text)}</text>`,
          `${pad}  </lyric>`,
        ]
          .filter(Boolean)
          .join('\n')
      : null,
    `${pad}</note>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderPart(part) {
  const measures = MEASURES.map((events, bar) => {
    const lines = [`  <measure number="${bar + 1}"${bar === 0 ? ' implicit="yes"' : ''}>`];

    if (bar === 0) {
      lines.push(
        '    <attributes>',
        `      <divisions>${DIVISIONS}</divisions>`,
        '      <key>',
        '        <fifths>-4</fifths>',
        '      </key>',
        '      <time>',
        '        <beats>3</beats>',
        '        <beat-type>4</beat-type>',
        '      </time>',
        '      <staves>1</staves>',
        '      <clef>',
        `        <sign>${part.clef.sign}</sign>`,
        `        <line>${part.clef.line}</line>`,
        part.clef.octaveChange
          ? `        <clef-octave-change>${part.clef.octaveChange}</clef-octave-change>`
          : null,
        '      </clef>',
        '    </attributes>',
      );
    }

    /* Tempo on the top part only, which is where "Quick! We have but a second" puts it
       and where a reader looks. The parser lifts it into a score-wide tempo map, so the
       other three parts do not need their own copy.

       The second mark is placed at the head of bar 5. On the printed page MuseScore has
       nudged the text right, over the third beat, but the whole second half is the
       slower tempo and beat 1 is where a singer would take it. */
    if (part.index === 0 && TEMPI[bar]) {
      lines.push(
        '    <direction placement="above">',
        '      <direction-type>',
        '        <metronome parentheses="no">',
        '          <beat-unit>quarter</beat-unit>',
        `          <per-minute>${TEMPI[bar]}</per-minute>`,
        '        </metronome>',
        '      </direction-type>',
        `      <sound tempo="${TEMPI[bar]}"/>`,
        '    </direction>',
      );
    }

    for (const event of events) {
      const entry = event.pitches[part.index];
      const heads = Array.isArray(entry) ? entry : [entry];
      heads.forEach((pitch, order) => {
        lines.push(renderNote({ pitch, event, chordMember: order > 0, indent: 4 }));
      });
    }

    if (bar === MEASURES.length - 1) {
      lines.push(
        '    <barline location="right">',
        '      <bar-style>light-heavy</bar-style>',
        '    </barline>',
      );
    }

    lines.push('  </measure>');
    return lines.filter(Boolean).join('\n');
  });

  return `<part id="${part.id}">\n${measures.join('\n')}\n</part>`;
}

const reindent = (block) =>
  block
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');

/** Bauguess's own notice, kept word for word: it is the licence. */
const NOTICE =
  'This arrangement may be freely reproduced. A PDF file is available at ' +
  'tinyurl.com/yazlt88y or from davidbauguess@yahoo.com';

const RIGHTS =
  `${NOTICE} — Arrangement by David Bauguess, reproduced under that notice. ` +
  'The song is public domain: melody by Mildred J. Hill, "Good Morning to All" ' +
  '(1893); the lyrics were held unprotected in Marya v. Warner/Chappell Music ' +
  '(C.D. Cal. 2015, settlement approved June 2016).';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>Happy Birthday</work-title>
  </work>
  <identification>
    <creator type="composer">Mildred J. Hill</creator>
    <creator type="lyricist">Patty S. Hill</creator>
    <creator type="arranger">David Bauguess</creator>
    <rights>${escape(RIGHTS)}</rights>
    <encoding>
      <software>tools/make-happy-birthday-sample.js</software>
      <encoding-description>Generated. Edit the script, not this file.</encoding-description>
    </encoding>
  </identification>
  <credit page="1">
    <credit-words justify="right" valign="top">arr. David Bauguess</credit-words>
  </credit>
  <part-list>
${PARTS.map(
  (part) => `    <score-part id="${part.id}">
      <part-name>${part.name}</part-name>
    </score-part>`,
).join('\n')}
  </part-list>
${PARTS.map((part) => reindent(renderPart(part))).join('\n')}
</score-partwise>
`;

// `fileURLToPath`, not `url.pathname`: this repository lives under a directory with a
// space in its name, and `pathname` hands back `bing%20bong`.
const target = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'public',
  'sample-pieces',
  'Happy Birthday.musicxml',
);

writeFileSync(target, xml, 'utf8');
const heads = MEASURES.reduce(
  (total, bar) =>
    total +
    bar.reduce(
      (n, event) => n + event.pitches.reduce((k, p) => k + (Array.isArray(p) ? p.length : 1), 0),
      0,
    ),
  0,
);
console.log(
  `wrote ${target} (${(xml.length / 1024).toFixed(1)} kB, ${MEASURES.length} bars, ` +
    `4 parts, ${heads} noteheads)`,
);
