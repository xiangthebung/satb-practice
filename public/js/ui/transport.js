/**
 * Transport bar: position, tempo, playback, and the practice toggles.
 *
 * Every control is a real form control or button, so pointer, touch, and
 * keyboard input all work without bespoke gesture handling.
 */

/** Format seconds as m:ss. */
export function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** Spoken description of the transport position. */
export function describePosition(currentSeconds, totalSeconds, barLabel) {
  const base = `${formatTime(currentSeconds)} of ${formatTime(totalSeconds)}`;
  return barLabel ? `${base}, ${barLabel}` : base;
}

const MIC_LABELS = {
  off: 'Turn on microphone pitch guidance',
  connecting: 'Connecting the microphone',
  on: 'Turn off microphone pitch guidance',
  error: 'Microphone unavailable, try again'
};

export class Transport {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.root = document.getElementById('transport');
    this.seek = document.getElementById('seek');
    this.timeDisplay = document.getElementById('time-display');
    this.tempoInput = document.getElementById('tempo');
    this.tempoValue = document.getElementById('tempo-value');
    this.playButton = document.getElementById('play-btn');
    this.playIcon = document.getElementById('play-icon');
    this.pauseIcon = document.getElementById('pause-icon');
    this.loopButton = document.getElementById('loop-btn');
    this.metronomeButton = document.getElementById('metronome-btn');
    this.micButton = document.getElementById('mic-btn');
    this.beatDot = document.getElementById('beat-dot');
    this.partsButton = document.getElementById('parts-btn');
    this.loopBadge = document.getElementById('loop-range-badge');
    this.loopSummary = document.getElementById('loop-range-summary');
    this.loopFrom = document.getElementById('loop-from');
    this.loopTo = document.getElementById('loop-to');
    this.tempoCommitTimer = null;
    this.beatTimer = null;
    this.isSeekDragging = false;

    this.bind();
  }

  bind() {
    this.playButton?.addEventListener('click', () => this.handlers.onTogglePlay?.());
    document.getElementById('prev-bar')?.addEventListener('click', () => this.handlers.onPrevBar?.());
    document.getElementById('next-bar')?.addEventListener('click', () => this.handlers.onNextBar?.());
    this.loopButton?.addEventListener('click', () => this.handlers.onToggleLoop?.());
    this.metronomeButton?.addEventListener('click', () => this.handlers.onToggleMetronome?.());
    this.micButton?.addEventListener('click', () => this.handlers.onToggleMic?.());
    this.partsButton?.addEventListener('click', () => this.handlers.onOpenParts?.());

    this.seek?.addEventListener('input', () => {
      const percent = Number(this.seek.value) / 10;
      this.paintSeek(percent);
      this.handlers.onSeek?.(percent);
    });

    // While the singer is dragging, playback updates must not fight the thumb.
    this.seek?.addEventListener('pointerdown', () => { this.isSeekDragging = true; });
    for (const type of ['pointerup', 'pointercancel', 'blur']) {
      this.seek?.addEventListener(type, () => { this.isSeekDragging = false; });
    }

    // Tempo changes preview instantly, then rebuild the audio timeline once the
    // gesture settles. Rescheduling on every step re-attacks sustained notes.
    this.tempoInput?.addEventListener('input', () => {
      const bpm = Number(this.tempoInput.value);
      this.paintTempo(bpm);
      this.handlers.onTempoPreview?.(bpm);
      clearTimeout(this.tempoCommitTimer);
      this.tempoCommitTimer = setTimeout(() => this.handlers.onTempoCommit?.(bpm), 140);
    });
    this.tempoInput?.addEventListener('change', () => {
      clearTimeout(this.tempoCommitTimer);
      this.handlers.onTempoCommit?.(Number(this.tempoInput.value));
    });

    this.bindLoopRange();
  }

  /**
   * The loop range controls.
   *
   * Bar numbers are the unit a singer thinks in ("take it from bar 34"), so the
   * range is entered and displayed as bars even though the engine stores it as
   * positions in the performance.
   */
  bindLoopRange() {
    const commit = () => {
      this.handlers.onLoopRange?.({
        from: this.readBar(this.loopFrom),
        to: this.readBar(this.loopTo)
      });
    };
    for (const input of [this.loopFrom, this.loopTo]) {
      // Committing on every keystroke would fight the typing, so the range is
      // taken when the field settles or the singer presses Enter.
      input?.addEventListener('change', commit);
      input?.addEventListener('blur', commit);
      input?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
      });
    }

    document.getElementById('loop-mark-start')
      ?.addEventListener('click', () => this.handlers.onLoopMark?.('start'));
    document.getElementById('loop-mark-end')
      ?.addEventListener('click', () => this.handlers.onLoopMark?.('end'));
    document.getElementById('loop-clear')
      ?.addEventListener('click', () => this.handlers.onLoopClear?.());
  }

  /** Read a bar number field, returning null when it is empty or unusable. */
  readBar(input) {
    if (!input) return null;
    const text = String(input.value ?? '').trim();
    if (!text) return null;
    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Show the active loop range.
   *
   * This deliberately does not touch the two bar fields. Setting one end
   * resolves the other, and writing that resolved value back would overwrite the
   * number the singer is in the middle of typing. Use `setLoopFields` for a
   * range that came from somewhere other than the fields themselves.
   *
   * @param {{ fromBar: number, toBar: number }|null} range
   */
  setLoopRange(range) {
    const hasRange = Boolean(range);
    if (this.loopBadge) this.loopBadge.hidden = !hasRange;
    if (this.loopSummary) {
      this.loopSummary.textContent = hasRange
        ? `Bars ${range.fromBar} to ${range.toBar}`
        : 'The whole score';
    }
    if (this.loopButton) {
      const label = hasRange ? `Loop bars ${range.fromBar} to ${range.toBar}` : 'Loop';
      this.loopButton.setAttribute('aria-label', label);
    }
  }

  /**
   * Write a range into the two bar fields.
   *
   * Only for ranges set from outside this control, such as the keyboard markers,
   * the clear button, or loading a new score.
   *
   * @param {{ fromBar: number, toBar: number }|null} range
   */
  setLoopFields(range) {
    if (this.loopFrom) this.loopFrom.value = range ? String(range.fromBar) : '';
    if (this.loopTo) this.loopTo.value = range ? String(range.toBar) : '';
  }

  /** Constrain the bar fields to the score that is open. */
  setBarRange(lowestBar, highestBar) {
    for (const input of [this.loopFrom, this.loopTo]) {
      if (!input) continue;
      input.min = String(lowestBar);
      input.max = String(highestBar);
    }
  }

  setVisible(visible) {
    if (this.root) this.root.hidden = !visible;
  }

  setPlaying(isPlaying) {
    // SVG elements have no `hidden` IDL property, so set the attribute itself.
    this.playIcon?.toggleAttribute('hidden', isPlaying);
    this.pauseIcon?.toggleAttribute('hidden', !isPlaying);
    if (this.playButton) {
      const label = isPlaying ? 'Pause' : 'Play';
      this.playButton.setAttribute('aria-label', label);
      this.playButton.title = `${label} (Space)`;
    }
  }

  /**
   * Update the position controls.
   * @param {{ percent: number, currentSeconds: number, totalSeconds: number, barLabel?: string }} position
   */
  setPosition({ percent, currentSeconds, totalSeconds, barLabel }) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    if (this.seek) {
      if (!this.isSeekDragging) this.seek.value = String(Math.round(clamped * 10));
      this.seek.setAttribute(
        'aria-valuetext',
        describePosition(currentSeconds, totalSeconds, barLabel)
      );
    }
    this.paintSeek(clamped);
    if (this.timeDisplay) {
      this.timeDisplay.textContent = `${formatTime(currentSeconds)} / ${formatTime(totalSeconds)}`;
    }
  }

  paintSeek(percent) {
    if (!this.seek) return;
    this.seek.style.background =
      `linear-gradient(to right, var(--accent) ${percent}%, var(--separator) ${percent}%) center / 100% 3px no-repeat`;
  }

  setTempo(bpm) {
    if (this.tempoInput) this.tempoInput.value = String(Math.round(bpm));
    this.paintTempo(bpm);
  }

  paintTempo(bpm) {
    const value = Math.round(Number(bpm) || 0);
    if (this.tempoValue) this.tempoValue.textContent = `${value} BPM`;
    this.tempoInput?.setAttribute('aria-valuetext', `${value} beats per minute`);
    if (!this.tempoInput) return;
    // The slider's filled length is drawn by the stylesheet, so it has to be
    // told how far along the range the tempo sits.
    const min = Number(this.tempoInput.min);
    const max = Number(this.tempoInput.max);
    const span = max - min;
    const progress = span > 0 ? (value - min) / span : 0;
    const percent = Math.max(0, Math.min(1, progress)) * 100;
    this.tempoInput.style.setProperty('--fill', `${percent.toFixed(2)}%`);
  }

  setLoop(active) {
    this.loopButton?.setAttribute('aria-pressed', String(Boolean(active)));
  }

  setMetronome(active) {
    this.metronomeButton?.setAttribute('aria-pressed', String(Boolean(active)));
    if (!active) this.clearBeat();
  }

  /**
   * @param {'off'|'connecting'|'on'|'error'} state
   */
  setMic(state) {
    if (!this.micButton) return;
    this.micButton.setAttribute('aria-pressed', String(state === 'on'));
    this.micButton.disabled = state === 'connecting';
    const label = MIC_LABELS[state] || MIC_LABELS.off;
    this.micButton.setAttribute('aria-label', label);
    this.micButton.title = label;
  }

  /** Brief visual pulse on the metronome button. */
  flashBeat(isDownbeat) {
    if (!this.beatDot) return;
    this.beatDot.classList.add('is-beat');
    this.beatDot.classList.toggle('is-downbeat', Boolean(isDownbeat));
    clearTimeout(this.beatTimer);
    this.beatTimer = setTimeout(() => this.clearBeat(), 110);
  }

  clearBeat() {
    clearTimeout(this.beatTimer);
    this.beatDot?.classList.remove('is-beat', 'is-downbeat');
  }
}
