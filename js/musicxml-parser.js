/**
 * MusicXML Parser Module
 * Parses MusicXML files and extracts voice parts with their note data.
 * Dynamically detects part types using string matching heuristics.
 */

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
 * @param {Array} events - ordered events: { kind: 'note'|'backup'|'forward', ... }
 * @param {number} divisions - divisions per quarter note for this measure
 * @returns {{ notes: Array, beats: number }} notes with timing and measure length in beats
 */
export function layoutMeasure(events, divisions) {
  const div = divisions > 0 ? divisions : 1;
  const notes = [];
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
      startBeatInMeasure: startDiv / div
    };
    if (ev.pitch) note.pitch = { ...ev.pitch };
    if (ev.lyric) note.lyric = { ...ev.lyric };
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

  return { notes, beats: maxCursor / div };
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
    notes: [],
    divisions: currentDivisions,
    timeSignature: currentTimeSignature,
    keySignature: null,
    tempo: null,
    voices: new Set(),
    beats: 0,
    barlineFermatas: [],
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
    } else if (tag === 'direction') {
      const sound = child.querySelector('sound');
      if (sound && sound.getAttribute('tempo')) {
        result.tempo = parseFloat(sound.getAttribute('tempo'));
      }
    } else if (tag === 'sound') {
      if (child.getAttribute('tempo')) {
        result.tempo = parseFloat(child.getAttribute('tempo'));
      }
    } else if (tag === 'barline') {
      const location = child.getAttribute('location') || 'right';
      for (const fermataEl of child.querySelectorAll('fermata')) {
        const type = fermataEl.getAttribute('type') || 'upright';
        result.barlineFermatas.push({
          type,
          shape: fermataEl.textContent.trim() || 'normal',
          placement: fermataEl.getAttribute('placement') || (type === 'inverted' ? 'below' : 'above'),
          location
        });
      }
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

      const lyricEl = child.querySelector('lyric');
      if (lyricEl) {
        ev.lyric = {
          text: lyricEl.querySelector('text')?.textContent || '',
          syllabic: lyricEl.querySelector('syllabic')?.textContent || 'single'
        };
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
  result.beats = laid.beats;
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
        tempo: measure.tempo,
        barlineFermatas: measure.barlineFermatas.map(fermata => ({ ...fermata })),
        clefs: cloneClefs(measure.clefs),
        // Preserve absolute timing so every voice stays aligned to the same grid.
        startBeat: measure.startBeat,
        beats: measure.beats
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
      for (const [voiceNum, voiceMeasures] of voiceMap) {
        const subPartName = `${info.name} (Voice ${voiceNum})`;
        const subVoiceType = detectVoiceType(subPartName);
        const staffNumber = findPrimaryStaff(voiceMeasures);

        parts.push({
          id: `${info.id}_v${voiceNum}`,
          name: subPartName,
          originalName: info.name,
          abbreviation: info.abbreviation,
          voiceType: subVoiceType !== subPartName.toLowerCase().trim() ? subVoiceType : voiceType,
          voiceNumber: voiceNum,
          staffNumber,
          clef: findClefForStaff(voiceMeasures, staffNumber),
          measures: voiceMeasures,
          isSubPart: true
        });
      }
    } else {
      const partMeasures = measures.map(m => ({
        number: m.number,
        notes: m.notes,
        divisions: m.divisions,
        timeSignature: m.timeSignature,
        keySignature: m.keySignature,
        tempo: m.tempo,
        barlineFermatas: m.barlineFermatas.map(fermata => ({ ...fermata })),
        clefs: cloneClefs(m.clefs),
        startBeat: m.startBeat,
        beats: m.beats
      }));
      const staffNumber = findPrimaryStaff(partMeasures);

      parts.push({
        id: info.id,
        name: info.name,
        originalName: info.name,
        abbreviation: info.abbreviation,
        voiceType,
        voiceNumber: allVoices.values().next().value || 1,
        staffNumber,
        clef: findClefForStaff(partMeasures, staffNumber),
        measures: partMeasures,
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
