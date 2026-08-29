/**
 * Application controller.
 *
 * Owns the practice session state and wires the score parser, notation
 * renderer, audio engine, metronome, and microphone together. Interface details
 * live in the ui/ modules; this file keeps the rules of the session.
 */

import { parseFile, detectVoiceType } from './musicxml-parser.js';
import { describePitch } from './utils.js';
import { NotationRenderer } from './notation-renderer.js';
import { AudioEngine, lyricForVerse } from './audio-engine.js';
import { PitchDetector } from './pitch-detector.js';
import { Metronome, isClickPattern } from './metronome.js';
import { readScoreTheme, watchColorScheme } from './theme.js';
import {
  readPref,
  writePref,
  readNumberPref,
  readBoolPref,
  writeBoolPref
} from './prefs.js';
import {
  DEFAULT_OTHERS_LEVEL,
  detectMixPreset,
  getMixVolumes,
  isMixPreset
} from './mix.js';
import { exportMusicXMLFile, exportWavFile } from './exporters.js';
import { Overlays } from './ui/overlays.js';
import { PartsPanel } from './ui/parts-panel.js';
import { Transport } from './ui/transport.js';
import { SETTINGS_DEFAULTS, Settings } from './ui/settings.js';

const TEMPO_MIN = 40;
const TEMPO_MAX = 240;
const TRANSPORT_UI_INTERVAL_MS = 50;
/** How long a pitch control has to settle before playback is rebuilt. */
const PITCH_REBUILD_DELAY_MS = 160;
/** How long a manual pan holds the score still while playback continues. */
const AUTO_SCROLL_PAUSE_MS = 3000;

class ChoirPracticeApp {
  constructor() {
    const storedPreset = readPref('mix-preset', 'mostly-mine');

    this.state = {
      parts: [],
      metadata: null,
      rawXml: null,
      fileName: null,
      isPlaying: false,
      currentBeat: 0,
      tempo: 120,
      myPartId: null,
      volumes: {},
      muted: new Set(),
      mixPreset: isMixPreset(storedPreset) ? storedPreset : 'mostly-mine',
      othersLevel: readNumberPref('others-level', DEFAULT_OTHERS_LEVEL, 0, 100),
      dimOthers: readBoolPref('dim-others', false),
      loop: false,
      metronome: false,
      playRepeats: readBoolPref('play-repeats', SETTINGS_DEFAULTS.playRepeats),
      micState: 'off',
      synthMode: readPref('synth-mode', 'vocal') === 'oscillator' ? 'oscillator' : 'vocal',
      room: readNumberPref('room', SETTINGS_DEFAULTS.room, 0, 100),
      fermata: readNumberPref('fermata', SETTINGS_DEFAULTS.fermata, 1, 4),
      masterVolume: readNumberPref('master-volume', SETTINGS_DEFAULTS.masterVolume, 0, 100),
      tuning: readNumberPref('tuning', SETTINGS_DEFAULTS.tuning, 415, 450),
      transpose: readNumberPref('transpose', SETTINGS_DEFAULTS.transpose, -12, 12),
      followDynamics: readBoolPref('follow-dynamics', SETTINGS_DEFAULTS.followDynamics),
      clickPattern: readPref('click-pattern', SETTINGS_DEFAULTS.clickPattern),
      clickVolume: readNumberPref('click-volume', SETTINGS_DEFAULTS.clickVolume, 0, 100),
      countInBars: readNumberPref('count-in', SETTINGS_DEFAULTS.countInBars, 0, 4),
      showLyrics: readBoolPref('show-lyrics', SETTINGS_DEFAULTS.showLyrics),
      showTimeSignatures: readBoolPref(
        'show-time-signatures',
        SETTINGS_DEFAULTS.showTimeSignatures
      ),
      verse: readNumberPref('verse', SETTINGS_DEFAULTS.verse, 1, 20),
      soloed: new Set(),
      loopRange: null
    };

    this.renderer = null;
    this.audioEngine = null;
    this.metronome = null;
    this.pitchDetector = null;
    this.committedTempo = this.state.tempo;
    this.loadGeneration = 0;
    this.micGeneration = 0;
    this.isSeeking = false;
    this.wasScoreDragged = false;
    this.autoScrollResumesAt = 0;
    this.isTransportBusy = false;
    this.lastTransportUiAt = -Infinity;
    this.pitchGuidePosition = 0;
    this.pitchAnnounceTimer = null;
    this.pitchRebuildTimer = null;

    this.cacheElements();
    // Exposed on the instance so the interface modules stay independently
    // testable and inspectable from the console.
    this.overlays = new Overlays();
    this.partsPanel = new PartsPanel(this.createPartsHandlers());
    this.transport = new Transport(this.createTransportHandlers());
    this.settings = new Settings(this.createSettingsHandlers());

    this.partsPanel.setOthersLevel(this.state.othersLevel);
    this.partsPanel.setMixPreset(this.state.mixPreset);
    this.partsPanel.setDimOthers(this.state.dimOthers);
    this.transport.setTempo(this.state.tempo);
    this.transport.setLoopRange(null);
    this.settings.setAll(this.collectSettings());

    this.bindHomeScreen();
    this.bindScoreCanvas();
    this.bindExports();
    this.bindKeyboard();
    this.watchAppearance();
  }

  cacheElements() {
    this.home = document.getElementById('home');
    this.practice = document.getElementById('practice');
    this.sampleList = document.getElementById('sample-list');
    this.dropzone = document.getElementById('dropzone');
    this.fileInput = document.getElementById('file-input');
    this.scoreMeta = document.getElementById('score-meta');
    this.scoreName = document.getElementById('score-name');
    this.scoreComposer = document.getElementById('score-composer');
    this.exportMenu = document.getElementById('export-menu');
    this.exportWavButton = document.getElementById('export-wav-btn');
    this.exportXmlButton = document.getElementById('export-xml-btn');
    this.loading = document.getElementById('loading');
    this.loadingText = document.getElementById('loading-text');
    this.scoreFrame = document.getElementById('score-frame');
    this.canvas = document.getElementById('score-canvas');
    this.pitchPill = document.getElementById('pitch-pill');
    this.pitchLabel = document.getElementById('pitch-label');
  }

  /* =====================================================================
     Screens and score loading
     ===================================================================== */

  bindHomeScreen() {
    document.getElementById('home-btn')?.addEventListener('click', () => this.returnHome());

    this.sampleList?.addEventListener('click', event => {
      const button = event.target.closest('.sample');
      if (button) this.loadSample(button.dataset.samplePath, button);
    });

    this.dropzone?.addEventListener('click', () => this.fileInput?.click());
    this.fileInput?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      // Reset so choosing the same file again still fires a change event.
      event.target.value = '';
      if (file) this.openFile(file);
    });

    const setDragState = (isOver) => this.dropzone?.classList.toggle('is-drag-over', isOver);
    for (const type of ['dragenter', 'dragover']) {
      this.dropzone?.addEventListener(type, event => {
        event.preventDefault();
        setDragState(true);
      });
    }
    for (const type of ['dragleave', 'dragend']) {
      this.dropzone?.addEventListener(type, () => setDragState(false));
    }
    this.dropzone?.addEventListener('drop', event => {
      event.preventDefault();
      setDragState(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) this.openFile(file);
    });
    // Dropping anywhere else should not navigate away from the app.
    window.addEventListener('dragover', event => event.preventDefault());
    window.addEventListener('drop', event => event.preventDefault());
  }

  setLoading(isLoading, message = 'Opening score…') {
    if (this.loading) this.loading.hidden = !isLoading;
    if (this.loadingText && isLoading) this.loadingText.textContent = message;
    if (this.dropzone) {
      this.dropzone.disabled = isLoading;
      this.dropzone.setAttribute('aria-busy', String(isLoading));
    }
    for (const button of this.sampleList?.querySelectorAll('.sample') || []) {
      button.disabled = isLoading;
    }
    if (isLoading) this.overlays.announce(message);
  }

  /** Load one of the bundled sample scores. */
  async loadSample(path, button) {
    if (!path) return;
    const generation = ++this.loadGeneration;
    this.setLoading(true, 'Opening sample…');
    if (button) button.setAttribute('aria-busy', 'true');

    try {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(encoded);
      if (!response.ok) {
        throw new Error('That sample could not be loaded. Check your connection and try again.');
      }
      const blob = await response.blob();
      // Some static hosts answer a missing asset with their index page and HTTP 200.
      // Without this check the HTML reaches DOMParser and looks like damaged MusicXML,
      // hiding the actual deployment problem from the singer.
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const beginning = (await blob.slice(0, 512).text()).trimStart().toLowerCase();
      if (contentType.includes('text/html') ||
          beginning.startsWith('<!doctype html') || beginning.startsWith('<html')) {
        throw new Error(
          'That sample is missing from this deployment. The server returned a web page instead of MusicXML.'
        );
      }
      const fileName = path.split('/').pop();
      await this.readScore(new File([blob], fileName, { type: 'application/xml' }), generation);
    } catch (error) {
      if (generation === this.loadGeneration) this.failLoad(error);
    } finally {
      button?.removeAttribute('aria-busy');
    }
  }

  /** Open a score the singer chose or dropped. */
  async openFile(file) {
    const generation = ++this.loadGeneration;
    this.setLoading(true, `Opening ${file.name}…`);
    try {
      await this.readScore(file, generation);
    } catch (error) {
      if (generation === this.loadGeneration) this.failLoad(error);
    }
  }

  failLoad(error) {
    this.setLoading(false);
    this.overlays.toast(
      error?.message || 'That score could not be opened.',
      { type: 'error' }
    );
  }

  async readScore(file, generation) {
    const result = await parseFile(file);
    if (generation !== this.loadGeneration) return;
    if (!result.parts?.length) {
      throw new Error('No playable parts were found in this file.');
    }

    this.resetSession();
    this.state.parts = result.parts;
    this.state.metadata = result.metadata;
    this.state.rawXml = result.rawXml || null;
    this.state.fileName = file.name;
    this.state.tempo = this.clampTempo(result.metadata.tempo || 120);
    this.committedTempo = this.state.tempo;
    this.state.myPartId = this.chooseDefaultPart(result.parts);

    for (const part of result.parts) {
      this.state.volumes[part.id] = 100;
    }

    this.showPracticeScreen(result, file.name);
    this.createRenderer();
    await this.prepareAudio(generation);
    if (generation !== this.loadGeneration) return;

    this.applyMix(this.state.mixPreset, { persist: false });
    this.partsPanel.renderParts(this.state.parts, this.state);
    this.partsPanel.setVolumes(this.state.volumes);
    this.partsPanel.setMixPreset(this.state.mixPreset);
    this.transport.setTempo(this.state.tempo);
    this.updateTransportPosition();
    this.setLoading(false);

    if (!readBoolPref('coach-seen', false)) this.partsPanel.showCoach();
    this.overlays.announce(
      `${this.getScoreTitle(result, file.name)} is open with ${result.parts.length} parts. Press space to play.`
    );
    this.reportUnperformed(result.metadata);
  }

  /**
   * Say out loud what is written on the page but will not be played.
   *
   * The parser has always worked this out — `summariseFeatures` builds an
   * `unperformed` list precisely "so the app can tell a singer when something
   * written on the page is not reflected in playback instead of quietly ignoring
   * it" — and then nothing read it, so the app quietly ignored it anyway. A
   * singer whose score says *D.C. al Fine* and hears it played straight through
   * has no way to tell whether the app skipped the jump or they misread the page.
   *
   * @param {object} metadata
   */
  reportUnperformed(metadata) {
    const unperformed = metadata?.features?.unperformed || [];
    if (!unperformed.length) return;
    const list = unperformed.length === 1
      ? unperformed[0]
      : `${unperformed.slice(0, -1).join(', ')} and ${unperformed[unperformed.length - 1]}`;
    const message = `This score has ${list}, which playback does not follow. The notes are all there.`;
    this.overlays.toast(message, { duration: 9000 });
    this.overlays.announce(message);
  }

  getScoreTitle(result, fileName) {
    const title = result.metadata?.title;
    if (title && title !== 'Untitled') return title;
    return fileName.replace(/\.(musicxml|xml|mxl)$/i, '');
  }

  /**
   * Pick a sensible starting part: the voice this singer chose last time when
   * the score has it, otherwise the first singable part.
   */
  chooseDefaultPart(parts) {
    const preferred = readPref('voice-type');
    const singable = parts.filter(part => !part.isPiano);
    const pool = singable.length ? singable : parts;
    if (preferred) {
      const match = pool.find(part => part.voiceType === preferred) ||
        pool.find(part => String(part.voiceType || '').startsWith(preferred));
      if (match) return match.id;
    }
    return pool[0]?.id || null;
  }

  showPracticeScreen(result, fileName) {
    const title = this.getScoreTitle(result, fileName);
    if (this.scoreName) this.scoreName.textContent = title;
    if (this.scoreComposer) this.scoreComposer.textContent = result.metadata?.composer || '';
    if (this.scoreMeta) this.scoreMeta.hidden = false;
    if (this.exportMenu) this.exportMenu.hidden = false;
    if (this.home) this.home.hidden = true;
    if (this.practice) this.practice.hidden = false;
    this.transport.setVisible(true);
    this.partsPanel.show();
    const voices = result.parts.map(part => part.name).join(', ');
    this.canvas?.setAttribute('aria-label', `Score for ${title}. Parts: ${voices}.`);
    document.title = `${title} · Choir Practice`;
  }

  /** Clear everything tied to the previous score, keeping session preferences. */
  resetSession() {
    this.stopMicrophone();
    this.state.isPlaying = false;
    this.state.currentBeat = 0;
    this.state.parts = [];
    this.state.metadata = null;
    this.state.rawXml = null;
    this.state.fileName = null;
    this.state.myPartId = null;
    this.state.volumes = {};
    this.state.muted = new Set();
    this.state.soloed = new Set();
    this.state.loopRange = null;
    this.state.loop = false;
    this.state.metronome = false;
    this.isSeeking = false;
    clearTimeout(this.pitchRebuildTimer);
    this.pitchRebuildTimer = null;
    this.renderer?.destroy();
    this.renderer = null;

    this.audioEngine?.resetForNewScore();
    if (this.metronome) {
      this.metronome.reset();
      this.metronome.setTimeSignature(4, 4);
      this.metronome.setMeasureStartBeats(null);
    }

    this.transport.setPlaying(false);
    this.transport.setLoop(false);
    this.transport.setMetronome(false);
    this.transport.setLoopRange(null);
    this.transport.setLoopFields(null);
    this.transport.setPosition({ percent: 0, currentSeconds: 0, totalSeconds: 0 });
    this.audioEngine?.clearLoopRange();
    this.audioEngine?.clearSolo();
  }

  /** Return to the score picker. */
  returnHome() {
    this.loadGeneration++;
    this.setLoading(false);
    this.overlays.closeMenus();
    this.resetSession();
    this.partsPanel.hide();
    this.transport.setVisible(false);
    if (this.practice) this.practice.hidden = true;
    if (this.home) this.home.hidden = false;
    if (this.scoreMeta) this.scoreMeta.hidden = true;
    if (this.exportMenu) this.exportMenu.hidden = true;
    if (this.pitchPill) this.pitchPill.hidden = true;
    document.title = 'Choir Practice';
    this.sampleList?.querySelector('.sample')?.focus();
  }

  /* =====================================================================
     Score rendering and pointer interaction
     ===================================================================== */

  createRenderer() {
    if (!this.canvas) return;
    this.renderer?.destroy();
    this.renderer = new NotationRenderer(this.canvas);
    this.renderer.setTheme(readScoreTheme());
    // Score-view choices are set before the data so the first layout already
    // reserves room for the words instead of reflowing once they appear.
    this.renderer.showLyrics = this.state.showLyrics;
    this.renderer.showTimeSignatures = this.state.showTimeSignatures;
    this.renderer.verse = this.state.verse;
    this.renderer.setData(this.state.parts, this.state.metadata);
    this.renderer.setSelectedPart(this.state.myPartId);
    this.renderer.setFocusSelectedPart(this.state.dimOthers);
    this.applyPitchReference();
    this.observeScoreFrame();

    // A verse picker is only worth offering when the score has more than one.
    const verseCount = this.renderer.getVerseCount();
    if (this.state.verse > Math.max(1, verseCount)) this.state.verse = 1;
    this.renderer.verse = this.state.verse;
    this.settings.setVerses(verseCount, this.state.verse);
  }

  observeScoreFrame() {
    if (this.frameObserver || !this.scoreFrame || typeof ResizeObserver !== 'function') return;
    this.frameObserver = new ResizeObserver(() => {
      if (!this.renderer) return;
      this.renderer.resize();
      this.renderer.render();
    });
    this.frameObserver.observe(this.scoreFrame);
  }

  watchAppearance() {
    watchColorScheme(theme => {
      this.renderer?.setTheme(theme);
      this.partsPanel.refreshVoiceColors(this.state.parts);
    });
  }

  bindScoreCanvas() {
    const canvas = this.canvas;
    if (!canvas) return;

    let pointerId = null;
    let startX = 0;
    let startBeat = 0;
    let didDrag = false;

    canvas.addEventListener('pointerdown', event => {
      if (!this.renderer || event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startBeat = this.state.currentBeat;
      didDrag = false;
      canvas.setPointerCapture?.(pointerId);
      canvas.classList.add('is-scrubbing');
    });

    canvas.addEventListener('pointermove', event => {
      if (pointerId === null || event.pointerId !== pointerId || !this.renderer) return;
      const distance = event.clientX - startX;
      if (!didDrag && Math.abs(distance) <= 4) return;
      didDrag = true;
      event.preventDefault();
      const startScoreX = this.renderer.getScoreX(startBeat);
      const targetBeat = this.renderer.getBeatAtScoreX(startScoreX - distance);
      this.renderer.isAutoScrollEnabled = true;
      this.seekToBeat(targetBeat, { followScore: true });
    });

    const endDrag = event => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      pointerId = null;
      canvas.classList.remove('is-scrubbing');
      this.wasScoreDragged = didDrag;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('click', event => {
      if (!this.renderer) return;
      if (this.wasScoreDragged) {
        this.wasScoreDragged = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      const beat = this.renderer.getBeatAtScreenX(event.clientX - rect.left);
      if (beat !== null) this.seekToBeat(beat);
    });

    // Trackpad and shift-wheel gestures browse ahead without moving playback.
    // While playing, auto-scroll pauses briefly so the view does not snap back
    // under the reader's hand, then resumes on its own.
    canvas.addEventListener('wheel', event => {
      if (!this.renderer) return;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && !event.shiftKey) return;
      event.preventDefault();
      const delta = horizontal ? event.deltaX : event.deltaY;
      this.autoScrollResumesAt = performance.now() + AUTO_SCROLL_PAUSE_MS;
      this.renderer.setScrollX(this.renderer.scrollX + delta);
    }, { passive: false });
  }

  /* =====================================================================
     Parts and mix
     ===================================================================== */

  createPartsHandlers() {
    return {
      onSelectPart: partId => this.selectPart(partId),
      onVolumeChange: (partId, volume) => this.setPartVolume(partId, volume),
      onMuteChange: (partId, muted) => this.setPartMuted(partId, muted),
      onSoloChange: (partId, soloed) => this.setPartSoloed(partId, soloed),
      onRename: (partId, name) => this.renamePart(partId, name),
      onMixChange: presetId => this.applyMix(presetId),
      onOthersLevelChange: level => this.setOthersLevel(level),
      onDimChange: dim => this.setDimOthers(dim),
      onCoachDismiss: () => writeBoolPref('coach-seen', true)
    };
  }

  selectPart(partId) {
    const part = this.state.parts.find(item => item.id === partId);
    if (!part) return;

    this.state.myPartId = partId;
    writePref('voice-type', part.voiceType || '');
    this.partsPanel.setSelectedPart(partId);
    this.renderer?.setSelectedPart(partId);
    if (this.state.mixPreset) this.applyMix(this.state.mixPreset, { persist: false });
    this.overlays.announce(`${part.name} is now your part.`);
  }

  setPartVolume(partId, volume) {
    this.state.volumes[partId] = volume;
    this.audioEngine?.setPartVolume(partId, volume);
    // A manual change may or may not still match a preset.
    const detected = detectMixPreset(
      this.state.volumes,
      this.state.parts,
      this.state.myPartId,
      this.state.othersLevel
    );
    this.state.mixPreset = detected;
    this.partsPanel.setMixPreset(detected);
    if (detected) writePref('mix-preset', detected);
  }

  /**
   * Solo or unsolo a part.
   *
   * Soloing is a temporary "just this line" rather than a change to the mix, so
   * it never touches the mute choices underneath it.
   *
   * @param {string} partId
   * @param {boolean} soloed
   */
  setPartSoloed(partId, soloed) {
    if (soloed) this.state.soloed.add(partId);
    else this.state.soloed.delete(partId);

    this.audioEngine?.setPartSoloed(partId, soloed);
    this.partsPanel.setSoloed(this.state.soloed);

    const part = this.state.parts.find(item => item.id === partId);
    const name = part ? part.name : 'That part';
    this.overlays.announce(
      this.state.soloed.size === 0
        ? 'Back to the full mix'
        : soloed ? `${name} on its own` : `${name} no longer on its own`
    );
  }

  setPartMuted(partId, muted) {
    if (muted) this.state.muted.add(partId);
    else this.state.muted.delete(partId);
    this.audioEngine?.setPartMuted(partId, muted);
  }

  renamePart(partId, name) {
    const part = this.state.parts.find(item => item.id === partId);
    if (!part) return;

    part.name = name;
    part.voiceType = detectVoiceType(name);
    this.partsPanel.setPartLabel(partId, part);
    if (partId === this.state.myPartId) writePref('voice-type', part.voiceType || '');
    // Voice colour and clef inference are baked into the cached score layer.
    this.renderer?.invalidateStaticScore();
    this.renderer?.requestRender();
    this.overlays.announce(`Part renamed to ${name}.`);
  }

  /**
   * Apply a mix preset to every part.
   * @param {string|null} presetId
   * @param {{ persist?: boolean }} options
   */
  applyMix(presetId, { persist = true } = {}) {
    if (!presetId || !isMixPreset(presetId)) return;

    this.state.mixPreset = presetId;
    this.state.volumes = getMixVolumes(
      presetId,
      this.state.parts,
      this.state.myPartId,
      this.state.othersLevel
    );
    for (const [partId, volume] of Object.entries(this.state.volumes)) {
      this.audioEngine?.setPartVolume(partId, volume);
    }
    this.partsPanel.setVolumes(this.state.volumes);
    this.partsPanel.setMixPreset(presetId);
    if (persist) writePref('mix-preset', presetId);
  }

  setOthersLevel(level) {
    this.state.othersLevel = Math.max(0, Math.min(100, Math.round(level)));
    writePref('others-level', this.state.othersLevel);
    if (this.state.mixPreset === 'mostly-mine') {
      this.applyMix('mostly-mine', { persist: false });
    }
  }

  setDimOthers(dim) {
    this.state.dimOthers = Boolean(dim);
    writeBoolPref('dim-others', this.state.dimOthers);
    this.renderer?.setFocusSelectedPart(this.state.dimOthers);
  }

  /* =====================================================================
     Audio, transport and playback
     ===================================================================== */

  createTransportHandlers() {
    return {
      onTogglePlay: () => this.togglePlay(),
      onSeek: percent => this.seekToPercent(percent, { followScore: true }),
      onPrevBar: () => this.seekToPreviousBar(),
      onNextBar: () => this.seekToNextBar(),
      onToggleLoop: () => this.toggleLoop(),
      onToggleMetronome: () => this.toggleMetronome(),
      onToggleMic: () => this.toggleMicrophone(),
      onOpenParts: () => this.partsPanel.toggle(),
      onTempoPreview: bpm => this.previewTempo(bpm),
      onTempoCommit: bpm => this.setTempo(bpm),
      // The fields are the source of truth for this path, so nothing is written
      // back into them.
      onLoopRange: range => this.setLoopBars(range.from, range.to, { syncFields: false }),
      onLoopMark: edge => this.markLoopEdge(edge),
      onLoopClear: () => this.clearLoopRange()
    };
  }

  createSettingsHandlers() {
    return {
      onSynthMode: mode => this.setSynthMode(mode),
      onMasterVolume: value => this.setMasterVolume(value),
      onRoom: value => this.setRoom(value),
      onTuning: value => this.setTuning(value),
      onTranspose: value => this.setTranspose(value),
      onFermata: value => this.setFermata(value),
      onFollowDynamics: enabled => this.setFollowDynamics(enabled),
      onPlayRepeats: enabled => this.setPlayRepeats(enabled),
      onClickPattern: pattern => this.setClickPattern(pattern),
      onClickVolume: value => this.setClickVolume(value),
      onCountInBars: value => this.setCountInBars(value),
      onShowLyrics: visible => this.setShowLyrics(visible),
      onShowTimeSignatures: visible => this.setShowTimeSignatures(visible),
      onVerse: verse => this.setVerse(verse),
      onReset: () => this.restoreDefaultSettings()
    };
  }

  clampTempo(bpm) {
    return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(Number(bpm) || 120)));
  }

  async initAudioEngine({ resume = true } = {}) {
    if (!this.audioEngine) this.audioEngine = new AudioEngine();
    await this.audioEngine.init({ resume });

    if (!this.audioEngine.onBeatUpdate) {
      this.audioEngine.onBeatUpdate = beat => this.handleBeatUpdate(beat);
      this.audioEngine.onPlaybackEnd = () => this.handlePlaybackEnd();
      this.audioEngine.onLoopEnd = () => this.handleLoopEnd();
      this.audioEngine.onContextStateChange = state => this.handleAudioContextState(state);
    }

    if (!this.metronome) {
      this.metronome = new Metronome(
        this.audioEngine.getAudioContext(),
        this.audioEngine.getClickBus()
      );
      this.metronome.onBeat = (_beat, isDownbeat) => this.transport.flashBeat(isDownbeat);
    }
    return this.audioEngine;
  }

  /** Build the audio graph for a freshly loaded score without resuming it. */
  async prepareAudio(generation) {
    // The load happens after async parsing, so the original click's activation
    // window may be gone. Playback resumes the context from its own gesture.
    await this.initAudioEngine({ resume: false });
    if (generation !== this.loadGeneration) return;

    this.audioEngine.setSynthMode(this.state.synthMode);
    this.audioEngine.setRoomAmount(this.state.room);
    this.audioEngine.setMasterVolume(this.state.masterVolume);
    this.audioEngine.setTuning(this.state.tuning);
    this.audioEngine.setTranspose(this.state.transpose);
    this.audioEngine.setFollowDynamics(this.state.followDynamics);
    this.audioEngine.setCountInBars(this.state.countInBars);
    this.audioEngine.setFermataMultiplier(this.state.fermata);
    this.audioEngine.setVerse(this.state.verse);
    this.audioEngine.setParts(this.state.parts);
    // The structure has to land before the tempo: the rehearsal tempo is a scale
    // on the score's own tempo map, so the map must be known first.
    this.audioEngine.setPlayRepeats(this.state.playRepeats);
    this.audioEngine.setScoreStructure(this.state.metadata);
    this.audioEngine.setTempo(this.state.tempo);
    for (const part of this.state.parts) {
      this.audioEngine.setPartVolume(part.id, this.state.volumes[part.id] ?? 100);
    }

    // Bar numbers bound the loop fields, so they follow the score that is open.
    const bars = this.getBarList();
    if (bars.length) {
      this.transport.setBarRange(bars[0].number, bars[bars.length - 1].number);
    }
    this.applyLoopRange();

    this.metronome.setTempo(this.state.tempo);
    this.metronome.setPattern(this.state.clickPattern);
    this.metronome.setVolume(this.state.clickVolume);
    const firstMeasure = this.state.parts[0]?.measures?.[0];
    if (firstMeasure?.timeSignature) {
      this.metronome.setTimeSignature(
        firstMeasure.timeSignature.numerator,
        firstMeasure.timeSignature.denominator
      );
    }
    // Real bar starts *with their metre*: accents follow pickup bars and metre
    // changes, and so does the spacing between clicks.
    this.metronome.setMeasureGrid(this.state.parts[0]?.measures || []);
  }

  handleBeatUpdate(beat) {
    // AudioEngine.stop() emits a reset callback synchronously; ignore it while
    // a seek is replacing the transport position.
    if (this.isSeeking) return;
    this.state.currentBeat = beat;
    const followPlayhead = this.state.isPlaying &&
      performance.now() >= this.autoScrollResumesAt;
    this.renderer?.setCurrentBeat(beat, { autoScroll: followPlayhead });
    this.updateTransportPosition({ throttle: true });
  }

  /**
   * A loop pass reached its end marker.
   *
   * With looping on this goes round again from the start of the range. With
   * looping off the range is a stopping point instead, which makes marking a
   * passage useful even when you only want to hear it once.
   */
  handleLoopEnd() {
    if (this.state.loop) {
      this.restartLoopPass();
      return;
    }
    this.audioEngine?.stop();
    this.state.isPlaying = false;
    if (this.state.metronome) this.metronome?.stop();
    this.transport.setPlaying(false);
    this.restartLoopPass();
    this.overlays.announce('Reached the end of the loop');
  }

  handlePlaybackEnd() {
    // Seeking while the session is still marked as playing restarts the
    // transport by itself, so the score must not also be started here.
    if (this.state.loop) {
      const loopStart = this.audioEngine?.getLoopRange();
      if (loopStart) this.restartLoopPass();
      else this.seekToBeat(0, { followScore: true });
      return;
    }

    this.state.isPlaying = false;
    if (this.state.metronome) this.metronome?.stop();
    this.transport.setPlaying(false);
    this.updateTransportPosition();
  }

  async togglePlay() {
    if (!this.state.parts.length || this.isTransportBusy) return;

    // Starting the audio context is asynchronous, so a second press before it
    // resolves must not start a second playback pass.
    this.isTransportBusy = true;
    try {
      await this.startOrPausePlayback();
    } finally {
      this.isTransportBusy = false;
    }
  }

  /**
   * The browser suspended the audio clock while a performance was running.
   *
   * On iOS this is a phone call or another app taking the audio session; on any
   * platform it can be the tab being discarded and restored. The transport would
   * otherwise keep showing a pause button over silence, which reads as the app
   * being broken rather than as the browser having stopped it.
   *
   * @param {string} state
   */
  handleAudioContextState(state) {
    if (state === 'running' || !this.state.isPlaying) return;
    this.state.isPlaying = false;
    this.audioEngine?.pause();
    if (this.state.metronome) this.metronome?.stop();
    this.transport.setPlaying(false);
    this.updateTransportPosition();
    this.overlays.toast('The browser paused the sound. Press play to carry on.');
  }

  async startOrPausePlayback() {
    await this.initAudioEngine();
    this.autoScrollResumesAt = 0;

    if (this.state.isPlaying) {
      this.state.isPlaying = false;
      this.audioEngine.pause();
      if (this.state.metronome) this.metronome.stop();
      this.transport.setPlaying(false);
      this.overlays.announce('Paused');
    } else {
      // A context that did not start has to be reported, not played into. This
      // is the autoplay-policy case: the activation window was spent elsewhere,
      // `resume()` resolved without starting the clock, and every note would be
      // scheduled against a frozen time with the pause button showing.
      if (!this.audioEngine.isRunning()) {
        this.overlays.toast(
          'The browser is holding sound back. Click anywhere on the page, then press play.',
          { type: 'error' }
        );
        this.transport.setPlaying(false);
        return;
      }
      this.state.isPlaying = true;
      if (this.renderer) this.renderer.isAutoScrollEnabled = true;
      this.audioEngine.setTempo(this.state.tempo);
      this.committedTempo = this.state.tempo;
      this.audioEngine.setParts(this.state.parts);
      // A score click can happen before the engine exists, so align the
      // transport with the visible cursor before the first play.
      if (!this.audioEngine.isPaused) this.audioEngine.seek(this.state.currentBeat);
      this.audioEngine.play();
      this.playCountIn();
      if (this.state.metronome) this.startMetronome();
      this.transport.setPlaying(true);
      this.overlays.announce('Playing');
    }
    this.updateTransportPosition();
  }

  /**
   * Click the count-in leading up to the first note.
   *
   * Wanted whether or not the metronome is on: its job is to say when to come
   * in, not to keep time through the piece.
   */
  playCountIn() {
    if (!this.metronome || !this.audioEngine) return;
    const beats = this.audioEngine.getCountInBeats();
    if (beats <= 0) return;

    const startPlaybackBeat = this.audioEngine.getPlaybackBeat(this.state.currentBeat);
    const secondsPerBeat = this.audioEngine.timeline.secondsPerBeatAt(startPlaybackBeat);
    // The metre of the bar being counted into, not of the first bar of the score.
    // `getCountInBeats` already measures the right bar, so taking the numerator
    // and denominator from bar one meant a count-in that was the correct length
    // but clicked at the wrong spacing and accented in the wrong place as soon as
    // the singer started from after a metre change.
    const measure = this.getMeasureAtBeat(this.state.currentBeat);
    const denominator = Number(measure?.timeSignature?.denominator) || 4;
    const clickInterval = secondsPerBeat * (4 / denominator);
    const clicks = clickInterval > 0 ? Math.round(beats / (4 / denominator)) : 0;

    this.metronome.playCountIn({
      startTime: this.audioEngine.getStartTime(),
      clicks,
      interval: clickInterval,
      beatsPerBar: Number(measure?.timeSignature?.numerator) || 4
    });
  }

  /**
   * The bar a score position falls in, with its metre carried forward from the
   * last bar that declared one.
   * @param {number} scoreBeat
   * @returns {object|null}
   */
  getMeasureAtBeat(scoreBeat) {
    const measures = this.state.parts[0]?.measures || [];
    let found = null;
    let timeSignature = null;
    for (const measure of measures) {
      if (measure.timeSignature) timeSignature = measure.timeSignature;
      if (measure.startBeat > scoreBeat + 1e-3) break;
      found = measure;
    }
    if (!found) return null;
    return found.timeSignature ? found : { ...found, timeSignature };
  }

  startMetronome() {
    if (!this.metronome || !this.audioEngine) return;
    this.metronome.stop();
    this.metronome.setTempo(this.state.tempo);
    this.metronome.start({
      startTime: this.audioEngine.getStartTime(),
      currentPlaybackBeat: this.audioEngine.getCurrentPlaybackBeat(),
      currentScoreBeat: this.state.currentBeat,
      nextGridPosition: (after, step, options) =>
        this.audioEngine.timeline.nextGridPosition(after, step, options),
      playbackBeatToSeconds: beat => this.audioEngine.playbackBeatToSeconds(beat)
    });
  }

  async toggleMetronome() {
    if (!this.state.parts.length) return;
    await this.initAudioEngine();

    this.state.metronome = !this.state.metronome;
    this.transport.setMetronome(this.state.metronome);
    if (this.state.metronome && this.state.isPlaying) this.startMetronome();
    else if (!this.state.metronome) this.metronome.stop();
    this.overlays.announce(this.state.metronome ? 'Metronome on' : 'Metronome off');
  }

  toggleLoop() {
    this.state.loop = !this.state.loop;
    this.transport.setLoop(this.state.loop);
    this.overlays.announce(this.state.loop ? 'Loop on' : 'Loop off');
  }

  /** Show a tempo change immediately, before the audio timeline is rebuilt. */
  previewTempo(bpm) {
    this.state.tempo = this.clampTempo(bpm);
  }

  setTempo(bpm) {
    const tempo = this.clampTempo(bpm);
    this.state.tempo = tempo;
    this.transport.setTempo(tempo);
    if (tempo === this.committedTempo) return;

    const restartMetronome = Boolean(
      this.metronome?.isRunning && this.state.isPlaying && this.audioEngine
    );
    if (restartMetronome) this.metronome.stop();
    this.audioEngine?.setTempo(tempo);
    this.metronome?.setTempo(tempo);
    if (restartMetronome) this.startMetronome();
    this.committedTempo = tempo;
    this.updateTransportPosition();
  }

  setSynthMode(mode) {
    this.state.synthMode = mode === 'oscillator' ? 'oscillator' : 'vocal';
    writePref('synth-mode', this.state.synthMode);
    this.audioEngine?.setSynthMode(this.state.synthMode);
  }

  setRoom(value) {
    this.state.room = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    writePref('room', this.state.room);
    this.audioEngine?.setRoomAmount(this.state.room);
  }

  setFermata(value) {
    this.state.fermata = Math.max(1, Math.min(4, Math.round(Number(value) * 10) / 10));
    writePref('fermata', this.state.fermata);
    this.audioEngine?.setFermataMultiplier(this.state.fermata);
    // Holds change the length of the performance, so the loop range and the
    // transport readout both need re-resolving.
    this.applyLoopRange();
    this.updateTransportPosition();
  }

  setMasterVolume(value) {
    this.state.masterVolume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    writePref('master-volume', this.state.masterVolume);
    this.audioEngine?.setMasterVolume(this.state.masterVolume);
  }

  setTuning(value) {
    this.state.tuning = Math.max(415, Math.min(450, Math.round(Number(value) || 440)));
    writePref('tuning', this.state.tuning);
    this.audioEngine?.setTuning(this.state.tuning);
    // The guidance has to judge against the same reference the playback uses.
    this.pitchDetector?.setTuning(this.state.tuning);
    this.applyPitchReference();
    this.rebuildPlaybackForPitchChange();
  }

  setTranspose(value) {
    this.state.transpose = Math.max(-12, Math.min(12, Math.round(Number(value) || 0)));
    writePref('transpose', this.state.transpose);
    this.audioEngine?.setTranspose(this.state.transpose);
    this.applyPitchReference();
    this.rebuildPlaybackForPitchChange();
  }

  /**
   * Tell the score overlay what the playback is sounding at.
   *
   * The microphone hears absolute pitch. Without this the guidance measures a
   * singer following a transposed playback against the printed note and reports
   * the whole rehearsal as out of tune.
   */
  applyPitchReference() {
    this.renderer?.setPitchReference({
      tuningHz: this.state.tuning,
      transposeSemitones: this.state.transpose
    });
  }

  /**
   * Rebuild the sounding schedule after a change to pitch rather than timing.
   *
   * Note frequencies are resolved when the schedule is built, so a change of
   * tuning or transposition needs the schedule again. Restarting from the
   * current position keeps the change audible immediately.
   *
   * Dragging a slider reports every step it passes through, and restarting the
   * transport on each one stutters the playback the singer is listening to
   * while they choose, so the rebuild waits for the gesture to settle.
   */
  rebuildPlaybackForPitchChange() {
    if (!this.audioEngine || !this.state.isPlaying) return;
    clearTimeout(this.pitchRebuildTimer);
    this.pitchRebuildTimer = setTimeout(() => {
      this.pitchRebuildTimer = null;
      if (!this.audioEngine || !this.state.isPlaying) return;
      this.suspendTransport(true);
      this.audioEngine.seek(this.state.currentBeat);
      this.resumeTransport(true);
    }, PITCH_REBUILD_DELAY_MS);
  }

  setFollowDynamics(enabled) {
    this.state.followDynamics = Boolean(enabled);
    writeBoolPref('follow-dynamics', this.state.followDynamics);
    this.audioEngine?.setFollowDynamics(this.state.followDynamics);
    this.rebuildPlaybackForPitchChange();
    this.overlays.announce(
      this.state.followDynamics ? 'Following the written dynamics' : 'Playing at one steady level'
    );
  }

  setPlayRepeats(enabled) {
    this.state.playRepeats = Boolean(enabled);
    writeBoolPref('play-repeats', this.state.playRepeats);
    if (!this.audioEngine) return;

    const wasPlaying = this.state.isPlaying;
    this.suspendTransport(wasPlaying);
    this.audioEngine.setPlayRepeats(this.state.playRepeats);
    // The performance just changed length, so anything measured against it has
    // to be resolved again.
    this.applyLoopRange();
    this.audioEngine.seek(this.state.currentBeat);
    this.resumeTransport(wasPlaying);
    this.updateTransportPosition();
    this.overlays.announce(
      this.state.playRepeats ? 'Playing the repeats' : 'Reading straight through'
    );
  }

  setClickPattern(pattern) {
    this.state.clickPattern = isClickPattern(pattern)
      ? pattern
      : SETTINGS_DEFAULTS.clickPattern;
    writePref('click-pattern', this.state.clickPattern);
    this.metronome?.setPattern(this.state.clickPattern);
    if (this.state.metronome && this.state.isPlaying) this.startMetronome();
  }

  setClickVolume(value) {
    this.state.clickVolume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    writePref('click-volume', this.state.clickVolume);
    this.metronome?.setVolume(this.state.clickVolume);
  }

  setCountInBars(value) {
    this.state.countInBars = Math.max(0, Math.min(4, Math.round(Number(value) || 0)));
    writePref('count-in', this.state.countInBars);
    this.audioEngine?.setCountInBars(this.state.countInBars);
  }

  setShowLyrics(visible) {
    this.state.showLyrics = Boolean(visible);
    writeBoolPref('show-lyrics', this.state.showLyrics);
    this.renderer?.setLyricsVisible(this.state.showLyrics);
    this.overlays.announce(this.state.showLyrics ? 'Words shown' : 'Words hidden');
  }

  setShowTimeSignatures(visible) {
    this.state.showTimeSignatures = Boolean(visible);
    writeBoolPref('show-time-signatures', this.state.showTimeSignatures);
    this.renderer?.setTimeSignaturesVisible(this.state.showTimeSignatures);
  }

  setVerse(verse) {
    this.state.verse = Math.max(1, Math.round(Number(verse) || 1));
    writePref('verse', this.state.verse);
    this.renderer?.setVerse(this.state.verse);
    // The sung vowels follow the verse on the page.
    this.audioEngine?.setVerse(this.state.verse);
    this.rebuildPlaybackForPitchChange();
    this.overlays.announce(`Showing verse ${this.state.verse}`);
  }

  /** The current value of every setting, for showing in the dialog. */
  collectSettings() {
    return {
      synthMode: this.state.synthMode,
      masterVolume: this.state.masterVolume,
      room: this.state.room,
      tuning: this.state.tuning,
      transpose: this.state.transpose,
      fermata: this.state.fermata,
      followDynamics: this.state.followDynamics,
      playRepeats: this.state.playRepeats,
      clickPattern: this.state.clickPattern,
      clickVolume: this.state.clickVolume,
      countInBars: this.state.countInBars,
      showLyrics: this.state.showLyrics,
      showTimeSignatures: this.state.showTimeSignatures,
      verse: this.state.verse
    };
  }

  /** Put every setting back to its shipped value. */
  restoreDefaultSettings() {
    this.setSynthMode(SETTINGS_DEFAULTS.synthMode);
    this.setMasterVolume(SETTINGS_DEFAULTS.masterVolume);
    this.setRoom(SETTINGS_DEFAULTS.room);
    this.setTuning(SETTINGS_DEFAULTS.tuning);
    this.setTranspose(SETTINGS_DEFAULTS.transpose);
    this.setFermata(SETTINGS_DEFAULTS.fermata);
    this.setFollowDynamics(SETTINGS_DEFAULTS.followDynamics);
    this.setPlayRepeats(SETTINGS_DEFAULTS.playRepeats);
    this.setClickPattern(SETTINGS_DEFAULTS.clickPattern);
    this.setClickVolume(SETTINGS_DEFAULTS.clickVolume);
    this.setCountInBars(SETTINGS_DEFAULTS.countInBars);
    this.setShowLyrics(SETTINGS_DEFAULTS.showLyrics);
    this.setShowTimeSignatures(SETTINGS_DEFAULTS.showTimeSignatures);
    this.setVerse(SETTINGS_DEFAULTS.verse);
    this.settings.setAll(this.collectSettings());
    this.overlays.announce('Settings restored to their defaults');
  }

  /* =====================================================================
     Rehearsal loop
     ===================================================================== */

  /**
   * Set the loop range from bar numbers.
   *
   * Bars are what a singer asks for, so they are the unit here even though the
   * engine works in performance positions. Either end may be left blank, which
   * means "leave that end where it is".
   *
   * @param {number|null} fromBar
   * @param {number|null} toBar
   */
  setLoopBars(fromBar, toBar, { syncFields = true } = {}) {
    const bars = this.getBarList();
    if (!bars.length) return;

    const resolve = (requested, fallback) => {
      if (requested === null || requested === undefined) return fallback;
      const match = bars.find(bar => bar.number === requested);
      return match ? match : fallback;
    };

    const existing = this.state.loopRange;
    const start = resolve(fromBar, existing ? existing.fromBarEntry : bars[0]);
    const end = resolve(toBar, existing ? existing.toBarEntry : bars[bars.length - 1]);
    if (!start || !end) return;

    const ordered = start.startBeat <= end.startBeat ? [start, end] : [end, start];
    this.state.loopRange = {
      fromBar: ordered[0].number,
      toBar: ordered[1].number,
      fromBarEntry: ordered[0],
      toBarEntry: ordered[1]
    };
    this.applyLoopRange({ syncFields });
    this.overlays.announce(
      `Looping bars ${this.state.loopRange.fromBar} to ${this.state.loopRange.toBar}`
    );
  }

  /**
   * Set one end of the loop from where the cursor is.
   * @param {'start'|'end'} edge
   */
  markLoopEdge(edge) {
    const context = this.renderer?.getMeasureContext(this.state.currentBeat);
    if (!context) return;
    if (edge === 'start') this.setLoopBars(context.number, null);
    else this.setLoopBars(null, context.number);
  }

  clearLoopRange() {
    this.state.loopRange = null;
    this.applyLoopRange();
    this.overlays.announce('Looping the whole score');
  }

  /**
   * Push the loop range down to the engine, converting bars to performance
   * positions. Re-run whenever the shape of the performance changes.
   */
  applyLoopRange({ syncFields = true } = {}) {
    if (!this.audioEngine) return;
    const range = this.state.loopRange;

    if (!range) {
      this.audioEngine.clearLoopRange();
      this.transport.setLoopRange(null);
      if (syncFields) this.transport.setLoopFields(null);
      return;
    }

    const startBeat = range.fromBarEntry.startBeat;
    const endBeat = range.toBarEntry.startBeat + range.toBarEntry.beats;
    const startPlayback = this.audioEngine.getPlaybackBeat(startBeat);
    const endPlayback = this.audioEngine.getPlaybackBeat(endBeat, { after: startPlayback });

    this.audioEngine.setLoopRange(startPlayback, endPlayback);
    const shown = this.audioEngine.getLoopRange()
      ? { fromBar: range.fromBar, toBar: range.toBar }
      : null;
    this.transport.setLoopRange(shown);
    if (syncFields) this.transport.setLoopFields(shown);
  }

  /** Every bar in the score, with its position and length. */
  getBarList() {
    const measures = this.state.metadata?.measureStructure;
    if (Array.isArray(measures) && measures.length) {
      return measures.map(measure => ({
        number: Number(measure.number),
        startBeat: Number(measure.startBeat) || 0,
        beats: Number(measure.beats) || 0
      }));
    }
    // A score loaded without structure metadata still has measures on its parts.
    const fallback = this.state.parts[0]?.measures || [];
    return fallback.map((measure, index) => ({
      number: Number(measure.number ?? index + 1),
      startBeat: Number(measure.startBeat) || 0,
      beats: Number(measure.beats) || 0
    }));
  }

  /** Restart the current loop pass from its beginning. */
  restartLoopPass() {
    if (!this.audioEngine) return;
    this.seekToPlaybackBeat(this.audioEngine.getLoopStartPlaybackBeat(), { followScore: true });
  }

  /* =====================================================================
     Position
     ===================================================================== */

  /**
   * Move the transport to a fraction of the performance.
   *
   * The seek bar measures the performance rather than the page, because with
   * repeats the page position moves backwards partway through and a bar that
   * scrubbed backwards would be unusable.
   *
   * @param {number} percent
   * @param {object} [options]
   */
  seekToPercent(percent, options = {}) {
    const totalPlaybackBeats = this.audioEngine?.getTotalPlaybackBeats() ?? 0;
    if (totalPlaybackBeats <= 0) return;
    this.seekToPlaybackBeat((percent / 100) * totalPlaybackBeats, options);
  }

  /**
   * Move the transport to a position in the performance.
   * @param {number} playbackBeat
   * @param {object} [options]
   */
  seekToPlaybackBeat(playbackBeat, options = {}) {
    if (!this.audioEngine) return;
    const wasPlaying = this.state.isPlaying;
    this.suspendTransport(wasPlaying);

    const targetBeat = this.audioEngine.seekToPlaybackBeat(playbackBeat);
    this.state.currentBeat = targetBeat;
    this.applySeekToView(targetBeat, options);
    this.resumeTransport(wasPlaying);
    this.updateTransportPosition();
  }

  /**
   * Move playback to a score beat.
   * @param {number} beat
   * @param {{ followScore?: boolean, moveSheet?: boolean }} options
   */
  seekToBeat(beat, options = {}) {
    const engineTotal = this.audioEngine?.getTotalBeats() ?? 0;
    const layoutTotal = this.renderer?.horizontalLayout?.totalBeats ?? 0;
    const maxBeat = engineTotal > 0 ? engineTotal : layoutTotal;
    const requested = Number(beat);
    const clamped = Number.isFinite(requested)
      ? Math.max(0, Math.min(maxBeat, requested))
      : 0;
    const wasPlaying = this.state.isPlaying;
    // With repeats one score position occurs several times. Prefer the pass at
    // or after where the transport already is, so seeking a bar ahead does not
    // jump back to the first time through.
    const after = this.audioEngine?.pausePlaybackBeat ?? -Infinity;

    this.suspendTransport(wasPlaying);

    const targetBeat = engineTotal > 0
      ? this.audioEngine.seek(clamped, { after })
      : clamped;
    this.state.currentBeat = targetBeat;

    this.applySeekToView(targetBeat, options);
    this.resumeTransport(wasPlaying);
    this.updateTransportPosition();
  }

  /**
   * Stop the transport before moving it.
   *
   * The reset callback is suppressed so the visible cursor never flashes back
   * to the start of the score on the way to its new position.
   * @param {boolean} wasPlaying
   */
  suspendTransport(wasPlaying) {
    if (!wasPlaying || !this.audioEngine) return;
    this.isSeeking = true;
    this.audioEngine.stop();
    this.isSeeking = false;
    if (this.state.metronome) this.metronome.stop();
  }

  /** Restart the transport at the position it was just moved to. */
  resumeTransport(wasPlaying) {
    if (!wasPlaying || !this.audioEngine) return;
    this.audioEngine.play();
    if (this.state.metronome) this.startMetronome();
  }

  /** Move the score view to follow a new transport position. */
  applySeekToView(targetBeat, options = {}) {
    if (!this.renderer) return;
    this.renderer.clearUserPitchTrail();
    this.renderer.setCurrentBeat(targetBeat, { autoScroll: options.followScore === true });
    if (options.moveSheet) this.renderer.ensureBeatVisible(targetBeat);
  }

  /** Shared measure starts in score order. */
  getMeasureStartBeats() {
    const starts = new Set();
    for (const part of this.state.parts) {
      for (const measure of part.measures || []) {
        const start = Number(measure.startBeat);
        if (Number.isFinite(start)) starts.add(Math.max(0, start));
      }
    }
    return [...starts].sort((left, right) => left - right);
  }

  seekToPreviousBar() {
    const starts = this.getMeasureStartBeats();
    if (!starts.length) return;

    const current = Math.max(0, Number(this.state.currentBeat) || 0);
    const epsilon = 1e-6;
    let index = -1;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= current + epsilon) index = i;
      else break;
    }

    const target = starts[Math.max(0, index - 1)];
    if (Math.abs(target - current) <= epsilon) return;
    this.seekToBeat(target, { moveSheet: true });
    this.announceBar();
  }

  seekToNextBar() {
    const starts = this.getMeasureStartBeats();
    if (!starts.length) return;
    const next = starts.find(start => start > (Number(this.state.currentBeat) || 0) + 1e-6);
    if (next === undefined) return;
    this.seekToBeat(next, { moveSheet: true });
    this.announceBar();
  }

  getBarLabel() {
    const context = this.renderer?.getMeasureContext(this.state.currentBeat);
    return context ? `bar ${context.number}` : '';
  }

  announceBar() {
    const label = this.getBarLabel();
    if (!label) return;
    const spoken = label.charAt(0).toUpperCase() + label.slice(1);
    const note = this.describeNoteUnderCursor();
    this.overlays.announce(note ? `${spoken}, ${note}` : spoken);
  }

  /**
   * What the singer's own part has at the cursor, in words.
   *
   * The score is a canvas, so a screen reader gets nothing from it beyond the
   * label. Stepping through the bars used to announce "Bar 3" and stop there,
   * which tells somebody where they are and nothing about what is written. The
   * note is read from the score's own spelling, so an F sharp is announced as an
   * F sharp rather than as a G flat.
   *
   * @returns {string}
   */
  describeNoteUnderCursor() {
    if (!this.renderer) return '';
    const part = this.state.parts.find(candidate => candidate.id === this.state.myPartId);
    if (!part) return '';
    const target = this.renderer.findTargetNote(part, this.state.currentBeat, null);
    const pitch = target?.note?.pitch;
    if (!pitch) return 'rest';
    const spoken = describePitch(pitch.step, pitch.alter, pitch.octave);
    if (!spoken) return '';
    const syllable = lyricForVerse(target.note, this.state.verse)?.text;
    return syllable ? `${spoken}, "${String(syllable).trim()}"` : spoken;
  }

  updateTransportPosition({ throttle = false } = {}) {
    if (!this.audioEngine) return;
    const now = performance.now();
    if (throttle && now - this.lastTransportUiAt < TRANSPORT_UI_INTERVAL_MS) return;
    this.lastTransportUiAt = now;

    const totalPlaybackBeats = this.audioEngine.getTotalPlaybackBeats();
    if (totalPlaybackBeats <= 0) return;

    // Everything here measures the performance, not the page: with repeats a
    // page position occurs more than once, so only the performance position
    // moves forward monotonically the way a progress bar has to.
    const playbackBeat = this.state.isPlaying
      ? this.audioEngine.getCurrentPlaybackBeat()
      : this.audioEngine.pausePlaybackBeat;

    this.transport.setPosition({
      percent: (playbackBeat / totalPlaybackBeats) * 100,
      currentSeconds: this.audioEngine.playbackBeatToSeconds(playbackBeat),
      totalSeconds: this.audioEngine.getTotalSeconds(),
      barLabel: this.getBarLabel()
    });
  }

  /* =====================================================================
     Microphone pitch guidance
     ===================================================================== */

  async toggleMicrophone() {
    if (this.state.micState === 'on' || this.state.micState === 'connecting') {
      this.stopMicrophone();
      this.overlays.announce('Microphone off');
      return;
    }

    const proceed = await this.overlays.confirmMicrophone();
    if (proceed) this.startMicrophone();
  }

  async startMicrophone() {
    const generation = ++this.micGeneration;
    const detector = new PitchDetector();
    // The reference has to be in force before the first frame is analysed, not
    // only after the tuning is next changed.
    detector.setTuning(this.state.tuning);
    this.pitchDetector = detector;
    this.setMicState('connecting');

    detector.onPitchDetected = pitchData => {
      if (generation === this.micGeneration) this.handlePitchDetected(pitchData);
    };

    const started = await detector.start();
    if (generation !== this.micGeneration || this.pitchDetector !== detector) {
      detector.stop();
      return;
    }

    if (started) {
      this.setMicState('on');
      this.updatePitchGuide(null);
      if (this.pitchPill) this.pitchPill.hidden = false;
      this.overlays.announce('Microphone on. Pitch guidance is listening.');
    } else {
      // The detector says why. Repeating one message for every failure sent
      // people with no microphone to a permissions screen that could not help.
      const reason = detector.failureReason ||
        'The microphone could not be started. Try turning the guidance on again.';
      this.pitchDetector = null;
      this.setMicState('error');
      this.overlays.toast(reason, { type: 'error' });
      this.overlays.announce(reason);
    }
  }

  stopMicrophone() {
    this.micGeneration++;
    if (this.pitchDetector) {
      this.pitchDetector.stop();
      this.pitchDetector = null;
    }
    this.setMicState('off');
    if (this.pitchPill) this.pitchPill.hidden = true;
    clearTimeout(this.pitchAnnounceTimer);
    this.pitchAnnounceTimer = null;
    this.pitchGuidePosition = 0;
    this.renderer?.setUserPitch(null);
  }

  setMicState(state) {
    this.state.micState = state;
    this.transport.setMic(state);
  }

  handlePitchDetected(pitchData) {
    let samplePosition = this.state.currentBeat;
    if (pitchData && this.audioEngine) {
      samplePosition = this.audioEngine.getScorePositionSecondsAgo(pitchData.latencySeconds);
    }
    const sample = this.renderer
      ? this.renderer.setUserPitch(pitchData, samplePosition)
      : null;
    this.updatePitchGuide(pitchData ? sample : null);
  }

  /**
   * Present pitch as one calm gesture instead of rapidly changing numbers.
   * The orb sits left when the voice is flat and right when it is sharp; the
   * label says which way to correct.
   * @param {object|null} sample
   */
  updatePitchGuide(sample) {
    let state = 'listening';
    let label = 'Listening';
    let target = 0;

    if (sample?.hasTarget && Number.isFinite(sample.centsFromTarget)) {
      state = sample.accuracy;
      target = Math.max(-1, Math.min(1, sample.centsFromTarget / 100));
      label = state === 'correct'
        ? 'On pitch'
        : sample.centsFromTarget < 0 ? 'Sing higher' : 'Sing lower';
    }

    // A light low-pass keeps vibrato alive without making the orb look nervous.
    this.pitchGuidePosition = state === 'listening'
      ? 0
      : this.pitchGuidePosition + (target - this.pitchGuidePosition) * 0.34;

    const labelChanged = this.pitchLabel?.textContent !== label;
    if (this.pitchPill) {
      this.pitchPill.dataset.state = state;
      this.pitchPill.style.setProperty(
        '--pitch-shift',
        `${(this.pitchGuidePosition * 34).toFixed(1)}px`
      );
    }
    if (this.pitchLabel && labelChanged) this.pitchLabel.textContent = label;

    // Announce a guidance change only once it has settled, so screen reader
    // users are not read every analysis frame.
    if (labelChanged && this.state.micState === 'on') {
      clearTimeout(this.pitchAnnounceTimer);
      this.pitchAnnounceTimer = setTimeout(() => {
        if (this.pitchLabel?.textContent === label) this.overlays.announce(label);
      }, 450);
    }
  }

  /* =====================================================================
     Exports
     ===================================================================== */

  bindExports() {
    this.exportXmlButton?.addEventListener('click', () => {
      this.overlays.closeMenus();
      try {
        exportMusicXMLFile({
          rawXml: this.state.rawXml,
          parts: this.state.parts,
          tempo: this.state.tempo,
          fileName: this.state.fileName
        });
        this.overlays.toast('MusicXML exported with your tempo and part names.');
      } catch (error) {
        this.overlays.toast(error.message || 'The score could not be exported.', { type: 'error' });
      }
    });

    this.exportWavButton?.addEventListener('click', () => this.exportAudio());
  }

  async exportAudio() {
    if (!this.state.parts.length) return;
    const button = this.exportWavButton;
    const label = button?.querySelector('.menu-item-label');
    const originalLabel = label?.textContent;

    this.overlays.closeMenus();
    if (button) button.disabled = true;
    this.overlays.announce('Rendering audio export');

    try {
      await this.initAudioEngine({ resume: false });
      this.audioEngine.setTempo(this.state.tempo);
      this.audioEngine.setSynthMode(this.state.synthMode);
      this.audioEngine.setRoomAmount(this.state.room);
      this.audioEngine.setMasterVolume(this.state.masterVolume);
      this.audioEngine.setTuning(this.state.tuning);
      this.audioEngine.setTranspose(this.state.transpose);
      this.audioEngine.setFollowDynamics(this.state.followDynamics);
      this.audioEngine.setFermataMultiplier(this.state.fermata);
      this.audioEngine.setParts(this.state.parts);
      this.audioEngine.setPlayRepeats(this.state.playRepeats);
      this.audioEngine.setScoreStructure(this.state.metadata);
      this.audioEngine.setTempo(this.state.tempo);
      for (const part of this.state.parts) {
        this.audioEngine.setPartVolume(part.id, this.state.volumes[part.id] ?? 100);
        this.audioEngine.setPartMuted(part.id, this.state.muted.has(part.id));
        this.audioEngine.setPartSoloed(part.id, this.state.soloed.has(part.id));
      }

      await exportWavFile(this.audioEngine, {
        fileName: this.state.fileName,
        onProgress: ratio => {
          if (!label) return;
          const percent = Math.round(ratio * 100);
          label.textContent = percent < 100 ? `Rendering ${percent}%` : 'Encoding…';
        }
      });
      this.overlays.toast('Audio exported as a WAV file.');
    } catch (error) {
      this.overlays.toast(
        `Audio export failed: ${error.message || 'unknown error'}`,
        { type: 'error' }
      );
    } finally {
      if (button) button.disabled = false;
      if (label && originalLabel) label.textContent = originalLabel;
    }
  }

  /* =====================================================================
     Keyboard
     ===================================================================== */

  bindKeyboard() {
    document.addEventListener('keydown', event => this.handleKeydown(event));
  }

  /** True while any modal surface owns the keyboard. */
  isModalOpen() {
    try {
      if (document.querySelector('dialog:modal')) return true;
    } catch (error) {
      // :modal is unsupported; fall back to what the modules know.
    }
    // The parts panel is deliberately not in this list. It is a non-modal panel
    // that sits beside or under the score, and the whole point of it is that you
    // can hold it open and still press space.
    return this.overlays.isDialogOpen() || this.settings.isOpen();
  }

  handleKeydown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    const tag = target?.tagName;
    const isSlider = tag === 'INPUT' && target.type === 'range';
    // Form controls keep their own keys, including slider arrows. A slider does
    // nothing with space, so play/pause still works from there.
    if (tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
    if (tag === 'INPUT' && !(isSlider && event.code === 'Space')) return;

    if (event.key === '?') {
      if (this.isModalOpen() && !this.overlays.isHelpOpen()) return;
      event.preventDefault();
      this.overlays.toggleHelp();
      return;
    }

    if (this.isModalOpen() || !this.state.parts.length) return;

    switch (event.code) {
      case 'Space':
        // Let a focused button handle its own activation.
        if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return;
        event.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.seekToPreviousBar();
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.seekToNextBar();
        break;
      case 'Home':
        event.preventDefault();
        this.seekToBeat(0, { followScore: true });
        this.overlays.announce('Back to the start');
        break;
      case 'KeyM':
        event.preventDefault();
        this.toggleMetronome();
        break;
      case 'KeyR':
        event.preventDefault();
        this.toggleLoop();
        break;
      case 'BracketLeft':
        event.preventDefault();
        this.markLoopEdge('start');
        break;
      case 'BracketRight':
        event.preventDefault();
        this.markLoopEdge('end');
        break;
      case 'Backslash':
        event.preventDefault();
        this.clearLoopRange();
        break;
      case 'Comma':
        event.preventDefault();
        if (!this.settings.isOpen()) this.settings.setAll(this.collectSettings());
        this.settings.toggle();
        break;
      default:
        break;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.choirPracticeApp = new ChoirPracticeApp();
});

export { ChoirPracticeApp };
