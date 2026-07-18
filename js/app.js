/**
 * Main Application Controller
 * Wires together the parser, renderer, audio engine, pitch detector,
 * and metronome modules for the choir practice experience.
 */

import {
  parseMusicXML,
  parseFile,
  detectVoiceType,
  buildPartNameUpdates
} from './musicxml-parser.js';
import { getPartColor } from './utils.js';
import { NotationRenderer } from './notation-renderer.js?v=mic-sync-3';
import { AudioEngine } from './audio-engine.js?v=mic-sync-3';
import { PitchDetector } from './pitch-detector.js?v=mic-sync-3';
import { Metronome } from './metronome.js';

class ChoirPracticeApp {
  constructor() {
    this.state = {
      parts: [],
      metadata: null,
      rawXml: null,
      fileName: null,
      isPlaying: false,
      currentBeat: 0,
      tempo: 120,
      selectedParts: new Set(),
      selectedSectionId: null,
      partVolumes: {},
      metronomeActive: false,
      micActive: false,
      activePreset: null,
      customVolumes: {},
      othersVolume: 30,
      fermataMultiplier: 2.0,
      synthMode: 'vocal',
      repeatActive: false
    };

    this.renderer = null;
    this.audioEngine = null;
    this.pitchDetector = null;
    this.metronome = null;
    this.committedTempo = this.state.tempo;
    this.pitchGuidePosition = 0;
    this.micStartGeneration = 0;
    this.fileLoadGeneration = 0;
    this.micStartPending = false;
    this.pitchAnnouncementTimer = null;

    this.initUI();
    this.initEventListeners();
    this.initKeyboardShortcuts();
    this.renderSettings();
  }

  initUI() {
    this.fileUploadZone = document.getElementById('file-upload-zone');
    this.fileInput = document.getElementById('file-input');
    this.samplePiecesList = document.getElementById('sample-pieces-list');
    this.partsList = document.getElementById('parts-list');
    this.notationArea = document.getElementById('notation-area');
    this.tempoDisplay = document.getElementById('tempo-value');
    this.tempoScrubber = document.getElementById('tempo-scrubber');
    this.playBtn = document.getElementById('play-btn');
    this.playIcon = document.getElementById('play-icon');
    this.pauseIcon = document.getElementById('pause-icon');
    this.repeatBtn = document.getElementById('repeat-btn');
    this.metronomeBtn = document.getElementById('metronome-btn');
    this.uploadPrompt = document.getElementById('upload-prompt');
    this.scoreTitle = document.getElementById('score-title');
    this.appTitle = document.getElementById('app-title');
    this.micBtn = document.getElementById('mic-btn');
    this.micPrompt = document.getElementById('mic-prompt');
    this.micPromptCancel = document.getElementById('mic-prompt-cancel');
    this.micPromptContinue = document.getElementById('mic-prompt-continue');
    this.pitchIndicator = document.getElementById('pitch-indicator');
    this.ensurePitchGuideUI();
    this.pitchGuidance = document.getElementById('pitch-guidance');
    this.pitchAnnouncement = document.getElementById('pitch-announcement');
    this.notationCanvas = document.getElementById('notation-canvas');
    this.beatIndicator = document.getElementById('beat-indicator');
    this.seekSlider = document.getElementById('seek-slider');
    this.seekTime = document.getElementById('seek-time');
    this.exportBtn = document.getElementById('export-btn');
    this.exportAudioBtn = document.getElementById('export-audio-btn');
    this.exportGroup = document.getElementById('export-group');
  }

  /**
   * Normalize the pitch guide before binding it. This repairs mixed-cache page
   * loads where an older HTML shell (the `--` tuner) is paired with newer CSS
   * and JavaScript, instead of leaving a permanently empty pill.
   */
  ensurePitchGuideUI() {
    const indicator = this.pitchIndicator;
    if (!indicator) return;

    const hasCurrentGuide =
      indicator.querySelector('#pitch-guidance') &&
      indicator.querySelector('.pitch-guide') &&
      indicator.querySelector('.pitch-orb');

    if (!hasCurrentGuide) {
      const guidance = document.createElement('span');
      guidance.id = 'pitch-guidance';
      guidance.className = 'pitch-guidance';
      guidance.textContent = 'Listening';

      const guide = document.createElement('div');
      guide.className = 'pitch-guide';
      guide.setAttribute('aria-hidden', 'true');

      const center = document.createElement('span');
      center.className = 'pitch-guide-center';
      const orb = document.createElement('span');
      orb.className = 'pitch-orb';
      guide.append(center, orb);
      indicator.replaceChildren(guidance, guide);
    }

    indicator.dataset.state = 'listening';
    indicator.setAttribute('role', 'img');
    indicator.setAttribute('aria-label', 'Microphone listening');

    if (!document.getElementById('pitch-announcement')) {
      const announcement = document.createElement('span');
      announcement.id = 'pitch-announcement';
      announcement.className = 'visually-hidden';
      announcement.setAttribute('aria-live', 'polite');
      announcement.setAttribute('aria-atomic', 'true');
      indicator.insertAdjacentElement('afterend', announcement);
    }
  }

  initEventListeners() {
    // File upload via click
    if (this.fileInput) {
      this.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.handleFile(file);
        // Reset so the same file can be re-uploaded
        e.target.value = '';
      });

      // Prevent click events on the input from bubbling to the upload zone
      this.fileInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    // Bundled sample pieces
    if (this.samplePiecesList) {
      this.samplePiecesList.addEventListener('click', (e) => {
        const sampleButton = e.target.closest('.sample-piece');
        if (!sampleButton) return;
        this.handleSamplePiece(sampleButton.dataset.samplePath, sampleButton);
      });
    }

    // Drag and drop
    if (this.fileUploadZone) {
      this.fileUploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.fileUploadZone.classList.add('drag-over');
      });

      this.fileUploadZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.fileUploadZone.classList.remove('drag-over');
      });

      this.fileUploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.fileUploadZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) this.handleFile(file);
      });

      this.fileUploadZone.addEventListener('click', (e) => {
        // Only trigger file picker if the click wasn't on the input itself
        if (e.target !== this.fileInput) {
          this.fileInput?.click();
        }
      });
    }

    // Transport controls
    if (this.playBtn) {
      this.playBtn.addEventListener('click', () => this.togglePlay());
    }
    if (this.repeatBtn) {
      this.repeatBtn.addEventListener('click', () => this.toggleRepeat());
    }
    if (this.metronomeBtn) {
      this.metronomeBtn.addEventListener('click', () => this.toggleMetronome());
    }
    if (this.micBtn) {
      this.micBtn.addEventListener('click', () => this.toggleMic());
    }
    if (this.micPromptCancel) {
      this.micPromptCancel.addEventListener('click', () => this.hideMicPrompt());
    }
    if (this.micPromptContinue) {
      this.micPromptContinue.addEventListener('click', () => {
        this.hideMicPrompt();
        this.startMicrophone();
      });
    }
    if (this.micPrompt) {
      this.micPrompt.addEventListener('click', (e) => {
        if (e.target === this.micPrompt) this.hideMicPrompt();
      });
    }

    // App title click to return to home
    if (this.appTitle) {
      this.appTitle.addEventListener('click', () => this.resetToHome());
    }

    // Export buttons
    if (this.exportBtn) {
      this.exportBtn.addEventListener('click', () => this.exportMusicXML());
    }
    if (this.exportAudioBtn) {
      this.exportAudioBtn.addEventListener('click', () => this.exportWAV());
    }

    // Tempo scrubber — velocity-sensitive horizontal drag. Preview changes in
    // the UI while scrubbing, then update the audio timeline once per gesture.
    // Rebuilding sustained notes for every crossed BPM creates repeated attacks.
    if (this.tempoScrubber) {
      let isDragging = false;
      let dragTempoChanged = false;
      let tempoCommitTimer = null;
      let lastX = 0;
      let lastTime = 0;
      let accumulatedDelta = 0;

      const previewTempo = (bpm) => {
        this.state.tempo = bpm;
        if (this.tempoDisplay) {
          this.tempoDisplay.textContent = bpm;
        }
      };

      const cancelTempoCommitTimer = () => {
        if (tempoCommitTimer) {
          clearTimeout(tempoCommitTimer);
          tempoCommitTimer = null;
        }
      };

      const commitPendingTempo = () => {
        if (!tempoCommitTimer) return;
        cancelTempoCommitTimer();
        this.setTempo(this.state.tempo);
      };

      const startDrag = (x) => {
        // Preserve a wheel preview if the user immediately switches gestures.
        commitPendingTempo();
        isDragging = true;
        dragTempoChanged = false;
        lastX = x;
        lastTime = performance.now();
        accumulatedDelta = 0;
        this.tempoScrubber.classList.add('dragging');
      };

      const doDrag = (x) => {
        if (!isDragging) return;
        const now = performance.now();
        const dx = x - lastX;
        const dt = Math.max(1, now - lastTime); // ms elapsed

        // Velocity: pixels per millisecond
        const velocity = Math.abs(dx) / dt;

        // Map velocity to a sensitivity multiplier:
        // slow drag (velocity < 0.3): 1 BPM per ~8px (precise)
        // medium drag (0.3-1.0): 1 BPM per ~3px
        // fast drag (velocity > 1.0): 1 BPM per ~1px (coarse)
        let sensitivity;
        if (velocity < 0.3) {
          sensitivity = 0.12; // very precise
        } else if (velocity < 0.8) {
          sensitivity = 0.35;
        } else if (velocity < 1.5) {
          sensitivity = 0.7;
        } else {
          sensitivity = 1.5; // fast scrubbing
        }

        accumulatedDelta += dx * sensitivity;
        const bpmChange = Math.trunc(accumulatedDelta);

        if (bpmChange !== 0) {
          accumulatedDelta -= bpmChange;
          const newTempo = Math.max(40, Math.min(240, this.state.tempo + bpmChange));
          if (newTempo !== this.state.tempo) {
            previewTempo(newTempo);
            dragTempoChanged = true;
          }
        }

        lastX = x;
        lastTime = now;
      };

      const endDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        this.tempoScrubber.classList.remove('dragging');
        if (dragTempoChanged) {
          this.setTempo(this.state.tempo);
          dragTempoChanged = false;
        }
      };

      // Mouse events
      this.tempoScrubber.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startDrag(e.clientX);
      });
      document.addEventListener('mousemove', (e) => {
        doDrag(e.clientX);
      });
      document.addEventListener('mouseup', () => {
        endDrag();
      });

      // Touch events
      this.tempoScrubber.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startDrag(e.touches[0].clientX);
      });
      document.addEventListener('touchmove', (e) => {
        if (isDragging) {
          doDrag(e.touches[0].clientX);
        }
      });
      document.addEventListener('touchend', () => {
        endDrag();
      });
      document.addEventListener('touchcancel', () => {
        endDrag();
      });

      // Scroll wheel updates the display immediately but coalesces a wheel
      // burst into one audio reschedule after scrolling settles.
      this.tempoScrubber.addEventListener('wheel', (e) => {
        e.preventDefault();
        const direction = e.deltaY > 0 ? -1 : 1;
        const step = e.shiftKey ? 5 : 1;
        const newTempo = Math.max(40, Math.min(240, this.state.tempo + direction * step));
        if (newTempo !== this.state.tempo) {
          previewTempo(newTempo);
          cancelTempoCommitTimer();
          tempoCommitTimer = setTimeout(() => {
            tempoCommitTimer = null;
            this.setTempo(this.state.tempo);
          }, 150);
        }
      });
    }

    // Seek slider
    if (this.seekSlider) {
      this.seekSlider.addEventListener('input', (e) => {
        const percent = parseFloat(e.target.value);
        // Update filled track immediately while dragging
        this.seekSlider.style.background =
          `linear-gradient(to right, var(--accent-primary) ${percent}%, var(--bg-tertiary) ${percent}%)`;
        // When paused, move the sheet to the selected progress position so the
        // cursor and visible notation stay in sync. Playback will continue to
        // use its pinned-cursor auto-scroll behavior.
        this.seekToPercent(percent, { moveSheet: !this.state.isPlaying });
      });
    }

    // Clicking the sheet selects the nearest note or measure onset. Manual
    // selection must not trigger the renderer's automatic scroll-to-cursor.
    if (this.notationCanvas) {
      this.notationCanvas.addEventListener('click', (e) => {
        if (!this.renderer) return;
        const rect = this.notationCanvas.getBoundingClientRect();
        if (!rect.width) return;
        const canvasX = (e.clientX - rect.left) * (this.notationCanvas.width / rect.width);
        const beat = this.renderer.getBeatAtScreenX(canvasX);
        if (beat !== null) {
          this.seekToBeat(beat);
        }
      });
    }

    // Window resize
    window.addEventListener('resize', () => {
      if (this.renderer) {
        this.renderer.resize();
        this.renderer.render();
      }
    });
  }

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.micPrompt && !this.micPrompt.hidden) {
        e.preventDefault();
        this.hideMicPrompt();
        return;
      }

      // Ignore if typing in a text input or textarea (but allow range sliders)
      if (e.target.tagName === 'TEXTAREA') return;
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;

      // Ignore if modifier keys are pressed (Cmd/Ctrl, Alt, etc.)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.togglePlay();
          break;
        case 'KeyM':
          e.preventDefault();
          this.toggleMetronome();
          break;
        case 'KeyR':
          e.preventDefault();
          this.toggleRepeat();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.seekToPreviousBar();
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.seekToNextBar();
          break;
      }
    });
  }

  /**
   * Initialize the audio engine (requires user interaction first).
   */
  async initAudioEngine() {
    if (!this.audioEngine) {
      this.audioEngine = new AudioEngine();
    }
    await this.audioEngine.init();

    // Set up beat update callback
    this.audioEngine.onBeatUpdate = (beat) => {
      // AudioEngine.stop() emits a reset callback synchronously. Ignore that
      // transient update while a seek is replacing the transport position.
      if (this.isSeeking) return;
      this.state.currentBeat = beat;
      if (this.renderer) {
        // Keep the playback cursor pinned on the left side of center while the
        // score scrolls beneath it.
        this.renderer.setCurrentBeat(beat, {
          autoScroll: this.state.isPlaying
        });
      }
      this.updateSeekSlider();
    };

    // Reset UI when playback reaches the end naturally
    this.audioEngine.onPlaybackEnd = () => {
      if (this.state.repeatActive) {
        // Restart from beginning
        this.seekToBeat(0);
        if (this.state.isPlaying) {
          this.audioEngine.play();
        }
      } else {
        // Stop playback
        this.state.isPlaying = false;
        if (this.state.metronomeActive && this.metronome) {
          this.metronome.stop();
        }
        if (this.playIcon) this.playIcon.style.display = '';
        if (this.pauseIcon) this.pauseIcon.style.display = 'none';
        if (this.playBtn) this.playBtn.classList.remove('active');
        this.updateSeekSlider();
      }
    };

    // Initialize metronome
    if (!this.metronome) {
      this.metronome = new Metronome(
        this.audioEngine.getAudioContext(),
        this.audioEngine.getMasterGain()
      );
      this.metronome.setTempo(this.state.tempo);
      this.metronome.onBeat = (beatNum, isDownbeat) => {
        if (this.beatIndicator) {
          this.beatIndicator.classList.add('flash');
          if (isDownbeat) {
            this.beatIndicator.classList.add('downbeat');
          }
          setTimeout(() => {
            this.beatIndicator.classList.remove('flash', 'downbeat');
          }, 100);
        }
      };
    }
  }

  /**
   * Load one of the MusicXML files bundled with the app.
   * @param {string} samplePath
   * @param {HTMLButtonElement} button
   */
  async handleSamplePiece(samplePath, button) {
    if (!samplePath) return;
    const loadGeneration = ++this.fileLoadGeneration;

    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }

    try {
      // The HTML provides the complete path so sample files are loaded from
      // the bundled directory without trying to discover them by filename.
      const encodedPath = samplePath
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');
      const response = await fetch(encodedPath);
      if (!response.ok) {
        throw new Error(`Could not load sample piece (${response.status}).`);
      }

      const blob = await response.blob();
      const fileName = samplePath.split('/').pop();
      const file = new File([blob], fileName, { type: 'application/xml' });
      await this.handleFile(file, loadGeneration);
    } catch (err) {
      if (loadGeneration === this.fileLoadGeneration) {
        this.showError(err.message);
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  }

  async handleFile(file, loadGeneration = ++this.fileLoadGeneration) {
    try {
      const result = await parseFile(file);
      if (loadGeneration !== this.fileLoadGeneration) return;
      this.resetScoreTransition();

      this.state.parts = result.parts;
      this.state.metadata = result.metadata;
      this.state.rawXml = result.rawXml || null;
      this.state.fileName = file.name;
      this.state.tempo = result.metadata.tempo || 120;

      // Default to Tenor section if available, otherwise first part
      const tenorPart = this.state.parts.find(p =>
        p.voiceType?.toLowerCase() === 'tenor' || p.name?.toLowerCase().includes('tenor')
      );
      this.state.selectedSectionId = tenorPart?.id || this.state.parts[0]?.id || null;

      // Update tempo UI
      if (this.tempoDisplay) {
        this.tempoDisplay.textContent = this.state.tempo;
      }

      // Update title
      if (this.scoreTitle) {
        const title = result.metadata.title && result.metadata.title !== 'Untitled'
          ? result.metadata.title
          : file.name.replace(/\.(xml|musicxml|mxl)$/i, '');
        this.scoreTitle.textContent = title;
      }

      // Hide upload prompt, show notation area
      if (this.uploadPrompt) {
        this.uploadPrompt.style.display = 'none';
      }
      if (this.notationArea) {
        this.notationArea.style.display = 'block';
      }
      if (this.exportGroup) {
        this.exportGroup.style.display = '';
      }

      this.renderParts();
      this.renderPresets();
      this.initNotationRenderer();

      // Initialize audio engine with parts
      await this.initAudioEngine();
      if (loadGeneration !== this.fileLoadGeneration) return;
      this.audioEngine.setTempo(this.state.tempo);
      this.audioEngine.setSynthMode(this.state.synthMode);
      this.committedTempo = this.state.tempo;
      this.audioEngine.setParts(this.state.parts);
      for (const part of this.state.parts) {
        this.audioEngine.setPartVolume(part.id, this.state.partVolumes[part.id] ?? 100);
      }

      // Preserve non-custom volume presets as session preferences, but apply
      // them to the newly loaded score's parts. Keep a fresh custom baseline
      // for this score rather than restoring values from the previous score.
      if (this.state.activePreset && this.state.activePreset !== 'custom') {
        this.state.customVolumes = { ...this.state.partVolumes };
        this.applyPreset(this.state.activePreset);
      }

      // Set time signature from first measure if available
      if (this.metronome) {
        this.metronome.setTempo(this.state.tempo);
      }
      if (this.state.parts.length > 0 && this.state.parts[0].measures.length > 0) {
        const ts = this.state.parts[0].measures[0].timeSignature;
        if (ts && this.metronome) {
          this.metronome.setTimeSignature(ts.numerator, ts.denominator);
        }
      }

      // Pass actual measure start beats so the metronome accents on real
      // measure boundaries (handles pickup measures and time sig changes).
      if (this.metronome && this.state.parts.length > 0) {
        const measureStarts = this.state.parts[0].measures.map(m => m.startBeat);
        this.metronome.setMeasureStartBeats(measureStarts);
      }
    } catch (err) {
      if (loadGeneration === this.fileLoadGeneration) {
        this.showError(err.message);
      }
    }
  }

  /**
   * Clear score-specific state before loading a new file or returning home.
   * Session preferences such as synth mode, fermata timing, repeat, metronome,
   * and non-custom volume presets intentionally remain in state.
   */
  resetScoreTransition() {
    this.state.isPlaying = false;
    this.state.currentBeat = 0;
    this.state.parts = [];
    this.state.metadata = null;
    this.state.rawXml = null;
    this.state.fileName = null;
    this.state.selectedSectionId = null;
    this.state.partVolumes = {};
    this.state.selectedParts = new Set();
    this.state.customVolumes = {};
    if (this.state.activePreset === 'custom') {
      this.state.activePreset = null;
    }
    this._activePartEdit = null;
    this.isSeeking = false;

    if (this.audioEngine) {
      this.audioEngine.resetForNewScore();
    }
    if (this.metronome) {
      this.metronome.reset();
      this.metronome.setTimeSignature(4, 4);
      this.metronome.setMeasureStartBeats(null);
    }

    if (this.seekSlider) {
      this.seekSlider.value = 0;
      this.seekSlider.style.background =
        'linear-gradient(to right, var(--accent-primary) 0%, var(--bg-tertiary) 0%)';
    }
    if (this.seekTime) {
      this.seekTime.textContent = '0:00';
    }
    if (this.tempoDisplay) {
      this.tempoDisplay.textContent = '120';
    }
    this.state.tempo = 120;
    this.committedTempo = 120;

    if (this.scoreTitle) {
      this.scoreTitle.textContent = '';
    }
    if (this.partsList) {
      this.partsList.innerHTML = '<p class="no-parts-message">Choose a sample or upload a MusicXML file to see parts</p>';
    }
    if (this.renderer) {
      this.renderer = null;
    }
    this.pitchGuidePosition = 0;
    this.updatePitchGuide(null);

    if (this.playIcon) this.playIcon.style.display = '';
    if (this.pauseIcon) this.pauseIcon.style.display = 'none';
    if (this.playBtn) this.playBtn.classList.remove('active');
  }

  /**
   * Reset the app back to the home/upload screen.
   */
  resetToHome() {
    // Invalidate any file that is still parsing or downloading.
    this.fileLoadGeneration++;
    // No score should remain active on the home screen. Stop microphone
    // capture separately because it is otherwise preserved across files.
    this.stopMicrophone();
    this.resetScoreTransition();
    document.getElementById('presets-section')?.remove();

    if (this.uploadPrompt) {
      this.uploadPrompt.style.display = '';
    }
    if (this.notationArea) {
      this.notationArea.style.display = 'none';
    }
    if (this.pitchIndicator) {
      this.pitchIndicator.style.display = 'none';
    }
    if (this.exportGroup) {
      this.exportGroup.style.display = 'none';
    }
  }

  /**
   * Initialize the canvas-based notation renderer.
   */
  initNotationRenderer() {
    if (!this.notationCanvas) return;

    this.renderer = new NotationRenderer(this.notationCanvas);
    this.renderer.setData(this.state.parts, this.state.metadata);
    this.renderer.setSelectedPart(this.state.selectedSectionId);
  }

  renderParts() {
    if (!this.partsList) return;
    this.partsList.innerHTML = '';

    for (const part of this.state.parts) {
      const color = getPartColor(part.voiceType);
      const partEl = document.createElement('div');
      partEl.className = 'part-control';
      partEl.classList.toggle('selected-section', part.id === this.state.selectedSectionId);
      partEl.dataset.partId = part.id;

      // Initialize volume
      if (!(part.id in this.state.partVolumes)) {
        this.state.partVolumes[part.id] = 100;
      }
      this.state.selectedParts.add(part.id);

      partEl.innerHTML = `
        <div class="part-header">
          <span class="part-color-dot" style="background: ${color}"></span>
          <span class="part-name" title="Double-click to rename">${part.name}</span>
          <span class="part-type-badge">${part.voiceType}</span>
          ${part.id === this.state.selectedSectionId ? '<span class="my-section-badge">My Section</span>' : ''}
        </div>
        <div class="part-volume">
          <button class="mute-btn" data-part-id="${part.id}" title="Mute">
            <svg class="mute-icon unmuted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            <svg class="mute-icon muted" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/>
              <line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          </button>
          <input type="range" min="0" max="100" value="${this.state.partVolumes[part.id]}"
                 class="volume-slider" data-part-id="${part.id}">
          <span class="volume-value">${this.state.partVolumes[part.id]}%</span>
        </div>
      `;

      this.partsList.appendChild(partEl);

      // Double-click part name to edit inline
      const partNameEl = partEl.querySelector('.part-name');
      partNameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (partNameEl.contentEditable === 'true') return;

        // Commit any other active edit first
        this.commitActivePartEdit();

        partNameEl.contentEditable = 'true';
        partNameEl.classList.add('editing');
        partNameEl.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(partNameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        const commitEdit = () => {
          if (this._activePartEdit?.element !== partNameEl) return;
          this._activePartEdit = null;
          partNameEl.contentEditable = 'false';
          partNameEl.classList.remove('editing');
          partNameEl.removeEventListener('blur', commitEdit);
          partNameEl.removeEventListener('keydown', onKeydown);
          const newName = partNameEl.textContent.trim();
          if (newName && newName !== part.name) {
            part.name = newName;
            // Re-detect voice type from the new name
            part.voiceType = detectVoiceType(newName);
            const badge = partEl.querySelector('.part-type-badge');
            if (badge) badge.textContent = part.voiceType;
          } else {
            partNameEl.textContent = part.name;
          }
        };

        const onKeydown = (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault();
            partNameEl.blur();
          } else if (ke.key === 'Escape') {
            partNameEl.textContent = part.name;
            partNameEl.blur();
          }
        };

        partNameEl.addEventListener('blur', commitEdit);
        partNameEl.addEventListener('keydown', onKeydown);
        this._activePartEdit = { element: partNameEl, commit: commitEdit };
      });

      // Click the box to select as your section
      partEl.addEventListener('click', (e) => {
        // Don't select section when interacting with controls or editing name
        if (e.target.closest('input') || e.target.closest('button')) return;
        if (e.target.contentEditable === 'true') return;
        this.selectSection(part.id);
      });

      // Volume slider event
      const slider = partEl.querySelector('.volume-slider');
      const valueDisplay = partEl.querySelector('.volume-value');
      slider.addEventListener('input', (e) => {
        const volume = parseInt(e.target.value, 10);
        this.state.partVolumes[part.id] = volume;
        valueDisplay.textContent = `${volume}%`;
        if (this.audioEngine) {
          this.audioEngine.setPartVolume(part.id, volume);
        }
      });

      // Mute button event
      const muteBtn = partEl.querySelector('.mute-btn');
      muteBtn.addEventListener('click', () => {
        const isMuted = this.state.selectedParts.has(part.id);
        if (isMuted) {
          this.state.selectedParts.delete(part.id);
          muteBtn.classList.add('active');
          muteBtn.querySelector('.unmuted').style.display = 'none';
          muteBtn.querySelector('.muted').style.display = '';
          if (this.audioEngine) {
            this.audioEngine.setPartMuted(part.id, true);
          }
        } else {
          this.state.selectedParts.add(part.id);
          muteBtn.classList.remove('active');
          muteBtn.querySelector('.unmuted').style.display = '';
          muteBtn.querySelector('.muted').style.display = 'none';
          if (this.audioEngine) {
            this.audioEngine.setPartMuted(part.id, false);
          }
        }
      });
    }
  }

  /**
   * Select a section as "my section" — clicking a part box sets this.
   * @param {string} partId
   */
  selectSection(partId) {
    this.commitActivePartEdit();
    this.state.selectedSectionId = partId;
    // Update visual state
    this.partsList.querySelectorAll('.part-control').forEach(control => {
      const isSelected = control.dataset.partId === partId;
      control.classList.toggle('selected-section', isSelected);
      const badge = control.querySelector('.my-section-badge');
      if (isSelected && !badge) {
        const header = control.querySelector('.part-header');
        const badgeEl = document.createElement('span');
        badgeEl.className = 'my-section-badge';
        badgeEl.textContent = 'My Section';
        header.appendChild(badgeEl);
      } else if (!isSelected && badge) {
        badge.remove();
      }
    });
    if (this.renderer) {
      this.renderer.setSelectedPart(partId);
    }
    // Re-apply active preset if one is set
    if (this.state.activePreset) {
      this.applyPreset(this.state.activePreset);
    }
  }

  /**
   * Render the volume presets panel at the bottom of the sidebar.
   */
  renderPresets() {
    let presetsEl = document.getElementById('presets-section');
    if (!presetsEl) {
      presetsEl = document.createElement('div');
      presetsEl.id = 'presets-section';
      presetsEl.className = 'presets-section';
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.appendChild(presetsEl);
    }

    presetsEl.innerHTML = `
      <div class="presets-header">
        <h3>Volume Presets</h3>
      </div>
      <div class="presets-list">
        <button class="preset-btn ${this.state.activePreset === 'custom' ? 'active' : ''}" data-preset="custom">
          Custom
        </button>
        <button class="preset-btn ${this.state.activePreset === 'just-yours' ? 'active' : ''}" data-preset="just-yours">
          Just Yours
        </button>
        <button class="preset-btn preset-scrubber ${this.state.activePreset === 'mostly-yours' ? 'active' : ''}" data-preset="mostly-yours">
          <span class="preset-scrubber-label">Mostly Yours</span>
          <span class="preset-scrubber-control">
            <svg class="scrubber-drag-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 8H12"/>
              <path d="M6 6L4 8L6 10"/>
              <path d="M10 6L12 8L10 10"/>
            </svg>
            <span class="scrubber-context">others</span>
            <span id="others-volume-value">${this.state.othersVolume}%</span>
          </span>
        </button>
        <button class="preset-btn ${this.state.activePreset === 'all' ? 'active' : ''}" data-preset="all">
          All
        </button>
        <button class="preset-btn ${this.state.activePreset === 'everything-but-yours' ? 'active' : ''}" data-preset="everything-but-yours">
          Everything But Yours
        </button>
      </div>
    `;

    // Bind preset buttons
    presetsEl.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Don't activate via click if it was a drag gesture on the scrubber
        if (btn.dataset.wasDragged === 'true') {
          btn.dataset.wasDragged = 'false';
          return;
        }
        const preset = btn.dataset.preset;
        this.applyPreset(preset);
      });
    });

    // "Mostly Yours" scrubber — horizontal drag to adjust others volume
    const scrubberBtn = presetsEl.querySelector('.preset-scrubber');
    if (scrubberBtn) {
      let isDragging = false;
      let lastX = 0;
      let accumulatedDelta = 0;

      const startDrag = (x) => {
        isDragging = true;
        lastX = x;
        accumulatedDelta = 0;
        scrubberBtn.classList.add('dragging');
        // Activate this preset on drag start
        if (this.state.activePreset !== 'mostly-yours') {
          this.applyPreset('mostly-yours');
        }
      };

      const doDrag = (x) => {
        if (!isDragging) return;
        const dx = x - lastX;
        accumulatedDelta += dx * 0.4;
        const volumeChange = Math.trunc(accumulatedDelta);
        if (volumeChange !== 0) {
          accumulatedDelta -= volumeChange;
          const newVolume = Math.max(0, Math.min(100, this.state.othersVolume + volumeChange));
          if (newVolume !== this.state.othersVolume) {
            this.state.othersVolume = newVolume;
            const valueEl = presetsEl.querySelector('#others-volume-value');
            if (valueEl) valueEl.textContent = newVolume + '%';
            if (this.state.activePreset === 'mostly-yours') {
              this.applyPreset('mostly-yours');
            }
          }
        }
        lastX = x;
      };

      const endDrag = () => {
        if (!isDragging) return;
        // If there was meaningful movement, suppress the click
        if (Math.abs(lastX - lastX) !== 0 || accumulatedDelta !== 0) {
          scrubberBtn.dataset.wasDragged = 'true';
        }
        isDragging = false;
        scrubberBtn.classList.remove('dragging');
      };

      scrubberBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startDrag(e.clientX);
        scrubberBtn.dataset.wasDragged = 'false';
        const startX = e.clientX;

        const onMove = (ev) => {
          doDrag(ev.clientX);
          // Mark as dragged if moved more than 3px
          if (Math.abs(ev.clientX - startX) > 3) {
            scrubberBtn.dataset.wasDragged = 'true';
          }
        };
        const onUp = () => {
          endDrag();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      scrubberBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startDrag(e.touches[0].clientX);
        scrubberBtn.dataset.wasDragged = 'false';
        const startX = e.touches[0].clientX;

        const onMove = (ev) => {
          doDrag(ev.touches[0].clientX);
          if (Math.abs(ev.touches[0].clientX - startX) > 3) {
            scrubberBtn.dataset.wasDragged = 'true';
          }
        };
        const onEnd = () => {
          endDrag();
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onEnd);
          document.removeEventListener('touchcancel', onEnd);
        };
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
      });

      // Scroll wheel on the scrubber button
      scrubberBtn.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (this.state.activePreset !== 'mostly-yours') {
          this.applyPreset('mostly-yours');
        }
        const direction = e.deltaY > 0 ? -1 : 1;
        const step = e.shiftKey ? 10 : 5;
        const newVolume = Math.max(0, Math.min(100, this.state.othersVolume + direction * step));
        if (newVolume !== this.state.othersVolume) {
          this.state.othersVolume = newVolume;
          const valueEl = presetsEl.querySelector('#others-volume-value');
          if (valueEl) valueEl.textContent = newVolume + '%';
          this.applyPreset('mostly-yours');
        }
      });
    }
  }

  /**
   * Wire up the settings popover and fermata scrubber in the transport toolbar.
   */
  renderSettings() {
    const settingsBtn = document.getElementById('settings-btn');
    const popover = document.getElementById('settings-popover');
    const scrubber = document.getElementById('fermata-scrubber');
    const fermataValue = document.getElementById('fermata-value');
    const synthToggle = document.getElementById('synth-toggle');

    if (!settingsBtn || !popover) return;

    // Toggle popover
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = popover.style.display !== 'none';
      popover.style.display = isOpen ? 'none' : '';
      settingsBtn.classList.toggle('active', !isOpen);
    });

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && e.target !== settingsBtn) {
        popover.style.display = 'none';
        settingsBtn.classList.remove('active');
      }
    });

    // Synth mode toggle (Synth / Vocal)
    if (synthToggle) {
      synthToggle.querySelectorAll('.synth-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const mode = btn.dataset.mode;
          if (mode === this.state.synthMode) return;
          this.state.synthMode = mode;
          synthToggle.querySelectorAll('.synth-toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
          });
          if (this.audioEngine) {
            this.audioEngine.setSynthMode(mode);
          }
        });
      });
    }

    // Update displayed value
    if (fermataValue) {
      fermataValue.textContent = this.state.fermataMultiplier.toFixed(1) + 'x';
    }

    // Fermata scrubber — horizontal drag
    if (scrubber) {
      let isDragging = false;
      let lastX = 0;
      let accumulatedDelta = 0;

      const startDrag = (x) => {
        isDragging = true;
        lastX = x;
        accumulatedDelta = 0;
        scrubber.classList.add('dragging');
      };

      const doDrag = (x) => {
        if (!isDragging) return;
        const dx = x - lastX;
        accumulatedDelta += dx * 0.01; // 100px = 1.0x change
        const newVal = Math.max(1.0, Math.min(4.0,
          Math.round((this.state.fermataMultiplier + accumulatedDelta) * 10) / 10
        ));
        if (newVal !== this.state.fermataMultiplier) {
          accumulatedDelta = 0;
          this.state.fermataMultiplier = newVal;
          if (fermataValue) fermataValue.textContent = newVal.toFixed(1) + 'x';
          if (this.audioEngine) {
            this.audioEngine.setFermataMultiplier(newVal);
          }
        }
        lastX = x;
      };

      const endDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        scrubber.classList.remove('dragging');
      };

      scrubber.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e.clientX);
        const onMove = (ev) => doDrag(ev.clientX);
        const onUp = () => {
          endDrag();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      scrubber.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e.touches[0].clientX);
        const onMove = (ev) => doDrag(ev.touches[0].clientX);
        const onEnd = () => {
          endDrag();
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onEnd);
          document.removeEventListener('touchcancel', onEnd);
        };
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
      });

      // Scroll wheel
      scrubber.addEventListener('wheel', (e) => {
        e.preventDefault();
        const direction = e.deltaY > 0 ? -0.1 : 0.1;
        const step = e.shiftKey ? direction * 5 : direction;
        const newVal = Math.max(1.0, Math.min(4.0,
          Math.round((this.state.fermataMultiplier + step) * 10) / 10
        ));
        if (newVal !== this.state.fermataMultiplier) {
          this.state.fermataMultiplier = newVal;
          if (fermataValue) fermataValue.textContent = newVal.toFixed(1) + 'x';
          if (this.audioEngine) {
            this.audioEngine.setFermataMultiplier(newVal);
          }
        }
      });
    }
  }

  /**
   * Apply a volume preset.
   * @param {string} preset - one of 'custom', 'just-yours', 'mostly-yours', 'all', 'everything-but-yours'
   */
  applyPreset(preset) {
    // Save current volumes as custom if switching away from custom/no preset
    if (preset !== 'custom' && (this.state.activePreset === 'custom' || this.state.activePreset === null)) {
      this.state.customVolumes = { ...this.state.partVolumes };
    }

    this.state.activePreset = preset;
    const myId = this.state.selectedSectionId;

    if (preset === 'custom') {
      // Restore saved custom volumes
      if (Object.keys(this.state.customVolumes).length > 0) {
        for (const part of this.state.parts) {
          const volume = this.state.customVolumes[part.id] ?? 80;
          this.state.partVolumes[part.id] = volume;
          if (this.audioEngine) {
            this.audioEngine.setPartVolume(part.id, volume);
          }
        }
      }
    } else {
      for (const part of this.state.parts) {
        let volume;
        const isMine = part.id === myId;

        switch (preset) {
          case 'just-yours':
            volume = isMine ? 100 : 0;
            break;
          case 'mostly-yours':
            volume = isMine ? 100 : this.state.othersVolume;
            break;
          case 'all':
            volume = 100;
            break;
          case 'everything-but-yours':
            volume = isMine ? 0 : 100;
            break;
          default:
            volume = 100;
        }

        this.state.partVolumes[part.id] = volume;
        if (this.audioEngine) {
          this.audioEngine.setPartVolume(part.id, volume);
        }
      }
    }

    // Update the volume sliders in the parts list UI
    this.partsList.querySelectorAll('.part-control').forEach(control => {
      const partId = control.dataset.partId;
      const slider = control.querySelector('.volume-slider');
      const display = control.querySelector('.volume-value');
      if (slider && display) {
        slider.value = this.state.partVolumes[partId];
        display.textContent = `${this.state.partVolumes[partId]}%`;
      }
    });

    // Update preset button active states and slider visibility
    const presetsEl = document.getElementById('presets-section');
    if (presetsEl) {
      presetsEl.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === preset);
      });
      // Update the displayed volume value on the scrubber button
      const othersValueEl = presetsEl.querySelector('#others-volume-value');
      if (othersValueEl) {
        othersValueEl.textContent = this.state.othersVolume + '%';
      }
    }
  }

  /** Build score-aware synchronization options for the metronome. */
  getMetronomeSyncOptions() {
    if (!this.audioEngine) return null;
    return {
      startTime: this.audioEngine.getStartTime(),
      currentScoreBeat: this.audioEngine.getCurrentBeat(),
      scoreToPlaybackBeat: beat => this.audioEngine.getPlaybackBeat(beat)
    };
  }

  /**
   * Set the tempo across all modules.
   * @param {number} bpm
   */
  setTempo(bpm) {
    const newTempo = Math.max(40, Math.min(240, bpm));
    this.state.tempo = newTempo;
    if (this.tempoDisplay) {
      this.tempoDisplay.textContent = newTempo;
    }
    if (newTempo === this.committedTempo) return;

    const restartMetronome = !!(
      this.metronome?.isRunning && this.state.isPlaying && this.audioEngine
    );
    if (restartMetronome) this.metronome.stop();
    if (this.audioEngine) {
      this.audioEngine.setTempo(newTempo);
    }
    if (this.metronome) {
      this.metronome.setTempo(newTempo);
      if (restartMetronome) this.metronome.start(this.getMetronomeSyncOptions());
    }
    this.committedTempo = newTempo;
  }

  /**
   * Toggle play/pause state.
   */
  async togglePlay() {
    await this.initAudioEngine();

    if (this.state.isPlaying) {
      // Pause
      this.state.isPlaying = false;
      this.audioEngine.pause();
      if (this.state.metronomeActive && this.metronome) {
        this.metronome.stop();
      }
      if (this.playIcon) this.playIcon.style.display = '';
      if (this.pauseIcon) this.pauseIcon.style.display = 'none';
      if (this.playBtn) this.playBtn.classList.remove('active');
    } else {
      // Play
      this.state.isPlaying = true;
      this.audioEngine.setTempo(this.state.tempo);
      this.committedTempo = this.state.tempo;
      this.audioEngine.setParts(this.state.parts);
      // A sheet click can happen before the audio engine is initialized. Set
      // the transport to that selected score position on the first play, while
      // preserving the expanded pause position when resuming.
      if (!this.audioEngine.isPaused) {
        this.audioEngine.seek(this.state.currentBeat);
      }
      this.audioEngine.play();
      // Auto-start metronome in sync if enabled
      if (this.state.metronomeActive && this.metronome) {
        this.metronome.stop(); // reset before re-syncing
        this.metronome.setTempo(this.state.tempo);
        this.metronome.start(this.getMetronomeSyncOptions());
      }
      if (this.playIcon) this.playIcon.style.display = 'none';
      if (this.pauseIcon) this.pauseIcon.style.display = '';
      if (this.playBtn) this.playBtn.classList.add('active');
    }
    this.updateSeekSlider();
  }

  /**
   * Stop playback and reset position.
   */
  stop() {
    this.state.isPlaying = false;
    this.state.currentBeat = 0;
    if (this.audioEngine) {
      this.audioEngine.stop();
    }
    if (this.state.metronomeActive && this.metronome) {
      this.metronome.stop();
    }
    if (this.renderer) {
      this.renderer.reset();
    }
    if (this.playIcon) this.playIcon.style.display = '';
    if (this.pauseIcon) this.pauseIcon.style.display = 'none';
    if (this.playBtn) this.playBtn.classList.remove('active');
    this.updateSeekSlider();
  }

  /**
   * Toggle metronome on/off.
   */
  async toggleMetronome() {
    await this.initAudioEngine();

    this.state.metronomeActive = !this.state.metronomeActive;
    if (this.metronomeBtn) {
      this.metronomeBtn.classList.toggle('active', this.state.metronomeActive);
    }

    if (this.state.metronomeActive) {
      this.metronome.setTempo(this.state.tempo);
      // Sync metronome to audio engine if currently playing
      if (this.state.isPlaying && this.audioEngine) {
        this.metronome.start(this.getMetronomeSyncOptions());
      }
      // If not playing, metronome will start when play is pressed
    } else {
      this.metronome.stop();
    }
  }

  /**
   * Toggle repeat on/off.
   */
  toggleRepeat() {
    this.state.repeatActive = !this.state.repeatActive;
    if (this.repeatBtn) {
      this.repeatBtn.classList.toggle('active', this.state.repeatActive);
    }
  }

  /**
   * Stop active capture and invalidate any microphone permission request that
   * is still pending. A late permission response must not reactivate the mic.
   */
  stopMicrophone() {
    this.micStartGeneration++;
    this.micStartPending = false;
    this.state.micActive = false;

    if (this.pitchDetector) {
      this.pitchDetector.stop();
      this.pitchDetector = null;
    }
    if (this.micBtn) {
      this.micBtn.disabled = false;
      this.micBtn.classList.remove('active');
      this.micBtn.setAttribute('aria-pressed', 'false');
      this.micBtn.setAttribute('aria-label', 'Enable microphone');
      this.micBtn.title = 'Enable Microphone';
    }
    if (this.pitchIndicator) this.pitchIndicator.style.display = 'none';
    if (this.pitchAnnouncementTimer) {
      clearTimeout(this.pitchAnnouncementTimer);
      this.pitchAnnouncementTimer = null;
    }
    if (this.pitchAnnouncement) this.pitchAnnouncement.textContent = '';
    this.updatePitchGuide(null);
    if (this.renderer) this.renderer.setUserPitch(null);
  }

  /**
   * Open microphone setup guidance before requesting browser permission.
   */
  toggleMic() {
    if (this.state.micActive || this.micStartPending) {
      this.stopMicrophone();
      return;
    }

    this.showMicPrompt();
  }

  /**
   * Show the microphone setup guidance dialog.
   */
  showMicPrompt() {
    if (!this.micPrompt) {
      this.startMicrophone();
      return;
    }

    this.micPrompt.hidden = false;
    this.micPrompt.setAttribute('aria-hidden', 'false');
    this.micPromptContinue?.focus();
  }

  /**
   * Close the microphone setup guidance dialog.
   */
  hideMicPrompt() {
    if (!this.micPrompt || this.micPrompt.hidden) return;

    this.micPrompt.hidden = true;
    this.micPrompt.setAttribute('aria-hidden', 'true');
    this.micBtn?.focus();
  }

  /**
   * Request microphone access and start pitch detection after the user has
   * confirmed the headphone guidance.
   */
  async startMicrophone() {
    // PitchDetector owns a dedicated input context. Disable the control while
    // permission is pending so repeated clicks cannot create parallel streams.
    const requestGeneration = ++this.micStartGeneration;
    const detector = new PitchDetector();
    this.pitchDetector = detector;
    this.micStartPending = true;
    if (this.micBtn) this.micBtn.disabled = true;

    detector.onPitchDetected = pitchData => {
      if (requestGeneration === this.micStartGeneration) {
        this.handlePitchDetected(pitchData);
      }
    };

    const success = await detector.start();
    const requestIsCurrent =
      requestGeneration === this.micStartGeneration &&
      this.pitchDetector === detector;

    if (!requestIsCurrent) {
      detector.stop();
      return;
    }
    this.micStartPending = false;
    if (this.micBtn) this.micBtn.disabled = false;

    if (success) {
      this.state.micActive = true;
      if (this.micBtn) {
        this.micBtn.classList.add('active');
        this.micBtn.setAttribute('aria-pressed', 'true');
        this.micBtn.setAttribute('aria-label', 'Disable microphone');
        this.micBtn.title = 'Disable Microphone';
      }
      this.updatePitchGuide(null);
      if (this.pitchIndicator) this.pitchIndicator.style.display = 'flex';
    } else {
      this.pitchDetector = null;
      this.showError('Could not access microphone. Please allow microphone permissions.');
    }
  }

  /**
   * Handle pitch detection results.
   * @param {object|null} pitchData
   */
  handlePitchDetected(pitchData) {
    let samplePosition = this.state.currentBeat;
    if (pitchData && this.audioEngine) {
      samplePosition = this.audioEngine.getScorePositionSecondsAgo(
        pitchData.latencySeconds
      );
    }

    // Canvas history and guidance share the same target-relative result and the
    // same latency-compensated score position.
    const pitchSample = this.renderer
      ? this.renderer.setUserPitch(pitchData, samplePosition)
      : null;
    this.updatePitchGuide(pitchData ? pitchSample : null);
  }

  /**
   * Present pitch as a single centered gesture rather than rapidly changing
   * measurements. Left means the voice is low, right means it is high; the
   * instruction tells the singer which direction to correct.
   * @param {object|null} pitchSample
   */
  updatePitchGuide(pitchSample) {
    let state = 'listening';
    let label = 'Listening';
    let targetPosition = 0;

    if (pitchSample?.hasTarget && Number.isFinite(pitchSample.centsFromTarget)) {
      const cents = pitchSample.centsFromTarget;
      state = pitchSample.accuracy;
      targetPosition = Math.max(-1, Math.min(1, cents / 100));

      if (state === 'correct') {
        label = 'On pitch';
      } else {
        label = cents < 0 ? 'Higher' : 'Lower';
      }
    }

    // Complement the CSS easing with a small low-pass filter so vibrato feels
    // alive without making the control look nervous.
    this.pitchGuidePosition = state === 'listening'
      ? 0
      : this.pitchGuidePosition + (targetPosition - this.pitchGuidePosition) * 0.34;

    const labelChanged = this.pitchGuidance?.textContent !== label;
    if (this.pitchIndicator) {
      this.pitchIndicator.dataset.state = state;
      this.pitchIndicator.style.setProperty(
        '--pitch-shift',
        `${(this.pitchGuidePosition * 38).toFixed(1)}px`
      );
      this.pitchIndicator.setAttribute('aria-label', label);
    }
    if (this.pitchGuidance && labelChanged) {
      this.pitchGuidance.textContent = label;
    }

    // Announce only a guidance transition that remains stable briefly. This
    // makes the visual experience accessible without speaking on every frame.
    if (labelChanged && this.pitchAnnouncement) {
      if (this.pitchAnnouncementTimer) clearTimeout(this.pitchAnnouncementTimer);
      this.pitchAnnouncement.textContent = '';
      if (this.state.micActive) {
        this.pitchAnnouncementTimer = setTimeout(() => {
          if (this.state.micActive && this.pitchGuidance?.textContent === label) {
            this.pitchAnnouncement.textContent = label;
          }
          this.pitchAnnouncementTimer = null;
        }, 420);
      }
    }
  }

  /**
   * Seek to a percentage position in the score.
   * @param {number} percent - 0 to 100
   * @param {{ moveSheet?: boolean }} options
   */
  seekToPercent(percent, options = {}) {
    if (!this.audioEngine) return;
    const totalBeats = this.audioEngine.getTotalBeats();
    if (totalBeats <= 0) return;
    const targetBeat = (percent / 100) * totalBeats;
    this.seekToBeat(targetBeat, options);
  }

  /**
   * Seek to a specific beat position.
   * @param {number} beat
   * @param {{ moveSheet?: boolean, direction?: number }} options
   */
  seekToBeat(beat, options = {}) {
    const rendererTotalBeats = this.renderer?.horizontalLayout?.totalBeats ?? 0;
    const engineTotalBeats = this.audioEngine?.getTotalBeats() ?? 0;
    const maxBeat = engineTotalBeats > 0 ? engineTotalBeats : rendererTotalBeats;
    const requestedBeat = Number(beat);
    const clampedBeat = Number.isFinite(requestedBeat)
      ? Math.max(0, Math.min(maxBeat, requestedBeat))
      : 0;
    const wasPlaying = this.state.isPlaying;

    // Stop playback before changing its transport position. The stop callback
    // is suppressed so it cannot briefly reset the visible cursor to beat 0.
    if (wasPlaying && this.audioEngine) {
      this.isSeeking = true;
      this.audioEngine.stop();
      this.isSeeking = false;
      if (this.state.metronomeActive && this.metronome) {
        this.metronome.stop();
      }
    }

    const targetBeat = engineTotalBeats > 0
      ? this.audioEngine.seek(clampedBeat)
      : clampedBeat;
    this.state.currentBeat = targetBeat;

    // Manual seeks preserve the user's current sheet position. Navigation can
    // opt into a minimal scroll only when its target is outside the viewport.
    if (this.renderer) {
      this.renderer.clearUserPitchTrail();
      this.renderer.setCurrentBeat(targetBeat, { autoScroll: false });
      if (options.moveSheet) {
        this.renderer.ensureBeatVisible(targetBeat);
      }
    }

    // Resume playback from the exact selected position if it was playing.
    if (wasPlaying && this.audioEngine) {
      this.audioEngine.setTempo(this.state.tempo);
      this.audioEngine.setParts(this.state.parts);
      this.audioEngine.play();
      if (this.state.metronomeActive && this.metronome) {
        this.metronome.setTempo(this.state.tempo);
        this.metronome.start(this.getMetronomeSyncOptions());
      }
    }

    this.updateSeekSlider();
  }

  /**
   * Return the shared measure starts in score order.
   * @returns {number[]}
   */
  getMeasureStartBeats() {
    const starts = new Set();
    for (const part of this.state.parts || []) {
      for (const measure of part.measures || []) {
        const start = Number(measure.startBeat);
        if (Number.isFinite(start)) starts.add(Math.max(0, start));
      }
    }
    return [...starts].sort((left, right) => left - right);
  }

  /**
   * Seek to the start of the previous bar. The sheet moves only when the
   * destination is off-screen, and never while returning to piece start.
   */
  seekToPreviousBar() {
    const starts = this.getMeasureStartBeats();
    if (starts.length === 0) return;

    const currentBeat = Math.max(0, Number(this.state.currentBeat) || 0);
    const epsilon = 1e-6;
    let currentIndex = -1;
    for (let index = 0; index < starts.length; index++) {
      if (starts[index] <= currentBeat + epsilon) currentIndex = index;
      else break;
    }

    const targetIndex = Math.max(0, currentIndex - 1);
    const targetBeat = starts[targetIndex];
    if (Math.abs(targetBeat - currentBeat) <= epsilon) return;

    this.seekToBeat(targetBeat, {
      moveSheet: targetBeat > epsilon,
      direction: -1
    });
  }

  /**
   * Seek to the start of the next bar. The sheet moves only when the next bar
   * is outside the visible score area, rather than centering every selection.
   */
  seekToNextBar() {
    const starts = this.getMeasureStartBeats();
    if (starts.length === 0) return;

    const currentBeat = Math.max(0, Number(this.state.currentBeat) || 0);
    const nextBeat = starts.find(start => start > currentBeat + 1e-6);
    if (nextBeat === undefined) return;

    this.seekToBeat(nextBeat, {
      moveSheet: true,
      direction: 1
    });
  }

  /**
   * Seek relative to current position by a number of seconds.
   * @param {number} seconds - positive to forward, negative to back
   */
  seekRelative(seconds) {
    if (!this.audioEngine) return;

    const currentSeconds = this.audioEngine.getScorePositionSeconds();
    const newSeconds = Math.max(0, currentSeconds + seconds);
    this.seekToTime(newSeconds);
  }

  /**
   * Seek to a specific time position in seconds.
   * @param {number} seconds
   */
  seekToTime(seconds) {
    if (!this.audioEngine) return;

    const totalPlaybackBeats = this.audioEngine.getTotalPlaybackBeats();
    const totalTimeSec = (totalPlaybackBeats / this.state.tempo) * 60;
    if (seconds > totalTimeSec) seconds = totalTimeSec;

    const percent = (seconds / totalTimeSec) * 100;
    this.seekToPercent(percent);
  }

  /**
   * Update the seek slider and time display to reflect the current position.
   */
  updateSeekSlider() {
    if (!this.seekSlider || !this.audioEngine) return;
    const totalBeats = this.audioEngine.getTotalBeats();
    if (totalBeats <= 0) return;
    const percent = (this.state.currentBeat / totalBeats) * 100;
    this.seekSlider.value = percent;

    // YouTube-style filled track: accent color up to current position
    this.seekSlider.style.background =
      `linear-gradient(to right, var(--accent-primary) ${percent}%, var(--bg-tertiary) ${percent}%)`;

    // Update time display from the expanded playback timeline so fermata holds
    // are included and elapsed time continues while the score cursor waits.
    if (this.seekTime) {
      const currentPlaybackBeat = this.audioEngine.getCurrentPlaybackBeat();
      const totalPlaybackBeats = this.audioEngine.getTotalPlaybackBeats();
      const currentTimeSec = (currentPlaybackBeat / this.state.tempo) * 60;
      const totalTimeSec = (totalPlaybackBeats / this.state.tempo) * 60;
      this.seekTime.textContent = `${this.formatTime(currentTimeSec)} / ${this.formatTime(totalTimeSec)}`;
    }
  }

  /**
   * Format seconds to m:ss.
   * @param {number} seconds
   * @returns {string}
   */
  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Commit any in-progress part name edit so the value is saved to state.
   */
  commitActivePartEdit() {
    if (this._activePartEdit) {
      this._activePartEdit.commit();
    }
  }

  /**
   * Render the score with the current volume preset and download as a WAV file.
   * Shows a progress indicator in the export button while rendering.
   */
  async exportWAV() {
    if (!this.audioEngine || !this.state.parts.length) return;

    // Make sure the engine is initialised (needs an AudioContext for the
    // soft-clip curve builder even in offline mode).
    await this.initAudioEngine();

    const exportAudioBtn = document.getElementById('export-audio-btn');
    if (exportAudioBtn) {
      exportAudioBtn.disabled = true;
      exportAudioBtn.querySelector('.export-audio-label').textContent = 'Rendering…';
    }

    try {
      // Sync engine state so the offline render uses the latest tempo / parts.
      this.audioEngine.setTempo(this.state.tempo);
      this.audioEngine.setParts(this.state.parts);

      const audioBuffer = await this.audioEngine.exportAudio({
        onProgress: (ratio) => {
          if (exportAudioBtn) {
            const pct = Math.round(ratio * 100);
            exportAudioBtn.querySelector('.export-audio-label').textContent =
              pct < 100 ? `Rendering ${pct}%` : 'Encoding…';
          }
        }
      });

      const wav = AudioEngine.audioBufferToWav(audioBuffer);
      const url = URL.createObjectURL(wav);
      const a = document.createElement('a');
      a.href = url;
      const baseName = (this.state.fileName || 'score').replace(/\.(xml|musicxml|mxl)$/i, '');
      a.download = `${baseName}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      this.showError('Audio export failed: ' + err.message);
    } finally {
      if (exportAudioBtn) {
        exportAudioBtn.disabled = false;
        exportAudioBtn.querySelector('.export-audio-label').textContent = 'Export WAV';
      }
    }
  }

  /**
   * Export the current score as a modified MusicXML file.
   * Patches the original XML with the current tempo and any renamed parts,
   * then triggers a browser download.
   */
  exportMusicXML() {
    this.commitActivePartEdit();
    if (!this.state.rawXml) return;

    const parser = new DOMParser();
    const doc = parser.parseFromString(this.state.rawXml, 'application/xml');

    // --- Patch part names ---
    // MusicXML has one <part-name> per source part, while this app may split
    // that source into several editable logical voices. Preserve every edited
    // name by writing a compound label (for example "Soprano / Alto") in
    // voice-number order. The parser restores those names individually later.
    const partNameUpdates = buildPartNameUpdates(this.state.parts);

    const partList = doc.querySelector('part-list');
    if (partList) {
      for (const scorePart of partList.querySelectorAll('score-part')) {
        const id = scorePart.getAttribute('id');
        if (partNameUpdates.has(id)) {
          const nameEl = scorePart.querySelector('part-name');
          if (nameEl) {
            nameEl.textContent = partNameUpdates.get(id);
          }
        }
      }
    }

    // --- Patch tempo ---
    // Strategy: find the first <sound tempo="..."> in the score and update it.
    // If none exists, insert one in the first measure's first direction or as a
    // new <direction> element.
    const currentTempo = this.state.tempo;
    let tempoPatched = false;

    // Look for existing <sound tempo="..."> anywhere in the score
    const allSounds = doc.querySelectorAll('sound[tempo]');
    if (allSounds.length > 0) {
      // Update all tempo markings proportionally? No — just set the first one
      // to the user's chosen tempo. Additional tempo changes (accelerando etc.)
      // are left intact relative to their original values.
      allSounds[0].setAttribute('tempo', String(currentTempo));
      tempoPatched = true;
    }

    if (!tempoPatched) {
      // Insert a <direction> with <sound tempo="..."> at the start of the first measure
      const firstPart = doc.querySelector('part');
      const firstMeasure = firstPart?.querySelector('measure');
      if (firstMeasure) {
        const direction = doc.createElement('direction');
        direction.setAttribute('placement', 'above');
        const sound = doc.createElement('sound');
        sound.setAttribute('tempo', String(currentTempo));
        direction.appendChild(sound);
        // Insert before the first child (attributes/note)
        firstMeasure.insertBefore(direction, firstMeasure.firstChild);
      }
    }

    // --- Serialize and download ---
    const serializer = new XMLSerializer();
    let xmlString = serializer.serializeToString(doc);

    // Ensure XML declaration is present
    if (!xmlString.startsWith('<?xml')) {
      xmlString = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlString;
    }

    const blob = new Blob([xmlString], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Generate filename from the original, appending "-edited" before the extension
    const baseName = (this.state.fileName || 'score.xml').replace(/\.(xml|musicxml)$/i, '');
    a.download = `${baseName}-edited.musicxml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'error-message';
    errorEl.textContent = message;
    errorEl.addEventListener('click', () => errorEl.remove());

    document.body.appendChild(errorEl);
    setTimeout(() => errorEl.remove(), 5000);
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new ChoirPracticeApp();
});
