/**
 * Canvas-based Music Notation Renderer
 * Renders staves with notes for each detected part, playback cursor,
 * and user pitch overlay with accuracy feedback.
 */

import { getPartColor } from './utils.js';

const STEP_ORDER = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const NOTE_DURATION_BEATS = {
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
  '256th': 0.015625,
  '512th': 0.0078125,
  '1024th': 0.00390625
};
const FLAG_COUNTS = {
  eighth: 1,
  '16th': 2,
  '32nd': 3,
  '64th': 4,
  '128th': 5,
  '256th': 6,
  '512th': 7,
  '1024th': 8
};
const OPEN_NOTE_TYPES = new Set(['maxima', 'long', 'breve', 'whole', 'half']);
const STEMLESS_NOTE_TYPES = new Set(['maxima', 'long', 'breve', 'whole']);
const CLEF_SYMBOLS = {
  G: String.fromCodePoint(0x1D11E),
  F: String.fromCodePoint(0x1D122),
  C: String.fromCodePoint(0x1D121)
};
const MUSIC_FONT_STACK = '"Apple Symbols", "Noto Music", "Bravura", serif';

/**
 * Return the visual type, head, stem, and flag information for a note/rest.
 * MusicXML's <type> is preferred; duration is only a fallback for sparse files.
 * @param {object} note
 * @returns {{ type: string, openHead: boolean, hasStem: boolean, flagCount: number }}
 */
export function getNoteRenderInfo(note = {}) {
  let type = typeof note.type === 'string' ? note.type.trim().toLowerCase() : '';

  if (!Object.hasOwn(NOTE_DURATION_BEATS, type)) {
    const duration = Number(note.durationBeats);
    if (duration > 0) {
      const dots = Math.max(0, Number(note.dots) || 0);
      const dotFactor = 2 - Math.pow(0.5, dots);
      const undottedDuration = duration / dotFactor;
      let closestType = 'quarter';
      let closestDistance = Infinity;
      for (const [candidate, beats] of Object.entries(NOTE_DURATION_BEATS)) {
        const distance = Math.abs(Math.log2(undottedDuration / beats));
        if (distance < closestDistance) {
          closestType = candidate;
          closestDistance = distance;
        }
      }
      type = closestType;
    } else {
      type = 'quarter';
    }
  }

  return {
    type,
    openHead: OPEN_NOTE_TYPES.has(type),
    hasStem: !STEMLESS_NOTE_TYPES.has(type),
    flagCount: FLAG_COUNTS[type] || 0
  };
}

/**
 * Normalize a parser or fallback clef into one renderer descriptor.
 * @param {object|string|null} clef
 * @returns {{ sign: string, line: number, octaveChange: number, staff: number }|null}
 */
function normalizeClef(clef) {
  if (!clef) return null;
  if (typeof clef === 'string') {
    if (clef === 'bass') return { sign: 'F', line: 4, octaveChange: 0, staff: 1 };
    return { sign: 'G', line: 2, octaveChange: 0, staff: 1 };
  }

  const sign = String(clef.sign || '').toUpperCase();
  if (!['G', 'F', 'C'].includes(sign)) return null;
  const defaultLine = sign === 'F' ? 4 : sign === 'C' ? 3 : 2;
  return {
    sign,
    line: Number(clef.line) || defaultLine,
    octaveChange: Number(clef.octaveChange) || 0,
    staff: Number(clef.staff) || 1
  };
}

function inferVoiceClef(label) {
  const lower = String(label || '').toLowerCase();
  if (lower.includes('bass') || lower.includes('baritone')) {
    return { sign: 'F', line: 4, octaveChange: 0, staff: 1 };
  }
  if (lower.includes('tenor')) {
    return { sign: 'G', line: 2, octaveChange: -1, staff: 1 };
  }
  if (/soprano|mezzo|alto|contralto/.test(lower)) {
    return { sign: 'G', line: 2, octaveChange: 0, staff: 1 };
  }
  return null;
}

/**
 * Resolve the clef for a rendered section. Source MusicXML is retained, with
 * conventional SATB fallbacks for files that omit or mislabel their clefs.
 * @param {object|string} partOrVoiceType
 * @param {number} partIndex
 * @param {number} totalParts
 * @returns {{ sign: string, line: number, octaveChange: number, staff: number }}
 */
export function getClefDescriptorForPart(partOrVoiceType, partIndex = 0, totalParts = 0) {
  const part = typeof partOrVoiceType === 'object' && partOrVoiceType !== null
    ? partOrVoiceType
    : { voiceType: partOrVoiceType };
  const label = [part.voiceType, part.name, part.originalName, part.abbreviation]
    .filter(Boolean)
    .join(' ');
  const inferred = inferVoiceClef(label);
  const imported = normalizeClef(part.clef);

  // Keep valid source clefs, except for an obvious generic G clef on a named
  // bass. Tenor G clefs receive the conventional octave-below indication.
  if (inferred?.sign === 'F') {
    return imported && imported.sign !== 'G' ? imported : inferred;
  }
  if (inferred?.octaveChange === -1) {
    if (imported?.sign === 'F' || imported?.sign === 'C') return imported;
    return imported ? { ...imported, octaveChange: imported.octaveChange || -1 } : inferred;
  }
  if (imported) return imported;
  if (inferred) return inferred;

  // In a four-section SATB score, ordering is the safest fallback for generic
  // names such as "Voice 1". The third section is tenor and fourth is bass.
  if (totalParts === 4 && partIndex === 2) {
    return { sign: 'G', line: 2, octaveChange: -1, staff: part.staffNumber || 1 };
  }
  if (totalParts === 4 && partIndex === 3) {
    return { sign: 'F', line: 4, octaveChange: 0, staff: part.staffNumber || 1 };
  }
  if (Number(part.staffNumber) > 1) {
    return { sign: 'F', line: 4, octaveChange: 0, staff: Number(part.staffNumber) };
  }
  return { sign: 'G', line: 2, octaveChange: 0, staff: part.staffNumber || 1 };
}

/**
 * Get a note's diatonic distance from the bottom staff line for any G/F/C clef.
 * @param {string} noteName
 * @param {number} octave
 * @param {object|string} clef
 * @returns {number}
 */
export function getStaffPositionForClef(noteName, octave, clef) {
  const descriptor = normalizeClef(clef) || { sign: 'G', line: 2, octaveChange: 0 };
  const step = String(noteName || 'C').charAt(0).toUpperCase();
  const pitchIndex = Number(octave) * 7 + (STEP_ORDER[step] ?? 0) - descriptor.octaveChange * 7;
  const reference = descriptor.sign === 'F'
    ? { step: 'F', octave: 3 }
    : descriptor.sign === 'C'
      ? { step: 'C', octave: 4 }
      : { step: 'G', octave: 4 };
  const referenceIndex = reference.octave * 7 + STEP_ORDER[reference.step];
  const bottomLineIndex = referenceIndex - (descriptor.line - 1) * 2;
  return pitchIndex - bottomLineIndex;
}

/**
 * Legacy helper retained for callers that use the original treble/bass scale.
 * @param {string} noteName - e.g., 'C', 'D#', 'Bb'
 * @param {number} octave
 * @param {string} clef - 'treble' or 'bass'
 * @returns {number} position (higher = higher on staff)
 */
export function getNoteStaffPosition(noteName, octave, clef) {
  const step = String(noteName || 'C').charAt(0).toUpperCase();
  const stepIndex = STEP_ORDER[step] ?? 0;
  if (clef === 'bass') {
    return (octave - 2) * 7 + stepIndex - 2;
  }
  return (octave - 4) * 7 + stepIndex;
}

/**
 * Determine the conventional broad clef family for a voice type.
 * @param {string} voiceType
 * @returns {string} 'treble' or 'bass'
 */
export function getClefForPart(voiceType) {
  return inferVoiceClef(voiceType)?.sign === 'F' ? 'bass' : 'treble';
}

/**
 * NotationRenderer class - renders music notation on an HTML5 Canvas.
 */
export class NotationRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Layout configuration
    this.config = {
      staffHeight: 60,
      staffSpacing: 140,
      lineSpacing: 12, // pixels between staff lines
      noteWidth: 40, // horizontal space per beat
      marginLeft: 100,
      marginTop: 40,
      marginRight: 40,
      clefWidth: 70,
      measureBarWidth: 2,
      cursorColor: 'rgba(74, 158, 255, 0.6)',
      cursorWidth: 3,
      ...options
    };

    this.parts = [];
    this.metadata = null;
    this.scrollX = 0;
    this.currentBeat = 0;
    this.userPitch = null; // { frequency, noteName, octave, cents, accuracy }
    this.selectedPartId = null;
    this.isAutoScrollEnabled = true;
  }

  /**
   * Set the parsed music data for rendering.
   * @param {Array} parts - array of part objects from parser
   * @param {object} metadata - metadata from parser
   */
  setData(parts, metadata) {
    this.parts = parts;
    this.metadata = metadata;
    this.resize();
    this.render();
  }

  /**
   * Resize the canvas to fit content.
   */
  resize() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const parent = this.canvas.parentElement;
    this.canvas.width = parent.clientWidth;
    this.canvas.height = parent.clientHeight;
  }

  /**
   * Update the current playback position.
   * @param {number} beat - current beat position
   */
  setCurrentBeat(beat) {
    this.currentBeat = beat;
    if (this.isAutoScrollEnabled) {
      this.autoScroll();
    }
    this.render();
  }

  /**
   * Update the user's detected pitch for overlay display.
   * @param {object|null} pitchData - { frequency, noteName, octave, cents, accuracy }
   */
  setUserPitch(pitchData) {
    this.userPitch = pitchData;
    this.render();
  }

  /**
   * Select which part's staff receives the live microphone pitch overlay.
   * @param {string|null} partId
   */
  setSelectedPart(partId) {
    this.selectedPartId = partId;
    this.render();
  }

  /**
   * Auto-scroll to keep the cursor visible.
   */
  autoScroll() {
    const cursorX = this.config.marginLeft + this.config.clefWidth +
                    this.currentBeat * this.config.noteWidth;
    const visibleWidth = this.canvas.width;
    const scrollMargin = visibleWidth * 0.3;

    if (cursorX - this.scrollX > visibleWidth - scrollMargin) {
      this.scrollX = cursorX - scrollMargin;
    }
    if (cursorX - this.scrollX < scrollMargin && this.scrollX > 0) {
      this.scrollX = Math.max(0, cursorX - scrollMargin);
    }
  }

  /**
   * Main render method - draws the entire notation.
   */
  render() {
    if (!this.ctx || !this.canvas) return;

    const ctx = this.ctx;
    const { width, height } = this.canvas;

    // Clear canvas
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);

    if (!this.parts || this.parts.length === 0) {
      ctx.fillStyle = '#6a6a7a';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No music loaded', width / 2, height / 2);
      return;
    }

    ctx.save();
    ctx.translate(-this.scrollX, 0);

    // Draw each part's staff
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      const yOffset = this.config.marginTop + i * this.config.staffSpacing;
      this.drawPartStaff(ctx, part, yOffset, i);
    }

    // Draw playback cursor
    this.drawCursor(ctx);

    // Draw user pitch indicator
    if (this.userPitch) {
      this.drawUserPitch(ctx);
    }

    ctx.restore();
  }

  /**
   * Draw a single part's staff with notes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} part
   * @param {number} yOffset - vertical position of the staff top
   * @param {number} partIndex - section index, used for SATB clef fallback
   */
  drawPartStaff(ctx, part, yOffset, partIndex = 0) {
    const { lineSpacing, marginLeft, clefWidth, noteWidth } = this.config;
    const color = getPartColor(part.voiceType);
    const clef = getClefDescriptorForPart(part, partIndex, this.parts.length);

    // Draw part name
    ctx.fillStyle = color;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(part.name, marginLeft - 70 + this.scrollX, yOffset + lineSpacing * 2 + 4);

    // Total length in beats from absolute measure positions.
    let totalBeats = 0;
    for (const measure of part.measures) {
      const end = (measure.startBeat || 0) + (measure.beats || 0);
      if (end > totalBeats) totalBeats = end;
    }

    // Draw 5 staff lines
    ctx.strokeStyle = '#3a4a6a';
    ctx.lineWidth = 1;
    const totalWidth = Math.max(this.canvas.width, totalBeats * noteWidth + marginLeft + clefWidth + 100);
    for (let line = 0; line < 5; line++) {
      const y = yOffset + line * lineSpacing;
      ctx.beginPath();
      ctx.moveTo(marginLeft + this.scrollX, y);
      ctx.lineTo(totalWidth + this.scrollX, y);
      ctx.stroke();
    }

    // Draw the score's clef (or the SATB fallback) at the start of the staff.
    this.drawClef(ctx, clef, marginLeft + 10 + this.scrollX, yOffset);

    // Build geometry before drawing. Beams need every member's position in
    // order to choose one stem direction and one shared beam line.
    const allLayouts = [];
    const barlineLayouts = [];
    for (let mIdx = 0; mIdx < part.measures.length; mIdx++) {
      const measure = part.measures[mIdx];
      const measureStart = measure.startBeat || 0;

      if (mIdx > 0) {
        const barX = marginLeft + clefWidth + measureStart * noteWidth;
        ctx.strokeStyle = '#4a5a7a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(barX, yOffset);
        ctx.lineTo(barX, yOffset + lineSpacing * 4);
        ctx.stroke();
      }

      const measureLayouts = measure.notes.map((note, noteIndex) => {
        const absoluteBeat = measureStart + (note.startBeatInMeasure || 0);
        const x = marginLeft + clefWidth + absoluteBeat * noteWidth + noteWidth / 2;
        const visible = x - this.scrollX >= marginLeft + clefWidth;
        const noteClef = normalizeClef(note.clef) || clef;
        let y = yOffset + lineSpacing * 2;
        if (!note.isRest && note.pitch) {
          const position = getStaffPositionForClef(note.pitch.step, note.pitch.octave, noteClef);
          y = yOffset + (4 * lineSpacing) - (position * lineSpacing / 2);
        }
        return {
          note,
          noteIndex,
          measureIndex: mIdx,
          absoluteBeat,
          x,
          y,
          visible,
          appearance: getNoteRenderInfo(note)
        };
      });

      allLayouts.push(...measureLayouts);
      for (const fermata of measure.barlineFermatas || []) {
        const boundaryBeat = fermata.location === 'left'
          ? measureStart
          : measureStart + (measure.beats || 0);
        const x = marginLeft + clefWidth + boundaryBeat * noteWidth;
        barlineLayouts.push({
          fermata,
          x,
          visible: x - this.scrollX >= marginLeft + clefWidth
        });
      }
    }

    // Keep one beam state across the ordered part so valid cross-barline beams
    // remain connected instead of turning into flagless singleton notes.
    const beamGroups = this.prepareBeamGroups(allLayouts, yOffset);

    // Note heads and stems are drawn first. A beamed note keeps its stem but
    // suppresses its individual flag; the shared beam is painted afterwards.
    for (const layout of allLayouts) {
      if (!layout.visible) continue;
      const { note, x, y } = layout;
      if (!note.isRest && note.pitch) {
        this.drawLedgerLines(ctx, x, y, yOffset);
        this.drawNoteGlyph(ctx, x, y, note, yOffset, color, {
          stemUp: layout.stemUp,
          stemEndY: layout.stemEndY,
          suppressStem: layout.suppressStem,
          suppressFlags: layout.suppressFlags
        });
      } else if (note.isRest) {
        this.drawRestGlyph(ctx, x, note, yOffset, color);
      }
    }

    for (const group of beamGroups) {
      this.drawBeamGroup(ctx, group, color);
    }
    for (const group of this.collectTupletGroups(allLayouts)) {
      this.drawTupletGroup(ctx, group, yOffset, color);
    }
    this.drawConnectionCurves(ctx, allLayouts, yOffset, color);

    for (const layout of allLayouts) {
      if (layout.visible && layout.note.fermata) {
        this.drawFermata(ctx, layout, yOffset, color);
      }
    }
    for (const boundary of barlineLayouts) {
      if (boundary.visible) this.drawBarlineFermata(ctx, boundary, yOffset, color);
    }
  }

  /** Prepare explicit MusicXML beam groups and shared stem geometry. */
  prepareBeamGroups(layouts, yOffset) {
    const { lineSpacing } = this.config;
    const groups = [];
    let active = null;

    const finish = () => {
      if (!active || active.length === 0) {
        active = null;
        return;
      }
      const singletonPrimary = active.length === 1
        ? active[0].note.beams?.find(beam => Number(beam.number) === 1)
        : null;
      if (singletonPrimary && !String(singletonPrimary.type || '').includes('hook')) {
        // Malformed/unmatched beam metadata should degrade to the note's normal
        // flag, never to a stem with neither flag nor beam.
        active = null;
        return;
      }

      const sourceDirections = active
        .map(layout => layout.note.stem)
        .filter(stem => stem === 'up' || stem === 'down');
      const stemUp = sourceDirections.length
        ? sourceDirections.filter(stem => stem === 'up').length >= sourceDirections.length / 2
        : active.reduce((sum, layout) => sum + layout.y, 0) / active.length > yOffset + lineSpacing * 2;
      const beamY = stemUp
        ? Math.min(...active.map(layout => layout.y)) - lineSpacing * 3
        : Math.max(...active.map(layout => layout.y)) + lineSpacing * 3;

      for (const layout of active) {
        const scale = layout.note.isGrace ? 0.75 : 1;
        const radiusX = (layout.appearance.type === 'whole' || layout.appearance.type === 'breve' ? 7 : 6) * scale;
        layout.beamed = true;
        layout.suppressFlags = true;
        layout.stemUp = stemUp;
        layout.stemEndY = beamY;
        layout.stemX = layout.x + (stemUp ? radiusX - 1 : -radiusX + 1);
      }
      groups.push({ layouts: active, stemUp, beamY });
      active = null;
    };

    for (const layout of layouts) {
      const primary = layout.note.beams?.find(beam => Number(beam.number) === 1);
      if (layout.note.isChord) {
        // Chord noteheads share the preceding note's stem and beam.
        layout.suppressStem = true;
        layout.suppressFlags = true;
        continue;
      }
      if (!primary || layout.note.isRest || !layout.note.pitch) {
        finish();
        continue;
      }

      const type = String(primary.type || '').toLowerCase();
      if (type === 'begin') {
        finish();
        active = [layout];
      } else if (type === 'continue') {
        if (!active) active = [];
        active.push(layout);
      } else if (type === 'end') {
        if (!active) active = [];
        active.push(layout);
        finish();
      } else if (type.includes('hook')) {
        finish();
        active = [layout];
        finish();
      } else {
        finish();
      }
    }
    finish();
    return groups;
  }

  /** Draw primary/secondary beams and MusicXML forward/backward hooks. */
  drawBeamGroup(ctx, group, color) {
    const visible = group.layouts.filter(layout => layout.visible);
    if (visible.length === 0) return;

    const direction = group.stemUp ? 1 : -1;
    const beamSpacing = 6;
    const drawSegment = (from, to, level) => {
      const y = group.beamY + direction * (level - 1) * beamSpacing;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(from, y);
      ctx.lineTo(to, y);
      ctx.stroke();
    };

    if (visible.length > 1) {
      drawSegment(visible[0].stemX, visible[visible.length - 1].stemX, 1);
    } else {
      const primary = visible[0].note.beams?.find(beam => Number(beam.number) === 1);
      if (String(primary?.type || '').includes('hook')) {
        const backward = String(primary.type).includes('backward');
        drawSegment(visible[0].stemX, visible[0].stemX + (backward ? -11 : 11), 1);
      }
    }

    const maxLevel = Math.max(1, ...group.layouts.flatMap(layout =>
      (layout.note.beams || []).map(beam => Number(beam.number) || 1)
    ));
    for (let level = 2; level <= maxLevel; level++) {
      for (let index = 0; index < group.layouts.length - 1; index++) {
        const left = group.layouts[index];
        const right = group.layouts[index + 1];
        if (!left.visible || !right.visible) continue;
        const leftType = String(left.note.beams?.find(beam => Number(beam.number) === level)?.type || '');
        const rightType = String(right.note.beams?.find(beam => Number(beam.number) === level)?.type || '');
        const connectsRight = ['begin', 'continue'].includes(leftType) && ['continue', 'end'].includes(rightType);
        if (connectsRight) drawSegment(left.stemX, right.stemX, level);
      }

      for (const layout of group.layouts) {
        if (!layout.visible) continue;
        const type = String(layout.note.beams?.find(beam => Number(beam.number) === level)?.type || '');
        if (!type.includes('hook')) continue;
        const backward = type.includes('backward');
        drawSegment(layout.stemX, layout.stemX + (backward ? -10 : 10), level);
      }
    }
    ctx.lineCap = 'butt';
  }

  /** Collect explicit tuplets, with a ratio-based fallback for sparse files. */
  collectTupletGroups(layouts) {
    const groups = [];
    const used = new Set();

    for (let startIndex = 0; startIndex < layouts.length; startIndex++) {
      const startLayout = layouts[startIndex];
      const starts = (startLayout.note.tuplets || []).filter(tuplet => tuplet.type === 'start');
      for (const marker of starts) {
        const voice = startLayout.note.voice;
        let stopIndex = -1;
        for (let index = startIndex; index < layouts.length; index++) {
          const candidate = layouts[index];
          if (candidate.note.voice !== voice) continue;
          const stops = candidate.note.tuplets || [];
          if (stops.some(tuplet => tuplet.type === 'stop' && Number(tuplet.number) === Number(marker.number))) {
            stopIndex = index;
            break;
          }
        }

        const fallbackCount = startLayout.note.timeModification?.actualNotes || 1;
        const endIndex = stopIndex >= 0
          ? stopIndex
          : Math.min(layouts.length - 1, startIndex + fallbackCount - 1);
        const members = layouts.slice(startIndex, endIndex + 1)
          .filter(layout => layout.note.voice === voice && !layout.note.isChord);
        if (members.length === 0) continue;
        members.forEach(layout => used.add(layout));
        groups.push({ layouts: members, marker, explicit: true });
      }
    }

    for (let index = 0; index < layouts.length;) {
      const first = layouts[index];
      const ratio = first.note.timeModification;
      if (used.has(first) || first.note.isChord || !ratio?.actualNotes || !ratio?.normalNotes || ratio.actualNotes === ratio.normalNotes) {
        index++;
        continue;
      }

      const members = [first];
      let cursor = index + 1;
      while (cursor < layouts.length && members.length < ratio.actualNotes) {
        const candidate = layouts[cursor];
        const candidateRatio = candidate.note.timeModification;
        const previous = members[members.length - 1];
        const contiguous = Math.abs(
          candidate.absoluteBeat - (previous.absoluteBeat + (previous.note.durationBeats || 0))
        ) < 1e-4;
        if (candidate.note.isChord) {
          cursor++;
          continue;
        }
        if (used.has(candidate) || candidate.note.voice !== first.note.voice || !contiguous ||
            candidateRatio?.actualNotes !== ratio.actualNotes || candidateRatio?.normalNotes !== ratio.normalNotes) {
          break;
        }
        members.push(candidate);
        cursor++;
      }

      if (members.length === ratio.actualNotes) {
        members.forEach(layout => used.add(layout));
        groups.push({
          layouts: members,
          marker: { type: 'start', number: 1, bracket: null, showNumber: 'actual', placement: null },
          explicit: false
        });
        index = cursor;
      } else {
        index++;
      }
    }
    return groups;
  }

  /** Draw one tuplet number and, when needed, its bracket. */
  drawTupletGroup(ctx, group, yOffset, color) {
    const members = group.layouts.filter(layout => layout.visible);
    if (members.length === 0) return;

    const first = members[0];
    const last = members[members.length - 1];
    const ratio = group.layouts[0].note.timeModification;
    const actual = ratio?.actualNotes || group.layouts.length;
    const normal = ratio?.normalNotes || 0;
    const showNumber = group.marker.showNumber || 'actual';
    const label = showNumber === 'none'
      ? ''
      : showNumber === 'both' && normal
        ? `${actual}:${normal}`
        : String(actual);
    const placement = group.marker.placement || 'above';
    const below = placement === 'below';
    const direction = below ? 1 : -1;
    const extremes = members.map(layout => {
      if (layout.stemEndY == null) return layout.y;
      return below ? Math.max(layout.y, layout.stemEndY) : Math.min(layout.y, layout.stemEndY);
    });
    const y = (below ? Math.max(...extremes) : Math.min(...extremes)) + direction * 12;
    const x1 = first.x - 6;
    const x2 = last.x + 6;
    const center = (x1 + x2) / 2;
    const bracket = group.marker.bracket === 'yes' ||
      (group.marker.bracket !== 'no' && !group.layouts.every(layout => layout.beamed));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.2;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (bracket) {
      const gap = label ? Math.max(12, ctx.measureText(label).width + 7) : 0;
      ctx.beginPath();
      ctx.moveTo(x1, y + direction * 5);
      ctx.lineTo(x1, y);
      ctx.lineTo(center - gap / 2, y);
      ctx.moveTo(center + gap / 2, y);
      ctx.lineTo(x2, y);
      ctx.lineTo(x2, y + direction * 5);
      ctx.stroke();
    }
    if (label) ctx.fillText(label, center, y);
    ctx.restore();
  }

  /** Draw legato slurs and ties after all note geometry is known. */
  drawConnectionCurves(ctx, layouts, yOffset, color) {
    const activeSlurs = new Map();
    const activeTies = new Map();
    const pitchKey = layout => {
      const pitch = layout.note.pitch || {};
      return `${layout.note.voice || 1}:${pitch.step || ''}:${pitch.alter || 0}:${pitch.octave || ''}`;
    };

    for (const layout of layouts) {
      if (layout.note.isRest || !layout.note.pitch) continue;
      const slurs = layout.note.slurs || [];
      for (const slur of slurs.filter(item => item.type === 'stop' || item.type === 'continue')) {
        const key = `${layout.note.voice || 1}:${slur.number || 1}`;
        const start = activeSlurs.get(key);
        if (start) {
          this.drawConnectionCurve(ctx, start.layout, layout, slur.placement || start.marker.placement || 'above', color, false, start.marker.lineType);
          activeSlurs.delete(key);
        }
      }
      for (const slur of slurs.filter(item => item.type === 'start' || item.type === 'continue')) {
        activeSlurs.set(`${layout.note.voice || 1}:${slur.number || 1}`, { layout, marker: slur });
      }

      const key = pitchKey(layout);
      if (layout.note.tie?.stop && activeTies.has(key)) {
        const start = activeTies.get(key);
        const stopMarker = (layout.note.ties || []).find(tie => tie.type === 'stop');
        const defaultPlacement = start.layout.stemUp === false ? 'above' : 'below';
        this.drawConnectionCurve(
          ctx,
          start.layout,
          layout,
          stopMarker?.placement || start.marker?.placement || defaultPlacement,
          color,
          true,
          start.marker?.lineType
        );
        activeTies.delete(key);
      }
      if (layout.note.tie?.start) {
        const startMarker = (layout.note.ties || []).find(tie => tie.type === 'start');
        activeTies.set(key, { layout, marker: startMarker });
      }
    }
  }

  /** Draw one slur/tie Bezier curve. */
  drawConnectionCurve(ctx, start, end, placement, color, isTie = false, lineType = 'solid') {
    if (!start.visible || !end.visible || end.x <= start.x) return;
    const below = placement === 'below';
    const direction = below ? 1 : -1;
    const inset = isTie ? 4 : 1;
    const startX = start.x + inset;
    const endX = end.x - inset;
    const startY = start.y + direction * (isTie ? 6 : 8);
    const endY = end.y + direction * (isTie ? 6 : 8);
    const span = endX - startX;
    const depth = isTie ? Math.min(12, 6 + span * 0.06) : Math.min(28, 11 + Math.sqrt(span));
    const controlY = (below ? Math.max(startY, endY) : Math.min(startY, endY)) + direction * depth;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = isTie ? 1.4 : 1.6;
    if (lineType === 'dashed') ctx.setLineDash([5, 4]);
    else if (lineType === 'dotted') ctx.setLineDash([1.5, 3]);
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(
      startX + span * 0.28, controlY,
      endX - span * 0.28, controlY,
      endX, endY
    );
    ctx.stroke();
    ctx.restore();
  }

  /** Draw an upright or inverted fermata above a note/rest. */
  drawFermata(ctx, layout, yOffset, color) {
    const fermata = layout.note.fermata;
    const below = fermata.placement === 'below' || fermata.type === 'inverted';
    const stemExtreme = layout.stemEndY == null
      ? layout.y
      : below ? Math.max(layout.y, layout.stemEndY) : Math.min(layout.y, layout.stemEndY);
    this.drawFermataSymbol(ctx, layout.x, stemExtreme + (below ? 16 : -16), fermata, color);
  }

  /** Draw a measure-boundary fermata and ensure its barline is visible. */
  drawBarlineFermata(ctx, boundary, yOffset, color) {
    const { lineSpacing } = this.config;
    const fermata = boundary.fermata;
    const below = fermata.placement === 'below' || fermata.type === 'inverted';
    ctx.save();
    ctx.strokeStyle = '#4a5a7a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(boundary.x, yOffset);
    ctx.lineTo(boundary.x, yOffset + lineSpacing * 4);
    ctx.stroke();
    ctx.restore();
    const centerY = below ? yOffset + lineSpacing * 4 + 16 : yOffset - 16;
    this.drawFermataSymbol(ctx, boundary.x, centerY, fermata, color);
  }

  /** Draw normal, angled, or square fermata shapes with a central dot. */
  drawFermataSymbol(ctx, x, centerY, fermata, color) {
    const below = fermata.placement === 'below' || fermata.type === 'inverted';
    const shape = String(fermata.shape || 'normal').toLowerCase();
    const radius = 7;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    if (shape.includes('square')) {
      const direction = below ? 1 : -1;
      ctx.moveTo(x - radius, centerY);
      ctx.lineTo(x - radius, centerY + direction * radius);
      ctx.lineTo(x + radius, centerY + direction * radius);
      ctx.lineTo(x + radius, centerY);
    } else if (shape.includes('angled')) {
      const direction = below ? 1 : -1;
      ctx.moveTo(x - radius, centerY);
      ctx.lineTo(x, centerY + direction * radius);
      ctx.lineTo(x + radius, centerY);
    } else if (below) {
      ctx.arc(x, centerY, radius, 0, Math.PI);
    } else {
      ctx.arc(x, centerY, radius, Math.PI, Math.PI * 2);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, centerY + (below ? -2 : 2), 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Draw an actual G, F, or C clef plus any octave-transposition mark. */
  drawClef(ctx, clef, x, yOffset) {
    const { lineSpacing } = this.config;
    const descriptor = normalizeClef(clef) || { sign: 'G', line: 2, octaveChange: 0 };
    const symbol = CLEF_SYMBOLS[descriptor.sign] || descriptor.sign;

    ctx.save();
    ctx.fillStyle = '#e0e0e0';
    ctx.font = `42px ${MUSIC_FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(symbol, x, yOffset + lineSpacing * 2);

    if (descriptor.octaveChange) {
      const octaves = Math.abs(descriptor.octaveChange);
      const label = octaves === 1 ? '8' : String(octaves * 7 + 1);
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const labelY = descriptor.octaveChange < 0
        ? yOffset + lineSpacing * 4 + 12
        : yOffset - 4;
      ctx.fillText(label, x + 14, labelY);
    }
    ctx.restore();
  }

  /** Draw ledger lines above or below a staff for one note head. */
  drawLedgerLines(ctx, noteX, noteY, yOffset) {
    const { lineSpacing } = this.config;
    ctx.strokeStyle = '#5a6a8a';
    ctx.lineWidth = 1;

    for (let y = yOffset + 5 * lineSpacing; y <= noteY + lineSpacing / 4; y += lineSpacing) {
      ctx.beginPath();
      ctx.moveTo(noteX - 10, y);
      ctx.lineTo(noteX + 10, y);
      ctx.stroke();
    }
    for (let y = yOffset - lineSpacing; y >= noteY - lineSpacing / 4; y -= lineSpacing) {
      ctx.beginPath();
      ctx.moveTo(noteX - 10, y);
      ctx.lineTo(noteX + 10, y);
      ctx.stroke();
    }
  }

  /** Draw a pitched note with the correct head, stem, flags, and dots. */
  drawNoteGlyph(ctx, noteX, noteY, note, yOffset, color, options = {}) {
    const { lineSpacing } = this.config;
    const appearance = getNoteRenderInfo(note);
    const scale = note.isGrace ? 0.75 : 1;
    const radiusX = (appearance.type === 'whole' || appearance.type === 'breve' ? 7 : 6) * scale;
    const radiusY = 4.5 * scale;

    ctx.beginPath();
    ctx.ellipse(noteX, noteY, radiusX, radiusY, -0.2, 0, Math.PI * 2);
    if (appearance.openHead) {
      // Mask the staff line through an open head before outlining it.
      ctx.fillStyle = '#1a1a2e';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (['maxima', 'long', 'breve'].includes(appearance.type)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(noteX - radiusX - 3, noteY - 7 * scale);
      ctx.lineTo(noteX - radiusX - 3, noteY + 7 * scale);
      ctx.moveTo(noteX + radiusX + 3, noteY - 7 * scale);
      ctx.lineTo(noteX + radiusX + 3, noteY + 7 * scale);
      ctx.stroke();
    }

    if (appearance.hasStem && !options.suppressStem && note.stem !== 'none') {
      const sourceStemUp = note.stem === 'up' ? true : note.stem === 'down' ? false : null;
      const stemUp = typeof options.stemUp === 'boolean'
        ? options.stemUp
        : sourceStemUp ?? noteY > yOffset + lineSpacing * 2;
      const stemX = noteX + (stemUp ? radiusX - 1 : -radiusX + 1);
      const stemEndY = Number.isFinite(options.stemEndY)
        ? options.stemEndY
        : noteY + (stemUp ? -lineSpacing * 3 : lineSpacing * 3) * scale;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(stemX, noteY);
      ctx.lineTo(stemX, stemEndY);
      ctx.stroke();

      if (!options.suppressFlags) {
        for (let flag = 0; flag < appearance.flagCount; flag++) {
          const flagY = stemEndY + (stemUp ? flag * 5.5 : -flag * 5.5) * scale;
          ctx.beginPath();
          ctx.moveTo(stemX, flagY);
          if (stemUp) {
            ctx.bezierCurveTo(
              stemX + 12 * scale, flagY + 4 * scale,
              stemX + 11 * scale, flagY + 12 * scale,
              stemX + 4 * scale, flagY + 16 * scale
            );
          } else {
            ctx.bezierCurveTo(
              stemX - 12 * scale, flagY - 4 * scale,
              stemX - 11 * scale, flagY - 12 * scale,
              stemX - 4 * scale, flagY - 16 * scale
            );
          }
          ctx.stroke();
        }
      }
    }

    const staffPosition = Math.round((yOffset + 4 * lineSpacing - noteY) / (lineSpacing / 2));
    const dotY = staffPosition % 2 === 0 ? noteY - lineSpacing / 2 : noteY;
    this.drawDots(ctx, noteX + radiusX + 4, dotY, note.dots, color);
  }

  /** Draw a duration-specific rest instead of a generic dash. */
  drawRestGlyph(ctx, noteX, note, yOffset, color) {
    const { lineSpacing } = this.config;
    const appearance = getNoteRenderInfo(note);
    const centerY = yOffset + lineSpacing * 2;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    if (['maxima', 'long', 'breve', 'whole'].includes(appearance.type)) {
      const restY = yOffset + lineSpacing;
      ctx.fillRect(noteX - 6, restY, 12, 4);
      if (appearance.type !== 'whole') {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(noteX - 9, restY - 3);
        ctx.lineTo(noteX - 9, restY + 9);
        ctx.moveTo(noteX + 9, restY - 3);
        ctx.lineTo(noteX + 9, restY + 9);
        ctx.stroke();
      }
    } else if (appearance.type === 'half') {
      ctx.fillRect(noteX - 6, centerY - 4, 12, 4);
    } else if (appearance.type === 'quarter') {
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(noteX - 3, centerY - 13);
      ctx.lineTo(noteX + 3, centerY - 6);
      ctx.lineTo(noteX - 2, centerY);
      ctx.lineTo(noteX + 4, centerY + 6);
      ctx.lineTo(noteX - 3, centerY + 13);
      ctx.stroke();
    } else {
      const flags = Math.max(1, appearance.flagCount);
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(noteX + 2, centerY - 14);
      ctx.lineTo(noteX - 2, centerY + 14);
      ctx.stroke();
      for (let flag = 0; flag < flags; flag++) {
        const flagY = centerY - 12 + flag * 6;
        ctx.beginPath();
        ctx.moveTo(noteX + 2, flagY);
        ctx.bezierCurveTo(noteX + 10, flagY + 1, noteX + 9, flagY + 8, noteX, flagY + 11);
        ctx.stroke();
      }
    }

    this.drawDots(ctx, noteX + 10, centerY, note.dots, color);

  }

  /** Draw one or more augmentation dots. */
  drawDots(ctx, startX, y, count, color) {
    const dots = Math.max(0, Number(count) || 0);
    ctx.fillStyle = color;
    for (let dot = 0; dot < dots; dot++) {
      ctx.beginPath();
      ctx.arc(startX + dot * 5, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }



  /**
   * Draw the playback position cursor.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawCursor(ctx) {
    if (this.currentBeat <= 0) return;

    const { marginLeft, clefWidth, noteWidth, marginTop, staffSpacing, cursorColor, cursorWidth } = this.config;
    const cursorX = marginLeft + clefWidth + this.currentBeat * noteWidth;

    ctx.strokeStyle = cursorColor;
    ctx.lineWidth = cursorWidth;
    ctx.beginPath();
    ctx.moveTo(cursorX, marginTop - 10);
    ctx.lineTo(cursorX, marginTop + this.parts.length * staffSpacing - 20);
    ctx.stroke();
  }

  /**
   * Draw the user's detected pitch on the staff.
   * @param {CanvasRenderingContext2D} ctx
   */
  drawUserPitch(ctx) {
    if (!this.userPitch || !this.userPitch.noteName) return;

    const { marginLeft, clefWidth, noteWidth, marginTop, staffSpacing, lineSpacing } = this.config;
    const cursorX = marginLeft + clefWidth + this.currentBeat * noteWidth + noteWidth;

    // Determine accuracy color
    let indicatorColor;
    const absCents = Math.abs(this.userPitch.cents);
    if (absCents <= 50) {
      indicatorColor = '#4caf50'; // green - good
    } else if (absCents <= 100) {
      indicatorColor = '#ff9800'; // yellow - close
    } else {
      indicatorColor = '#f44336'; // red - off
    }

    // Draw on the singer's selected section. Fall back to the first staff if
    // the selection no longer exists (for example, after loading a new score).
    const selectedIndex = this.parts.findIndex(part => part.id === this.selectedPartId);
    const partIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const selectedPart = this.parts[partIndex];
    const yOffset = marginTop + partIndex * staffSpacing;
    const clef = selectedPart
      ? getClefDescriptorForPart(selectedPart, partIndex, this.parts.length)
      : { sign: 'G', line: 2, octaveChange: 0, staff: 1 };
    const position = getStaffPositionForClef(
      this.userPitch.noteName.charAt(0),
      this.userPitch.octave,
      clef
    );

    const noteY = yOffset + (4 * lineSpacing) - (position * lineSpacing / 2);

    // Draw diamond-shaped pitch indicator
    ctx.fillStyle = indicatorColor;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(cursorX, noteY - 7);
    ctx.lineTo(cursorX + 7, noteY);
    ctx.lineTo(cursorX, noteY + 7);
    ctx.lineTo(cursorX - 7, noteY);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Draw cents offset text
    ctx.fillStyle = indicatorColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${this.userPitch.cents > 0 ? '+' : ''}${this.userPitch.cents}c`,
                 cursorX, noteY - 12);
    ctx.textAlign = 'left';
  }

  /**
   * Scroll to a specific beat position.
   * @param {number} beat
   */
  scrollToBeat(beat) {
    this.scrollX = Math.max(0, beat * this.config.noteWidth - this.canvas.width * 0.3);
    this.render();
  }

  /**
   * Reset the renderer state.
   */
  reset() {
    this.scrollX = 0;
    this.currentBeat = 0;
    this.userPitch = null;
    this.render();
  }
}
