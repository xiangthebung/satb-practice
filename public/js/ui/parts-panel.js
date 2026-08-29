/**
 * Parts panel: choose the part you sing, balance the other voices, and set how
 * the score is displayed.
 *
 * On wide screens the panel is a column beside the score. On narrow screens the
 * same markup becomes a bottom sheet under it. One implementation, one set of
 * behaviours, and in both layouts it is a plain non-modal `<dialog open>` that
 * takes its own grid track — so it can be closed, and while it is open the
 * score, the transport and the keyboard all still work.
 *
 * It was not always. The sheet used to be `showModal()`, which put it in the top
 * layer over the score with a backdrop: measured at 860x640 it covered 83% of the
 * score, made the play button unclickable, and stopped the space bar because the
 * app's keyboard handler stands down while a modal dialog is open. Above 900px
 * the panel had the opposite problem — no close button, no trigger, and a `close`
 * listener that re-opened it — so a 300px column of mixer was permanent, and on a
 * short window the score got a 286px band while most of the panel sat below its
 * own scroll fold. Both are the same mistake: treating the mixer as something you
 * visit instead of something you hold open while you sing.
 */

import { getPartColor } from '../utils.js';
import { getPartLabel } from '../notation-renderer.js';
import { MIX_PRESETS } from '../mix.js';
import { ensureContrast, readScoreTheme } from '../theme.js';
import { readBoolPref, writeBoolPref } from '../prefs.js';

const SHEET_QUERY = '(max-width: 899px)';

/**
 * Whether the panel is open, on wide screens only.
 *
 * Not remembered for the sheet layout. A phone has little enough score showing
 * that starting with the mixer over half of it is the wrong first impression,
 * and someone who wants it has one button to press. The wide-screen state is
 * worth keeping, because that is where closing it is a considered choice about
 * how much room the score gets.
 */
const PANEL_OPEN_PREF = 'parts-panel-open';

/** Coerce a stored volume into a usable 0-100 percentage. */
function clampVolume(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return 100;
  return Math.max(0, Math.min(100, Math.round(volume)));
}

const ICON_UNMUTED = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M11 5.5 6.5 9.2H3.5v5.6h3L11 18.5z"/>
  <path d="M15.2 9.4a3.6 3.6 0 0 1 0 5.2"/>
  <path d="M18 7a7 7 0 0 1 0 10"/>
</svg>`;

const ICON_MUTED = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M11 5.5 6.5 9.2H3.5v5.6h3L11 18.5z"/>
  <path d="M16 10l5 4M21 10l-5 4"/>
</svg>`;

const ICON_RENAME = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 20h4l10-10-4-4L4 16z"/>
  <path d="M14.5 5.5 18.5 9.5"/>
</svg>`;

/** Headphones: hear this line on its own. */
const ICON_SOLO = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 15v-3a8 8 0 0 1 16 0v3"/>
  <path d="M4 14h2.6v6H5.2A1.2 1.2 0 0 1 4 18.8z"/>
  <path d="M20 14h-2.6v6h1.4A1.2 1.2 0 0 0 20 18.8z"/>
</svg>`;

const ICON_CHECK = `<svg class="mix-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="m5 12.5 4.5 4.5L19 7"/>
</svg>`;

export class PartsPanel {
  /**
   * @param {object} handlers
   * @param {(partId: string) => void} handlers.onSelectPart
   * @param {(partId: string, volume: number) => void} handlers.onVolumeChange
   * @param {(partId: string, muted: boolean) => void} handlers.onMuteChange
   * @param {(partId: string, name: string) => void} handlers.onRename
   * @param {(presetId: string) => void} handlers.onMixChange
   * @param {(level: number) => void} handlers.onOthersLevelChange
   * @param {(dim: boolean) => void} handlers.onDimChange
   * @param {() => void} handlers.onCoachDismiss
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.panel = document.getElementById('parts-panel');
    this.list = document.getElementById('part-list');
    this.mixOptions = document.getElementById('mix-options');
    this.othersRow = document.getElementById('others-level-row');
    this.othersInput = document.getElementById('others-level');
    this.othersOutput = document.getElementById('others-level-value');
    this.dimSwitch = document.getElementById('dim-others');
    this.coach = document.getElementById('coach');
    this.closeButton = document.getElementById('parts-close');
    this.trigger = document.getElementById('parts-btn');
    this.rows = new Map();
    this.visible = false;

    this.sheetQuery = window.matchMedia(SHEET_QUERY);
    this.expanded = this.defaultExpanded();
    this.sheetQuery.addEventListener('change', () => {
      // Crossing the breakpoint is a change of layout, not of intent, so the
      // state goes back to what that layout starts at rather than carrying a
      // wide-screen choice onto a phone.
      this.expanded = this.defaultExpanded();
      this.syncLayout();
    });

    // The transport owns the button that opens this panel, so it is bound once
    // there and routed through the app.
    this.closeButton?.addEventListener('click', () => this.close());
    // A non-modal <dialog> gets no Escape handling of its own.
    this.panel?.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.close();
    });

    this.renderMixOptions();
    this.bindGlobalControls();
    this.syncTrigger();
  }

  /** How the panel starts in the current layout. */
  defaultExpanded() {
    if (this.sheetQuery.matches) return false;
    return readBoolPref(PANEL_OPEN_PREF, true);
  }

  bindGlobalControls() {
    this.othersInput?.addEventListener('input', () => {
      const level = Number(this.othersInput.value);
      this.setOthersLevel(level);
      this.handlers.onOthersLevelChange?.(level);
    });

    this.dimSwitch?.addEventListener('change', () => {
      this.handlers.onDimChange?.(this.dimSwitch.checked);
    });

    document.getElementById('coach-dismiss')?.addEventListener('click', () => {
      this.hideCoach();
      this.handlers.onCoachDismiss?.();
    });
  }

  /* ----------------------------------------------------------------- layout */

  /** A score is open: the panel may now show. */
  show() {
    this.visible = true;
    this.syncLayout();
  }

  /** Hide the panel entirely, for example when returning to the home screen. */
  hide() {
    this.visible = false;
    this.syncLayout();
  }

  /** True while the panel is showing. */
  isOpen() {
    return Boolean(this.visible && this.expanded && this.panel?.open);
  }

  syncLayout() {
    if (!this.panel) return;
    const shouldOpen = this.visible && this.expanded;
    // `open` rather than `showModal()`: a modal dialog is in the top layer, so it
    // would sit over the score whatever the stylesheet asks for, and would take
    // the keyboard away from the transport.
    if (this.panel.open !== shouldOpen) this.panel.open = shouldOpen;
    this.syncTrigger();
  }

  syncTrigger() {
    if (!this.trigger) return;
    const open = this.isOpen();
    this.trigger.setAttribute('aria-expanded', String(open));
    const label = open ? 'Hide parts and mix' : 'Parts and mix';
    this.trigger.setAttribute('aria-label', label);
    this.trigger.title = label;
  }

  /** Open the panel, moving focus into it when it was closed. */
  open() {
    this.setExpanded(true, { focus: true });
  }

  close() {
    this.setExpanded(false, { focus: true });
  }

  /** The transport button: one control that both opens and closes the panel. */
  toggle() {
    this.setExpanded(!this.expanded, { focus: true });
  }

  /**
   * @param {boolean} expanded
   * @param {{ focus?: boolean }} [options] move focus with the change
   */
  setExpanded(expanded, { focus = false } = {}) {
    const next = Boolean(expanded);
    if (!this.visible) {
      this.expanded = next;
      this.syncLayout();
      return;
    }
    const changed = this.expanded !== next;
    this.expanded = next;
    if (!this.sheetQuery.matches) writeBoolPref(PANEL_OPEN_PREF, next);
    this.syncLayout();
    if (!changed || !focus) return;
    // In the sheet layout the panel is placed below the score by `grid-row`, so
    // its position in the DOM is ahead of where it appears. Moving focus into it
    // on open and back to the trigger on close keeps the two orders agreeing for
    // anyone driving this from the keyboard.
    if (next) this.panel?.querySelector('input, button')?.focus();
    else this.trigger?.focus();
  }

  /* ------------------------------------------------------------------ parts */

  /**
   * Rebuild the part rows.
   * @param {Array} parts
   * @param {{ myPartId: string|null, volumes: Record<string, number>, muted: Set<string> }} state
   */
  renderParts(parts, state) {
    if (!this.list) return;
    this.list.replaceChildren();
    this.rows.clear();

    for (const part of parts) {
      const row = this.createPartRow(part, state);
      this.rows.set(part.id, row);
      this.list.appendChild(row.element);
    }
  }

  /** The same legible voice colour the score uses. */
  getVoiceColor(part) {
    const paper = readScoreTheme().paper;
    return ensureContrast(getPartColor(part?.voiceType || part?.name || ''), paper, 3.6);
  }

  createPartRow(part, state) {
    const label = getPartLabel(part);
    const color = this.getVoiceColor(part);
    const volume = clampVolume(state.volumes?.[part.id]);
    const isMuted = Boolean(state.muted?.has(part.id));
    const isMine = part.id === state.myPartId;

    const element = document.createElement('div');
    element.className = 'part';
    element.dataset.partId = part.id;
    element.style.setProperty('--part-color', color);
    element.classList.toggle('is-mine', isMine);
    element.classList.toggle('is-muted', isMuted);

    const pick = document.createElement('label');
    pick.className = 'part-pick';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'my-part';
    radio.value = part.id;
    radio.checked = isMine;
    radio.addEventListener('change', () => {
      if (radio.checked) this.handlers.onSelectPart?.(part.id);
    });

    const dot = document.createElement('span');
    dot.className = 'part-dot';
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'part-name';
    name.textContent = label;
    name.title = part.name;

    pick.append(radio, dot, name);

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'icon-btn part-rename';
    rename.innerHTML = ICON_RENAME;
    rename.setAttribute('aria-label', `Rename ${label}`);
    rename.title = `Rename ${label}`;
    rename.addEventListener('click', () => this.startRename(part.id));
    name.addEventListener('dblclick', () => this.startRename(part.id));

    const isSoloed = Boolean(state.soloed?.has(part.id));
    element.classList.toggle('is-soloed', isSoloed);

    const solo = document.createElement('button');
    solo.type = 'button';
    solo.className = 'icon-btn part-solo';
    solo.innerHTML = ICON_SOLO;
    solo.setAttribute('aria-pressed', String(isSoloed));
    solo.setAttribute('aria-label', `Hear ${label} on its own`);
    solo.title = `Hear ${label} on its own`;
    solo.addEventListener('click', () => {
      const nextSoloed = solo.getAttribute('aria-pressed') !== 'true';
      this.handlers.onSoloChange?.(part.id, nextSoloed);
    });

    const volumeRow = document.createElement('div');
    volumeRow.className = 'part-volume-row';

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'icon-btn part-mute';
    mute.innerHTML = isMuted ? ICON_MUTED : ICON_UNMUTED;
    mute.setAttribute('aria-pressed', String(isMuted));
    mute.setAttribute('aria-label', `${isMuted ? 'Unmute' : 'Mute'} ${label}`);
    mute.addEventListener('click', () => {
      const nextMuted = mute.getAttribute('aria-pressed') !== 'true';
      this.setPartMuted(part.id, nextMuted);
      this.handlers.onMuteChange?.(part.id, nextMuted);
    });

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'part-volume';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(volume);
    slider.setAttribute('aria-label', `${label} volume`);
    slider.setAttribute('aria-valuetext', `${volume}%`);
    slider.style.setProperty('--fill', `${volume}%`);

    const level = document.createElement('span');
    level.className = 'part-level';
    level.textContent = `${volume}%`;

    slider.addEventListener('input', () => {
      const next = Number(slider.value);
      level.textContent = `${next}%`;
      slider.setAttribute('aria-valuetext', `${next}%`);
      slider.style.setProperty('--fill', `${next}%`);
      this.handlers.onVolumeChange?.(part.id, next);
    });

    volumeRow.append(mute, slider, level);
    element.append(pick, solo, rename, volumeRow);

    return { element, radio, name, rename, mute, solo, slider, level, label };
  }

  /** Reflect solo state across every row at once. */
  setSoloed(soloedIds = new Set()) {
    for (const [id, row] of this.rows) {
      const isSoloed = soloedIds.has(id);
      row.element.classList.toggle('is-soloed', isSoloed);
      row.solo.setAttribute('aria-pressed', String(isSoloed));
    }
    // Any solo at all changes what the other rows mean, so the panel says so.
    this.list?.classList.toggle('has-solo', soloedIds.size > 0);
  }

  /** Swap a part name for an inline text field. */
  startRename(partId) {
    const row = this.rows.get(partId);
    if (!row || row.element.querySelector('.part-name-input')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'part-name-input';
    input.value = row.name.textContent;
    input.setAttribute('aria-label', `Name for ${row.label}`);
    input.maxLength = 48;
    row.name.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      const value = input.value.trim();
      input.replaceWith(row.name);
      row.rename.focus();
      if (commit && value && value !== row.name.textContent) {
        this.handlers.onRename?.(partId, value);
      }
    };

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Update the selected part without rebuilding the list. */
  setSelectedPart(partId) {
    for (const [id, row] of this.rows) {
      const isMine = id === partId;
      row.element.classList.toggle('is-mine', isMine);
      row.radio.checked = isMine;
    }
  }

  /** Reflect volumes coming from a preset change. */
  setVolumes(volumes = {}) {
    for (const [id, row] of this.rows) {
      const volume = clampVolume(volumes[id]);
      row.slider.value = String(volume);
      row.slider.setAttribute('aria-valuetext', `${volume}%`);
      row.slider.style.setProperty('--fill', `${volume}%`);
      row.level.textContent = `${volume}%`;
    }
  }

  /** Re-resolve voice colours after a light/dark appearance change. */
  refreshVoiceColors(parts = []) {
    for (const part of parts) {
      const row = this.rows.get(part.id);
      if (row) row.element.style.setProperty('--part-color', this.getVoiceColor(part));
    }
  }

  setPartMuted(partId, muted) {
    const row = this.rows.get(partId);
    if (!row) return;
    row.element.classList.toggle('is-muted', muted);
    row.mute.innerHTML = muted ? ICON_MUTED : ICON_UNMUTED;
    row.mute.setAttribute('aria-pressed', String(muted));
    row.mute.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} ${row.label}`);
  }

  /** Refresh a renamed row's label and its accessible names. */
  setPartLabel(partId, part) {
    const row = this.rows.get(partId);
    if (!row) return;
    const label = getPartLabel(part);
    row.label = label;
    row.name.textContent = label;
    row.name.title = part.name;
    row.rename.setAttribute('aria-label', `Rename ${label}`);
    row.rename.title = `Rename ${label}`;
    row.solo.setAttribute('aria-label', `Hear ${label} on its own`);
    row.solo.title = `Hear ${label} on its own`;
    row.slider.setAttribute('aria-label', `${label} volume`);
    const isMuted = row.mute.getAttribute('aria-pressed') === 'true';
    row.mute.setAttribute('aria-label', `${isMuted ? 'Unmute' : 'Mute'} ${label}`);
    row.element.style.setProperty('--part-color', this.getVoiceColor(part));
  }

  /* -------------------------------------------------------------------- mix */

  renderMixOptions() {
    if (!this.mixOptions) return;
    this.mixOptions.replaceChildren();

    for (const preset of MIX_PRESETS) {
      const option = document.createElement('label');
      option.className = 'mix-option';
      option.title = preset.hint;

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'mix-preset';
      radio.value = preset.id;
      radio.addEventListener('change', () => {
        if (radio.checked) this.handlers.onMixChange?.(preset.id);
      });

      const text = document.createElement('span');
      text.textContent = preset.label;

      option.insertAdjacentHTML('afterbegin', ICON_CHECK);
      option.append(radio, text);
      this.mixOptions.appendChild(option);
    }
  }

  /** Show which preset is active; null means a custom mix. */
  setMixPreset(presetId) {
    if (!this.mixOptions) return;
    for (const radio of this.mixOptions.querySelectorAll('input[name="mix-preset"]')) {
      radio.checked = radio.value === presetId;
    }
    if (this.othersRow) this.othersRow.hidden = presetId !== 'mostly-mine';
  }

  setOthersLevel(level) {
    const value = Math.max(0, Math.min(100, Math.round(level)));
    if (this.othersInput) {
      this.othersInput.value = String(value);
      // The filled length of the track is drawn from this, as it is for the
      // per-part volumes above it.
      this.othersInput.style.setProperty('--fill', `${value}%`);
    }
    if (this.othersOutput) this.othersOutput.textContent = `${value}%`;
  }

  setDimOthers(dim) {
    if (this.dimSwitch) this.dimSwitch.checked = Boolean(dim);
  }

  /* ------------------------------------------------------------------ coach */

  showCoach() {
    if (this.coach) this.coach.hidden = false;
  }

  hideCoach() {
    if (this.coach) this.coach.hidden = true;
  }
}
