/**
 * Shared overlay behaviour: status messages, the help sheet, microphone
 * guidance, and menus.
 *
 * Native <dialog> and the popover API do the heavy lifting (focus handling,
 * Escape, light dismiss), with small scripted fallbacks for browsers that lack
 * the popover API.
 */

import { readBoolPref, writeBoolPref } from '../prefs.js';

const MIC_PROMPT_SKIP = 'mic-prompt-skipped';
const POPOVER_SUPPORTED = typeof document !== 'undefined' &&
  typeof document.createElement('div').showPopover === 'function';

/** Show a modal dialog, degrading to a plain open panel where needed. */
function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal();
  } else {
    dialog.open = true;
  }
}

export class Overlays {
  constructor() {
    this.toastList = document.getElementById('toasts');
    this.statusLive = document.getElementById('status-live');
    this.helpDialog = document.getElementById('help-dialog');
    this.micDialog = document.getElementById('mic-dialog');
    this.micSkipCheckbox = document.getElementById('mic-skip-prompt');
    this.lastAnnouncement = '';

    document.getElementById('help-btn')?.addEventListener('click', () => this.openHelp());
    document.getElementById('help-close')?.addEventListener('click', () => this.helpDialog?.close());
    // Clicking the dimmed area outside the card closes the sheet.
    this.helpDialog?.addEventListener('click', event => {
      if (event.target === this.helpDialog) this.helpDialog.close();
    });

    this.setupMenus();
  }

  /** Keep menu triggers and their popovers in sync, including without support. */
  setupMenus() {
    this.menus = [];

    for (const trigger of document.querySelectorAll('[popovertarget]')) {
      const popover = document.getElementById(trigger.getAttribute('popovertarget'));
      if (!popover) continue;
      this.menus.push({ trigger, popover });

      if (POPOVER_SUPPORTED) {
        popover.addEventListener('toggle', event => {
          const isOpen = event.newState === 'open';
          trigger.setAttribute('aria-expanded', String(isOpen));
          if (isOpen) this.positionMenu(trigger, popover);
        });
        continue;
      }

      // Fallback: script the open state and light dismiss.
      trigger.addEventListener('click', event => {
        event.stopPropagation();
        const willOpen = !popover.classList.contains('is-open');
        popover.classList.toggle('is-open', willOpen);
        trigger.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) this.positionMenu(trigger, popover);
      });
      document.addEventListener('click', event => {
        if (popover.contains(event.target) || trigger.contains(event.target)) return;
        popover.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !popover.classList.contains('is-open')) return;
        popover.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.focus();
      });
    }

    window.addEventListener('resize', () => this.repositionMenus());
  }

  /**
   * Anchor an open menu to its trigger, clamped inside the viewport.
   * @param {HTMLElement} trigger
   * @param {HTMLElement} popover
   */
  positionMenu(trigger, popover) {
    const gap = 8;
    const margin = 8;
    const anchor = trigger.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const above = popover.classList.contains('popover-up');
    const alignEnd = popover.classList.contains('popover-end');

    let top = above ? anchor.top - box.height - gap : anchor.bottom + gap;
    let left = alignEnd ? anchor.right - box.width : anchor.left;
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - box.height - margin));
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - box.width - margin));

    popover.style.top = `${Math.round(top)}px`;
    popover.style.left = `${Math.round(left)}px`;
  }

  repositionMenus() {
    for (const { trigger, popover } of this.menus || []) {
      const isOpen = POPOVER_SUPPORTED
        ? popover.matches(':popover-open')
        : popover.classList.contains('is-open');
      if (isOpen) this.positionMenu(trigger, popover);
    }
  }

  /** Close any open menu, for example before switching screens. */
  closeMenus() {
    for (const popover of document.querySelectorAll('.popover')) {
      if (POPOVER_SUPPORTED && popover.matches(':popover-open')) popover.hidePopover();
      popover.classList.remove('is-open');
    }
    for (const trigger of document.querySelectorAll('[popovertarget]')) {
      trigger.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * Show a transient message. Errors stay until dismissed or 8 seconds pass.
   * @param {string} message
   * @param {{ type?: 'info'|'error', duration?: number }} options
   */
  toast(message, { type = 'info', duration } = {}) {
    if (!this.toastList || !message) return;

    const toast = document.createElement('div');
    toast.className = type === 'error' ? 'toast toast-error' : 'toast';

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'toast-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss message');
    dismiss.textContent = '×';

    const remove = () => {
      clearTimeout(timer);
      toast.remove();
    };
    dismiss.addEventListener('click', remove);
    toast.append(text, dismiss);
    this.toastList.appendChild(toast);

    const timer = setTimeout(remove, duration ?? (type === 'error' ? 8000 : 4000));
  }

  /**
   * Announce a change to assistive technology without moving focus.
   * @param {string} message
   */
  announce(message) {
    if (!this.statusLive || !message) return;
    // Repeating identical text is not re-announced, so nudge it.
    this.statusLive.textContent = message === this.lastAnnouncement
      ? `${message} `
      : message;
    this.lastAnnouncement = message;
  }

  openHelp() {
    openDialog(this.helpDialog);
  }

  toggleHelp() {
    if (this.helpDialog?.open) this.helpDialog.close();
    else this.openHelp();
  }

  isDialogOpen() {
    return Boolean(this.helpDialog?.open || this.micDialog?.open);
  }

  isHelpOpen() {
    return Boolean(this.helpDialog?.open);
  }

  /**
   * Ask for headphones before requesting microphone permission.
   *
   * The answer is taken from the buttons themselves rather than only from the
   * dialog's close event, so the microphone can never end up waiting on an
   * event that a browser quirk swallowed.
   *
   * @returns {Promise<boolean>} true when the singer wants to continue
   */
  confirmMicrophone() {
    if (readBoolPref(MIC_PROMPT_SKIP, false) || !this.micDialog) {
      return Promise.resolve(true);
    }

    const continueButton = document.getElementById('mic-continue');
    if (this.micSkipCheckbox) this.micSkipCheckbox.checked = false;
    openDialog(this.micDialog);
    continueButton?.focus();

    return new Promise(resolve => {
      let settled = false;
      const onContinue = () => settle(true);
      const onClose = () => settle(this.micDialog.returnValue === 'continue');

      const settle = (proceed) => {
        if (settled) return;
        settled = true;
        continueButton?.removeEventListener('click', onContinue);
        this.micDialog.removeEventListener('close', onClose);
        if (proceed && this.micSkipCheckbox?.checked) {
          writeBoolPref(MIC_PROMPT_SKIP, true);
        }
        this.micDialog.returnValue = '';
        if (this.micDialog.open) this.micDialog.close();
        resolve(proceed);
      };

      continueButton?.addEventListener('click', onContinue);
      this.micDialog.addEventListener('close', onClose);
    });
  }
}
