/**
 * Main Application Controller
 * Wires together the parser, renderer, audio engine, pitch detector,
 * and metronome modules for the choir practice experience.
 */

import { parseMusicXML, parseFile } from './musicxml-parser.js';
import { getPartColor } from './utils.js';
import { NotationRenderer } from './notation-renderer.js';
import { AudioEngine } from './audio-engine.js';
import { PitchDetector } from './pitch-detector.js';
import { Metronome } from './metronome.js';

class ChoirPracticeApp {
  constructor() {
    this.state = {
      parts: [],
      metadata: null,
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
      othersVolume: 30
    };

    this.renderer = null;
    this.audioEngine = null;
    this.pitchDetector = null;
    this.metronome = null;

    this.initUI();
    this.initEventListeners();
    this.initKeyboardShortcuts();
  }

  initUI() {
    this.fileUploadZone = document.getElementById('file-upload-zone');
    this.fileInput = document.getElementById('file-input');
    this.partsList = document.getElementById('parts-list');
    this.notationArea = document.getElementById('notation-area');
    this.tempoDisplay = document.getElementById('tempo-value');
    this.tempoScrubber = document.getElementById('tempo-scrubber');
    this.playBtn = document.getElementById('play-btn');
    this.playIcon = document.getElementById('play-icon');
    this.pauseIcon = document.getElementById('pause-icon');
    this.metronomeBtn = document.getElementById('metronome-btn');
    this.uploadPrompt = document.getElementById('upload-prompt');
    this.scoreTitle = document.getElementById('score-title');
    this.micBtn = document.getElementById('mic-btn');
    this.pitchNote = document.getElementById('pitch-note');
    this.pitchCents = document.getElementById('pitch-cents');
    this.pitchAccuracy = document.getElementById('pitch-accuracy');
    this.pitchIndicator = document.getElementById('pitch-indicator');
    this.notationCanvas = document.getElementById('notation-canvas');
    this.beatIndicator = document.getElementById('beat-indicator');
    this.seekSlider = document.getElementById('seek-slider');
    this.seekTime = document.getElementById('seek-time');
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
    if (this.metronomeBtn) {
      this.metronomeBtn.addEventListener('click', () => this.toggleMetronome());
    }
    if (this.micBtn) {
      this.micBtn.addEventListener('click', () => this.toggleMic());
    }

    // Tempo scrubber — velocity-sensitive horizontal drag
    if (this.tempoScrubber) {
      let isDragging = false;
      let lastX = 0;
      let lastTime = 0;
      let accumulatedDelta = 0;

      const startDrag = (x) => {
        isDragging = true;
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
            this.setTempo(newTempo);
          }
        }

        lastX = x;
        lastTime = now;
      };

      const endDrag = () => {
        if (!isDragging) return;
        isDragging = false;
        this.tempoScrubber.classList.remove('dragging');
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

      // Scroll wheel on the scrubber for fine adjustment
      this.tempoScrubber.addEventListener('wheel', (e) => {
        e.preventDefault();
        const direction = e.deltaY > 0 ? -1 : 1;
        const step = e.shiftKey ? 5 : 1;
        const newTempo = Math.max(40, Math.min(240, this.state.tempo + direction * step));
        if (newTempo !== this.state.tempo) {
          this.setTempo(newTempo);
        }
      });
    }

    // Seek slider
    if (this.seekSlider) {
      this.seekSlider.addEventListener('input', (e) => {
        const percent = parseFloat(e.target.value);
        this.seekToPercent(percent);
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
      // Ignore if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.togglePlay();
          break;
        case 'KeyM':
          e.preventDefault();
          this.toggleMetronome();
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
      this.state.currentBeat = beat;
      if (this.renderer) {
        this.renderer.setCurrentBeat(beat);
      }
      this.updateSeekSlider();
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

  async handleFile(file) {
    try {
      const result = await parseFile(file);
      this.state.parts = result.parts;
      this.state.metadata = result.metadata;
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
        this.scoreTitle.textContent = result.metadata.title;
      }

      // Hide upload prompt, show notation area
      if (this.uploadPrompt) {
        this.uploadPrompt.style.display = 'none';
      }
      if (this.notationArea) {
        this.notationArea.style.display = 'block';
      }

      this.renderParts();
      this.renderPresets();
      this.initNotationRenderer();

      // Initialize audio engine with parts
      await this.initAudioEngine();
      this.audioEngine.setTempo(this.state.tempo);
      this.audioEngine.setParts(this.state.parts);

      // Set time signature from first measure if available
      if (this.state.parts.length > 0 && this.state.parts[0].measures.length > 0) {
        const ts = this.state.parts[0].measures[0].timeSignature;
        if (ts && this.metronome) {
          this.metronome.setTimeSignature(ts.numerator, ts.denominator);
        }
      }
    } catch (err) {
      this.showError(err.message);
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

      const noteCount = part.measures.reduce((sum, m) =>
        sum + m.notes.filter(n => !n.isRest).length, 0);

      partEl.innerHTML = `
        <div class="part-header">
          <span class="part-color-dot" style="background: ${color}"></span>
          <span class="part-name">${part.name}</span>
          <span class="part-type-badge">${part.voiceType}</span>
          ${part.id === this.state.selectedSectionId ? '<span class="my-section-badge">My Section</span>' : ''}
        </div>
        <div class="part-info">
          <span class="note-count">${noteCount} notes</span>
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

      // Click the box to select as your section
      partEl.addEventListener('click', (e) => {
        // Don't select section when interacting with controls inside the box
        if (e.target.closest('input') || e.target.closest('button')) return;
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
        <button class="preset-btn ${this.state.activePreset === 'mostly-yours' ? 'active' : ''}" data-preset="mostly-yours">
          Mostly Yours
        </button>
        <div class="preset-others-slider" style="display: ${this.state.activePreset === 'mostly-yours' ? 'flex' : 'none'}">
          <label>Others:</label>
          <input type="range" min="0" max="100" value="${this.state.othersVolume}" class="volume-slider" id="others-volume-slider">
          <span class="volume-value" id="others-volume-value">${this.state.othersVolume}%</span>
        </div>
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
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        this.applyPreset(preset);
      });
    });

    // Bind others volume slider
    const othersSlider = presetsEl.querySelector('#others-volume-slider');
    const othersValue = presetsEl.querySelector('#others-volume-value');
    if (othersSlider) {
      othersSlider.addEventListener('input', (e) => {
        this.state.othersVolume = parseInt(e.target.value, 10);
        othersValue.textContent = `${this.state.othersVolume}%`;
        // Re-apply mostly-yours with new slider value
        if (this.state.activePreset === 'mostly-yours') {
          this.applyPreset('mostly-yours');
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
      const othersSliderContainer = presetsEl.querySelector('.preset-others-slider');
      if (othersSliderContainer) {
        othersSliderContainer.style.display = preset === 'mostly-yours' ? 'flex' : 'none';
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
    this.state.tempo = bpm;
    if (this.tempoDisplay) {
      this.tempoDisplay.textContent = bpm;
    }
    const restartMetronome = !!(
      this.metronome?.isRunning && this.state.isPlaying && this.audioEngine
    );
    if (restartMetronome) this.metronome.stop();
    if (this.audioEngine) {
      this.audioEngine.setTempo(bpm);
    }
    if (this.metronome) {
      this.metronome.setTempo(bpm);
      if (restartMetronome) this.metronome.start(this.getMetronomeSyncOptions());
    }
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
      this.audioEngine.setParts(this.state.parts);
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
   * Toggle microphone pitch detection.
   */
  async toggleMic() {
    if (this.state.micActive) {
      // Stop mic
      this.state.micActive = false;
      if (this.pitchDetector) {
        this.pitchDetector.stop();
        this.pitchDetector = null;
      }
      if (this.micBtn) {
        this.micBtn.classList.remove('active');
      }
      if (this.pitchIndicator) {
        this.pitchIndicator.style.display = 'none';
      }
      if (this.renderer) {
        this.renderer.setUserPitch(null);
      }
    } else {
      // Start mic — PitchDetector manages its own AudioContext
      this.pitchDetector = new PitchDetector();
      this.pitchDetector.onPitchDetected = (pitchData) => {
        this.handlePitchDetected(pitchData);
      };

      const success = await this.pitchDetector.start();
      if (success) {
        this.state.micActive = true;
        if (this.micBtn) {
          this.micBtn.classList.add('active');
        }
        if (this.pitchIndicator) {
          this.pitchIndicator.style.display = 'block';
        }
      } else {
        this.pitchDetector = null;
        this.showError('Could not access microphone. Please allow microphone permissions.');
      }
    }
  }

  /**
   * Handle pitch detection results.
   * @param {object|null} pitchData
   */
  handlePitchDetected(pitchData) {
    if (pitchData) {
      if (this.pitchNote) {
        this.pitchNote.textContent = `${pitchData.noteName}${pitchData.octave}`;
      }
      if (this.pitchCents) {
        const sign = pitchData.cents >= 0 ? '+' : '';
        this.pitchCents.textContent = `${sign}${pitchData.cents} cents`;
      }
      if (this.pitchAccuracy) {
        this.pitchAccuracy.className = 'pitch-accuracy ' + pitchData.accuracy;
      }
      if (this.renderer) {
        this.renderer.setUserPitch(pitchData);
      }
    } else {
      if (this.pitchNote) {
        this.pitchNote.textContent = '--';
      }
      if (this.pitchCents) {
        this.pitchCents.textContent = '0 cents';
      }
      if (this.pitchAccuracy) {
        this.pitchAccuracy.className = 'pitch-accuracy';
      }
      if (this.renderer) {
        this.renderer.setUserPitch(null);
      }
    }
  }

  /**
   * Seek to a percentage position in the score.
   * @param {number} percent - 0 to 100
   */
  seekToPercent(percent) {
    if (!this.audioEngine) return;
    const totalBeats = this.audioEngine.getTotalBeats();
    if (totalBeats <= 0) return;
    const targetBeat = (percent / 100) * totalBeats;
    this.seekToBeat(targetBeat);
  }

  /**
   * Seek to a specific beat position.
   * @param {number} beat
   */
  seekToBeat(beat) {
    if (!this.audioEngine) return;
    const wasPlaying = this.state.isPlaying;

    // Stop current playback
    if (wasPlaying) {
      this.audioEngine.stop();
      if (this.state.metronomeActive && this.metronome) {
        this.metronome.stop();
      }
    }

    // Set the new position in both score and expanded playback coordinates.
    this.state.currentBeat = this.audioEngine.seek(beat);

    // Update renderer
    if (this.renderer) {
      this.renderer.setCurrentBeat(this.state.currentBeat);
    }

    // Resume playback from new position if it was playing
    if (wasPlaying) {
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
   * Update the seek slider and time display to reflect the current position.
   */
  updateSeekSlider() {
    if (!this.seekSlider || !this.audioEngine) return;
    const totalBeats = this.audioEngine.getTotalBeats();
    if (totalBeats <= 0) return;
    const percent = (this.state.currentBeat / totalBeats) * 100;
    this.seekSlider.value = percent;

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
