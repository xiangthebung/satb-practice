/**
 * Parts panel: choose the part you sing, balance the other voices, and set how
 * the score is displayed.
 *
 * On wide screens the panel is a column beside the score. On narrow screens the
 * same markup becomes a modal bottom sheet, which keeps one implementation and
 * one set of behaviours for both layouts.
 */

import { getPartColor } from '../utils.js';
import { getPartLabel } from '../notation-renderer.js';
import { MIX_PRESETS } from '../mix.js';
import { ensureContrast, readScoreTheme } from '../theme.js';

const SHEET_QUERY = '(max-width: 899px)';

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
    this.rows = new Map();
    this.isModal = false;
    this.visible = false;

    this.sheetQuery = window.matchMedia(SHEET_QUERY);
    this.sheetQuery.addEventListener('change', () => this.syncLayout());

    // The transport owns the button that opens this panel, so it is bound once
    // there and routed through the app.
    this.closeButton?.addEventListener('click', () => this.close());
    this.panel?.addEventListener('close', () => {
      this.isModal = false;
      // The panel is permanent on wide screens; re-open it after a stray close.
      if (this.visible && !this.sheetQuery.matches) this.syncLayout();
    });

    this.renderMixOptions();
    this.bindGlobalControls();
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

  /** Show the panel: inline beside the score, or as a sheet on demand. */
  show() {
    this.visible = true;
    this.syncLayout();
  }

  /** Hide the panel entirely, for example when returning to the home screen. */
  hide() {
    this.visible = false;
    this.closeDialog();
  }

  syncLayout() {
    if (!this.panel) return;
    if (!this.visible) {
      this.closeDialog();
      return;
    }

    if (this.sheetQuery.matches) {
      // Narrow screens open the sheet only when asked for.
      if (!this.isModal) this.closeDialog();
      return;
    }

    if (this.isModal) this.closeDialog();
    this.panel.open = true;
  }

  openSheet() {
    if (!this.panel || !this.visible) return;
    if (!this.sheetQuery.matches) {
      this.panel.open = true;
      this.panel.querySelector('input, button')?.focus();
      return;
    }
    this.closeDialog();
    if (typeof this.panel.showModal === 'function') {
      this.panel.showModal();
      this.isModal = true;
    } else {
      this.panel.open = true;
    }
  }

  close() {
    if (this.sheetQuery.matches) this.closeDialog();
  }

  /** True while the panel covers the score as a modal sheet. */
  isSheetOpen() {
    return Boolean(this.panel?.open && this.isModal);
  }

  closeDialog() {
    if (!this.panel) return;
    if (this.panel.open && typeof this.panel.close === 'function') this.panel.close();
    else this.panel.open = false;
    this.isModal = false;
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
    if (this.othersInput) this.othersInput.value = String(value);
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
