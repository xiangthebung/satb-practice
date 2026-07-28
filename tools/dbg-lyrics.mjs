import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { parseMusicXML } from '../js/musicxml-parser.js';

const file = process.argv[2] || 'sample-pieces/Smavinir fagrir.musicxml';
const xml = readFileSync(file, 'utf8');
const doc = new DOMParser().parseFromString(xml, 'text/xml');
const score = parseMusicXML(xml, doc);

for (const part of score.parts) {
  let total = 0;
  let withLyric = 0;
  const nums = new Set();
  for (const m of part.measures) {
    for (const n of m.notes || []) {
      if (n.isRest) continue;
      total++;
      if (n.lyrics && n.lyrics.length) {
        withLyric++;
        for (const l of n.lyrics) nums.add(l.number);
      }
    }
  }
  console.log(
    `${part.id} ${JSON.stringify(part.name)} voiceType=${part.voiceType} notes=${total} withLyric=${withLyric} verses=[${[...nums].join(',')}]`
  );
}

const p0 = score.parts[0];
console.log('\n--- part0 measures 1-3 ---');
for (const m of p0.measures.slice(0, 3)) {
  for (const n of m.notes || []) {
    console.log(
      `m${m.number} ${n.isRest ? 'rest' : n.pitch?.step + n.pitch?.octave} voice=${n.voice} staff=${n.staff} chord=${!!n.isChord} lyrics=${JSON.stringify(n.lyrics || null)}`
    );
  }
}
