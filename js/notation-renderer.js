/**
 * Canvas-based Music Notation Renderer
 * Renders staves with notes for each detected part, playback cursor,
 * and user pitch overlay with accuracy feedback.
 */

import { getPartColor, noteToMidi, midiToNoteName } from './utils.js';

/**
 * Map of note step to staff line position (from bottom of treble staff).
 * For treble clef, middle C (C4) is one ledger line below.
 * Position 0 = first ledger line below staff, position 4 = bottom line of staff.
 */
const TREBLE_NOTE_POSITIONS = {
  'C4': 0, 'D4': 1, 'E4': 2, 'F4': 3, 'G4': 4,
  'A4': 5, 'B4': 6, 'C5': 7, 'D5': 8, 'E5': 9,
  'F5': 10, 'G5': 11, 'A5': 12, 'B5': 13, 'C6': 14
};

const BASS_NOTE_POSITIONS = {
  'E2': 0, 'F2': 1, 'G2': 2, 'A2': 3, 'B2': 4,
  'C3': 5, 'D3': 6, 'E3': 7, 'F3': 8, 'G3': 9,
  'A3': 10, 'B3': 11, 'C4': 12, 'D4': 13, 'E4': 14
};

/**
 * Get the vertical position for a note on the staff.
 * Returns a position value where each integer represents a half-step on the staff.
 * @param {string} noteName - e.g., 'C', 'D#', 'Bb'
 * @param {number} octave
 * @param {string} clef - 'treble' or 'bass'
 * @returns {number} position (higher = higher on staff)
 */
export function getNoteStaffPosition(noteName, octave, clef) {
  // Strip accidentals to get the step
  const step = noteName.charAt(0);
  const stepOrder = { 'C': 0, 'D': 1, 'E': 2, 'F': 3, 'G': 4, 'A': 5, 'B': 6 };
  const stepIndex = stepOrder[step] || 0;

  if (clef === 'bass') {
    // Bass clef: B2 is on the middle line (position 4 from bottom)
    // Reference: A2 is on the second space from bottom
    const referenceOctave = 2;
    const referenceStep = 4; // E2 is at position 0
    return (octave - referenceOctave) * 7 + stepIndex - 2; // E=2 offset
  }

  // Treble clef: B4 is on the middle line (position 6 from bottom of staff)
  // Reference: C4 is at position 0 (one ledger line below)
  const referenceOctave = 4;
  return (octave - referenceOctave) * 7 + stepIndex;
}

/**
 * Determine the appropriate clef for a part based on its voice type.
 * @param {string} voiceType
 * @returns {string} 'treble' or 'bass'
 */
export function getClefForPart(voiceType) {
  const lower = voiceType.toLowerCase();
  if (lower.includes('bass') || lower.includes('baritone')) {
    return 'bass';
  }
  if (lower.includes('tenor')) {
    return 'treble'; // Tenor typically uses treble clef with 8vb
  }
  return 'treble';
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
      staffSpacing: 100,
      lineSpacing: 12, // pixels between staff lines
      noteWidth: 40, // horizontal space per beat
      marginLeft: 80,
      marginTop: 40,
      marginRight: 40,
      clefWidth: 50,
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
      this.drawPartStaff(ctx, part, yOffset);
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
   */
  drawPartStaff(ctx, part, yOffset) {
    const { lineSpacing, marginLeft, clefWidth, noteWidth } = this.config;
    const color = getPartColor(part.voiceType);
    const clef = getClefForPart(part.voiceType);

    // Draw part name
    ctx.fillStyle = color;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(part.name, marginLeft - 70 + this.scrollX, yOffset + lineSpacing * 2 + 4);

    // Draw 5 staff lines
    ctx.strokeStyle = '#3a4a6a';
    ctx.lineWidth = 1;
    for (let line = 0; line < 5; line++) {
      const y = yOffset + line * lineSpacing;
      ctx.beginPath();
      ctx.moveTo(marginLeft + this.scrollX, y);

      // Calculate total width from note content
      let totalBeats = 0;
      for (const measure of part.measures) {
        for (const note of measure.notes) {
          if (!note.isChord) {
            totalBeats += note.durationBeats;
          }
        }
      }
      const totalWidth = Math.max(this.canvas.width, totalBeats * noteWidth + marginLeft + clefWidth + 100);
      ctx.lineTo(totalWidth + this.scrollX, y);
      ctx.stroke();
    }

    // Draw clef symbol
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '32px serif';
    ctx.textAlign = 'left';
    const clefSymbol = clef === 'bass' ? '\u{1D122}' : '\u{1D11E}';
    // Use text-based clef indicators since music font glyphs may not be available
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(clef === 'bass' ? 'F' : 'G', marginLeft + 5 + this.scrollX, yOffset + lineSpacing * 2 + 5);

    // Draw notes in each measure
    let beatOffset = 0;
    for (let mIdx = 0; mIdx < part.measures.length; mIdx++) {
      const measure = part.measures[mIdx];

      // Draw measure bar line at start
      if (mIdx > 0) {
        const barX = marginLeft + clefWidth + beatOffset * noteWidth;
        ctx.strokeStyle = '#4a5a7a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(barX, yOffset);
        ctx.lineTo(barX, yOffset + lineSpacing * 4);
        ctx.stroke();
      }

      // Draw notes
      let lastNoteX = marginLeft + clefWidth + beatOffset * noteWidth + noteWidth / 2;
      for (const note of measure.notes) {
        let noteX;
        if (note.isChord) {
          // Chord notes share the same X position as the previous note
          noteX = lastNoteX;
        } else {
          noteX = marginLeft + clefWidth + beatOffset * noteWidth + noteWidth / 2;
          lastNoteX = noteX;
        }

        if (!note.isRest && note.pitch) {
          const position = getNoteStaffPosition(
            note.pitch.step, note.pitch.octave, clef
          );

          // Position 0 = C4 for treble (one ledger below), staff lines at positions 2,4,6,8,10
          // Map position to Y: staff bottom line is position 2 for treble
          const staffBottomLine = clef === 'bass' ? 4 : 2;
          const noteY = yOffset + (4 * lineSpacing) -
                       ((position - staffBottomLine) * lineSpacing / 2);

          // Draw ledger lines if needed
          ctx.strokeStyle = '#5a6a8a';
          ctx.lineWidth = 1;
          if (noteY > yOffset + 4 * lineSpacing) {
            // Below staff
            for (let ly = yOffset + 5 * lineSpacing; ly <= noteY + lineSpacing / 4; ly += lineSpacing) {
              ctx.beginPath();
              ctx.moveTo(noteX - 10, ly);
              ctx.lineTo(noteX + 10, ly);
              ctx.stroke();
            }
          }
          if (noteY < yOffset) {
            // Above staff
            for (let ly = yOffset - lineSpacing; ly >= noteY - lineSpacing / 4; ly -= lineSpacing) {
              ctx.beginPath();
              ctx.moveTo(noteX - 10, ly);
              ctx.lineTo(noteX + 10, ly);
              ctx.stroke();
            }
          }

          // Draw note head
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.ellipse(noteX, noteY, 6, 4.5, -0.2, 0, Math.PI * 2);
          ctx.fill();

          // Draw stem
          if (note.type !== 'whole') {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const stemUp = noteY > yOffset + lineSpacing * 2;
            if (stemUp) {
              ctx.moveTo(noteX + 5, noteY);
              ctx.lineTo(noteX + 5, noteY - lineSpacing * 3);
            } else {
              ctx.moveTo(noteX - 5, noteY);
              ctx.lineTo(noteX - 5, noteY + lineSpacing * 3);
            }
            ctx.stroke();
          }

          // Fill open note heads for half/whole notes
          if (note.type === 'half' || note.type === 'whole') {
            ctx.fillStyle = '#1a1a2e';
            ctx.beginPath();
            ctx.ellipse(noteX, noteY, 4, 3, -0.2, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (note.isRest) {
          // Draw rest symbol (simplified)
          ctx.fillStyle = '#6a6a7a';
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('-', noteX, yOffset + lineSpacing * 2 + 4);
          ctx.textAlign = 'left';
        }

        // Only advance beat offset for non-chord notes
        if (!note.isChord) {
          beatOffset += note.durationBeats;
        }
      }
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

    // Draw on the first part's staff as reference
    const yOffset = marginTop;
    const clef = this.parts.length > 0 ? getClefForPart(this.parts[0].voiceType) : 'treble';
    const position = getNoteStaffPosition(
      this.userPitch.noteName.charAt(0),
      this.userPitch.octave,
      clef
    );

    const staffBottomLine = clef === 'bass' ? 4 : 2;
    const noteY = yOffset + (4 * lineSpacing) -
                 ((position - staffBottomLine) * lineSpacing / 2);

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
