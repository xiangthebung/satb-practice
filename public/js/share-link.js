/**
 * Deep links: the practice state, written into and read back out of the URL hash.
 *
 * A singer who has found the four bars that keep going wrong wants to hand
 * those four bars to the rest of the section, not a description of how to find
 * them. So the things that describe a passage — which score, which part, which
 * bars, how fast — are mirrored into `location.hash` as it changes, and a link
 * pasted into the choir's chat opens the app already looking at that passage:
 *
 *   #sample=quick&part=alto&loop=13-16&tempo=90
 *
 * The hash is chosen over a query string because it never reaches the server
 * and never busts the cache of the page it is on. The keys are short words a
 * person can read and edit by hand. Everything here is pure, so it can be
 * tested without a browser; the app owns the two sides of the mirror.
 */

const LOOP_PATTERN = /^(\d+)-(\d+)$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Tempo limits, the same ones the transport slider has. */
export const SHARE_TEMPO_RANGE = { min: 40, max: 240 };

/** Zoom limits, the same ones the score view has. */
export const SHARE_ZOOM_RANGE = { min: 0.5, max: 2.5 };

/**
 * A voice type as it appears in a link: `soprano 1` becomes `soprano-1`.
 * @param {string} voiceType
 * @returns {string}
 */
export function voiceSlug(voiceType) {
  return String(voiceType || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The part a link's `part=` names, or null.
 *
 * Matched on the voice type first, because that is what the slug was made
 * from, then on the printed name, so a score whose parts are called "Cantus"
 * and "Bassus" can still be linked to by name.
 *
 * @param {Array<{ id: string, name?: string, voiceType?: string }>} parts
 * @param {string} slug
 * @returns {object|null}
 */
export function findPartBySlug(parts, slug) {
  const wanted = voiceSlug(slug);
  if (!wanted) return null;
  return (parts || []).find(part => voiceSlug(part.voiceType) === wanted) ||
    (parts || []).find(part => voiceSlug(part.name) === wanted) ||
    (parts || []).find(part => String(part.id) === String(slug)) ||
    null;
}

/**
 * Write the state into a hash, without the leading `#`.
 *
 * Only what is set goes in, so a link to a score with nothing else chosen is
 * just `sample=quick`. An empty state gives an empty string, which the app
 * uses to clear the hash when it goes back to the home screen.
 *
 * @param {{
 *   sample?: string|null,
 *   part?: string|null,
 *   loop?: { fromBar: number, toBar: number }|null,
 *   tempo?: number|null,
 *   zoom?: number|null,
 *   mix?: string|null
 * }} state
 * @returns {string}
 */
export function buildShareHash(state = {}) {
  const pairs = [];
  const sample = voiceSlug(state.sample);
  if (sample) pairs.push(['sample', sample]);

  const part = voiceSlug(state.part);
  if (part) pairs.push(['part', part]);

  const loop = state.loop;
  if (loop && Number.isFinite(Number(loop.fromBar)) && Number.isFinite(Number(loop.toBar))) {
    const from = Math.round(Number(loop.fromBar));
    const to = Math.round(Number(loop.toBar));
    pairs.push(['loop', `${Math.min(from, to)}-${Math.max(from, to)}`]);
  }

  const tempo = Math.round(Number(state.tempo));
  if (Number.isFinite(tempo) && tempo > 0) pairs.push(['tempo', String(tempo)]);

  const zoom = Number(state.zoom);
  // The default zoom is not worth writing down.
  if (Number.isFinite(zoom) && zoom > 0 && Math.abs(zoom - 1) > 0.005) {
    pairs.push(['zoom', String(Math.round(zoom * 100) / 100)]);
  }

  const mix = voiceSlug(state.mix);
  if (mix) pairs.push(['mix', mix]);

  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

/**
 * Read a hash back into state.
 *
 * Anything malformed is dropped rather than rejected as a whole: a link with a
 * mistyped tempo still opens the right score at the right bars. Every value is
 * clamped or validated, because the hash is typed by people.
 *
 * @param {string} hash with or without the leading `#`
 * @returns {{
 *   sample: string|null,
 *   part: string|null,
 *   loop: { fromBar: number, toBar: number }|null,
 *   tempo: number|null,
 *   zoom: number|null,
 *   mix: string|null,
 *   isEmpty: boolean
 * }}
 */
export function parseShareHash(hash) {
  const text = String(hash || '').replace(/^#/, '');
  const state = { sample: null, part: null, loop: null, tempo: null, zoom: null, mix: null };
  if (!text) return { ...state, isEmpty: true };

  let params;
  try {
    params = new URLSearchParams(text);
  } catch (error) {
    return { ...state, isEmpty: true };
  }

  const slug = (key) => {
    const value = voiceSlug(params.get(key));
    return value && SLUG_PATTERN.test(value) ? value : null;
  };
  state.sample = slug('sample');
  state.part = slug('part');
  state.mix = slug('mix');

  const loop = String(params.get('loop') || '').trim().match(LOOP_PATTERN);
  if (loop) {
    const from = Number.parseInt(loop[1], 10);
    const to = Number.parseInt(loop[2], 10);
    if (from > 0 && to > 0) {
      state.loop = { fromBar: Math.min(from, to), toBar: Math.max(from, to) };
    }
  }

  const tempo = Number.parseInt(String(params.get('tempo') || ''), 10);
  if (Number.isFinite(tempo)) {
    state.tempo = Math.max(SHARE_TEMPO_RANGE.min, Math.min(SHARE_TEMPO_RANGE.max, tempo));
  }

  const zoom = Number.parseFloat(String(params.get('zoom') || ''));
  if (Number.isFinite(zoom) && zoom > 0) {
    state.zoom = Math.max(SHARE_ZOOM_RANGE.min, Math.min(SHARE_ZOOM_RANGE.max, zoom));
  }

  const isEmpty = !state.sample && !state.part && !state.loop &&
    state.tempo === null && state.zoom === null && !state.mix;
  return { ...state, isEmpty };
}

/**
 * Say what a link points at, for the message shown when it is copied.
 *
 * @param {{ title?: string, partName?: string|null, loop?: object|null, tempo?: number|null }} details
 * @returns {string}
 */
export function describeShare({ title, partName, loop, tempo } = {}) {
  const pieces = [];
  if (partName) pieces.push(partName);
  if (loop) {
    pieces.push(loop.fromBar === loop.toBar
      ? `bar ${loop.fromBar}`
      : `bars ${loop.fromBar} to ${loop.toBar}`);
  }
  if (Number.isFinite(Number(tempo)) && Number(tempo) > 0) pieces.push(`${Math.round(tempo)} BPM`);
  const what = pieces.length ? pieces.join(', ') : 'the whole score';
  return title ? `${title}: ${what}` : what;
}
