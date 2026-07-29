/**
 * Timbre tables and vocal-tract maths for the playback synthesizer.
 *
 * Everything here is pure data and pure functions: no AudioContext, no DOM.
 * The numbers that decide how a part *sounds* live in one place so they can be
 * read, reasoned about and adjusted without touching the scheduling engine.
 *
 * Approach: each voice part is synthesized as a section of singers. A glottal
 * pulse source supplies the harmonic spectrum, and a cascade of peaking filters
 * imposes the vowel resonances (formants). Cascaded peaking filters are used
 * rather than parallel bandpass filters because they keep the whole spectrum
 * intact — a parallel bandpass bank drops every harmonic that falls between two
 * formants, which is what gives naive formant synthesis its hollow, nasal
 * quality and makes the tone wobble as the pitch moves through the passband.
 */

/* ============================================================ voice profiles */

/**
 * Per-voice-class synthesis profile.
 *
 *   formantScale  Vocal tract length compensation. Formant frequencies scale
 *                 roughly inversely with tract length, so a bass sits below and
 *                 a soprano above the reference tract used by VOWELS.
 *   lowMidi/highMidi  Comfortable singing range, used to derive register
 *                 position (brightness and loudness rise towards the top).
 *   tilt          Glottal source spectral slope exponent. Larger = darker.
 *   pan           Stereo position, negative is left.
 *   reverb        Reverb send level before the global room amount is applied.
 *   lowShelf/highShelf  Gentle seat-in-the-mix tone shaping for the part bus.
 *   singerFormant The 2.8-3.3 kHz resonance cluster that lets a trained voice
 *                 project over an ensemble. Most prominent in men's voices.
 *   vibrato       Section-average rate (Hz), depth (cents) and onset (seconds).
 *   breath        Aspiration noise level relative to the voiced source.
 */
export const VOICE_PROFILES = {
  soprano: {
    formantScale: 1.14,
    lowMidi: 60,  // C4
    highMidi: 84, // C6
    tilt: 1.06,
    pan: -0.34,
    reverb: 0.26,
    lowShelf: { freq: 320, gain: -2.5 },
    highShelf: { freq: 5200, gain: 1.5 },
    singerFormant: { freq: 3150, gain: 2.5, q: 2.6 },
    vibrato: { rate: 5.8, depth: 24, onset: 0.20 },
    breath: 0.030
  },
  alto: {
    formantScale: 1.02,
    lowMidi: 53,  // F3
    highMidi: 77, // F5
    tilt: 1.18,
    pan: -0.12,
    reverb: 0.28,
    lowShelf: { freq: 270, gain: -1.5 },
    highShelf: { freq: 4800, gain: 0.5 },
    singerFormant: { freq: 2950, gain: 2.6, q: 2.8 },
    vibrato: { rate: 5.5, depth: 22, onset: 0.22 },
    breath: 0.028
  },
  tenor: {
    formantScale: 0.94,
    lowMidi: 46,  // Bb2
    highMidi: 70, // Bb4
    tilt: 1.26,
    pan: 0.12,
    reverb: 0.30,
    lowShelf: { freq: 220, gain: 0.5 },
    highShelf: { freq: 4600, gain: -0.5 },
    singerFormant: { freq: 2850, gain: 3.2, q: 3.0 },
    vibrato: { rate: 5.35, depth: 21, onset: 0.24 },
    breath: 0.026
  },
  bass: {
    formantScale: 0.86,
    lowMidi: 38,  // D2
    highMidi: 62, // D4
    tilt: 1.42,
    pan: 0.34,
    reverb: 0.32,
    lowShelf: { freq: 170, gain: 2.0 },
    highShelf: { freq: 4200, gain: -1.5 },
    singerFormant: { freq: 2700, gain: 3.4, q: 3.2 },
    vibrato: { rate: 5.15, depth: 19, onset: 0.26 },
    breath: 0.024
  },
  /** Accompaniment staves: no vocal colouring, centred, a little room. */
  piano: {
    formantScale: 1.0,
    lowMidi: 28,
    highMidi: 96,
    tilt: 1.2,
    pan: 0,
    reverb: 0.20,
    lowShelf: { freq: 200, gain: 0 },
    highShelf: { freq: 5000, gain: 0 },
    singerFormant: { freq: 2900, gain: 0, q: 3 },
    vibrato: { rate: 5, depth: 0, onset: 1 },
    breath: 0
  },
  default: {
    formantScale: 1.0,
    lowMidi: 50,
    highMidi: 74,
    tilt: 1.2,
    pan: 0,
    reverb: 0.28,
    lowShelf: { freq: 250, gain: 0 },
    highShelf: { freq: 4800, gain: 0 },
    singerFormant: { freq: 2900, gain: 2.6, q: 2.8 },
    vibrato: { rate: 5.5, depth: 22, onset: 0.22 },
    breath: 0.027
  }
};

/**
 * Map a MusicXML-derived voice type onto a synthesis class.
 * @param {string} [voiceType]
 * @returns {'soprano'|'alto'|'tenor'|'bass'|'default'}
 */
export function resolveVoiceClass(voiceType) {
  const name = String(voiceType || '').toLowerCase();
  if (!name) return 'default';
  if (name.includes('soprano') || name.includes('treble') || name.includes('descant')) {
    return 'soprano';
  }
  if (name.includes('mezzo') || name.includes('alto') || name.includes('contralto') ||
      name.includes('countertenor')) {
    return 'alto';
  }
  if (name.includes('tenor')) return 'tenor';
  if (name.includes('bass') || name.includes('baritone')) return 'bass';
  return 'default';
}

/**
 * Look up a profile, always returning something usable.
 * @param {string} voiceClass
 * @returns {object}
 */
export function profileFor(voiceClass) {
  return VOICE_PROFILES[voiceClass] || VOICE_PROFILES.default;
}

/**
 * Where a pitch sits in a voice's comfortable range, 0 at the bottom and 1 at
 * the top. Drives brightness and loudness: singers open up as they ascend.
 * @param {number} midi
 * @param {object} profile
 * @returns {number} 0..1
 */
export function registerPosition(midi, profile) {
  const low = Number(profile?.lowMidi);
  const high = Number(profile?.highMidi);
  if (!Number.isFinite(midi) || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, (midi - low) / (high - low)));
}

/* =================================================================== vowels */

/**
 * Sung vowel formants for a reference adult tract, scaled per voice class by
 * `formantScale`. Three vocal-tract resonances per vowel; the fourth resonance
 * comes from the voice profile's singer formant, which is a property of the
 * singer rather than of the vowel.
 *
 * freq in Hz, q is the peaking-filter Q, gain in dB.
 */
export const VOWELS = {
  /** "ah" — father, la. The most open and resonant vowel. */
  a: [
    { freq: 700,  q: 1.9, gain: 9.0 },
    { freq: 1180, q: 2.1, gain: 6.0 },
    { freq: 2560, q: 2.8, gain: 4.0 }
  ],
  /** "eh/ay" — bed, say. */
  e: [
    { freq: 500,  q: 2.1, gain: 8.5 },
    { freq: 1780, q: 2.3, gain: 6.5 },
    { freq: 2520, q: 2.8, gain: 4.0 }
  ],
  /** "ee" — see, me. Closed and bright. */
  i: [
    { freq: 330,  q: 2.3, gain: 8.0 },
    { freq: 2200, q: 2.5, gain: 7.0 },
    { freq: 2960, q: 3.0, gain: 4.5 }
  ],
  /** "oh" — boat, more. */
  o: [
    { freq: 460,  q: 2.1, gain: 9.0 },
    { freq: 820,  q: 2.1, gain: 5.5 },
    { freq: 2560, q: 2.8, gain: 2.5 }
  ],
  /** "oo" — boot, moon. Darkest of the set. */
  u: [
    { freq: 340,  q: 2.3, gain: 8.5 },
    { freq: 700,  q: 2.1, gain: 4.5 },
    { freq: 2400, q: 2.8, gain: 2.0 }
  ]
};

/**
 * Formant targets for a voice class singing a vowel at a given pitch.
 *
 * Two corrections are applied on top of the table. A singer raises F1 by
 * opening the jaw so it never falls below the sung fundamental — skipping this
 * is what makes synthesized high soprano lines sound thin and whistly. F2 is
 * then kept clear of F1 so the two peaks cannot collapse into one.
 *
 * @param {string} voiceClass
 * @param {string} vowel - key into VOWELS
 * @param {number} [fundamental] - sung pitch in Hz, 0 to skip the correction
 * @returns {Array<{freq: number, q: number, gain: number}>}
 */
export function formantsFor(voiceClass, vowel, fundamental = 0) {
  const profile = profileFor(voiceClass);
  const rows = VOWELS[vowel] || VOWELS.a;
  const formants = rows.map(row => ({
    freq: row.freq * profile.formantScale,
    q: row.q,
    gain: row.gain
  }));

  if (fundamental > 0) {
    const jawFloor = Math.min(fundamental * 1.06, 1150);
    if (formants[0].freq < jawFloor) formants[0].freq = jawFloor;
  }
  if (formants[1].freq < formants[0].freq * 1.25) {
    formants[1].freq = formants[0].freq * 1.25;
  }
  if (formants[2].freq < formants[1].freq * 1.2) {
    formants[2].freq = formants[1].freq * 1.2;
  }
  return formants;
}

/** Vowel letters, including the accented forms common in choral repertoire. */
const VOWEL_LETTERS = 'aeiouyáàâäãåæéèêëíìîïóòôöõøúùûüýÿœ';

/** Fold accented vowels onto the base letter used by the cluster table. */
const ACCENT_FOLD = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', æ: 'e',
  é: 'e', è: 'e', ê: 'e', ë: 'e', œ: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i', ý: 'i', ÿ: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o', ø: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u'
};

/**
 * Spelling-to-vowel table. This is deliberately a heuristic: the goal is that
 * consecutive syllables get audibly different vowel colours, not phonetic
 * transcription. Unknown spellings fall back to the open "ah".
 */
const VOWEL_BY_CLUSTER = {
  a: 'a', aa: 'a', ah: 'a', ai: 'e', ay: 'e', au: 'o', aw: 'o', ae: 'e',
  e: 'e', ea: 'e', ee: 'i', ei: 'e', eu: 'u', ew: 'u', ey: 'e', eo: 'o',
  i: 'i', ia: 'a', ie: 'i', io: 'o', iu: 'u',
  o: 'o', oa: 'o', oe: 'o', oi: 'o', oo: 'u', ou: 'u', ow: 'o', oy: 'o',
  u: 'u', ue: 'u', ui: 'u', uy: 'i', uo: 'o',
  y: 'i'
};

/**
 * Pick a vowel colour for a sung syllable.
 *
 * MusicXML gives us the printed syllable, not a pronunciation, so this reads
 * the first vowel cluster and applies a few English long-vowel rules (night,
 * find, name) that would otherwise be sung with the wrong colour.
 *
 * @param {string} text - lyric text for the note
 * @param {string} [fallback] - vowel to use when nothing can be read
 * @returns {'a'|'e'|'i'|'o'|'u'}
 */
export function vowelFromSyllable(text, fallback = 'a') {
  const raw = String(text ?? '').toLowerCase();
  let word = '';
  for (const char of raw) {
    if (ACCENT_FOLD[char]) word += ACCENT_FOLD[char];
    else if (char >= 'a' && char <= 'z') word += char;
  }
  if (!word) return VOWELS[fallback] ? fallback : 'a';

  // The "u" in qu- is part of the consonant, not the vowel: "quick" is sung on
  // an "i", not an "u".
  const scannable = word.replace(/qu/g, 'q');

  const start = [...scannable].findIndex(char => VOWEL_LETTERS.includes(char));
  if (start === -1) return VOWELS[fallback] ? fallback : 'a';

  let end = start;
  while (end < scannable.length && VOWEL_LETTERS.includes(scannable[end]) && end - start < 3) {
    end++;
  }
  // A following "w" completes the vowel rather than starting a consonant:
  // draw, know, new.
  if (end - start === 1 && scannable[end] === 'w') end++;
  const cluster = scannable.slice(start, end);
  const tail = scannable.slice(end);

  // English long vowels: a single vowel plus a consonant and a silent final
  // "e" (time, name), "igh" (night) or "-ind/-ild" (find, mild).
  if (cluster.length === 1) {
    const silentE = /^[bcdfghjklmnprstvwz]e$/.test(tail);
    if (cluster === 'i' && (/^gh/.test(tail) || /^(nd|ld|gn)$/.test(tail) || silentE)) {
      return 'a';
    }
    if (cluster === 'a' && silentE) return 'e';
    if (cluster === 'e' && silentE) return 'i';
  }

  return VOWEL_BY_CLUSTER[cluster] ||
    VOWEL_BY_CLUSTER[cluster.slice(0, 2)] ||
    VOWEL_BY_CLUSTER[cluster[0]] ||
    'a';
}

/* ============================================================ glottal source */

/**
 * Harmonic amplitudes for a glottal pulse train, normalized to a target RMS.
 *
 * Normalizing by RMS rather than by peak (which is what the Web Audio
 * PeriodicWave normalizer does) keeps perceived loudness steady across the
 * range: a low bass note carries far more harmonics than a high soprano note,
 * and peak normalization would make the bass much quieter than the soprano.
 *
 * @param {number} count - number of harmonics to include
 * @param {number} [tilt] - spectral slope exponent; larger is darker
 * @param {{corner?: number, rms?: number}} [options]
 *   corner: harmonic where a second, steeper rolloff sets in, tamimg buzz
 *   rms: target root-mean-square amplitude of the resulting waveform
 * @returns {Float32Array} amplitudes indexed 1..count (index 0 is the DC term)
 */
export function glottalHarmonics(count, tilt = 1.2, { corner = 14, rms = 0.3 } = {}) {
  const harmonics = Math.max(1, Math.floor(count));
  const amplitudes = new Float32Array(harmonics + 1);
  let power = 0;

  for (let n = 1; n <= harmonics; n++) {
    const slope = Math.pow(n, -tilt);
    const rolloff = 1 / Math.sqrt(1 + Math.pow(n / corner, 4));
    const amplitude = slope * rolloff;
    amplitudes[n] = amplitude;
    power += (amplitude * amplitude) / 2; // a sine of amplitude a has power a²/2
  }

  const scale = power > 0 ? rms / Math.sqrt(power) : 0;
  for (let n = 1; n <= harmonics; n++) amplitudes[n] *= scale;
  return amplitudes;
}

/**
 * How many harmonics a pitch can carry before aliasing.
 * @param {number} fundamental - Hz
 * @param {number} sampleRate - Hz
 * @param {{min?: number, max?: number}} [limits]
 * @returns {number}
 */
export function harmonicCountFor(fundamental, sampleRate, { min = 6, max = 48 } = {}) {
  const nyquist = (Number(sampleRate) || 44100) / 2;
  const usable = Math.floor((nyquist * 0.92) / Math.max(20, Number(fundamental) || 20));
  return Math.max(min, Math.min(max, usable));
}
