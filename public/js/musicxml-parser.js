/**
 * MusicXML Parser Module
 * Parses MusicXML files and extracts voice parts with their note data.
 * Dynamically detects part types using string matching heuristics.
 */

import { interpretDynamicNames, velocityFromSoundDynamics } from './dynamics.js';
import { buildRepeatPlan, isStraightThrough } from './repeats.js';
import { buildTempoMap } from './tempo-map.js';

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
 * Single-letter abbreviations for the standard choral voices. Used to expand
 * compound labels such as "S/A", "T/B" or the glued form "SATB".
 */
const VOICE_LETTER_TYPES = { S: 'soprano', A: 'alto', T: 'tenor', B: 'bass', M: 'mezzo-soprano' };

/**
 * Match a name against the known voice-type patterns.
 * @param {string} name
 * @returns {string|null} canonical voice type, or null when nothing matches
 */
function matchVoiceType(name) {
  if (!name) return null;
  for (const { pattern, type } of VOICE_TYPE_PATTERNS) {
    if (pattern.test(name)) {
      return type;
    }
  }
  return null;
}

/**
 * Detect voice type from a part name using heuristics.
 * @param {string} partName - the part name from MusicXML
 * @returns {string} detected voice type or the original name if unknown
 */
export function detectVoiceType(partName) {
  if (!partName) return 'unknown';
  // Return the original name lowercase if no pattern matches.
  return matchVoiceType(partName) || partName.toLowerCase().trim();
}

/**
 * Detect whether a MusicXML part represents a piano or keyboard-piano part.
 * Explicit instrument metadata takes precedence, while the part name remains
 * a useful fallback for scores that only label the staff "Piano".
 *
 * @param {string} partName
 * @param {Array<string>} instrumentNames
 * @param {Array<string>} instrumentSounds
 * @param {Array<number>} midiPrograms - General MIDI programs, 1-based
 * @returns {boolean}
 */
export function detectPianoPart(
  partName = '',
  instrumentNames = [],
  instrumentSounds = [],
  midiPrograms = []
) {
  const text = [partName, ...instrumentNames, ...instrumentSounds]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\bpiano\b|pianoforte|keyboard[._\s-]*piano/.test(text)) {
    return true;
  }

  // General MIDI programs 1–8 are the acoustic/electric piano family.
  return midiPrograms.some(program => {
    const number = Number(program);
    return Number.isInteger(number) && number >= 1 && number <= 8;
  });
}

/**
 * Expand a possibly-compound part label into an ordered list of voice types.
 *
 * Closed/condensed scores name a shared staff for several voices at once, e.g.
 * "S/A", "T/B", "Sop/Alto", or the glued form "SATB". Each token maps to one
 * voice, in written (top-to-bottom) order. Tokens that aren't recognizable
 * voices become null so a voice's position in the list is still preserved.
 *
 * @param {string} label
 * @returns {Array<string|null>}
 */
function expandVoiceLabel(label) {
  if (!label) return [];
  // Drop any "(Voice N)" tag the voice splitter appends before tokenizing.
  const base = String(label).replace(/\(\s*voice\s*\d+\s*\)/i, '').trim();
  const tokens = base.split(/[\/\\+,&·•|\-\s]+/).filter(Boolean);
  const types = [];

  for (const token of tokens) {
    const matched = matchVoiceType(token);
    if (matched) {
      types.push(matched);
      continue;
    }
    // A glued abbreviation such as "SATB", "SA" or "TB" carries one voice per
    // letter. Word matches are tried first, so real words like "Bass" never
    // reach this branch and get mis-split into letters.
    const letters = token.toUpperCase();
    if (/^[SATBM]+$/.test(letters)) {
      for (const letter of letters) types.push(VOICE_LETTER_TYPES[letter]);
    } else {
      types.push(null);
    }
  }
  return types;
}

/**
 * Resolve the voice type for one split voice of a compound part.
 * @param {string} baseName - the parent part name, e.g. "S/A"
 * @param {number} voiceOrdinal - 0-based order of this voice within the part
 * @returns {string|null} canonical voice type, or null when unresolved
 */
function resolveCompoundVoiceType(baseName, voiceOrdinal) {
  const expanded = expandVoiceLabel(baseName);
  if (expanded.length === 0) return null;
  // A single-section label (e.g. "S" split a2) applies to every sub-voice.
  if (expanded.length === 1) return expanded[0];
  return expanded[voiceOrdinal] || null;
}

/**
 * Extract explicit per-voice display names from a shared MusicXML part name.
 * Exported names use " / " as the separator. Other common score separators
 * are accepted for compatibility, while spaces and hyphens remain part of a
 * name (for example "Mezzo Soprano" and "Mezzo-Soprano").
 *
 * @param {string} label
 * @returns {Array<string>}
 */
export function expandCompoundVoiceNames(label) {
  if (!label) return [];
  const names = String(label)
    .split(/\s*(?:\/|\\|\+|&|·|•|\||,)\s*/)
    .map(name => name.trim())
    .filter(Boolean);
  return names.length > 1 ? names : [];
}

/**
 * Build the source MusicXML part-name values for the app's logical parts.
 * Multiple split voices are combined into one explicit compound label.
 *
 * @param {Array} parts
 * @returns {Map<string, string>}
 */
export function buildPartNameUpdates(parts = []) {
  const groupedPartNames = new Map();
  for (const part of parts) {
    const xmlId = part.sourcePartId || part.id.replace(/_v\d+$/, '');
    if (!groupedPartNames.has(xmlId)) groupedPartNames.set(xmlId, []);
    groupedPartNames.get(xmlId).push({
      name: String(part.name || '').trim(),
      voiceNumber: Number(part.voiceNumber) || 1
    });
  }

  const updates = new Map();
  for (const [xmlId, names] of groupedPartNames) {
    names.sort((a, b) => a.voiceNumber - b.voiceNumber);
    updates.set(xmlId, names.map(item => item.name).join(' / '));
  }
  return updates;
}

/**
 * Check if file data is a compressed MXL file (ZIP format).
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {boolean}
 */
export function isMxlFile(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return false;
  return ZIP_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * List the files inside a ZIP archive.
 *
 * Compressed MusicXML (.mxl) is what most notation software exports, so the app
 * reads the container itself instead of asking singers to unzip it. Only the
 * central directory is parsed, which is the authoritative index of a ZIP file.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Array<{ name: string, method: number, compressedSize: number, uncompressedSize: number, dataStart: number }>}
 */
export function listZipEntries(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');

  // Locate the end-of-central-directory record by scanning backwards over the
  // maximum comment length.
  let endOffset = -1;
  const scanFloor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= scanFloor; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('This file is not a readable compressed archive.');

  const entryCount = view.getUint16(endOffset + 10, true);
  let cursor = view.getUint32(endOffset + 16, true);
  const entries = [];
  const ZIP64_MARKER = 0xffffffff;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER ||
        localOffset === ZIP64_MARKER) {
      throw new Error('This archive uses the ZIP64 format, which is not supported.');
    }
    if (localOffset + 30 > bytes.length) {
      throw new Error('The compressed archive is damaged.');
    }

    // The local header repeats the name and extra fields before the payload.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new Error('The compressed archive is damaged.');
    }

    entries.push({ name, method, compressedSize, uncompressedSize, dataStart });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length === 0) throw new Error('The compressed archive is empty.');
  return entries;
}

/**
 * Choose which archive member holds the score.
 * META-INF/container.xml is authoritative when present; otherwise the first
 * XML member outside META-INF is used.
 *
 * @param {Array<{ name: string }>} entries
 * @param {string|null} containerXml
 * @returns {string|null} entry name
 */
export function selectScoreEntryName(entries, containerXml = null) {
  const names = entries.map(entry => entry.name);
  const rootPath = containerXml?.match(/full-path\s*=\s*"([^"]+)"/i)?.[1];
  if (rootPath && names.includes(rootPath)) return rootPath;

  const candidates = names.filter(name =>
    !name.startsWith('META-INF/') &&
    !name.endsWith('/') &&
    /\.(musicxml|xml)$/i.test(name)
  );
  return candidates[0] || null;
}

/**
 * Read one archive member as UTF-8 text.
 * @param {Uint8Array} bytes whole archive
 * @param {{ method: number, compressedSize: number, dataStart: number }} entry
 * @returns {Promise<string>}
 */
export async function readZipEntryText(bytes, entry) {
  const payload = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder('utf-8').decode(payload);
  if (entry.method !== 8) {
    throw new Error('This archive uses an unsupported compression method.');
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot open compressed MusicXML files.');
  }

  const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/**
 * Extract the MusicXML text from a compressed .mxl archive.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<string>}
 */
export async function readMxl(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = listZipEntries(bytes);
  const containerEntry = entries.find(entry => entry.name === 'META-INF/container.xml');
  const containerXml = containerEntry ? await readZipEntryText(bytes, containerEntry) : null;
  const scoreName = selectScoreEntryName(entries, containerXml);
  const scoreEntry = entries.find(entry => entry.name === scoreName);
  if (!scoreEntry) {
    throw new Error('No MusicXML score was found inside this archive.');
  }
  return readZipEntryText(bytes, scoreEntry);
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
 * Make a plain-object copy of the currently active clefs, keyed by staff.
 * MusicXML clefs remain active until another <clef> changes them.
 * @param {Object<number, object>} clefs
 * @returns {Object<number, object>}
 */
function cloneClefs(clefs = {}) {
  const copy = {};
  for (const [staff, clef] of Object.entries(clefs)) {
    copy[staff] = { ...clef };
  }
  return copy;
}

/**
 * Parse a MusicXML <clef> into the small descriptor used by the renderer.
 * @param {Element} clefEl
 * @returns {{ sign: string, line: number, octaveChange: number, staff: number }}
 */
function parseClef(clefEl) {
  const sign = (clefEl.querySelector('sign')?.textContent || 'G').trim().toUpperCase();
  const defaultLine = sign === 'F' ? 4 : sign === 'C' ? 3 : 2;
  const staff = parseInt(clefEl.getAttribute('number') || '1', 10) || 1;
  const line = parseInt(clefEl.querySelector('line')?.textContent || String(defaultLine), 10) || defaultLine;
  const octaveChange = parseInt(clefEl.querySelector('clef-octave-change')?.textContent || '0', 10) || 0;
  return { sign, line, octaveChange, staff };
}

/**
 * How many quarter notes one written note value lasts. Used to convert a
 * metronome mark such as "dotted half = 60" into quarter-note beats per minute,
 * which is the unit the whole app measures tempo in.
 */
const NOTE_TYPE_QUARTERS = {
  maxima: 32,
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
  '256th': 0.015625
};

/**
 * Parse a MusicXML <transpose> into a semitone offset.
 *
 * A transposing part writes one pitch and sounds another. The renderer wants the
 * written pitch and playback wants the sounding one, so the difference is kept
 * beside the part rather than baked into either.
 *
 * @param {Element} transposeEl
 * @returns {{ diatonic: number, chromatic: number, octaveChange: number, semitones: number }}
 */
function parseTranspose(transposeEl) {
  const readInt = (selector) =>
    parseInt(transposeEl.querySelector(selector)?.textContent || '0', 10) || 0;
  const diatonic = readInt('diatonic');
  const chromatic = readInt('chromatic');
  const octaveChange = readInt('octave-change');
  return {
    diatonic,
    chromatic,
    octaveChange,
    semitones: chromatic + octaveChange * 12
  };
}

/**
 * Convert a <metronome> element to quarter-note beats per minute.
 * @param {Element} metronomeEl
 * @returns {{ bpm: number|null, beatUnit: string|null, perMinute: number|null, dots: number }}
 */
function parseMetronome(metronomeEl) {
  const beatUnit = metronomeEl.querySelector('beat-unit')?.textContent?.trim().toLowerCase() || null;
  const perMinute = parseFloat(metronomeEl.querySelector('per-minute')?.textContent || '');
  const dots = metronomeEl.querySelectorAll('beat-unit-dot').length;

  if (!beatUnit || !Number.isFinite(perMinute) || perMinute <= 0) {
    return { bpm: null, beatUnit, perMinute: Number.isFinite(perMinute) ? perMinute : null, dots };
  }

  const base = NOTE_TYPE_QUARTERS[beatUnit];
  if (!base) return { bpm: null, beatUnit, perMinute, dots };

  // Each dot adds half of the remaining value: one dot is 1.5x, two is 1.75x.
  const dotFactor = 2 - Math.pow(0.5, dots);
  return { bpm: perMinute * base * dotFactor, beatUnit, perMinute, dots };
}

/**
 * Parse one <direction> element into a positioned direction event.
 *
 * Directions carry almost everything a singer reads that is not a note: the
 * dynamic markings, the hairpins, the tempo words, and the rehearsal letters.
 * They are returned as events so `layoutMeasure` can give each one the beat it
 * actually falls on, including any `<offset>`.
 *
 * @param {Element} directionEl
 * @returns {object} a single event with kind 'direction'
 */
function parseDirection(directionEl) {
  const event = {
    kind: 'direction',
    offset: parseInt(directionEl.querySelector('offset')?.textContent || '0', 10) || 0,
    placement: directionEl.getAttribute('placement') || null,
    staff: parseInt(directionEl.querySelector('staff')?.textContent || '1', 10) || 1,
    dynamics: null,
    wedge: null,
    words: null,
    rehearsal: null,
    metronome: null,
    tempo: null,
    soundDynamics: null,
    navigation: []
  };

  for (const typeEl of directionEl.querySelectorAll('direction-type')) {
    for (const child of Array.from(typeEl.children)) {
      const tag = child.tagName.toLowerCase();

      if (tag === 'dynamics') {
        const names = Array.from(child.children).map(element => element.tagName.toLowerCase());
        const other = child.querySelector('other-dynamics')?.textContent || '';
        const interpreted = interpretDynamicNames(names, other);
        event.dynamics = {
          ...interpreted,
          text: names.filter(name => name !== 'other-dynamics').join('') || other.trim()
        };
      } else if (tag === 'wedge') {
        event.wedge = {
          type: (child.getAttribute('type') || 'crescendo').toLowerCase(),
          number: parseInt(child.getAttribute('number') || '1', 10) || 1,
          spread: parseFloat(child.getAttribute('spread') || '') || null
        };
      } else if (tag === 'words') {
        const text = child.textContent.trim();
        if (text) event.words = event.words ? `${event.words} ${text}` : text;
      } else if (tag === 'rehearsal') {
        const text = child.textContent.trim();
        if (text) event.rehearsal = text;
      } else if (tag === 'metronome') {
        event.metronome = parseMetronome(child);
      }
    }
  }

  const soundEl = directionEl.querySelector('sound');
  if (soundEl) {
    Object.assign(event, readSoundElement(soundEl, event));
  }

  // A written metronome mark is a tempo instruction even without a <sound>.
  if (event.tempo === null && Number.isFinite(event.metronome?.bpm)) {
    event.tempo = event.metronome.bpm;
  }

  return event;
}

/**
 * Read the playback hints on a <sound> element.
 * @param {Element} soundEl
 * @param {object} [base] existing values to preserve
 * @returns {{ tempo: number|null, soundDynamics: number|null, navigation: Array<string> }}
 */
function readSoundElement(soundEl, base = {}) {
  const tempoAttribute = parseFloat(soundEl.getAttribute('tempo') || '');
  const dynamicsAttribute = soundEl.getAttribute('dynamics');
  const navigation = [...(base.navigation || [])];

  for (const attribute of ['dacapo', 'dalsegno', 'tocoda', 'fine', 'segno', 'coda']) {
    if (soundEl.hasAttribute(attribute)) navigation.push(attribute);
  }

  return {
    tempo: Number.isFinite(tempoAttribute) && tempoAttribute > 0 ? tempoAttribute : (base.tempo ?? null),
    soundDynamics: dynamicsAttribute !== null
      ? velocityFromSoundDynamics(dynamicsAttribute)
      : (base.soundDynamics ?? null),
    navigation
  };
}

/**
 * Parse one <barline> element.
 *
 * Barlines carry the performance structure (repeat signs and numbered endings)
 * as well as how the line is drawn, and both matter: the first decides the order
 * bars are sung in, the second is what makes a score look like a score.
 *
 * @param {Element} barlineEl
 * @returns {object}
 */
function parseBarline(barlineEl) {
  const location = barlineEl.getAttribute('location') || 'right';
  const style = barlineEl.querySelector('bar-style')?.textContent?.trim().toLowerCase() || null;

  const repeatEl = barlineEl.querySelector('repeat');
  const repeat = repeatEl
    ? {
      direction: (repeatEl.getAttribute('direction') || 'backward').toLowerCase(),
      times: parseInt(repeatEl.getAttribute('times') || '', 10) || null,
      winged: repeatEl.getAttribute('winged') || null
    }
    : null;

  const endingEl = barlineEl.querySelector('ending');
  const ending = endingEl
    ? {
      numbers: String(endingEl.getAttribute('number') || '')
        .split(/[,\s]+/)
        .map(value => parseInt(value, 10))
        .filter(Number.isFinite),
      type: (endingEl.getAttribute('type') || 'start').toLowerCase(),
      text: endingEl.textContent.trim() || null
    }
    : null;

  const fermatas = [];
  for (const fermataEl of barlineEl.querySelectorAll('fermata')) {
    const type = fermataEl.getAttribute('type') || 'upright';
    fermatas.push({
      type,
      shape: fermataEl.textContent.trim() || 'normal',
      placement: fermataEl.getAttribute('placement') || (type === 'inverted' ? 'below' : 'above'),
      location
    });
  }

  return { location, style, repeat, ending, fermatas };
}

/**
 * Find the staff used most often by a parsed part or split voice.
 * @param {Array} measures
 * @returns {number}
 */
function findPrimaryStaff(measures) {
  const counts = new Map();
  for (const measure of measures) {
    for (const note of measure.notes) {
      const staff = note.staff || 1;
      counts.set(staff, (counts.get(staff) || 0) + 1);
    }
  }

  let primaryStaff = 1;
  let highestCount = -1;
  for (const [staff, count] of counts) {
    if (count > highestCount) {
      primaryStaff = staff;
      highestCount = count;
    }
  }
  return primaryStaff;
}

/**
 * Find the first active clef for a staff in a part or split voice.
 * @param {Array} measures
 * @param {number} staff
 * @returns {object|null}
 */
function findClefForStaff(measures, staff) {
  for (const measure of measures) {
    const noteWithClef = measure.notes.find(note => note.staff === staff && note.clef);
    if (noteWithClef) return { ...noteWithClef.clef };
    if (measure.clefs?.[staff]) return { ...measure.clefs[staff] };
  }
  return null;
}

/**
 * Lay out a measure's timing from an ordered list of timing events.
 *
 * This is the canonical MusicXML timing model: the <duration> value (measured
 * in divisions per quarter note) is the single source of truth for how long a
 * note sounds. Using it directly makes every note type correct - tuplets,
 * dotted/double-dotted notes, breves, etc. - because <duration> already encodes
 * the sounding length regardless of the visual <type>. A moving cursor honours
 * <backup>/<forward> so multiple voices and staves line up, chords share their
 * onset with the preceding note, and grace notes take no time.
 *
 * Pure (no DOM) so it can be unit tested directly.
 *
 * @param {Array} events - ordered events: { kind: 'note'|'backup'|'forward'|'direction', ... }
 * @param {number} divisions - divisions per quarter note for this measure
 * @returns {{ notes: Array, directions: Array, beats: number }} notes and directions
 *   with timing, plus the measure length in beats
 */
export function layoutMeasure(events, divisions) {
  const div = divisions > 0 ? divisions : 1;
  const notes = [];
  const directions = [];
  let cursor = 0;       // current time position within the measure, in divisions
  let maxCursor = 0;    // furthest point reached (= measure length)
  let lastStart = 0;    // onset of the last non-chord note, so chords can share it

  for (const ev of events) {
    if (ev.kind === 'backup') {
      cursor = Math.max(0, cursor - (ev.duration || 0));
      continue;
    }
    if (ev.kind === 'forward') {
      cursor += ev.duration || 0;
      if (cursor > maxCursor) maxCursor = cursor;
      continue;
    }
    if (ev.kind === 'direction') {
      // A direction sounds at the cursor, shifted by its own <offset>. It takes
      // no time of its own, so the cursor does not move.
      const { kind, offset, ...rest } = ev;
      const startDiv = Math.max(0, cursor + (offset || 0));
      directions.push({ ...rest, startBeatInMeasure: startDiv / div });
      continue;
    }

    // kind === 'note'
    const isChord = !!ev.isChord;
    const isGrace = !!ev.isGrace;
    const duration = ev.duration || 0;
    const startDiv = isChord ? lastStart : cursor;

    const note = {
      isRest: !!ev.isRest,
      isChord,
      isGrace,
      voice: ev.voice,
      staff: ev.staff,
      duration,
      type: ev.type,
      dots: ev.dots,
      durationBeats: duration / div,
      startBeatInMeasure: startDiv / div,
      staccato: !!ev.staccato
    };
    if (ev.staccatissimo) note.staccatissimo = true;
    if (ev.accent) note.accent = true;
    if (ev.strongAccent) note.strongAccent = true;
    if (ev.tenuto) note.tenuto = true;
    if (ev.breathMark) note.breathMark = true;
    if (ev.caesura) note.caesura = true;
    if (ev.ornaments) note.ornaments = [...ev.ornaments];
    if (ev.noteDynamics) note.noteDynamics = { ...ev.noteDynamics };
    if (ev.pitch) note.pitch = { ...ev.pitch };
    if (ev.lyric) note.lyric = { ...ev.lyric };
    if (ev.lyrics) note.lyrics = ev.lyrics.map(lyric => ({ ...lyric }));
    if (ev.tie) note.tie = { ...ev.tie };
    if (ev.ties) note.ties = ev.ties.map(tie => ({ ...tie }));
    if (ev.stem) note.stem = ev.stem;
    if (ev.beams) note.beams = ev.beams.map(beam => ({ ...beam }));
    if (ev.timeModification) note.timeModification = { ...ev.timeModification };
    if (ev.tuplets) note.tuplets = ev.tuplets.map(tuplet => ({ ...tuplet }));
    if (ev.slurs) note.slurs = ev.slurs.map(slur => ({ ...slur }));
    if (ev.fermata) note.fermata = { ...ev.fermata };
    if (ev.clef) note.clef = { ...ev.clef };

    notes.push(note);

    if (!isChord) lastStart = startDiv;
    // Chords and grace notes do not advance the time cursor.
    if (!isChord && !isGrace) {
      cursor = startDiv + duration;
      if (cursor > maxCursor) maxCursor = cursor;
    }
  }

  return { notes, directions, beats: maxCursor / div };
}

/**
 * Parse a single measure element into timing events, then lay them out.
 * @param {Element} measureEl - the <measure> element
 * @param {number} currentDivisions - current divisions value
 * @param {{ numerator: number, denominator: number }} currentTimeSignature
 * @param {Object<number, object>} currentClefs - clefs inherited from the previous measure
 * @returns {{ notes: Array, divisions: number, timeSignature: object, keySignature: object|null, tempo: number|null, voices: Set, beats: number, clefs: Object }}
 */
function parseMeasure(measureEl, currentDivisions, currentTimeSignature, currentClefs = {}) {
  const clefs = cloneClefs(currentClefs);
  const result = {
    number: parseInt(measureEl.getAttribute('number') || '1', 10),
    // A pickup bar is shorter than its time signature and is conventionally
    // unnumbered, which is worth knowing when labelling bars for the singer.
    isPickup: measureEl.getAttribute('implicit') === 'yes',
    notes: [],
    directions: [],
    divisions: currentDivisions,
    timeSignature: currentTimeSignature,
    keySignature: null,
    tempo: null,
    transpose: null,
    voices: new Set(),
    beats: 0,
    barlines: [],
    barlineFermatas: [],
    navigation: [],
    clefs: cloneClefs(clefs)
  };

  let divisions = currentDivisions;
  const events = [];

  // Walk the measure's direct children in document order so <backup>/<forward>
  // are interleaved with notes exactly as written.
  for (const child of Array.from(measureEl.children)) {
    const tag = child.tagName.toLowerCase();

    if (tag === 'attributes') {
      const divisionsEl = child.querySelector('divisions');
      if (divisionsEl) {
        divisions = parseInt(divisionsEl.textContent, 10) || divisions;
      }
      const timeEl = child.querySelector('time');
      if (timeEl) {
        result.timeSignature = {
          numerator: parseInt(timeEl.querySelector('beats')?.textContent || '4', 10),
          denominator: parseInt(timeEl.querySelector('beat-type')?.textContent || '4', 10)
        };
      }
      const keyEl = child.querySelector('key');
      if (keyEl) {
        result.keySignature = {
          fifths: parseInt(keyEl.querySelector('fifths')?.textContent || '0', 10),
          mode: keyEl.querySelector('mode')?.textContent || 'major'
        };
      }
      for (const clefEl of child.querySelectorAll('clef')) {
        const clef = parseClef(clefEl);
        clefs[clef.staff] = clef;
      }
      const transposeEl = child.querySelector('transpose');
      if (transposeEl) result.transpose = parseTranspose(transposeEl);
    } else if (tag === 'direction') {
      const direction = parseDirection(child);
      events.push(direction);
      // Kept for callers that only need "the tempo somewhere in this measure".
      if (direction.tempo !== null && result.tempo === null) result.tempo = direction.tempo;
      if (direction.navigation.length) result.navigation.push(...direction.navigation);
    } else if (tag === 'sound') {
      const sound = readSoundElement(child);
      events.push({
        kind: 'direction',
        offset: 0,
        placement: null,
        staff: 1,
        dynamics: null,
        wedge: null,
        words: null,
        rehearsal: null,
        metronome: null,
        ...sound
      });
      if (sound.tempo !== null && result.tempo === null) result.tempo = sound.tempo;
      if (sound.navigation.length) result.navigation.push(...sound.navigation);
    } else if (tag === 'barline') {
      const barline = parseBarline(child);
      result.barlines.push(barline);
      // Barline fermatas keep their own list because the hold they create is
      // timed from the barline rather than from a note.
      result.barlineFermatas.push(...barline.fermatas);
    } else if (tag === 'backup') {
      events.push({ kind: 'backup', duration: parseInt(child.querySelector('duration')?.textContent || '0', 10) });
    } else if (tag === 'forward') {
      events.push({ kind: 'forward', duration: parseInt(child.querySelector('duration')?.textContent || '0', 10) });
    } else if (tag === 'note') {
      const isRest = child.querySelector('rest') !== null;
      const isChord = child.querySelector('chord') !== null;
      const isGrace = child.querySelector('grace') !== null;
      const voice = parseInt(child.querySelector('voice')?.textContent || '1', 10);
      const staff = parseInt(child.querySelector('staff')?.textContent || '1', 10);
      // Grace notes have no <duration>; everything else does.
      const durationEl = child.querySelector('duration');
      const duration = durationEl ? parseInt(durationEl.textContent, 10) : 0;
      const type = child.querySelector('type')?.textContent || null;
      const dots = child.querySelectorAll('dot').length;

      result.voices.add(voice);

      const ev = { kind: 'note', isRest, isChord, isGrace, voice, staff, duration, type, dots };
      if (clefs[staff]) ev.clef = { ...clefs[staff] };

      if (!isRest) {
        const pitchEl = child.querySelector('pitch');
        if (pitchEl) ev.pitch = parsePitch(pitchEl);
      }

      // Every verse, not just the first. A hymn or a strophic part song carries
      // several, and a singer rehearsing verse three needs verse three.
      const lyricEls = Array.from(child.querySelectorAll('lyric'));
      if (lyricEls.length) {
        const lyrics = lyricEls.map((lyricEl, lyricIndex) => {
          // One <lyric> can hold several <text> runs joined by <elision>, which
          // is how two words sung on one note are written.
          const textParts = Array.from(lyricEl.querySelectorAll('text'))
            .map(element => element.textContent || '');
          const elisions = Array.from(lyricEl.querySelectorAll('elision'))
            .map(element => element.textContent || ' ');
          let text = textParts[0] || '';
          for (let part = 1; part < textParts.length; part++) {
            text += (elisions[part - 1] ?? ' ') + textParts[part];
          }
          return {
            number: parseInt(lyricEl.getAttribute('number') || String(lyricIndex + 1), 10) ||
              lyricIndex + 1,
            name: lyricEl.getAttribute('name') || null,
            text,
            syllabic: lyricEl.querySelector('syllabic')?.textContent || 'single',
            extend: lyricEl.querySelector('extend') !== null,
            hasElision: elisions.length > 0
          };
        }).sort((left, right) => left.number - right.number);

        ev.lyrics = lyrics;
        // The single-verse field stays for the vowel logic and anything else
        // that only ever wanted the top line.
        ev.lyric = { text: lyrics[0].text, syllabic: lyrics[0].syllabic };
      }

      // Preserve the source stem and beam state so short notes can be drawn as
      // one connected group instead of as individually flagged notes.
      const stemEl = child.querySelector('stem');
      if (stemEl?.textContent.trim()) {
        ev.stem = stemEl.textContent.trim().toLowerCase();
      }

      const beamEls = Array.from(child.querySelectorAll('beam'));
      if (beamEls.length) {
        ev.beams = beamEls.map(beam => ({
          number: parseInt(beam.getAttribute('number') || '1', 10),
          type: beam.textContent.trim().toLowerCase(),
          repeater: beam.getAttribute('repeater') === 'yes',
          fan: beam.getAttribute('fan') || null
        }));
      }

      const timeModificationEl = child.querySelector('time-modification');
      if (timeModificationEl) {
        const normalDots = timeModificationEl.querySelectorAll('normal-dot').length;
        ev.timeModification = {
          actualNotes: parseInt(timeModificationEl.querySelector('actual-notes')?.textContent || '0', 10),
          normalNotes: parseInt(timeModificationEl.querySelector('normal-notes')?.textContent || '0', 10),
          normalType: timeModificationEl.querySelector('normal-type')?.textContent?.trim() || null,
          normalDots
        };
      }

      const notationsEl = child.querySelector('notations');
      if (notationsEl) {
        const tupletEls = Array.from(notationsEl.querySelectorAll('tuplet'));
        if (tupletEls.length) {
          ev.tuplets = tupletEls.map(tuplet => ({
            type: tuplet.getAttribute('type') || 'start',
            number: parseInt(tuplet.getAttribute('number') || '1', 10),
            bracket: tuplet.getAttribute('bracket'),
            showNumber: tuplet.getAttribute('show-number') || 'actual',
            showType: tuplet.getAttribute('show-type') || 'none',
            placement: tuplet.getAttribute('placement') || null,
            lineShape: tuplet.getAttribute('line-shape') || null
          }));
        }

        const slurEls = Array.from(notationsEl.querySelectorAll('slur'));
        if (slurEls.length) {
          ev.slurs = slurEls.map(slur => ({
            type: slur.getAttribute('type') || 'start',
            number: parseInt(slur.getAttribute('number') || '1', 10),
            placement: slur.getAttribute('placement') || null,
            lineType: slur.getAttribute('line-type') || 'solid'
          }));
        }

        // Articulations change how a note is sung rather than which note it is,
        // so each one playback can act on is preserved separately.
        const articulationsEl = notationsEl.querySelector('articulations');
        if (articulationsEl) {
          if (articulationsEl.querySelector('staccato')) ev.staccato = true;
          if (articulationsEl.querySelector('staccatissimo')) {
            ev.staccato = true;
            ev.staccatissimo = true;
          }
          if (articulationsEl.querySelector('accent')) ev.accent = true;
          if (articulationsEl.querySelector('strong-accent')) ev.strongAccent = true;
          if (articulationsEl.querySelector('tenuto')) ev.tenuto = true;
          if (articulationsEl.querySelector('breath-mark')) ev.breathMark = true;
          if (articulationsEl.querySelector('caesura')) ev.caesura = true;
        }

        // Ornaments are drawn but not realised: a rendered trill that does not
        // match what a singer is told to sing is worse than no trill at all.
        const ornamentsEl = notationsEl.querySelector('ornaments');
        if (ornamentsEl) {
          const names = Array.from(ornamentsEl.children)
            .map(element => element.tagName.toLowerCase())
            .filter(name => name !== 'accidental-mark');
          if (names.length) ev.ornaments = names;
        }

        // A dynamic marking attached directly to a note, rather than written as
        // a separate direction.
        const noteDynamicsEl = notationsEl.querySelector('dynamics');
        if (noteDynamicsEl) {
          const names = Array.from(noteDynamicsEl.children)
            .map(element => element.tagName.toLowerCase());
          ev.noteDynamics = interpretDynamicNames(
            names,
            noteDynamicsEl.querySelector('other-dynamics')?.textContent || ''
          );
        }

        const fermataEl = notationsEl.querySelector('fermata');
        if (fermataEl) {
          const type = fermataEl.getAttribute('type') || 'upright';
          ev.fermata = {
            type,
            shape: fermataEl.textContent.trim() || 'normal',
            placement: fermataEl.getAttribute('placement') || (type === 'inverted' ? 'below' : 'above')
          };
        }
      }

      // A note can carry two <tie> elements (stop then start). Some exporters
      // only emit the equivalent <notations><tied> elements, so merge both.
      const tieEls = Array.from(child.querySelectorAll('tie'));
      const tiedEls = notationsEl
        ? Array.from(notationsEl.querySelectorAll('tied'))
        : [];
      if (tieEls.length || tiedEls.length) {
        let start = false;
        let stop = false;
        for (const tie of [...tieEls, ...tiedEls]) {
          const tieType = tie.getAttribute('type');
          if (tieType === 'start') start = true;
          if (tieType === 'stop') stop = true;
        }
        ev.tie = { start, stop };
        if (tiedEls.length) {
          ev.ties = tiedEls.map(tied => ({
            type: tied.getAttribute('type') || 'start',
            number: parseInt(tied.getAttribute('number') || '1', 10),
            placement: tied.getAttribute('placement') || null,
            lineType: tied.getAttribute('line-type') || 'solid'
          }));
        }
      }

      events.push(ev);
    }
  }

  result.divisions = divisions;
  result.clefs = cloneClefs(clefs);
  const laid = layoutMeasure(events, divisions);
  result.notes = laid.notes;
  result.directions = laid.directions;
  result.beats = laid.beats;
  result.navigation = [...new Set(result.navigation)];
  return result;
}

/**
 * Split a part's measures by voice number (for multi-voice staves).
 * @param {Array} measures - array of parsed measures
 * @returns {Map<number, Array>} map of voice number to measures containing only that voice's notes
 */
function splitByVoice(measures) {
  const voiceMap = new Map();
  const voices = new Set();

  for (const measure of measures) {
    for (const voice of measure.voices) voices.add(voice);
  }

  // Preserve every measure for every voice, even when that voice is silent in
  // a measure. This keeps measure ordinals, shared barlines, and audio timing
  // aligned instead of shifting later measures left for one section.
  for (const voice of voices) {
    voiceMap.set(voice, measures.map(measure => ({
      number: measure.number,
      isPickup: measure.isPickup,
      // Forced stem directions are dropped. On a shared staff they encode "upper
      // voice up, lower voice down", which only means anything while the voices
      // sit together. Once each voice has a staff of its own those directions are
      // wrong: an alto line written low in a treble clef would keep its down
      // stems and hang three spaces below every notehead, straight through the
      // words. Clearing them lets the renderer choose by position, as it does for
      // any single-voice staff.
      notes: measure.notes
        .filter(note => note.voice === voice)
        .map(note => (note.stem === 'up' || note.stem === 'down'
          ? { ...note, stem: null }
          : note)),
      // Directions belong to the staff, not to one voice on it, so every split
      // voice keeps them. Dynamics and hairpins therefore still apply when a
      // condensed score is opened out into separate sections.
      directions: (measure.directions || []).map(direction => ({ ...direction })),
      divisions: measure.divisions,
      timeSignature: measure.timeSignature,
      keySignature: measure.keySignature,
      tempo: measure.tempo,
      transpose: measure.transpose ? { ...measure.transpose } : null,
      barlines: (measure.barlines || []).map(barline => ({
        ...barline,
        repeat: barline.repeat ? { ...barline.repeat } : null,
        ending: barline.ending ? { ...barline.ending, numbers: [...barline.ending.numbers] } : null,
        fermatas: barline.fermatas.map(fermata => ({ ...fermata }))
      })),
      barlineFermatas: measure.barlineFermatas.map(fermata => ({ ...fermata })),
      navigation: [...(measure.navigation || [])],
      clefs: cloneClefs(measure.clefs),
      startBeat: measure.startBeat,
      beats: measure.beats
    })));
  }

  return voiceMap;
}

/**
 * Give corresponding measures one canonical duration and absolute start across
 * every section. Empty measures fall back to their time signature so notation,
 * playback scheduling, the cursor, and barlines all advance together.
 * @param {Array} parts
 */
function normalizePartMeasureTimelines(parts) {
  const measureCount = Math.max(0, ...parts.map(part => part.measures?.length || 0));
  const sharedDurations = [];

  for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
    let duration = 0;
    let fallbackDuration = 0;
    for (const part of parts) {
      const measure = part.measures?.[measureIndex];
      if (!measure) continue;
      duration = Math.max(duration, Number(measure.beats) || 0);
      for (const note of measure.notes || []) {
        duration = Math.max(
          duration,
          (Number(note.startBeatInMeasure) || 0) + (Number(note.durationBeats) || 0)
        );
      }
      const numerator = Number(measure.timeSignature?.numerator);
      const denominator = Number(measure.timeSignature?.denominator);
      if (numerator > 0 && denominator > 0) {
        fallbackDuration = Math.max(fallbackDuration, numerator * 4 / denominator);
      }
    }
    sharedDurations.push(duration > 0 ? duration : fallbackDuration);
  }

  for (const part of parts) {
    let startBeat = 0;
    for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
      const duration = sharedDurations[measureIndex] || 0;
      const measure = part.measures?.[measureIndex];
      if (measure) {
        measure.startBeat = startBeat;
        measure.beats = duration;
      }
      startBeat += duration;
    }
  }
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
    throw new Error('This file could not be read as MusicXML. It may be damaged or in another format.');
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
    throw new Error('This MusicXML file has no part list, so there is nothing to practise.');
  }

  const scorePartElements = partListEl.querySelectorAll('score-part');
  const partInfo = [];
  for (const sp of scorePartElements) {
    const id = sp.getAttribute('id');
    const name = sp.querySelector('part-name')?.textContent || id;
    const abbreviation = sp.querySelector('part-abbreviation')?.textContent || '';
    const instrumentNames = Array.from(sp.querySelectorAll('instrument-name'))
      .map(element => element.textContent.trim())
      .filter(Boolean);
    const instrumentSounds = Array.from(sp.querySelectorAll('instrument-sound'))
      .map(element => element.textContent.trim())
      .filter(Boolean);
    const midiPrograms = Array.from(sp.querySelectorAll('midi-program'))
      .map(element => parseInt(element.textContent.trim(), 10))
      .filter(Number.isInteger);
    partInfo.push({
      id,
      name,
      abbreviation,
      instrumentNames,
      instrumentSounds,
      midiPrograms,
      isPiano: detectPianoPart(name, instrumentNames, instrumentSounds, midiPrograms)
    });
  }

  // Parse each part
  const parts = [];
  for (const info of partInfo) {
    const partEl = doc.querySelector(`part[id="${info.id}"]`);
    if (!partEl) continue;

    const measureElements = partEl.querySelectorAll('measure');
    let currentDivisions = 1;
    let currentTimeSignature = { numerator: 4, denominator: 4 };
    let currentClefs = {};
    const measures = [];

    for (const measureEl of measureElements) {
      const parsed = parseMeasure(measureEl, currentDivisions, currentTimeSignature, currentClefs);
      currentDivisions = parsed.divisions;
      currentTimeSignature = parsed.timeSignature;
      currentClefs = parsed.clefs;
      measures.push(parsed);
    }

    // Assign each measure an absolute start position (in quarter-note beats) by
    // accumulating measure lengths. Downstream code positions notes as
    // measure.startBeat + note.startBeatInMeasure.
    let beatAccumulator = 0;
    for (const m of measures) {
      m.startBeat = beatAccumulator;
      beatAccumulator += m.beats;
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
      // Split into separate voice parts while retaining each voice's source staff and clef.
      const voiceMap = splitByVoice(measures);
      // Order voices by their number so a compound label like "S/A" assigns its
      // first token to the upper voice, its second to the next, and so on.
      const voiceEntries = [...voiceMap.entries()].sort((a, b) => a[0] - b[0]);
      const compoundNames = expandCompoundVoiceNames(info.name);
      const hasPerVoiceNames = compoundNames.length === voiceEntries.length;
      voiceEntries.forEach(([voiceNum, voiceMeasures], voiceOrdinal) => {
        // A shared MusicXML part has only one <part-name>. When that name is a
        // compound label such as "Soprano / Alto", restore one display name per
        // logical voice. Otherwise retain the explicit voice-number suffix.
        const subPartName = hasPerVoiceNames
          ? compoundNames[voiceOrdinal]
          : `${info.name} (Voice ${voiceNum})`;
        const compoundType = resolveCompoundVoiceType(info.name, voiceOrdinal);
        const subVoiceType = compoundType || detectVoiceType(subPartName);
        const staffNumber = findPrimaryStaff(voiceMeasures);

        parts.push({
          id: `${info.id}_v${voiceNum}`,
          sourcePartId: info.id,
          name: subPartName,
          originalName: info.name,
          abbreviation: info.abbreviation,
          instrumentNames: [...info.instrumentNames],
          instrumentSounds: [...info.instrumentSounds],
          midiPrograms: [...info.midiPrograms],
          isPiano: info.isPiano,
          voiceType: subVoiceType,
          voiceNumber: voiceNum,
          staffNumber,
          clef: findClefForStaff(voiceMeasures, staffNumber),
          transpose: resolvePartTranspose(voiceMeasures),
          measures: voiceMeasures,
          isSubPart: true
        });
      });
    } else {
      const partMeasures = measures.map(m => ({
        number: m.number,
        isPickup: m.isPickup,
        notes: m.notes,
        directions: m.directions,
        divisions: m.divisions,
        timeSignature: m.timeSignature,
        keySignature: m.keySignature,
        tempo: m.tempo,
        transpose: m.transpose ? { ...m.transpose } : null,
        barlines: m.barlines,
        barlineFermatas: m.barlineFermatas.map(fermata => ({ ...fermata })),
        navigation: [...(m.navigation || [])],
        clefs: cloneClefs(m.clefs),
        startBeat: m.startBeat,
        beats: m.beats
      }));
      const staffNumber = findPrimaryStaff(partMeasures);

      parts.push({
        id: info.id,
        sourcePartId: info.id,
        name: info.name,
        originalName: info.name,
        abbreviation: info.abbreviation,
        instrumentNames: [...info.instrumentNames],
        instrumentSounds: [...info.instrumentSounds],
        midiPrograms: [...info.midiPrograms],
        isPiano: info.isPiano,
        voiceType,
        voiceNumber: allVoices.values().next().value || 1,
        staffNumber,
        clef: findClefForStaff(partMeasures, staffNumber),
        transpose: resolvePartTranspose(partMeasures),
        measures: partMeasures,
        isSubPart: false
      });
    }
  }

  normalizePartMeasureTimelines(parts);

  // Tempo, repeat structure and the feature summary all describe the score as a
  // whole, so they are resolved once here rather than per part.
  metadata.tempoMap = collectTempoMap(parts);
  metadata.baseTempo = metadata.tempoMap[0]?.bpm ?? 120;
  // Kept for callers that only ever wanted the opening tempo.
  metadata.tempo = metadata.baseTempo;

  const structure = collectScoreStructure(parts);
  metadata.measureStructure = structure.measures;
  metadata.repeatPlan = buildRepeatPlan(structure.measures);
  metadata.features = summariseFeatures(parts, metadata);

  return { parts, metadata };
}

/**
 * First transposition declared anywhere in a part.
 *
 * A transposition stays in force until it is changed, and a change mid-part is
 * rare enough in choral music that the opening value is the useful one.
 *
 * @param {Array} measures
 * @returns {object|null}
 */
function resolvePartTranspose(measures = []) {
  for (const measure of measures) {
    if (measure?.transpose && measure.transpose.semitones !== 0) {
      return { ...measure.transpose };
    }
  }
  return null;
}

/**
 * Gather every written tempo marking across the score into one map.
 *
 * Tempo directions are usually written on the top part only, so all parts are
 * scanned and the results merged by beat.
 *
 * @param {Array} parts
 * @returns {Array<{beat: number, bpm: number}>}
 */
function collectTempoMap(parts = []) {
  const entries = [];
  for (const part of parts) {
    for (const measure of part.measures || []) {
      const measureStart = Number(measure.startBeat) || 0;
      for (const direction of measure.directions || []) {
        if (Number.isFinite(direction?.tempo) && direction.tempo > 0) {
          entries.push({
            beat: measureStart + (Number(direction.startBeatInMeasure) || 0),
            bpm: direction.tempo
          });
        }
      }
    }
  }
  return buildTempoMap(entries, { baseTempo: 120 });
}

/**
 * Reduce the score to the per-measure information the repeat expander needs.
 *
 * Barlines are a property of the system, not of one voice, so any part that
 * carries them describes the structure. Taking the union is more forgiving than
 * trusting a single part, because exporters do not always repeat the markings on
 * every staff.
 *
 * @param {Array} parts
 * @returns {{ measures: Array<{number: number, barlines: Array, navigation: Array}> }}
 */
function collectScoreStructure(parts = []) {
  const measureCount = Math.max(0, ...parts.map(part => part.measures?.length || 0));
  const measures = [];

  for (let index = 0; index < measureCount; index++) {
    const barlines = [];
    const navigation = new Set();
    let number = index + 1;
    let startBeat = 0;
    let beats = 0;

    for (const part of parts) {
      const measure = part.measures?.[index];
      if (!measure) continue;
      if (measure.number !== undefined) number = measure.number;
      startBeat = Number(measure.startBeat) || 0;
      beats = Math.max(beats, Number(measure.beats) || 0);
      for (const mark of measure.navigation || []) navigation.add(mark);

      for (const barline of measure.barlines || []) {
        const alreadyKnown = barlines.some(existing =>
          existing.location === barline.location &&
          existing.style === barline.style &&
          existing.repeat?.direction === barline.repeat?.direction &&
          existing.ending?.type === barline.ending?.type &&
          String(existing.ending?.numbers) === String(barline.ending?.numbers)
        );
        if (!alreadyKnown) barlines.push(barline);
      }
    }

    measures.push({ index, number, startBeat, beats, barlines, navigation: [...navigation] });
  }

  return { measures };
}

/**
 * Describe what the score contains, so the app can tell a singer when something
 * written on the page is not reflected in playback instead of quietly ignoring it.
 *
 * @param {Array} parts
 * @param {object} metadata
 * @returns {object}
 */
function summariseFeatures(parts = [], metadata = {}) {
  let dynamicCount = 0;
  let wedgeCount = 0;
  let verseCount = 0;
  let ornamentCount = 0;
  let hasTranspose = false;
  const timeSignatures = new Set();
  const keySignatures = new Set();

  for (const part of parts) {
    if (part.transpose?.semitones) hasTranspose = true;
    for (const measure of part.measures || []) {
      if (measure.timeSignature) {
        timeSignatures.add(`${measure.timeSignature.numerator}/${measure.timeSignature.denominator}`);
      }
      if (measure.keySignature) keySignatures.add(Number(measure.keySignature.fifths) || 0);
      for (const direction of measure.directions || []) {
        if (direction.dynamics || direction.soundDynamics !== null) dynamicCount++;
        if (direction.wedge && direction.wedge.type !== 'stop') wedgeCount++;
      }
      for (const note of measure.notes || []) {
        if (note.lyrics) verseCount = Math.max(verseCount, note.lyrics.length);
        if (note.ornaments?.length) ornamentCount++;
      }
    }
  }

  const repeatPlan = metadata.repeatPlan || { hasRepeats: false, navigationMarks: [] };
  const measureCount = metadata.measureStructure?.length || 0;

  // Anything listed here is drawn or parsed but deliberately not performed.
  const unperformed = [];
  if (repeatPlan.navigationMarks?.length) unperformed.push('repeat jumps (D.C., D.S., Coda)');
  if (ornamentCount > 0) unperformed.push('ornaments');
  if (repeatPlan.truncated) unperformed.push('an unusually long repeat structure');

  return {
    measureCount,
    verseCount,
    hasDynamics: dynamicCount > 0,
    hasWedges: wedgeCount > 0,
    hasRepeats: Boolean(repeatPlan.hasRepeats),
    repeatsExpanded: Boolean(repeatPlan.hasRepeats) &&
      !isStraightThrough(repeatPlan.order || [], measureCount),
    hasTempoChanges: (metadata.tempoMap?.length || 0) > 1,
    hasTimeSignatureChanges: timeSignatures.size > 1,
    hasKeyChanges: keySignatures.size > 1,
    hasMultipleVerses: verseCount > 1,
    hasOrnaments: ornamentCount > 0,
    hasTranspose,
    unperformed
  };
}

/**
 * Read a file and parse it as MusicXML.
 * Handles both plain XML and detects MXL (compressed) files.
 * @param {File} file - the uploaded File object
 * @returns {Promise<{ parts: Array, metadata: object }>}
 */
export async function parseFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const text = isMxlFile(arrayBuffer)
    ? await readMxl(arrayBuffer)
    : new TextDecoder('utf-8').decode(arrayBuffer);

  const result = parseMusicXML(text);
  result.rawXml = text;
  return result;
}
