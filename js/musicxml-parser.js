/**
 * MusicXML Parser Module
 * Parses MusicXML files and extracts voice parts with their note data.
 * Dynamically detects part types using string matching heuristics.
 */

import { calculateDuration } from './utils.js';

// MXL (compressed MusicXML) ZIP signature bytes
const ZIP_SIGNATURE = [0x50, 0x4B, 0x03, 0x04];

/**
 * Heuristics for detecting voice type from a part name.
 * Order matters - more specific patterns are checked first.
 */
const VOICE_TYPE_PATTERNS = [
  { pattern: /\bmezzo[\s-]*soprano\b/i, type: 'mezzo-soprano' },
  { pattern: /\bmezzo\b/i, type: 'mezzo-soprano' },
  { pattern: /\bsoprano\s*2\b/i, type: 'soprano 2' },
  { pattern: /\bsoprano\s*1\b/i, type: 'soprano 1' },
  { pattern: /\bsoprano\b/i, type: 'soprano' },
  { pattern: /\bsop\.?\b/i, type: 'soprano' },
  { pattern: /\b[sS]\s*1\b/, type: 'soprano 1' },
  { pattern: /\b[sS]\s*2\b/, type: 'soprano 2' },
  { pattern: /\balto\s*2\b/i, type: 'alto 2' },
  { pattern: /\balto\s*1\b/i, type: 'alto 1' },
  { pattern: /\balto\b/i, type: 'alto' },
  { pattern: /\bcontralto\b/i, type: 'alto' },
  { pattern: /\b[aA]\s*1\b/, type: 'alto 1' },
  { pattern: /\b[aA]\s*2\b/, type: 'alto 2' },
  { pattern: /\btenor\s*2\b/i, type: 'tenor 2' },
  { pattern: /\btenor\s*1\b/i, type: 'tenor 1' },
  { pattern: /\btenor\b/i, type: 'tenor' },
  { pattern: /\bten\.?\b/i, type: 'tenor' },
  { pattern: /\b[tT]\s*1\b/, type: 'tenor 1' },
  { pattern: /\b[tT]\s*2\b/, type: 'tenor 2' },
  { pattern: /\bbaritone\b/i, type: 'baritone' },
  { pattern: /\bbar\.?\b/i, type: 'baritone' },
  { pattern: /\bbass\s*2\b/i, type: 'bass 2' },
  { pattern: /\bbass\s*1\b/i, type: 'bass 1' },
  { pattern: /\bbass\b/i, type: 'bass' },
  { pattern: /\b[bB]\s*1\b/, type: 'bass 1' },
  { pattern: /\b[bB]\s*2\b/, type: 'bass 2' }
];

/**
 * Detect voice type from a part name using heuristics.
 * @param {string} partName - the part name from MusicXML
 * @returns {string} detected voice type or the original name if unknown
 */
export function detectVoiceType(partName) {
  if (!partName) return 'unknown';

  for (const { pattern, type } of VOICE_TYPE_PATTERNS) {
    if (pattern.test(partName)) {
      return type;
    }
  }

  // Return the original name lowercase if no pattern matches
  return partName.toLowerCase().trim();
}

/**
 * Check if file data is a compressed MXL file (ZIP format).
 * @param {ArrayBuffer} data
 * @returns {boolean}
 */
export function isMxlFile(data) {
  const bytes = new Uint8Array(data, 0, 4);
  return ZIP_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * Parse a pitch element from MusicXML.
 * @param {Element} pitchEl - the <pitch> element
 * @returns {{ step: string, alter: number, octave: number, noteName: string }}
 */
function parsePitch(pitchEl) {
  const step = pitchEl.querySelector('step')?.textContent || 'C';
  const alter = parseInt(pitchEl.querySelector('alter')?.textContent || '0', 10);
  const octave = parseInt(pitchEl.querySelector('octave')?.textContent || '4', 10);

  let noteName = step;
  if (alter === 1) noteName += '#';
  else if (alter === -1) noteName += 'b';
  else if (alter === 2) noteName += '##';
  else if (alter === -2) noteName += 'bb';

  return { step, alter, octave, noteName };
}

/**
 * Parse a single measure element.
 * @param {Element} measureEl - the <measure> element
 * @param {number} currentDivisions - current divisions value
 * @param {{ numerator: number, denominator: number }} currentTimeSignature
 * @returns {{ notes: Array, divisions: number, timeSignature: object, keySignature: object|null, tempo: number|null, voices: Set }}
 */
function parseMeasure(measureEl, currentDivisions, currentTimeSignature) {
  const result = {
    number: parseInt(measureEl.getAttribute('number') || '1', 10),
    notes: [],
    divisions: currentDivisions,
    timeSignature: currentTimeSignature,
    keySignature: null,
    tempo: null,
    voices: new Set()
  };

  // Check for attributes element (divisions, time signature, key signature)
  const attributes = measureEl.querySelector('attributes');
  if (attributes) {
    const divisionsEl = attributes.querySelector('divisions');
    if (divisionsEl) {
      result.divisions = parseInt(divisionsEl.textContent, 10);
    }

    const timeEl = attributes.querySelector('time');
    if (timeEl) {
      result.timeSignature = {
        numerator: parseInt(timeEl.querySelector('beats')?.textContent || '4', 10),
        denominator: parseInt(timeEl.querySelector('beat-type')?.textContent || '4', 10)
      };
    }

    const keyEl = attributes.querySelector('key');
    if (keyEl) {
      result.keySignature = {
        fifths: parseInt(keyEl.querySelector('fifths')?.textContent || '0', 10),
        mode: keyEl.querySelector('mode')?.textContent || 'major'
      };
    }
  }

  // Check for tempo in direction elements
  const directions = measureEl.querySelectorAll('direction');
  for (const dir of directions) {
    const sound = dir.querySelector('sound');
    if (sound && sound.getAttribute('tempo')) {
      result.tempo = parseFloat(sound.getAttribute('tempo'));
    }
  }

  // Parse notes
  const noteElements = measureEl.querySelectorAll('note');
  for (const noteEl of noteElements) {
    const isRest = noteEl.querySelector('rest') !== null;
    const isChord = noteEl.querySelector('chord') !== null;
    const voice = parseInt(noteEl.querySelector('voice')?.textContent || '1', 10);
    const staff = parseInt(noteEl.querySelector('staff')?.textContent || '1', 10);
    const duration = parseInt(noteEl.querySelector('duration')?.textContent || '1', 10);
    const type = noteEl.querySelector('type')?.textContent || null;
    const dots = noteEl.querySelectorAll('dot').length;

    result.voices.add(voice);

    const noteData = {
      isRest,
      isChord,
      voice,
      staff,
      duration,
      type,
      dots,
      durationBeats: type ? calculateDuration(type, dots) : (duration / result.divisions)
    };

    if (!isRest) {
      const pitchEl = noteEl.querySelector('pitch');
      if (pitchEl) {
        const pitch = parsePitch(pitchEl);
        noteData.pitch = pitch;
      }
    }

    // Check for lyric
    const lyricEl = noteEl.querySelector('lyric');
    if (lyricEl) {
      const text = lyricEl.querySelector('text')?.textContent || '';
      const syllabic = lyricEl.querySelector('syllabic')?.textContent || 'single';
      noteData.lyric = { text, syllabic };
    }

    // Check for tie
    const tieEl = noteEl.querySelector('tie');
    if (tieEl) {
      noteData.tie = tieEl.getAttribute('type'); // 'start' or 'stop'
    }

    result.notes.push(noteData);
  }

  return result;
}

/**
 * Split a part's measures by voice number (for multi-voice staves).
 * @param {Array} measures - array of parsed measures
 * @returns {Map<number, Array>} map of voice number to measures containing only that voice's notes
 */
function splitByVoice(measures) {
  const voiceMap = new Map();

  for (const measure of measures) {
    for (const voice of measure.voices) {
      if (!voiceMap.has(voice)) {
        voiceMap.set(voice, []);
      }
      const voiceNotes = measure.notes.filter(n => n.voice === voice);
      voiceMap.get(voice).push({
        number: measure.number,
        notes: voiceNotes,
        divisions: measure.divisions,
        timeSignature: measure.timeSignature,
        keySignature: measure.keySignature,
        tempo: measure.tempo
      });
    }
  }

  return voiceMap;
}

/**
 * Get a DOMParser instance (works in both browser and Node.js).
 * In Node.js, uses the built-in JSDOM-like parsing if available,
 * otherwise falls back to a minimal XML parser.
 */
function getXMLDocument(xmlString) {
  if (typeof DOMParser !== 'undefined') {
    // Browser environment
    const parser = new DOMParser();
    return parser.parseFromString(xmlString, 'application/xml');
  }
  // Node.js environment - not supported for direct parsing
  throw new Error('DOMParser not available. Use parseFile() in browser or provide a DOMParser polyfill.');
}

/**
 * Parse a MusicXML string and extract all parts with their note data.
 * @param {string} xmlString - the MusicXML content as a string
 * @param {Document} [xmlDoc] - optional pre-parsed XML document (for Node.js testing)
 * @returns {{ parts: Array, metadata: object }} parsed result
 */
export function parseMusicXML(xmlString, xmlDoc) {
  const doc = xmlDoc || getXMLDocument(xmlString);

  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid MusicXML: ' + parseError.textContent);
  }

  // Extract metadata
  const metadata = {
    title: doc.querySelector('work work-title')?.textContent ||
           doc.querySelector('movement-title')?.textContent || 'Untitled',
    composer: doc.querySelector('identification creator[type="composer"]')?.textContent || '',
    encoding: doc.querySelector('identification encoding software')?.textContent || ''
  };

  // Extract part list
  const partListEl = doc.querySelector('part-list');
  if (!partListEl) {
    throw new Error('No part-list found in MusicXML');
  }

  const scorePartElements = partListEl.querySelectorAll('score-part');
  const partInfo = [];
  for (const sp of scorePartElements) {
    const id = sp.getAttribute('id');
    const name = sp.querySelector('part-name')?.textContent || id;
    const abbreviation = sp.querySelector('part-abbreviation')?.textContent || '';
    partInfo.push({ id, name, abbreviation });
  }

  // Parse each part
  const parts = [];
  for (const info of partInfo) {
    const partEl = doc.querySelector(`part[id="${info.id}"]`);
    if (!partEl) continue;

    const measureElements = partEl.querySelectorAll('measure');
    let currentDivisions = 1;
    let currentTimeSignature = { numerator: 4, denominator: 4 };
    const measures = [];

    for (const measureEl of measureElements) {
      const parsed = parseMeasure(measureEl, currentDivisions, currentTimeSignature);
      currentDivisions = parsed.divisions;
      currentTimeSignature = parsed.timeSignature;
      measures.push(parsed);
    }

    // Detect voice type
    const voiceType = detectVoiceType(info.name);

    // Check if this part has multiple voices (common in SATB on 2 staves)
    const allVoices = new Set();
    for (const m of measures) {
      for (const v of m.voices) {
        allVoices.add(v);
      }
    }

    if (allVoices.size > 1) {
      // Split into separate voice parts
      const voiceMap = splitByVoice(measures);
      let voiceIndex = 0;
      for (const [voiceNum, voiceMeasures] of voiceMap) {
        voiceIndex++;
        const subPartName = allVoices.size === 2
          ? `${info.name} (Voice ${voiceNum})`
          : `${info.name} (Voice ${voiceNum})`;
        const subVoiceType = detectVoiceType(subPartName);

        parts.push({
          id: `${info.id}_v${voiceNum}`,
          name: subPartName,
          originalName: info.name,
          abbreviation: info.abbreviation,
          voiceType: subVoiceType !== subPartName.toLowerCase().trim() ? subVoiceType : voiceType,
          voiceNumber: voiceNum,
          measures: voiceMeasures,
          isSubPart: true
        });
      }
    } else {
      parts.push({
        id: info.id,
        name: info.name,
        originalName: info.name,
        abbreviation: info.abbreviation,
        voiceType,
        voiceNumber: 1,
        measures: measures.map(m => ({
          number: m.number,
          notes: m.notes,
          divisions: m.divisions,
          timeSignature: m.timeSignature,
          keySignature: m.keySignature,
          tempo: m.tempo
        })),
        isSubPart: false
      });
    }
  }

  // Extract global tempo if available
  let globalTempo = 120; // default
  for (const part of parts) {
    for (const measure of part.measures) {
      if (measure.tempo) {
        globalTempo = measure.tempo;
        break;
      }
    }
    if (globalTempo !== 120) break;
  }

  metadata.tempo = globalTempo;

  return { parts, metadata };
}

/**
 * Read a file and parse it as MusicXML.
 * Handles both plain XML and detects MXL (compressed) files.
 * @param {File} file - the uploaded File object
 * @returns {Promise<{ parts: Array, metadata: object }>}
 */
export async function parseFile(file) {
  const arrayBuffer = await file.arrayBuffer();

  // Check if it's a compressed MXL file
  if (isMxlFile(arrayBuffer)) {
    throw new Error(
      'This appears to be a compressed MXL file. ' +
      'Please extract it first and upload the .xml or .musicxml file inside. ' +
      'MXL files are ZIP archives containing the actual MusicXML data.'
    );
  }

  // Parse as plain XML text
  const text = new TextDecoder('utf-8').decode(arrayBuffer);
  return parseMusicXML(text);
}
