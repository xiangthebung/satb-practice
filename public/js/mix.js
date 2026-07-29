/**
 * Rehearsal mix presets.
 *
 * A choir member usually wants one of four balances, so the panel offers
 * exactly those and treats anything else as a custom mix. The volume maths is
 * kept pure here so it can be reasoned about and tested without the DOM.
 */

export const DEFAULT_OTHERS_LEVEL = 35;

export const MIX_PRESETS = [
  {
    id: 'mostly-mine',
    label: 'Mostly my part',
    hint: 'Your line in front, the rest as support'
  },
  {
    id: 'only-mine',
    label: 'Only my part',
    hint: 'Learn the notes on their own'
  },
  {
    id: 'without-mine',
    label: 'Everyone but me',
    hint: 'Sing your line with the choir'
  },
  {
    id: 'everyone',
    label: 'Everyone',
    hint: 'Hear the piece as written'
  }
];

const PRESET_IDS = new Set(MIX_PRESETS.map(preset => preset.id));

/** True when the id names a known preset. */
export function isMixPreset(id) {
  return PRESET_IDS.has(id);
}

/**
 * Volume (0-100) for one part under a preset.
 * @param {string} presetId
 * @param {boolean} isMine
 * @param {number} othersLevel
 * @returns {number}
 */
export function getPresetVolume(presetId, isMine, othersLevel = DEFAULT_OTHERS_LEVEL) {
  const others = Math.max(0, Math.min(100, Math.round(othersLevel)));
  switch (presetId) {
    case 'only-mine':
      return isMine ? 100 : 0;
    case 'mostly-mine':
      return isMine ? 100 : others;
    case 'without-mine':
      return isMine ? 0 : 100;
    case 'everyone':
    default:
      return 100;
  }
}

/**
 * Volumes for every part under a preset.
 * @param {string} presetId
 * @param {Array<{ id: string }>} parts
 * @param {string|null} myPartId
 * @param {number} othersLevel
 * @returns {Record<string, number>}
 */
export function getMixVolumes(presetId, parts = [], myPartId = null, othersLevel = DEFAULT_OTHERS_LEVEL) {
  const volumes = {};
  for (const part of parts) {
    volumes[part.id] = getPresetVolume(presetId, part.id === myPartId, othersLevel);
  }
  return volumes;
}

/**
 * Identify which preset (if any) the current volumes represent. Moving a single
 * slider therefore reports a custom mix instead of leaving a stale selection.
 *
 * @param {Record<string, number>} volumes
 * @param {Array<{ id: string }>} parts
 * @param {string|null} myPartId
 * @param {number} othersLevel
 * @returns {string|null} preset id, or null for a custom mix
 */
export function detectMixPreset(volumes = {}, parts = [], myPartId = null, othersLevel = DEFAULT_OTHERS_LEVEL) {
  if (parts.length === 0) return null;

  for (const preset of MIX_PRESETS) {
    const matches = parts.every(part => {
      const expected = getPresetVolume(preset.id, part.id === myPartId, othersLevel);
      return Math.round(Number(volumes[part.id]) || 0) === expected;
    });
    if (matches) return preset.id;
  }
  return null;
}
