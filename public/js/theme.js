/**
 * Score theme bridge.
 *
 * The notation is painted on a canvas, so it cannot inherit CSS. This module
 * reads the same design tokens the interface uses and hands the renderer a
 * plain colour palette, which keeps the score visually consistent with the
 * rest of the app in both light and dark appearance.
 */

const SCORE_TOKENS = {
  paper: '--score-paper',
  staffLine: '--score-staff-line',
  barline: '--score-barline',
  ledger: '--score-ledger',
  ink: '--score-ink',
  label: '--score-label',
  cursor: '--score-cursor',
  selectionFill: '--score-selection-fill',
  selectionEdge: '--score-selection-edge',
  muted: '--score-muted',
  pitchNeutral: '--pitch-listening',
  pitchCorrect: '--pitch-correct',
  pitchClose: '--pitch-close',
  pitchOff: '--pitch-off'
};

const FALLBACK_THEME = {
  paper: '#ffffff',
  staffLine: '#c7c7cc',
  barline: '#8e8e93',
  ledger: '#aeaeb2',
  ink: '#1d1d1f',
  label: '#8e8e93',
  cursor: '#0071e3',
  selectionFill: 'rgba(0, 113, 227, 0.07)',
  selectionEdge: 'rgba(0, 113, 227, 0.55)',
  muted: '#8e8e93',
  pitchNeutral: '#8e8e93',
  pitchCorrect: '#17803d',
  pitchClose: '#b26a00',
  pitchOff: '#c9251c'
};

const NAMED_COLORS = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  transparent: { r: 0, g: 0, b: 0, a: 0 }
};

/**
 * Parse a hex, rgb() or rgba() colour into channel values.
 * @param {string} value
 * @returns {{ r: number, g: number, b: number, a: number }|null}
 */
export function parseCssColor(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) return null;
  if (NAMED_COLORS[input]) return { a: 1, ...NAMED_COLORS[input] };

  const hex = input.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const digits = hex[1];
    const expand = digits.length === 3 || digits.length === 4
      ? digits.split('').map(character => character + character).join('')
      : digits;
    if (expand.length !== 6 && expand.length !== 8) return null;
    return {
      r: parseInt(expand.slice(0, 2), 16),
      g: parseInt(expand.slice(2, 4), 16),
      b: parseInt(expand.slice(4, 6), 16),
      a: expand.length === 8 ? parseInt(expand.slice(6, 8), 16) / 255 : 1
    };
  }

  const functional = input.match(/^rgba?\(([^)]+)\)$/);
  if (functional) {
    const parts = functional[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(part))) return null;
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: Number.isFinite(parts[3]) ? parts[3] : 1
    };
  }
  return null;
}

/** Format channel values as a CSS colour string. */
export function colorToCss({ r, g, b, a = 1 }) {
  const channel = value => Math.max(0, Math.min(255, Math.round(value)));
  if (a >= 1) return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
  return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** WCAG relative luminance for a parsed colour. */
export function relativeLuminance({ r, g, b }) {
  const channel = value => {
    const scaled = Math.max(0, Math.min(1, value / 255));
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two parsed colours. */
export function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Linear blend between two parsed colours. */
export function mixColors(from, to, amount) {
  const ratio = Math.max(0, Math.min(1, amount));
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
    a: 1
  };
}

/**
 * Nudge a colour toward or away from the background until it is legible on it.
 * Voice colours are authored for identification, not for one specific
 * appearance, so both light and dark paper stay readable without maintaining
 * two hand-tuned palettes.
 *
 * @param {string} color source colour
 * @param {string} background colour it will be drawn on
 * @param {number} minRatio target contrast ratio
 * @returns {string} CSS colour string
 */
export function ensureContrast(color, background, minRatio = 3.4) {
  const source = parseCssColor(color);
  const paper = parseCssColor(background);
  if (!source || !paper) return String(color);
  if (contrastRatio(source, paper) >= minRatio) return colorToCss(source);

  const target = relativeLuminance(paper) > 0.4 ? NAMED_COLORS.black : NAMED_COLORS.white;
  let best = source;
  for (let step = 1; step <= 10; step++) {
    best = mixColors(source, target, step / 10 * 0.8);
    if (contrastRatio(best, paper) >= minRatio) break;
  }
  return colorToCss(best);
}

/**
 * Read the current score palette from CSS custom properties.
 * @param {Element} [element]
 * @returns {object}
 */
export function readScoreTheme(element) {
  const theme = { ...FALLBACK_THEME };
  if (typeof getComputedStyle !== 'function') return theme;

  const root = element || document.documentElement;
  const styles = getComputedStyle(root);
  for (const [key, token] of Object.entries(SCORE_TOKENS)) {
    const value = styles.getPropertyValue(token).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

/**
 * Observe appearance changes (system light/dark switch).
 * @param {(theme: object) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function watchColorScheme(onChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange(readScoreTheme());
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
