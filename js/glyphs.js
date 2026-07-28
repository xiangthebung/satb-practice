/**
 * Notation glyphs, drawn as geometry rather than text.
 *
 * The renderer used to set clefs and accidentals as characters from a music
 * font, which meant the score only looked right on a machine that happened to
 * have one installed. On Windows or Linux without Noto Music the font stack fell
 * through to a serif face and the clefs came out as missing-glyph boxes.
 *
 * Everything here is therefore drawn with paths. Note heads, stems, beams and
 * flags were already geometric, so this brings the last few symbols in line and
 * removes the dependency altogether: the score is now identical everywhere.
 *
 * Coordinates are in staff spaces. Each function scales the canvas so one unit
 * is the gap between two staff lines, which is how engraving proportions are
 * conventionally expressed, and sets its line widths in the same unit so a glyph
 * keeps its weight at any size.
 */

/** Anchor points, measured in staff spaces from the top line of the staff. */
const STAFF_LINES = 4;

/**
 * Vertical position of a staff line, counted the way MusicXML counts them:
 * line 1 is the bottom line.
 *
 * @param {number} line
 * @returns {number} staff spaces below the top line
 */
export function staffLineOffset(line) {
  const index = Number(line);
  const safe = Number.isFinite(index) ? index : 1;
  return STAFF_LINES - (safe - 1);
}

/**
 * Run a drawing function in a coordinate system of staff spaces.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x horizontal anchor, in pixels
 * @param {number} y vertical anchor, in pixels
 * @param {number} space pixels per staff space
 * @param {(ctx: CanvasRenderingContext2D) => void} draw
 */
function inStaffSpace(ctx, x, y, space, draw) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(space, space);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  draw(ctx);
  ctx.restore();
}

/* =============================================================== accidentals */

/**
 * The two slanted crossbars shared by the sharp and the natural.
 *
 * Engraved accidentals slope their crossbars up to the right. It is a small
 * detail that does a lot of work: it stops the bars reading as staff lines.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} halfWidth
 * @param {number} thickness
 * @param {Array<number>} centres vertical centre of each bar
 */
function drawCrossbars(ctx, halfWidth, thickness, centres) {
  const slope = 0.16;
  ctx.lineWidth = thickness;
  for (const centre of centres) {
    ctx.beginPath();
    ctx.moveTo(-halfWidth, centre + slope);
    ctx.lineTo(halfWidth, centre - slope);
    ctx.stroke();
  }
}

/** A sharp: two uprights crossed by two sloping bars. */
export function drawSharpGlyph(ctx, x, y, space, color) {
  inStaffSpace(ctx, x, y, space, () => {
    ctx.strokeStyle = color;

    ctx.lineWidth = 0.13;
    for (const offset of [-0.27, 0.27]) {
      ctx.beginPath();
      ctx.moveTo(offset, -1.0);
      ctx.lineTo(offset, 0.92);
      ctx.stroke();
    }
    drawCrossbars(ctx, 0.52, 0.26, [-0.3, 0.3]);
  });
}

/** A flat: an upright with a bowl hanging off its lower right. */
export function drawFlatGlyph(ctx, x, y, space, color) {
  inStaffSpace(ctx, x, y, space, () => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.lineWidth = 0.13;
    ctx.beginPath();
    ctx.moveTo(-0.3, -1.55);
    ctx.lineTo(-0.3, 0.52);
    ctx.stroke();

    // The bowl sits on the note's line, which is why the stem rises above it.
    ctx.beginPath();
    ctx.moveTo(-0.3, 0.5);
    ctx.bezierCurveTo(0.02, 0.2, 0.46, 0.16, 0.46, -0.16);
    ctx.bezierCurveTo(0.46, -0.5, 0.06, -0.44, -0.3, -0.1);
    ctx.closePath();
    ctx.fill();
  });
}

/** A natural: two offset uprights joined by two sloping bars. */
export function drawNaturalGlyph(ctx, x, y, space, color) {
  inStaffSpace(ctx, x, y, space, () => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.13;

    ctx.beginPath();
    ctx.moveTo(-0.26, -0.98);
    ctx.lineTo(-0.26, 0.62);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0.26, -0.62);
    ctx.lineTo(0.26, 0.98);
    ctx.stroke();

    drawCrossbars(ctx, 0.26, 0.24, [-0.28, 0.34]);
  });
}

/** A double sharp: a squat saltire, not two sharps. */
export function drawDoubleSharpGlyph(ctx, x, y, space, color) {
  inStaffSpace(ctx, x, y, space, () => {
    ctx.strokeStyle = color;
    // Square ends keep the saltire angular, the way the engraved glyph is,
    // rather than reading as a letter x.
    ctx.lineCap = 'butt';
    ctx.lineWidth = 0.32;
    const reach = 0.34;
    ctx.beginPath();
    ctx.moveTo(-reach, -reach);
    ctx.lineTo(reach, reach);
    ctx.moveTo(reach, -reach);
    ctx.lineTo(-reach, reach);
    ctx.stroke();
  });
}

/** A double flat: two flats, the second tucked behind the first. */
export function drawDoubleFlatGlyph(ctx, x, y, space, color) {
  drawFlatGlyph(ctx, x - 0.5 * space, y, space, color);
  drawFlatGlyph(ctx, x + 0.42 * space, y, space, color);
}

/**
 * Draw the accidental for a chromatic alteration.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} alter -2..2
 * @param {number} x centre of the glyph
 * @param {number} y the note's vertical position
 * @param {number} space pixels per staff space
 * @param {string} color
 */
export function drawAccidental(ctx, alter, x, y, space, color) {
  switch (Math.trunc(Number(alter) || 0)) {
    case 1: return drawSharpGlyph(ctx, x, y, space, color);
    case -1: return drawFlatGlyph(ctx, x, y, space, color);
    case 2: return drawDoubleSharpGlyph(ctx, x, y, space, color);
    case -2: return drawDoubleFlatGlyph(ctx, x, y, space, color);
    default: return drawNaturalGlyph(ctx, x, y, space, color);
  }
}

/**
 * Horizontal room an accidental needs, in pixels.
 * @param {number} alter
 * @param {number} space
 * @returns {number}
 */
export function accidentalWidth(alter, space) {
  const value = Math.trunc(Number(alter) || 0);
  if (value === -2) return 1.7 * space;
  if (value === 2) return 0.9 * space;
  if (value === -1) return 0.9 * space;
  return 1.15 * space;
}

/* ==================================================================== clefs */

/**
 * A G clef.
 *
 * Built around a logarithmic spiral, which is what gives a real treble clef its
 * curl: the radius grows by a constant factor per turn rather than linearly, so
 * the coil opens out the way an engraved one does. The spiral is drawn segment
 * by segment with a widening pen, because the stroke of a clef is thin at the
 * centre of the curl and heavy where it turns.
 *
 * The anchor is the line the curl encircles, which is the G line in a normal
 * treble clef and moves with the clef's `line` attribute.
 */
export function drawGClefGlyph(ctx, x, y, space, color) {
  inStaffSpace(ctx, x, y, space, () => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    // The coil, from the centre outwards. The growth constant is chosen so the
    // outermost turn lands just under one staff space from the centre; an
    // exponential compounds fast, so a value picked by eye is wrong by a factor
    // of five rather than a little.
    // Nearly two full turns, so the outermost turn closes round the line the
    // clef names instead of opening straight into the upper loop. That is what
    // stops the glyph reading as a balloon on a stick.
    const turns = 1.95 * Math.PI * 2;
    const phase = -1.257; // brings the outer end round to the top of the coil
    const steps = 96;
    let previous = null;
    for (let step = 0; step <= steps; step++) {
      const angle = (step / steps) * turns;
      const radius = 0.13 * Math.exp(0.167 * angle);
      const point = {
        x: radius * Math.cos(angle + phase),
        y: radius * Math.sin(angle + phase)
      };
      if (previous) {
        // The pen widens as the coil opens, the way an engraved clef does.
        ctx.lineWidth = 0.08 + 0.16 * (step / steps);
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      previous = point;
    }

    // Out of the top of the coil into the upper loop, a teardrop leaning right
    // rather than a circle.
    ctx.lineWidth = 0.23;
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.bezierCurveTo(0.62, -1.85, 0.6, -3.05, 0.0, -3.4);
    ctx.bezierCurveTo(-0.58, -3.72, -0.95, -3.15, -0.82, -2.55);
    ctx.stroke();

    // Back down through the coil as the spine.
    ctx.beginPath();
    ctx.moveTo(-0.82, -2.55);
    ctx.bezierCurveTo(-0.7, -1.6, 0.14, -0.7, 0.44, 0.4);
    ctx.bezierCurveTo(0.7, 1.3, 0.82, 1.88, 0.8, 2.3);
    ctx.stroke();

    // The tail, hooking left below the staff.
    ctx.lineWidth = 0.19;
    ctx.beginPath();
    ctx.moveTo(0.8, 2.3);
    ctx.bezierCurveTo(0.76, 2.9, 0.28, 3.26, -0.2, 3.2);
    ctx.bezierCurveTo(-0.62, 3.14, -0.88, 2.88, -0.84, 2.6);
    ctx.stroke();

    // The terminal dot the tail curls into.
    ctx.beginPath();
    ctx.arc(-0.72, 2.46, 0.17, 0, Math.PI * 2);
    ctx.fill();
  });
}

/**
 * An F clef: a heavy comma turning away from the F line, with the two dots that
 * identify which line it is.
 *
 * The anchor is the F line, which the head sits on and the dots straddle.
 */
export function drawFClefGlyph(ctx, x, y, space, color) {
  inStaffSpace(ctx, x, y, space, () => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    // The head: a filled blob sitting on the line.
    ctx.beginPath();
    ctx.ellipse(0.02, -0.04, 0.4, 0.33, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // From the head the stroke rises to the right, turns over, and sweeps back
    // down and left, finishing near the bottom line.
    ctx.lineWidth = 0.26;
    ctx.beginPath();
    ctx.moveTo(0.26, -0.28);
    ctx.bezierCurveTo(0.9, -0.86, 1.24, -0.28, 1.16, 0.42);
    ctx.bezierCurveTo(1.04, 1.4, 0.42, 2.14, -0.6, 2.62);
    ctx.stroke();

    // The two dots that say which line is F.
    for (const offset of [-0.52, 0.52]) {
      ctx.beginPath();
      ctx.arc(1.6, offset, 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/**
 * A C clef: two mirrored hooks meeting on the line they name, behind a heavy
 * and a light upright.
 *
 * The anchor is the line the two hooks point at.
 */
export function drawCClefGlyph(ctx, x, y, space, color) {
  inStaffSpace(ctx, x, y, space, () => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(-0.72, -2);
    ctx.lineTo(-0.72, 2);
    ctx.stroke();

    ctx.lineWidth = 0.11;
    ctx.beginPath();
    ctx.moveTo(-0.34, -2);
    ctx.lineTo(-0.34, 2);
    ctx.stroke();

    // The hooks are mirror images about the anchor line.
    ctx.lineWidth = 0.24;
    for (const direction of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-0.2, direction * 2);
      ctx.bezierCurveTo(0.85, direction * 2, 1.15, direction * 1.3, 0.6, direction * 0.75);
      ctx.bezierCurveTo(0.2, direction * 0.35, 0.5, direction * 0.1, 0.85, direction * 0.28);
      ctx.stroke();
    }
  });
}

/**
 * Draw a clef.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{sign: string, line: number, octaveChange: number}} clef
 * @param {number} x left edge of the glyph
 * @param {number} staffTopY vertical position of the staff's top line
 * @param {number} space pixels per staff space
 * @param {string} color
 * @param {string} [labelFont] font for the octave number
 */
export function drawClefGlyph(ctx, clef, x, staffTopY, space, color, labelFont) {
  const sign = String(clef?.sign || 'G').toUpperCase();
  const line = Number(clef?.line) || (sign === 'F' ? 4 : sign === 'C' ? 3 : 2);
  const anchorY = staffTopY + staffLineOffset(line) * space;
  // Each glyph is drawn about its own centre, so it is nudged clear of the left
  // edge by roughly half its width.
  const centreX = x + clefGlyphWidth(sign, space) * 0.45;

  if (sign === 'F') drawFClefGlyph(ctx, centreX, anchorY, space, color);
  else if (sign === 'C') drawCClefGlyph(ctx, centreX, anchorY, space, color);
  else drawGClefGlyph(ctx, centreX, anchorY, space, color);

  const octaveChange = Math.trunc(Number(clef?.octaveChange) || 0);
  if (!octaveChange) return;

  // A tenor line written in a treble clef sounds an octave lower, and the small
  // 8 under the clef is the only thing on the page that says so.
  const octaves = Math.abs(octaveChange);
  const label = octaves === 1 ? '8' : String(octaves * 7 + 1);
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = labelFont || `600 ${Math.round(space * 0.95)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = octaveChange < 0 ? 'top' : 'alphabetic';
  const labelY = octaveChange < 0
    ? staffTopY + STAFF_LINES * space + space * 0.5
    : staffTopY - space * 0.6;
  ctx.fillText(label, centreX, labelY);
  ctx.restore();
}

/**
 * Horizontal room a clef needs, in pixels.
 * @param {string} sign
 * @param {number} space
 * @returns {number}
 */
export function clefGlyphWidth(sign, space) {
  const upper = String(sign || 'G').toUpperCase();
  if (upper === 'F') return 2.6 * space;
  if (upper === 'C') return 2.4 * space;
  return 2.9 * space;
}

/* ================================================================ time marks */

/**
 * Draw a time signature as two stacked numerals.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{numerator: number, denominator: number}} timeSignature
 * @param {number} x centre of the numerals
 * @param {number} staffTopY
 * @param {number} space
 * @param {string} color
 * @param {string} [fontFamily]
 */
export function drawTimeSignature(ctx, timeSignature, x, staffTopY, space, color, fontFamily) {
  const numerator = Number(timeSignature?.numerator);
  const denominator = Number(timeSignature?.denominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return;

  ctx.save();
  ctx.fillStyle = color;
  // Each numeral fills two staff spaces, which is how they are engraved.
  const size = Math.round(space * 2.05);
  ctx.font = `600 ${size}px ${fontFamily || 'Georgia, "Times New Roman", serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(numerator), x, staffTopY + space * 1.02);
  ctx.fillText(String(denominator), x, staffTopY + space * 3.02);
  ctx.restore();
}

/**
 * Horizontal room a time signature needs, in pixels.
 * @param {{numerator: number, denominator: number}} timeSignature
 * @param {number} space
 * @returns {number}
 */
export function timeSignatureWidth(timeSignature, space) {
  const digits = Math.max(
    String(Number(timeSignature?.numerator) || 4).length,
    String(Number(timeSignature?.denominator) || 4).length
  );
  return (0.9 + digits * 0.85) * space;
}
