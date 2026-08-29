/**
 * A score with a repeat and two numbered endings, built for the browser tests.
 *
 * None of the three bundled samples has a repeat in it, which is how the repeat
 * signs came to be expanded into the performance and never drawn on the page:
 * the audio jumped back four bars and skipped an ending while every barline on
 * screen looked the same, and no test could see the difference because no test
 * had a score to see it in.
 *
 * Four bars, two parts, one note per bar. The music is deliberately trivial —
 * this fixture exists for its *structure*, not its notes:
 *
 *   bar 1  |: repeat forward
 *   bar 2  [1.  ... :| repeat backward, ending 1 stop
 *   bar 3  [2.  ... ending 2 stop
 *   bar 4  final barline
 *
 * so a correct reading plays bars 1, 2, 1, 3, 4 — five bars of performance from
 * four bars of score.
 */

const DIVISIONS = 4; // per quarter note, so a whole note is 16
const WHOLE = DIVISIONS * 4;

/** One whole-note bar for one part. */
function bar({ number, step, octave, attributes = '', barlines = '' }) {
  return `    <measure number="${number}">
${attributes}${barlines}      <note>
        <pitch><step>${step}</step><octave>${octave}</octave></pitch>
        <duration>${WHOLE}</duration>
        <voice>1</voice>
        <type>whole</type>
      </note>
    </measure>`;
}

const ATTRIBUTES = (clef, line) => `      <attributes>
        <divisions>${DIVISIONS}</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>${clef}</sign><line>${line}</line></clef>
      </attributes>
`;

const FORWARD_REPEAT = `      <barline location="left">
        <bar-style>heavy-light</bar-style>
        <repeat direction="forward"/>
      </barline>
`;

const ENDING_START = (number) => `      <barline location="left">
        <ending number="${number}" type="start"/>
      </barline>
`;

const BACKWARD_REPEAT_WITH_ENDING = `      <barline location="right">
        <bar-style>light-heavy</bar-style>
        <ending number="1" type="stop"/>
        <repeat direction="backward"/>
      </barline>
`;

const ENDING_STOP = `      <barline location="right">
        <ending number="2" type="discontinue"/>
      </barline>
`;

const FINAL = `      <barline location="right">
        <bar-style>light-heavy</bar-style>
      </barline>
`;

/** The four bars of one part, in the pitches given. */
function part(id, clef, line, pitches) {
  return `  <part id="${id}">
${bar({
    number: 1,
    step: pitches[0][0],
    octave: pitches[0][1],
    attributes: ATTRIBUTES(clef, line),
    barlines: FORWARD_REPEAT
  })}
${bar({
    number: 2,
    step: pitches[1][0],
    octave: pitches[1][1],
    barlines: ENDING_START(1) + BACKWARD_REPEAT_WITH_ENDING
  })}
${bar({
    number: 3,
    step: pitches[2][0],
    octave: pitches[2][1],
    barlines: ENDING_START(2) + ENDING_STOP
  })}
${bar({
    number: 4,
    step: pitches[3][0],
    octave: pitches[3][1],
    barlines: FINAL
  })}
  </part>`;
}

export const REPEAT_WITH_ENDINGS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Repeat and endings</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Bass</part-name></score-part>
  </part-list>
${part('P1', 'G', 2, [['C', 5], ['D', 5], ['E', 5], ['C', 5]])}
${part('P2', 'F', 4, [['C', 3], ['G', 2], ['A', 2], ['C', 3]])}
</score-partwise>
`;
