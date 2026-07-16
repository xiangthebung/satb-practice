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
      partVolumes: {},
      metronomeActive: false,
      micActive: false
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
    this.tempoSlider = document.getElementById('tempo-slider');
    this.playBtn = document.getElementById('play-btn');
    this.stopBtn = document.getElementById('stop-btn');
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
    this.tapTempoBtn = document.getElementById('tap-tempo-btn');
  }

  initEventListeners() {
    // File upload via click
    if (this.fileInput) {
      this.fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.handleFile(file);
      });
    }

    // Drag and drop
    if (this.fileUploadZone) {
      this.fileUploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        this.fileUploadZone.classList.add('drag-over');
      });

      this.fileUploadZone.addEventListener('dragleave', () => {
        this.fileUploadZone.classList.remove('drag-over');
      });

      this.fileUploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        this.fileUploadZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) this.handleFile(file);
      });

      this.fileUploadZone.addEventListener('click', () => {
        this.fileInput?.click();
      });
    }

    // Transport controls
    if (this.playBtn) {
      this.playBtn.addEventListener('click', () => this.togglePlay());
    }
    if (this.stopBtn) {
      this.stopBtn.addEventListener('click', () => this.stop());
    }
    if (this.metronomeBtn) {
      this.metronomeBtn.addEventListener('click', () => this.toggleMetronome());
    }
    if (this.micBtn) {
      this.micBtn.addEventListener('click', () => this.toggleMic());
    }

    // Tap tempo
    if (this.tapTempoBtn) {
      this.tapTempoBtn.addEventListener('click', () => this.handleTapTempo());
    }

    // Tempo slider
    if (this.tempoSlider) {
      this.tempoSlider.addEventListener('input', (e) => {
        const tempo = parseInt(e.target.value, 10);
        this.setTempo(tempo);
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

      // Update tempo UI
      if (this.tempoSlider) {
        this.tempoSlider.value = this.state.tempo;
      }
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
  }

  renderParts() {
    if (!this.partsList) return;
    this.partsList.innerHTML = '';

    for (const part of this.state.parts) {
      const color = getPartColor(part.voiceType);
      const partEl = document.createElement('div');
      partEl.className = 'part-control';
      partEl.dataset.partId = part.id;

      // Initialize volume
      if (!(part.id in this.state.partVolumes)) {
        this.state.partVolumes[part.id] = 80;
      }
      this.state.selectedParts.add(part.id);

      const noteCount = part.measures.reduce((sum, m) =>
        sum + m.notes.filter(n => !n.isRest).length, 0);

      partEl.innerHTML = `
        <div class="part-header">
          <span class="part-color-dot" style="background: ${color}"></span>
          <span class="part-name">${part.name}</span>
          <span class="part-type-badge">${part.voiceType}</span>
        </div>
        <div class="part-info">
          <span class="note-count">${noteCount} notes</span>
        </div>
        <div class="part-volume">
          <label>Volume</label>
          <input type="range" min="0" max="100" value="${this.state.partVolumes[part.id]}"
                 class="volume-slider" data-part-id="${part.id}">
          <span class="volume-value">${this.state.partVolumes[part.id]}%</span>
        </div>
        <div class="part-actions">
          <button class="mute-btn" data-part-id="${part.id}" title="Mute">M</button>
          <button class="solo-btn" data-part-id="${part.id}" title="Solo">S</button>
        </div>
        <div class="part-toggle">
          <label class="toggle-label">
            <input type="checkbox" checked data-part-id="${part.id}" class="part-checkbox">
            <span>Enabled</span>
          </label>
        </div>
      `;

      this.partsList.appendChild(partEl);

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
      muteBtn.addEventListener('click', (e) => {
        const btn = e.target;
        btn.classList.toggle('active');
        if (this.audioEngine) {
          this.audioEngine.setPartMuted(part.id, btn.classList.contains('active'));
        }
      });

      // Solo button event
      const soloBtn = partEl.querySelector('.solo-btn');
      soloBtn.addEventListener('click', (e) => {
        const btn = e.target;
        btn.classList.toggle('active');
        if (this.audioEngine) {
          this.audioEngine.setPartSoloed(part.id, btn.classList.contains('active'));
        }
      });

      // Toggle checkbox event
      const checkbox = partEl.querySelector('.part-checkbox');
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.state.selectedParts.add(part.id);
          if (this.audioEngine) {
            this.audioEngine.setPartMuted(part.id, false);
          }
        } else {
          this.state.selectedParts.delete(part.id);
          if (this.audioEngine) {
            this.audioEngine.setPartMuted(part.id, true);
          }
        }
      });
    }
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
    if (this.audioEngine) {
      this.audioEngine.setTempo(bpm);
    }
    if (this.metronome) {
      this.metronome.setTempo(bpm);
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
      if (this.playBtn) {
        this.playBtn.textContent = 'Play';
        this.playBtn.classList.remove('active');
      }
    } else {
      // Play
      this.state.isPlaying = true;
      this.audioEngine.setTempo(this.state.tempo);
      this.audioEngine.setParts(this.state.parts);
      this.audioEngine.play();
      if (this.playBtn) {
        this.playBtn.textContent = 'Pause';
        this.playBtn.classList.add('active');
      }
    }
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
    if (this.renderer) {
      this.renderer.reset();
    }
    if (this.playBtn) {
      this.playBtn.textContent = 'Play';
      this.playBtn.classList.remove('active');
    }
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
        this.metronome.start({
          startTime: this.audioEngine.getStartTime(),
          currentBeat: this.audioEngine.getCurrentBeat()
        });
      } else {
        this.metronome.start();
      }
    } else {
      this.metronome.stop();
    }
  }

  /**
   * Toggle microphone pitch detection.
   */
  async toggleMic() {
    await this.initAudioEngine();

    if (this.state.micActive) {
      // Stop mic
      this.state.micActive = false;
      if (this.pitchDetector) {
        this.pitchDetector.stop();
      }
      if (this.micBtn) {
        this.micBtn.textContent = 'Mic Off';
        this.micBtn.classList.remove('active');
      }
      if (this.pitchIndicator) {
        this.pitchIndicator.style.display = 'none';
      }
      if (this.renderer) {
        this.renderer.setUserPitch(null);
      }
    } else {
      // Start mic
      if (!this.pitchDetector) {
        this.pitchDetector = new PitchDetector(this.audioEngine.getAudioContext());
        this.pitchDetector.onPitchDetected = (pitchData) => {
          this.handlePitchDetected(pitchData);
        };
      }

      const success = await this.pitchDetector.start();
      if (success) {
        this.state.micActive = true;
        if (this.micBtn) {
          this.micBtn.textContent = 'Mic On';
          this.micBtn.classList.add('active');
        }
        if (this.pitchIndicator) {
          this.pitchIndicator.style.display = 'block';
        }
      } else {
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
   * Handle tap tempo button press.
   */
  async handleTapTempo() {
    await this.initAudioEngine();
    const bpm = this.metronome.tap();
    if (bpm && bpm >= 40 && bpm <= 240) {
      this.setTempo(bpm);
      if (this.tempoSlider) {
        this.tempoSlider.value = bpm;
      }
    }
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
