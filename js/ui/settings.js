/**
 * Settings dialog.
 *
 * Everything that is a preference rather than a transport action lives here, in
 * one place. It used to be spread across a gear popover, the parts panel and the
 * transport bar, which meant a singer had to remember which of three surfaces
 * held the control they wanted.
 *
 * Each control reports its change immediately and is also readable back, so the
 * dialog can be opened showing the state that is actually in force rather than
 * whatever the markup happened to default to.
 */

import { CLICK_PATTERNS, isClickPattern } from '../metronome.js';

/** The values a fresh install starts from, and what "restore defaults" means. */
export const SETTINGS_DEFAULTS = {
  synthMode: 'vocal',
  masterVolume: 100,
  room: 34,
  tuning: 440,
  transpose: 0,
  fermata: 2,
  followDynamics: true,
  playRepeats: true,
  clickPattern: 'beat',
  clickVolume: 80,
  countInBars: 0,
  showLyrics: true,
  showTimeSignatures: true,
  verse: 1
};

/** Describe a transposition the way a singer would say it. */
export function describeTranspose(semitones) {
  const value = Math.round(Number(semitones) || 0);
  if (value === 0) return 'As written';
  const direction = value > 0 ? 'up' : 'down';
  const size = Math.abs(value);
  if (size === 12) return `An octave ${direction}`;
  const unit = size === 1 ? 'semitone' : 'semitones';
  return `${size} ${unit} ${direction}`;
}

/** Describe a count-in length. */
export function describeCountIn(bars) {
  const value = Math.round(Number(bars) || 0);
  if (value <= 0) return 'Off';
  return value === 1 ? '1 bar' : `${value} bars`;
}

/** Describe a tuning reference. */
export function describeTuning(hertz) {
  return `A = ${Math.round(Number(hertz) || 440)} Hz`;
}

export class Settings {
  /**
   * @param {object} handlers one callback per setting, all optional
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.dialog = document.getElementById('settings-dialog');
    this.openButton = document.getElementById('settings-btn');

    this.controls = {
      masterVolume: document.getElementById('master-volume'),
      room: document.getElementById('room'),
      tuning: document.getElementById('tuning'),
      transpose: document.getElementById('transpose'),
      fermata: document.getElementById('fermata'),
      followDynamics: document.getElementById('follow-dynamics'),
      playRepeats: document.getElementById('play-repeats'),
      clickPattern: document.getElementById('click-pattern'),
      clickVolume: document.getElementById('click-volume'),
      countInBars: document.getElementById('count-in'),
      showLyrics: document.getElementById('show-lyrics'),
      showTimeSignatures: document.getElementById('show-time-signatures'),
      verse: document.getElementById('verse')
    };
    this.verseRow = document.getElementById('verse-row');
    this.outputs = {
      masterVolume: document.getElementById('master-volume-value'),
      room: document.getElementById('room-value'),
      tuning: document.getElementById('tuning-value'),
      transpose: document.getElementById('transpose-value'),
      fermata: document.getElementById('fermata-value'),
      clickVolume: document.getElementById('click-volume-value'),
      countInBars: document.getElementById('count-in-value')
    };

    this.fillClickPatterns();
    this.bind();
  }

  fillClickPatterns() {
    const select = this.controls.clickPattern;
    if (!select) return;
    select.replaceChildren();
    for (const pattern of CLICK_PATTERNS) {
      const option = document.createElement('option');
      option.value = pattern.id;
      option.textContent = pattern.label;
      select.appendChild(option);
    }
  }

  bind() {
    this.openButton?.addEventListener('click', () => this.open());
    document.getElementById('settings-close')?.addEventListener('click', () => this.close());
    document.getElementById('settings-done')?.addEventListener('click', () => this.close());
    document.getElementById('settings-reset')?.addEventListener('click', () => {
      this.handlers.onReset?.();
    });

    // Clicking the dimmed area outside the card closes the dialog.
    this.dialog?.addEventListener('click', event => {
      if (event.target === this.dialog) this.close();
    });

    for (const radio of document.querySelectorAll('input[name="synth-mode"]')) {
      radio.addEventListener('change', () => {
        if (radio.checked) this.handlers.onSynthMode?.(radio.value);
      });
    }

    // Every slider here changes a live gain, a lookup or a stored preference, so
    // following the thumb is both cheap and what the singer expects to hear.
    const sliders = [
      ['masterVolume', 'onMasterVolume'],
      ['room', 'onRoom'],
      ['tuning', 'onTuning'],
      ['transpose', 'onTranspose'],
      ['fermata', 'onFermata'],
      ['clickVolume', 'onClickVolume'],
      ['countInBars', 'onCountInBars']
    ];
    for (const [key, handlerName] of sliders) {
      this.controls[key]?.addEventListener('input', () => {
        const value = Number(this.controls[key].value);
        this.paint(key, value);
        this.handlers[handlerName]?.(value);
      });
    }

    this.controls.followDynamics?.addEventListener('change', () => {
      this.handlers.onFollowDynamics?.(this.controls.followDynamics.checked);
    });
    this.controls.playRepeats?.addEventListener('change', () => {
      this.handlers.onPlayRepeats?.(this.controls.playRepeats.checked);
    });
    this.controls.clickPattern?.addEventListener('change', () => {
      this.handlers.onClickPattern?.(this.controls.clickPattern.value);
    });
    this.controls.showLyrics?.addEventListener('change', () => {
      this.handlers.onShowLyrics?.(this.controls.showLyrics.checked);
    });
    this.controls.showTimeSignatures?.addEventListener('change', () => {
      this.handlers.onShowTimeSignatures?.(this.controls.showTimeSignatures.checked);
    });
    this.controls.verse?.addEventListener('change', () => {
      this.handlers.onVerse?.(Number(this.controls.verse.value));
    });
  }

  /**
   * Offer a verse picker only when the score has more than one.
   *
   * A single-verse score has nothing to choose between, and an empty or
   * one-option picker is worse than no picker.
   *
   * @param {number} verseCount
   * @param {number} selected
   */
  setVerses(verseCount, selected = 1) {
    const count = Math.max(0, Math.round(Number(verseCount) || 0));
    if (this.verseRow) this.verseRow.hidden = count < 2;
    const select = this.controls.verse;
    if (!select) return;

    select.replaceChildren();
    for (let number = 1; number <= count; number++) {
      const option = document.createElement('option');
      option.value = String(number);
      option.textContent = `Verse ${number}`;
      select.appendChild(option);
    }
    select.value = String(Math.min(Math.max(1, selected), Math.max(1, count)));
  }

  /* ------------------------------------------------------------- lifecycle */

  open() {
    if (!this.dialog) return;
    if (typeof this.dialog.showModal === 'function' && !this.dialog.open) {
      this.dialog.showModal();
    } else {
      this.dialog.open = true;
    }
    this.openButton?.setAttribute('aria-expanded', 'true');
    this.dialog.querySelector('input, select, button')?.focus();
  }

  close() {
    if (!this.dialog) return;
    if (this.dialog.open && typeof this.dialog.close === 'function') this.dialog.close();
    else this.dialog.open = false;
    this.openButton?.setAttribute('aria-expanded', 'false');
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  isOpen() {
    return Boolean(this.dialog?.open);
  }

  /* ---------------------------------------------------------------- display */

  /** Update one control's readout and its spoken description. */
  paint(key, value) {
    const output = this.outputs[key];
    const control = this.controls[key];
    let text = '';

    switch (key) {
      case 'masterVolume':
      case 'room':
      case 'clickVolume':
        text = `${Math.round(value)}%`;
        break;
      case 'tuning':
        text = describeTuning(value);
        break;
      case 'transpose':
        text = describeTranspose(value);
        break;
      case 'fermata':
        text = `${Number(value).toFixed(1)}×`;
        break;
      case 'countInBars':
        text = describeCountIn(value);
        break;
      default:
        text = String(value);
    }

    if (output) output.textContent = text;
    control?.setAttribute('aria-valuetext', text);
  }

  /**
   * Show a complete set of values without firing any change handlers.
   * @param {object} state
   */
  setAll(state = {}) {
    const assignSlider = (key, value) => {
      if (this.controls[key] && value !== undefined) {
        this.controls[key].value = String(value);
        this.paint(key, Number(value));
      }
    };

    assignSlider('masterVolume', state.masterVolume);
    assignSlider('room', state.room);
    assignSlider('tuning', state.tuning);
    assignSlider('transpose', state.transpose);
    assignSlider('fermata', state.fermata);
    assignSlider('clickVolume', state.clickVolume);
    assignSlider('countInBars', state.countInBars);

    if (state.synthMode !== undefined) {
      for (const radio of document.querySelectorAll('input[name="synth-mode"]')) {
        radio.checked = radio.value === state.synthMode;
      }
    }
    if (this.controls.followDynamics && state.followDynamics !== undefined) {
      this.controls.followDynamics.checked = Boolean(state.followDynamics);
    }
    if (this.controls.playRepeats && state.playRepeats !== undefined) {
      this.controls.playRepeats.checked = Boolean(state.playRepeats);
    }
    if (this.controls.clickPattern && state.clickPattern !== undefined) {
      this.controls.clickPattern.value = isClickPattern(state.clickPattern)
        ? state.clickPattern
        : SETTINGS_DEFAULTS.clickPattern;
    }
    if (this.controls.showLyrics && state.showLyrics !== undefined) {
      this.controls.showLyrics.checked = Boolean(state.showLyrics);
    }
    if (this.controls.showTimeSignatures && state.showTimeSignatures !== undefined) {
      this.controls.showTimeSignatures.checked = Boolean(state.showTimeSignatures);
    }
    if (this.controls.verse && state.verse !== undefined) {
      this.controls.verse.value = String(state.verse);
    }
  }
}
