/**
 * Dynamics: written markings turned into a playable loudness curve.
 *
 * A score marks loudness in two ways that have to be combined. Discrete
 * markings (p, mf, ff) set a level from that point on, and hairpins (wedges)
 * ramp between levels over a span of beats. This module flattens both into one
 * ordered timeline that playback can sample at any beat.
 *
 * Everything here is pure data and pure functions so it can be reasoned about
 * and tested without an AudioContext.
 */

/**
 * Standard markings as a peak-envelope scale, quietest to loudest.
 *
 * These are deliberately compressed relative to the notated extremes. A choir
 * rehearsing needs to hear a pianissimo entry clearly, so the useful range for
 * a practice tool is narrower than a concert recording would be.
 */
export const DYNAMIC_VELOCITIES = {
  n: 0.06,
  pppp: 0.16,
  ppp: 0.22,
  pp: 0.30,
  p: 0.40,
  mp: 0.52,
  mf: 0.64,
  f: 0.78,
  ff: 0.88,
  fff: 0.96,
  ffff: 1.0
};

/** The level a part sings at before any marking appears. */
export const DEFAULT_VELOCITY = DYNAMIC_VELOCITIES.mf;

/** Ordered levels, used to step a hairpin that has no explicit destination. */
const LEVEL_LADDER = [
  DYNAMIC_VELOCITIES.ppp,
  DYNAMIC_VELOCITIES.pp,
  DYNAMIC_VELOCITIES.p,
  DYNAMIC_VELOCITIES.mp,
  DYNAMIC_VELOCITIES.mf,
  DYNAMIC_VELOCITIES.f,
  DYNAMIC_VELOCITIES.ff,
  DYNAMIC_VELOCITIES.fff
];

/**
 * Sudden emphasis on a single note rather than a change of level. The value is
 * a multiplier applied to whatever level is in force.
 */
export const ACCENT_MARKINGS = {
  sf: 1.35,
  sfz: 1.4,
  sffz: 1.5,
  fz: 1.3,
  rf: 1.25,
  rfz: 1.3
};

/** Markings that set a level, then immediately drop to a second level. */
const COMPOUND_MARKINGS = {
  fp: { attack: DYNAMIC_VELOCITIES.f, settle: DYNAMIC_VELOCITIES.p },
  sfp: { attack: DYNAMIC_VELOCITIES.ff, settle: DYNAMIC_VELOCITIES.p }
};

const EPSILON = 1e-6;

/** Clamp to the usable envelope range. */
function clampVelocity(value) {
  const velocity = Number(value);
  if (!Number.isFinite(velocity)) return DEFAULT_VELOCITY;
  return Math.max(0.02, Math.min(1, velocity));
}

/**
 * Interpret the element names inside a MusicXML `<dynamics>` element.
 *
 * The element is a container of empty child elements, so "mf" arrives as
 * `<mf/>` rather than as text. Unknown children fall back to `<other-dynamics>`
 * text, which is where non-standard markings end up.
 *
 * @param {Array<string>} names child element names, in document order
 * @param {string} [otherText] contents of <other-dynamics>
 * @returns {{ velocity: number|null, accent: number|null, settle: number|null }}
 */
export function interpretDynamicNames(names = [], otherText = '') {
  const result = { velocity: null, accent: null, settle: null };

  for (const raw of names) {
    const name = String(raw || '').trim().toLowerCase();
    if (!name) continue;

    if (COMPOUND_MARKINGS[name]) {
      result.velocity = COMPOUND_MARKINGS[name].attack;
      result.settle = COMPOUND_MARKINGS[name].settle;
      continue;
    }
    if (ACCENT_MARKINGS[name]) {
      result.accent = ACCENT_MARKINGS[name];
      continue;
    }
    if (DYNAMIC_VELOCITIES[name] !== undefined) {
      result.velocity = DYNAMIC_VELOCITIES[name];
    }
  }

  if (result.velocity === null && result.accent === null) {
    const text = String(otherText || '').trim().toLowerCase();
    if (DYNAMIC_VELOCITIES[text] !== undefined) result.velocity = DYNAMIC_VELOCITIES[text];
    else if (ACCENT_MARKINGS[text] !== undefined) result.accent = ACCENT_MARKINGS[text];
  }

  return result;
}

/**
 * Convert the `dynamics` attribute of a `<sound>` element to an envelope level.
 *
 * MusicXML defines that attribute as a percentage where 100 corresponds to MIDI
 * velocity 90, so the conversion goes through velocity rather than treating the
 * number as a direct percentage of full scale.
 *
 * @param {number|string} value
 * @returns {number|null}
 */
export function velocityFromSoundDynamics(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  const midiVelocity = (percent / 100) * 90;
  return clampVelocity(midiVelocity / 127 * 1.35);
}

/** Nearest standard level to a velocity, as an index into the ladder. */
function ladderIndexFor(velocity) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < LEVEL_LADDER.length; index++) {
    const distance = Math.abs(LEVEL_LADDER[index] - velocity);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Where a hairpin with no written destination should arrive.
 * A crescendo climbs one standard level, a diminuendo drops one.
 *
 * @param {number} fromVelocity
 * @param {'crescendo'|'diminuendo'} type
 * @returns {number}
 */
export function stepLevel(fromVelocity, type) {
  const index = ladderIndexFor(fromVelocity);
  const target = type === 'diminuendo' ? index - 1 : index + 1;
  return LEVEL_LADDER[Math.max(0, Math.min(LEVEL_LADDER.length - 1, target))];
}

/**
 * Flatten discrete markings and hairpins into one sampled timeline.
 *
 * The result is a sorted list of nodes. Between a node and the next, the level
 * is constant unless the node is marked as ramping, in which case it moves
 * linearly to the following node's level. That representation covers a plain
 * marking, a hairpin between two markings, and a hairpin with no destination,
 * without needing three separate lookups at playback time.
 *
 * @param {object} input
 * @param {Array<{beat: number, velocity?: number|null, settle?: number|null}>} input.marks
 * @param {Array<{startBeat: number, endBeat: number, type: string}>} input.wedges
 * @param {number} [input.defaultVelocity]
 * @returns {{ nodes: Array<{beat: number, velocity: number, ramp: boolean}> }}
 */
export function buildDynamicsTimeline({ marks = [], wedges = [], defaultVelocity = DEFAULT_VELOCITY } = {}) {
  const byBeat = new Map();

  const setNode = (beat, velocity, { ramp = false, explicit = false } = {}) => {
    const key = Math.max(0, Number(beat) || 0);
    const rounded = Number(key.toFixed(6));
    const existing = byBeat.get(rounded);
    if (existing && existing.explicit && !explicit) {
      if (ramp) existing.ramp = true;
      return existing;
    }
    const node = {
      beat: rounded,
      velocity: clampVelocity(velocity),
      ramp: Boolean(ramp || existing?.ramp),
      explicit: Boolean(explicit || existing?.explicit)
    };
    byBeat.set(rounded, node);
    return node;
  };

  setNode(0, defaultVelocity);

  const sortedMarks = [...marks]
    .filter(mark => Number.isFinite(Number(mark?.beat)))
    .sort((left, right) => Number(left.beat) - Number(right.beat));

  for (const mark of sortedMarks) {
    // Null has to be rejected explicitly: Number(null) is 0, which is a finite
    // number, and would silently write a node at near-silence.
    if (mark.velocity != null && Number.isFinite(Number(mark.velocity))) {
      setNode(mark.beat, mark.velocity, { explicit: true });
    }
    // "fp" lands loud and immediately settles. The settled level starts a hair
    // after the attack so the drop is audible without needing a special case in
    // the sampler.
    if (mark.settle != null && Number.isFinite(Number(mark.settle))) {
      setNode(Number(mark.beat) + 0.25, mark.settle, { explicit: true });
    }
  }

  const orderedBeats = () => [...byBeat.values()].sort((left, right) => left.beat - right.beat);

  /** Level in force at a beat, given the nodes recorded so far. */
  const sampleSoFar = (beat) => {
    const nodes = orderedBeats();
    let velocity = defaultVelocity;
    for (const node of nodes) {
      if (node.beat > beat + EPSILON) break;
      velocity = node.velocity;
    }
    return velocity;
  };

  const sortedWedges = [...wedges]
    .filter(wedge => Number.isFinite(Number(wedge?.startBeat)) && Number.isFinite(Number(wedge?.endBeat)))
    .sort((left, right) => Number(left.startBeat) - Number(right.startBeat));

  for (const wedge of sortedWedges) {
    const startBeat = Math.max(0, Number(wedge.startBeat));
    const endBeat = Math.max(startBeat, Number(wedge.endBeat));
    if (endBeat - startBeat < EPSILON) continue;

    const type = String(wedge.type || 'crescendo').toLowerCase() === 'diminuendo'
      ? 'diminuendo'
      : 'crescendo';

    const startVelocity = sampleSoFar(startBeat);
    setNode(startBeat, startVelocity, { ramp: true });

    // A marking written at the end of the hairpin is its destination. Without
    // one, the hairpin moves by a single standard level.
    const existingEnd = [...byBeat.values()].find(node =>
      node.explicit && Math.abs(node.beat - endBeat) < 0.5
    );
    const endVelocity = existingEnd ? existingEnd.velocity : stepLevel(startVelocity, type);
    setNode(endBeat, endVelocity, { explicit: Boolean(existingEnd) });
  }

  const nodes = orderedBeats().map(node => ({
    beat: node.beat,
    velocity: node.velocity,
    ramp: node.ramp
  }));

  // A ramp only means anything when a later node gives it a destination.
  for (let index = 0; index < nodes.length; index++) {
    if (index === nodes.length - 1) nodes[index].ramp = false;
  }

  return { nodes };
}

/**
 * Sample the loudness timeline at a beat.
 * @param {{ nodes: Array }} timeline
 * @param {number} beat
 * @returns {number} envelope level, 0..1
 */
export function velocityAt(timeline, beat) {
  const nodes = timeline?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return DEFAULT_VELOCITY;

  const target = Math.max(0, Number(beat) || 0);
  if (target <= nodes[0].beat) return nodes[0].velocity;

  // Scores rarely carry enough markings for a binary search to pay off, and a
  // linear scan keeps the ramp interpolation obvious.
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const next = nodes[index + 1];
    if (!next || target < next.beat - EPSILON) {
      if (!next || !node.ramp) return node.velocity;
      const span = next.beat - node.beat;
      if (span <= EPSILON) return next.velocity;
      const progress = Math.max(0, Math.min(1, (target - node.beat) / span));
      return node.velocity + (next.velocity - node.velocity) * progress;
    }
  }
  return nodes[nodes.length - 1].velocity;
}

/**
 * Read a part's written markings into the inputs the timeline builder wants.
 *
 * Hairpins arrive as separate start and stop directions that have to be paired
 * up, and a hairpin left open at the end of the score still has to end
 * somewhere, so it is closed at the last bar rather than dropped.
 *
 * @param {object} part a parsed part
 * @returns {{ marks: Array, wedges: Array, accents: Array }}
 */
export function collectPartDynamics(part) {
  const marks = [];
  const wedges = [];
  const accents = [];
  const openWedges = new Map();
  let lastBeat = 0;

  for (const measure of part?.measures || []) {
    const measureStart = Number(measure.startBeat) || 0;
    lastBeat = Math.max(lastBeat, measureStart + (Number(measure.beats) || 0));

    for (const direction of measure.directions || []) {
      const beat = measureStart + (Number(direction.startBeatInMeasure) || 0);

      const velocity = direction.dynamics?.velocity ?? direction.soundDynamics ?? null;
      if (velocity !== null) {
        marks.push({
          beat,
          velocity,
          settle: direction.dynamics?.settle ?? null
        });
      }
      if (direction.dynamics?.accent) {
        accents.push({ beat, multiplier: direction.dynamics.accent });
      }

      const wedge = direction.wedge;
      if (!wedge) continue;
      const number = Number(wedge.number) || 1;
      if (wedge.type === 'stop') {
        const open = openWedges.get(number);
        if (open) {
          wedges.push({ startBeat: open.beat, endBeat: beat, type: open.type });
          openWedges.delete(number);
        }
      } else if (wedge.type === 'crescendo' || wedge.type === 'diminuendo') {
        openWedges.set(number, { beat, type: wedge.type });
      }
    }
  }

  // An unterminated hairpin runs to the end of the music.
  for (const open of openWedges.values()) {
    if (lastBeat > open.beat) {
      wedges.push({ startBeat: open.beat, endBeat: lastBeat, type: open.type });
    }
  }

  return { marks, wedges, accents };
}

/**
 * Build a part's loudness timeline directly from its parsed measures.
 * @param {object} part
 * @param {{ defaultVelocity?: number }} [options]
 * @returns {{ nodes: Array, accents: Array }}
 */
export function buildPartDynamics(part, { defaultVelocity = DEFAULT_VELOCITY } = {}) {
  const { marks, wedges, accents } = collectPartDynamics(part);
  const timeline = buildDynamicsTimeline({ marks, wedges, defaultVelocity });
  return { ...timeline, accents };
}

/**
 * Emphasis multiplier for a single note, from written accents.
 *
 * These stack multiplicatively but are capped, because a note marked both
 * accented and sforzando should be strong, not twice as loud as the ensemble.
 *
 * @param {{accent?: boolean, strongAccent?: boolean, tenuto?: boolean, accentVelocity?: number|null}} articulation
 * @returns {number}
 */
export function accentMultiplier(articulation = {}) {
  let multiplier = 1;
  if (articulation.accent) multiplier *= 1.22;
  if (articulation.strongAccent) multiplier *= 1.35;
  if (articulation.tenuto) multiplier *= 1.06;
  // Null has to be rejected explicitly: Number(null) is 0, which is finite, and
  // would multiply the emphasis away instead of leaving it alone.
  if (articulation.accentVelocity != null && Number.isFinite(Number(articulation.accentVelocity))) {
    multiplier *= Number(articulation.accentVelocity);
  }
  return Math.max(1, Math.min(1.6, multiplier));
}
