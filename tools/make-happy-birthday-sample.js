/**
 * Generate `sample-pieces/Happy Birthday to You.musicxml`.
 *
 * Why this file exists.
 *
 * The three bundled samples were a Wilbye madrigal, a Stanford part song and an
 * eight-bar warm-up with invented words. The two real pieces are the reason the
 * app exists and neither is a first score: "Draw on, sweet night" is six voices
 * over seventy bars of imitative counterpoint, and "Quick! We have but a second"
 * is 104 bars at crotchet=150. The warm-up is easy because it is not a piece —
 * sixteen half notes, no tune to hold on to, nothing to check yourself against.
 *
 * So this is the missing rung: a piece a singer already knows by heart, in four
 * parts, nine bars long. Knowing the tune is the point. A singer learning to hold
 * an inner line against three others needs to spend their attention on the line
 * and not on sight-reading, and the fastest way to arrange that is a melody they
 * cannot get lost in.
 *
 * COPYRIGHT
 *
 * Clear, and worth writing down given that a previous sample had to be deleted for
 * exactly this reason (see `make-warmup-sample.js`). The tune is Mildred J. Hill's
 * "Good Morning to All", published 1893, long out of copyright everywhere. The
 * words were the contested half: Warner/Chappell collected fees on them for decades
 * until `Marya v. Warner/Chappell Music` (C.D. Cal.) held in September 2015 that the
 * company had never acquired the lyric rights, and a settlement approved in June
 * 2016 placed them in the public domain. The song is also public domain in the EU,
 * where the term ran out in 2016. Nothing here is licensed from anyone.
 *
 * The four-part setting below is mine, written for this repository, so the
 * engraving is not third-party either.
 *
 * THE ARRANGEMENT
 *
 * F major, 3/4, melody in the soprano, one syllable per note, no divisi and no
 * repeats. Chosen so that every part stays inside a comfortable range and — the
 * thing that actually matters for a practice tool — so that the three lower parts
 * are almost entirely stepwise:
 *
 *   Soprano  C4-C5   the tune, untouched
 *   Alto     A3-E4   a fifth, wide. Mostly repeated notes and steps
 *   Tenor    E3-Bb3  a fifth
 *   Bass     F2-C3   roots and one first inversion, no leap wider than a fifth
 *
 * Harmony is I-IV-V with a ii on "dear friend" and a real dominant seventh in the
 * last line, where the melody's own Bb is the seventh and resolves down to A. Voice
 * crossing is checked in `tests/parse-samples.js`-adjacent territory only by eye:
 * S >= A >= T >= B at all twenty-four events, verified when writing the table.
 *
 * Run with: node tools/make-happy-birthday-sample.js
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIVISIONS = 4; // per quarter note, so an eighth is 2 and a bar of 3/4 is 12

/** MusicXML `<type>` plus the duration it takes at `DIVISIONS`. */
const DURATIONS = {
  eighth: { type: 'eighth', duration: DIVISIONS / 2, dots: 0 },
  quarter: { type: 'quarter', duration: DIVISIONS, dots: 0 },
  half: { type: 'half', duration: DIVISIONS * 2, dots: 0 },
  'dotted-half': { type: 'half', duration: DIVISIONS * 3, dots: 1 },
};

/**
 * The whole piece, bar by bar, four pitches to an event.
 *
 * Written out in full rather than generated from a chord table, because a score is
 * the kind of thing where being able to read every note off the page and check it
 * is worth more than being short. Pitches are `[soprano, alto, tenor, bass]` and
 * are sounding pitches — the tenor's octave-down clef is a drawing instruction, not
 * a transposition.
 *
 * Bar 1 is the upbeat: one beat, two eighths, `implicit="yes"`.
 */
const MEASURES = [
  // 1. upbeat -- F
  [
    { dur: 'eighth', beam: 'begin', pitches: ['C4', 'A3', 'F3', 'F2'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['C4', 'A3', 'F3', 'F2'], text: 'py', syllabic: 'end' },
  ],
  // 2. Bb - F/A - Bb
  [
    { dur: 'quarter', pitches: ['D4', 'Bb3', 'F3', 'Bb2'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['C4', 'A3', 'F3', 'A2'], text: 'day', syllabic: 'end' },
    { dur: 'quarter', pitches: ['F4', 'D4', 'Bb3', 'Bb2'], text: 'to' },
  ],
  // 3. C -- the first phrase ends on the dominant, then the next upbeat resolves it
  [
    { dur: 'half', pitches: ['E4', 'C4', 'G3', 'C3'], text: 'you,' },
    { dur: 'eighth', beam: 'begin', pitches: ['C4', 'A3', 'F3', 'F2'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['C4', 'A3', 'F3', 'F2'], text: 'py', syllabic: 'end' },
  ],
  // 4. Bb - F/A - C
  [
    { dur: 'quarter', pitches: ['D4', 'Bb3', 'F3', 'Bb2'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['C4', 'A3', 'F3', 'A2'], text: 'day', syllabic: 'end' },
    { dur: 'quarter', pitches: ['G4', 'C4', 'E3', 'C3'], text: 'to' },
  ],
  // 5. F
  [
    { dur: 'half', pitches: ['F4', 'C4', 'A3', 'F2'], text: 'you,' },
    { dur: 'eighth', beam: 'begin', pitches: ['C4', 'A3', 'F3', 'F2'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['C4', 'A3', 'F3', 'F2'], text: 'py', syllabic: 'end' },
  ],
  // 6. F - F - Bb. The soprano's octave leap to C5 is the top of the piece; the
  //    lower three hold still underneath it, which is the easiest bar to sing and
  //    the hardest to hear yourself in.
  [
    { dur: 'quarter', pitches: ['C5', 'C4', 'A3', 'F2'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['A4', 'C4', 'A3', 'F2'], text: 'day', syllabic: 'end' },
    { dur: 'quarter', pitches: ['F4', 'D4', 'F3', 'Bb2'], text: 'dear' },
  ],
  // 7. Gm, then C7 under the upbeat -- the melody's Bb is the seventh
  [
    { dur: 'half', pitches: ['G4', 'D4', 'Bb3', 'G2'], text: 'friend,' },
    { dur: 'eighth', beam: 'begin', pitches: ['Bb4', 'E4', 'G3', 'C3'], text: 'Hap', syllabic: 'begin' },
    { dur: 'eighth', beam: 'end', pitches: ['Bb4', 'E4', 'G3', 'C3'], text: 'py', syllabic: 'end' },
  ],
  // 8. F - F - C7, the seventh resolving down to A in the soprano
  [
    { dur: 'quarter', pitches: ['A4', 'C4', 'A3', 'F2'], text: 'birth', syllabic: 'begin' },
    { dur: 'quarter', pitches: ['F4', 'C4', 'A3', 'F2'], text: 'day', syllabic: 'end' },
    { dur: 'quarter', pitches: ['G4', 'E4', 'Bb3', 'C3'], text: 'to' },
  ],
  // 9. F
  [{ dur: 'dotted-half', pitches: ['F4', 'C4', 'A3', 'F2'], text: 'you!' }],
];

/**
 * The four parts, in score order.
 *
 * Named exactly "Soprano", "Alto", "Tenor", "Bass" because the app matches part
 * names to voice types with `VOICE_TYPE_PATTERNS` in `musicxml-parser.js`, and the
 * voice type is what picks the part's colour out of `PART_COLORS` and what the
 * balance panel lists. A cleverer label would render in grey and sort last.
 *
 * The tenor gets a treble clef with `clef-octave-change` of -1, which is standard
 * SATB open score: it draws where a tenor reads while the pitches stay where a
 * tenor sounds. Same as "Quick! We have but a second".
 */
const PARTS = [
  { id: 'P1', name: 'Soprano', index: 0, clef: { sign: 'G', line: 2 } },
  { id: 'P2', name: 'Alto', index: 1, clef: { sign: 'G', line: 2 } },
  { id: 'P3', name: 'Tenor', index: 2, clef: { sign: 'G', line: 2, octaveChange: -1 } },
  { id: 'P4', name: 'Bass', index: 3, clef: { sign: 'F', line: 4 } },
];

const escape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `Bb3` -> `{ step: 'B', alter: -1, octave: 3 }`. Only flats occur in F major. */
function splitPitch(name) {
  const match = /^([A-G])(b?)(\d)$/.exec(name);
  if (!match) throw new Error(`unsupported pitch: ${name}`);
  return { step: match[1], alter: match[2] === 'b' ? -1 : 0, octave: Number(match[3]) };
}

function renderNote(event, voiceIndex, indent) {
  const { step, alter, octave } = splitPitch(event.pitches[voiceIndex]);
  const { type, duration, dots } = DURATIONS[event.dur];
  const pad = ' '.repeat(indent);

  return [
    `${pad}<note>`,
    `${pad}  <pitch>`,
    `${pad}    <step>${step}</step>`,
    alter ? `${pad}    <alter>${alter}</alter>` : null,
    `${pad}    <octave>${octave}</octave>`,
    `${pad}  </pitch>`,
    `${pad}  <duration>${duration}</duration>`,
    `${pad}  <voice>1</voice>`,
    `${pad}  <type>${type}</type>`,
    ...Array.from({ length: dots }, () => `${pad}  <dot/>`),
    // No <stem>: one voice to a staff, so the renderer's own position rule gives
    // the right answer and a hard-coded direction could only ever be wrong.
    event.beam ? `${pad}  <beam number="1">${event.beam}</beam>` : null,
    `${pad}  <lyric number="1">`,
    event.syllabic ? `${pad}    <syllabic>${event.syllabic}</syllabic>` : null,
    `${pad}    <text>${escape(event.text)}</text>`,
    `${pad}  </lyric>`,
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
        '        <fifths>-1</fifths>',
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
      // Tempo on the top part only, which is where "Quick! We have but a second"
      // puts it and where a reader looks. The parser lifts it into a score-wide
      // tempo map, so the other three parts do not need their own copy.
      if (part.index === 0) {
        lines.push(
          '    <direction placement="above">',
          '      <direction-type>',
          '        <words font-weight="bold">Warmly</words>',
          '      </direction-type>',
          '      <sound tempo="104"/>',
          '    </direction>',
        );
      }
    }

    for (const event of events) lines.push(renderNote(event, part.index, 4));

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

const RIGHTS =
  'Public domain. Melody: Mildred J. Hill, "Good Morning to All" (1893). ' +
  'The "Happy Birthday to You" lyrics were held to be unprotected in Marya v. ' +
  'Warner/Chappell Music (C.D. Cal. 2015; settlement approved June 2016) and are ' +
  'public domain in the United States and the European Union. This four-part ' +
  'setting was written for this repository.';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>Happy Birthday to You</work-title>
  </work>
  <identification>
    <creator type="composer">Mildred J. Hill</creator>
    <creator type="lyricist">Patty S. Hill</creator>
    <creator type="arranger">Xiang Li</creator>
    <rights>${escape(RIGHTS)}</rights>
    <encoding>
      <software>tools/make-happy-birthday-sample.js</software>
      <encoding-description>Generated. Edit the script, not this file.</encoding-description>
    </encoding>
  </identification>
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

// `fileURLToPath`, not `url.pathname`: this repository lives under a directory
// with a space in its name, and `pathname` hands back `bing%20bong`.
const target = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'public',
  'sample-pieces',
  'Happy Birthday to You.musicxml',
);

writeFileSync(target, xml, 'utf8');
const events = MEASURES.reduce((total, bar) => total + bar.length, 0);
console.log(
  `wrote ${target} (${(xml.length / 1024).toFixed(1)} kB, ${MEASURES.length} bars, ` +
    `4 parts, ${events} notes each)`,
);
