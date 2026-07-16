/**
 * Web Audio API Playback Engine
 * Synthesizes notes for each part using oscillators with per-part volume control.
 * Uses lookahead scheduling for sample-accurate timing.
 */

import { noteToFrequency, pitchToFrequency, pitchToMidi } from './utils.js';

/**
 * Calculate the duration of a beat in seconds at a given tempo.
 * @param {number} bpm - beats per minute
 * @returns {number} seconds per beat
 */
export function beatDuration(bpm) {
  if (bpm <= 0) return 0;
  return 60 / bpm;
}

/**
 * Calculate the time offset for a note given its beat position and tempo.
 * @param {number} beatPosition - beat offset from start
 * @param {number} bpm - tempo in BPM
 * @returns {number} time in seconds
 */
export function beatToTime(beatPosition, bpm) {
  return beatPosition * beatDuration(bpm);
}

/** Default interpretation for an otherwise duration-less fermata mark. */
export const FERMATA_DURATION_MULTIPLIER = 2;

/**
 * Collect score-wide fermata holds. A fermata belongs to the whole ensemble,
 * so simultaneous marks collapse into one hold at the shared note/rest end.
 * @param {Array} parts
 * @param {number} multiplier
 * @returns {Array<{scoreBeat: number, extraBeats: number}>}
 */
export function collectFermataHolds(parts, multiplier = FERMATA_DURATION_MULTIPLIER) {
  const byBeat = new Map();
  const extension = Math.max(0, multiplier - 1);
  const addHold = (scoreBeat, extraBeats) => {
    const key = scoreBeat.toFixed(6);
    const existing = byBeat.get(key);
    if (!existing || extraBeats > existing.extraBeats) {
      byBeat.set(key, { scoreBeat, extraBeats });
    }
  };

  for (const part of parts || []) {
    for (const measure of part.measures || []) {
      const measureStart = Number(measure.startBeat) || 0;
      for (const note of measure.notes || []) {
        if (!note.fermata || !(note.durationBeats > 0)) continue;
        const scoreBeat = measureStart + (Number(note.startBeatInMeasure) || 0) + note.durationBeats;
        addHold(scoreBeat, note.durationBeats * extension);
      }

      // A barline fermata has no note duration. Hold it for one denominator
      // beat (one quarter in 4/4, one eighth in 6/8) by default.
      const denominator = Number(measure.timeSignature?.denominator) || 4;
      const boundaryHold = (4 / denominator) * extension;
      for (const fermata of measure.barlineFermatas || []) {
        const scoreBeat = fermata.location === 'left'
          ? measureStart
          : measureStart + (Number(measure.beats) || 0);
        addHold(scoreBeat, boundaryHold);
      }
    }
  }
  return Array.from(byBeat.values()).sort((a, b) => a.scoreBeat - b.scoreBeat);
}

/** Map a notated score beat to its position on the fermata-expanded timeline. */
export function scoreBeatToPlaybackBeat(scoreBeat, holds = []) {
  let playbackBeat = Math.max(0, Number(scoreBeat) || 0);
  for (const hold of holds) {
    if (hold.scoreBeat <= scoreBeat + 1e-6) playbackBeat += hold.extraBeats;
    else break;
  }
  return playbackBeat;
}

/** Map a fermata-expanded playback beat back to the score cursor position. */
export function playbackBeatToScoreBeat(playbackBeat, holds = []) {
  const target = Math.max(0, Number(playbackBeat) || 0);
  let accumulatedHold = 0;
  for (const hold of holds) {
    const holdStart = hold.scoreBeat + accumulatedHold;
    const holdEnd = holdStart + hold.extraBeats;
    if (target < holdStart) return target - accumulatedHold;
    if (target <= holdEnd) return hold.scoreBeat;
    accumulatedHold += hold.extraBeats;
  }
  return target - accumulatedHold;
}

/**
 * AudioEngine class - manages Web Audio API playback.
 */
export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.partGains = new Map(); // partId -> GainNode
    this.partVolumeLevels = new Map(); // partId -> intended volume (0-1)
    this.partMuted = new Map(); // partId -> boolean
    this.partSoloed = new Map(); // partId -> boolean
    this.parts = [];
    this.tempo = 120;
    this.isPlaying = false;
    this.isPaused = false;
    this.startTime = 0;
    this.pauseTime = 0;
    this.pausePlaybackBeat = 0;
    this.currentBeat = 0;
    this.scheduledNodes = [];
    this.lookaheadTime = 0.1; // seconds to look ahead
    this.scheduleInterval = 25; // ms between scheduling checks
    this.startLead = 0.08; // seconds of lead time before the first note plays
    this.schedulerTimer = null;
    this.nextScheduledBeat = 0; // next beat index to schedule in lookahead
    this.onBeatUpdate = null; // callback(currentBeat)
    this.animationFrame = null;
    this.schedule = []; // cached note schedule
    this.scheduleIndex = 0; // current position in schedule for lookahead
    this.fermataHolds = []; // score-wide pauses on the expanded playback timeline
  }

  /**
   * Initialize the AudioContext (must be called after user interaction).
   */
  async init() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.7;
      this.masterGain.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  /**
   * Set the parts data and create gain nodes for each part.
   * @param {Array} parts - parsed parts from MusicXML parser
   */
  setParts(parts) {
    this.parts = parts;
    this.fermataHolds = collectFermataHolds(parts);
    // Create gain nodes for each part
    for (const part of parts) {
      if (!this.partGains.has(part.id)) {
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = 0.8;
        gainNode.connect(this.masterGain);
        this.partGains.set(part.id, gainNode);
        this.partVolumeLevels.set(part.id, 0.8);
        this.partMuted.set(part.id, false);
        this.partSoloed.set(part.id, false);
      }
    }
  }

  /**
   * Set volume for a specific part.
   * @param {string} partId
   * @param {number} volume - 0 to 100
   */
  setPartVolume(partId, volume) {
    const gainNode = this.partGains.get(partId);
    if (gainNode) {
      const normalizedVolume = Math.max(0, Math.min(1, volume / 100));
      this.partVolumeLevels.set(partId, normalizedVolume);
      // Only apply if the part is currently audible
      const isMuted = this.partMuted.get(partId);
      const anySoloed = Array.from(this.partSoloed.values()).some(v => v);
      const isSoloed = this.partSoloed.get(partId);
      const isAudible = !isMuted && (!anySoloed || isSoloed);
      if (isAudible) {
        gainNode.gain.setValueAtTime(normalizedVolume, this.audioContext.currentTime);
      }
    }
  }

  /**
   * Mute/unmute a specific part.
   * @param {string} partId
   * @param {boolean} muted
   */
  setPartMuted(partId, muted) {
    this.partMuted.set(partId, muted);
    this.updatePartAudibility();
  }

  /**
   * Solo/unsolo a specific part.
   * @param {string} partId
   * @param {boolean} soloed
   */
  setPartSoloed(partId, soloed) {
    this.partSoloed.set(partId, soloed);
    this.updatePartAudibility();
  }

  /**
   * Update audibility of all parts based on mute/solo state.
   */
  updatePartAudibility() {
    const anySoloed = Array.from(this.partSoloed.values()).some(v => v);

    for (const [partId, gainNode] of this.partGains) {
      const isMuted = this.partMuted.get(partId);
      const isSoloed = this.partSoloed.get(partId);

      if (isMuted) {
        gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      } else if (anySoloed && !isSoloed) {
        gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      } else {
        // Restore to intended volume stored in partVolumeLevels
        const intendedVolume = this.partVolumeLevels.get(partId) || 0.8;
        gainNode.gain.setValueAtTime(intendedVolume, this.audioContext.currentTime);
      }
    }
  }

  /**
   * Set the playback tempo.
   * If playing, adjusts the start time reference so the current beat position
   * is maintained and future notes are scheduled at the new tempo.
   * @param {number} bpm
   */
  setTempo(bpm) {
    const newTempo = Math.max(40, Math.min(240, bpm));
    if (this.isPlaying && this.audioContext) {
      // Keep the same position on the expanded playback timeline. During a
      // fermata the score cursor is stationary, so score beat alone is not
      // enough to reconstruct the elapsed time.
      const elapsed = this.audioContext.currentTime - this.startTime;
      const currentPlaybackBeat = elapsed / beatDuration(this.tempo);
      this.currentBeat = playbackBeatToScoreBeat(currentPlaybackBeat, this.fermataHolds);
      this.startTime = this.audioContext.currentTime - beatToTime(currentPlaybackBeat, newTempo);

      // Stop ALL currently scheduled nodes. We'll re-schedule everything from
      // the current position to avoid doubled oscillators that cause volume spikes.
      const now = this.audioContext.currentTime;
      for (const node of this.scheduledNodes) {
        try {
          node.noteGain.gain.cancelScheduledValues(now);
          node.noteGain.gain.setValueAtTime(0, now);
          node.oscillator.stop(now + 0.01);
        } catch (e) { /* already stopped */ }
      }
      this.scheduledNodes = [];

      // Find the first event that is still sounding or hasn't started yet.
      // This includes notes whose start is before now but whose end extends
      // past now (they need to be resumed by scheduleAhead's resume logic).
      this.scheduleIndex = this.schedule.length;
      for (let i = 0; i < this.schedule.length; i++) {
        const event = this.schedule[i];
        const eventBeat = event.playbackStartBeat ?? event.startBeat;
        const eventDuration = event.playbackDurationBeats ?? event.durationBeats;
        const eventEndBeat = eventBeat + eventDuration;
        if (eventEndBeat > currentPlaybackBeat) {
          this.scheduleIndex = i;
          break;
        }
      }

      this.tempo = newTempo;
      this.scheduleAhead();
    } else {
      this.tempo = newTempo;
    }
  }

  /**
   * Build a schedule of all notes with their start times and durations.
   * @returns {Array} array of { partId, frequency, startBeat, durationBeats }
   */
  buildSchedule() {
    const schedule = [];
    this.fermataHolds = collectFermataHolds(this.parts);

    for (const part of this.parts) {
      const activeSlurs = new Set();
      for (const measure of part.measures) {
        const measureStart = measure.startBeat || 0;
        for (const note of measure.notes) {
          const slurs = note.slurs || [];
          const starts = slurs.filter(slur => slur.type === 'start' || slur.type === 'continue');
          const stops = slurs.filter(slur => slur.type === 'stop' || slur.type === 'continue');
          for (const slur of starts) activeSlurs.add(Number(slur.number) || 1);
          const noteSlurIds = new Set(activeSlurs);
          for (const slur of stops) noteSlurIds.add(Number(slur.number) || 1);
          const slursAfter = new Set(activeSlurs);
          for (const slur of slurs.filter(item => item.type === 'stop')) {
            slursAfter.delete(Number(slur.number) || 1);
          }
          const legato = noteSlurIds.size > 0;

          // Rests and pitchless notes make no sound. Chord notes ARE played -
          // they share an onset with the preceding note (same startBeatInMeasure).
          if (!note.isRest && note.pitch && note.durationBeats > 0) {
            // Compute the frequency directly from step + alter + octave. This is
            // robust to accidentals like E#, B# and double sharps/flats.
            let frequency;
            let midi;
            try {
              const p = note.pitch;
              if (p.step !== undefined) {
                midi = pitchToMidi(p.step, p.alter || 0, p.octave);
                frequency = pitchToFrequency(p.step, p.alter || 0, p.octave);
              } else {
                frequency = noteToFrequency(p.noteName, p.octave);
              }
            } catch (err) {
              console.warn('Skipping note with unresolved pitch:', note.pitch, err.message);
              frequency = null;
            }
            if (frequency && frequency > 0) {
              schedule.push({
                partId: part.id,
                frequency,
                midi: midi != null ? midi : Math.round(frequency),
                startBeat: measureStart + (note.startBeatInMeasure || 0),
                durationBeats: note.durationBeats,
                tieStart: !!(note.tie && note.tie.start),
                tieStop: !!(note.tie && note.tie.stop),
                legato,
                legatoStart: starts.length > 0,
                legatoStop: stops.length > 0,
                slurIds: Array.from(noteSlurIds),
                slursAfter: Array.from(slursAfter),
                fermata: note.fermata || null
              });
            }
          }

          // A continue marker closes one drawn segment and opens the next, so
          // it remains active. A true stop removes only that phrase identity.
          activeSlurs.clear();
          for (const slurNumber of slursAfter) activeSlurs.add(slurNumber);
        }
      }
    }

    const merged = this.mergeTiedNotes(schedule);
    for (const event of merged) {
      const playbackStart = scoreBeatToPlaybackBeat(event.startBeat, this.fermataHolds);
      const playbackEnd = scoreBeatToPlaybackBeat(
        event.startBeat + event.durationBeats,
        this.fermataHolds
      );
      event.playbackStartBeat = playbackStart;
      event.playbackDurationBeats = Math.max(0, playbackEnd - playbackStart);
    }

    // Mark contiguous notes within a slur. The scheduler uses this to overlap
    // their envelopes slightly, avoiding a separate attack/gap on every note.
    const byPart = new Map();
    for (const event of merged) {
      if (!byPart.has(event.partId)) byPart.set(event.partId, []);
      byPart.get(event.partId).push(event);
    }
    for (const events of byPart.values()) {
      const byStart = new Map();
      for (const event of events) {
        const key = event.startBeat.toFixed(6);
        if (!byStart.has(key)) byStart.set(key, []);
        byStart.get(key).push(event);
        event.legatoToNext = false;
        event.legatoFromPrevious = false;
      }

      for (const event of events) {
        if (!event.legato || !event.slursAfter?.length) continue;
        const endKey = (event.startBeat + event.durationBeats).toFixed(6);
        for (const next of byStart.get(endKey) || []) {
          const samePhrase = next.legato && event.slursAfter.some(id => next.slurIds?.includes(id));
          if (!samePhrase) continue;
          event.legatoToNext = true;
          next.legatoFromPrevious = true;
        }
      }
    }

    return merged;
  }



  /**
   * Merge tied notes so a note tied across beats/barlines sustains as a single
   * tone instead of being re-articulated. Operates per part on the flat schedule.
   * @param {Array} schedule
   * @returns {Array}
   */
  mergeTiedNotes(schedule) {
    const byPart = new Map();
    for (const e of schedule) {
      if (!byPart.has(e.partId)) byPart.set(e.partId, []);
      byPart.get(e.partId).push(e);
    }

    const out = [];
    for (const events of byPart.values()) {
      events.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
      const consumed = new Set();
      for (let i = 0; i < events.length; i++) {
        if (consumed.has(i)) continue;
        const e = events[i];
        out.push(e);
        if (!e.tieStart) continue;

        // Absorb subsequent contiguous same-pitch tie-stops, chaining while the
        // absorbed note itself starts another tie.
        let endBeat = e.startBeat + e.durationBeats;
        let openTie = true;
        for (let j = i + 1; j < events.length && openTie; j++) {
          if (consumed.has(j)) continue;
          const n = events[j];
          if (n.midi === e.midi && n.tieStop && Math.abs(n.startBeat - endBeat) < 1e-3) {
            e.durationBeats += n.durationBeats;
            endBeat += n.durationBeats;
            consumed.add(j);
            openTie = n.tieStart;
            if (n.fermata) e.fermata = n.fermata;
            e.legato = e.legato || n.legato;
            e.legatoStop = n.legatoStop;
            e.slurIds = Array.from(new Set([...(e.slurIds || []), ...(n.slurIds || [])]));
            e.slursAfter = [...(n.slursAfter || [])];
            e.tieStart = n.tieStart;
          }
        }
      }
    }
    return out;
  }

  /**
   * Get total beats across all parts (based on absolute measure positions).
   * @returns {number}
   */
  getTotalBeats() {
    let maxBeats = 0;
    for (const part of this.parts) {
      for (const measure of part.measures) {
        const end = (measure.startBeat || 0) + (measure.beats || 0);
        if (end > maxBeats) maxBeats = end;
      }
    }
    return maxBeats;
  }

  /** Return a score position on the fermata-expanded playback timeline. */
  getPlaybackBeat(scoreBeat) {
    if (this.fermataHolds.length === 0) {
      this.fermataHolds = collectFermataHolds(this.parts);
    }
    return scoreBeatToPlaybackBeat(scoreBeat, this.fermataHolds);
  }

  /** Return the score cursor position for an expanded playback beat. */
  getScoreBeat(playbackBeat) {
    return playbackBeatToScoreBeat(playbackBeat, this.fermataHolds);
  }

  /** Total length including time held at fermatas. */
  getTotalPlaybackBeats() {
    return this.getPlaybackBeat(this.getTotalBeats());
  }

  /**
   * Move the transport to a score beat and keep paused/resume coordinates in
   * sync. Callers may use this while stopped or paused.
   * @param {number} scoreBeat
   * @returns {number} clamped score beat
   */
  seek(scoreBeat) {
    const totalBeats = this.getTotalBeats();
    this.currentBeat = Math.max(0, Math.min(totalBeats, Number(scoreBeat) || 0));
    this.pausePlaybackBeat = this.getPlaybackBeat(this.currentBeat);
    this.pauseTime = beatToTime(this.pausePlaybackBeat, this.tempo);
    return this.currentBeat;
  }

  /**
   * Start or resume playback.
   */
  play() {
    if (!this.audioContext) return;

    // Build the expanded timeline before calculating the transport reference.
    this.schedule = this.buildSchedule();
    this.schedule.sort((a, b) =>
      (a.playbackStartBeat ?? a.startBeat) - (b.playbackStartBeat ?? b.startBeat)
    );

    let currentPlaybackBeat;
    if (this.isPaused) {
      currentPlaybackBeat = this.pausePlaybackBeat;
      this.pauseTime = beatToTime(currentPlaybackBeat, this.tempo);
      this.startTime = this.audioContext.currentTime - this.pauseTime;
      this.isPaused = false;
    } else {
      currentPlaybackBeat = this.getPlaybackBeat(this.currentBeat);
      // Add a small lead so the first note lands in the future instead of being
      // dropped by the lookahead scheduler's "already passed" check.
      this.startTime = this.audioContext.currentTime + this.startLead -
                       beatToTime(currentPlaybackBeat, this.tempo);
    }

    this.isPlaying = true;
    this.scheduleIndex = 0;
    for (let i = 0; i < this.schedule.length; i++) {
      const eventBeat = this.schedule[i].playbackStartBeat ?? this.schedule[i].startBeat;
      const eventDuration = this.schedule[i].playbackDurationBeats ?? this.schedule[i].durationBeats;
      if (eventBeat + eventDuration > currentPlaybackBeat + 1e-6) {
        this.scheduleIndex = i;
        break;
      }
      if (i === this.schedule.length - 1) {
        this.scheduleIndex = this.schedule.length;
      }
    }

    this.startLookaheadScheduler();
    this.startBeatTracking();
  }

  /**
   * Start the lookahead scheduler that schedules notes within a short window.
   */
  startLookaheadScheduler() {
    this.stopLookaheadScheduler();
    this.schedulerTimer = setInterval(() => {
      if (!this.isPlaying) return;
      this.scheduleAhead();
      this.cleanupEndedNodes();
    }, this.scheduleInterval);
  }

  /**
   * Stop the lookahead scheduler.
   */
  stopLookaheadScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /**
   * Schedule notes that fall within the lookahead window.
   */
  scheduleAhead() {
    const currentTime = this.audioContext.currentTime;
    const scheduleUntilTime = currentTime + this.lookaheadTime;

    while (this.scheduleIndex < this.schedule.length) {
      const event = this.schedule[this.scheduleIndex];
      const playbackStartBeat = event.playbackStartBeat ?? event.startBeat;
      const noteStartTime = this.startTime + beatToTime(playbackStartBeat, this.tempo);

      if (noteStartTime > scheduleUntilTime) {
        break; // This note is beyond our lookahead window
      }

      const playbackDuration = event.playbackDurationBeats ?? event.durationBeats;
      const baseDuration = beatToTime(playbackDuration, this.tempo);
      const overlap = event.legatoToNext ? Math.min(0.045, baseDuration * 0.12) : 0;
      const articulation = {
        legato: event.legato,
        legatoFromPrevious: event.legatoFromPrevious,
        legatoToNext: event.legatoToNext,
        fermata: !!event.fermata
      };

      if (noteStartTime >= currentTime - 0.01) {
        this.scheduleNote(
          event.partId,
          event.frequency,
          noteStartTime,
          baseDuration + overlap,
          articulation
        );
      } else {
        // Resume a note that was sounding at the pause/seek point, including a
        // note sustained through a fermata hold.
        const originalEndTime = noteStartTime + baseDuration + overlap;
        if (originalEndTime > currentTime + 0.01) {
          const resumedStart = currentTime + 0.005;
          this.scheduleNote(
            event.partId,
            event.frequency,
            resumedStart,
            originalEndTime - currentTime,
            { ...articulation, legatoFromPrevious: true }
          );
        }
      }

      this.scheduleIndex++;
    }
  }

  /**
   * Clean up nodes that have finished playing.
   */
  cleanupEndedNodes() {
    const currentTime = this.audioContext.currentTime;
    this.scheduledNodes = this.scheduledNodes.filter(node => {
      if (node.endTime && currentTime > node.endTime + 0.1) {
        // Node has ended, it should already be disconnected via onended
        return false;
      }
      return true;
    });
  }

  /**
   * Pause playback.
   */
  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.isPaused = true;
    this.pauseTime = this.audioContext.currentTime - this.startTime;
    this.pausePlaybackBeat = Math.max(0, this.pauseTime / beatDuration(this.tempo));
    this.stopAllNodes();
    this.stopLookaheadScheduler();
    this.stopBeatTracking();
  }

  /**
   * Stop playback and reset to beginning.
   */
  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this.currentBeat = 0;
    this.pauseTime = 0;
    this.pausePlaybackBeat = 0;
    this.stopAllNodes();
    this.stopLookaheadScheduler();
    this.stopBeatTracking();
    if (this.onBeatUpdate) {
      this.onBeatUpdate(0);
    }
  }

  /**
   * Schedule all notes from the current position (legacy fallback, not used by lookahead).
   */
  scheduleAllNotes() {
    this.stopAllNodes();
    const schedule = this.buildSchedule();
    const currentTime = this.audioContext.currentTime;
    const playbackStartBeat = this.getPlaybackBeat(this.currentBeat);

    for (const event of schedule) {
      if (event.startBeat < this.currentBeat) continue;

      const eventPlaybackBeat = event.playbackStartBeat ?? event.startBeat;
      const beatDelta = eventPlaybackBeat - playbackStartBeat;
      const noteStartTime = currentTime + beatToTime(beatDelta, this.tempo);
      const playbackDuration = event.playbackDurationBeats ?? event.durationBeats;
      const baseDuration = beatToTime(playbackDuration, this.tempo);
      const overlap = event.legatoToNext ? Math.min(0.045, baseDuration * 0.12) : 0;

      this.scheduleNote(event.partId, event.frequency, noteStartTime, baseDuration + overlap, {
        legato: event.legato,
        legatoFromPrevious: event.legatoFromPrevious,
        legatoToNext: event.legatoToNext,
        fermata: !!event.fermata
      });
    }
  }

  /**
   * Schedule a single note using an oscillator.
   * @param {string} partId
   * @param {number} frequency
   * @param {number} startTime - AudioContext time
   * @param {number} duration - seconds
   * @param {object} articulation - legato/fermata envelope hints
   */
  scheduleNote(partId, frequency, startTime, duration, articulation = {}) {
    const gainNode = this.partGains.get(partId);
    if (!gainNode) return;

    const oscillator = this.audioContext.createOscillator();
    const noteGain = this.audioContext.createGain();
    const safeDuration = Math.max(0.025, duration);

    // Use triangle wave for smoother choral sound.
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, startTime);

    // Slurred notes use a faster attack and overlap the next note slightly.
    // Clamp every stage for very short tuplets so automation times stay ordered.
    const requestedAttack = articulation.legatoFromPrevious
      ? 0.006
      : articulation.legato ? 0.012 : 0.02;
    const requestedRelease = articulation.fermata
      ? 0.08
      : articulation.legatoToNext ? 0.025 : 0.05;
    const attack = Math.min(requestedAttack, safeDuration * 0.25);
    const release = Math.min(requestedRelease, safeDuration * 0.35);
    const releaseStart = Math.max(startTime + attack, startTime + safeDuration - release);

    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(0.4, startTime + attack);
    noteGain.gain.setValueAtTime(0.4, releaseStart);
    noteGain.gain.linearRampToValueAtTime(0, startTime + safeDuration);

    oscillator.connect(noteGain);
    noteGain.connect(gainNode);

    oscillator.start(startTime);
    oscillator.stop(startTime + safeDuration + 0.01);

    const endTime = startTime + safeDuration + 0.01;
    const nodeEntry = { oscillator, noteGain, startTime, endTime };
    this.scheduledNodes.push(nodeEntry);

    oscillator.onended = () => {
      try {
        oscillator.disconnect();
        noteGain.disconnect();
      } catch (e) { /* already disconnected */ }
    };
  }

  /**
   * Stop and disconnect all scheduled oscillator nodes.
   */
  stopAllNodes() {
    const now = this.audioContext ? this.audioContext.currentTime : 0;
    for (const { oscillator, noteGain } of this.scheduledNodes) {
      try {
        noteGain.gain.cancelScheduledValues(now);
        noteGain.gain.setValueAtTime(0, now);
        oscillator.stop(now + 0.01);
      } catch (e) { /* already stopped */ }
    }
    this.scheduledNodes = [];
  }

  /**
   * Start tracking the current beat position using requestAnimationFrame.
   */
  startBeatTracking() {
    this.stopBeatTracking();
    const track = () => {
      if (!this.isPlaying) return;
      const elapsed = this.audioContext.currentTime - this.startTime;
      const playbackBeat = Math.max(0, elapsed / beatDuration(this.tempo));
      this.currentBeat = playbackBeatToScoreBeat(playbackBeat, this.fermataHolds);

      // End on the expanded timeline; during a fermata currentBeat intentionally
      // remains fixed at the marked score position.
      if (playbackBeat >= this.getTotalPlaybackBeats()) {
        this.stop();
        return;
      }

      if (this.onBeatUpdate) {
        this.onBeatUpdate(this.currentBeat);
      }
      this.animationFrame = requestAnimationFrame(track);
    };
    this.animationFrame = requestAnimationFrame(track);
  }

  /**
   * Stop beat tracking.
   */
  stopBeatTracking() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Get the AudioContext (for use by other modules like metronome).
   * @returns {AudioContext}
   */
  getAudioContext() {
    return this.audioContext;
  }

  /**
   * Get the playback start time reference (for syncing metronome).
   * @returns {number} AudioContext time when beat 0 started
   */
  getStartTime() {
    return this.startTime;
  }

  /**
   * Get the current beat position.
   * @returns {number}
   */
  getCurrentBeat() {
    return this.currentBeat;
  }

  /**
   * Get the exact position on the fermata-expanded timeline. Unlike currentBeat,
   * this continues advancing while the score cursor waits on a fermata.
   * @returns {number}
   */
  getCurrentPlaybackBeat() {
    if (this.isPlaying && this.audioContext) {
      return Math.max(0, (this.audioContext.currentTime - this.startTime) / beatDuration(this.tempo));
    }
    if (this.isPaused) return this.pausePlaybackBeat;
    return this.getPlaybackBeat(this.currentBeat);
  }

  /**
   * Get the master gain node.
   * @returns {GainNode}
   */
  getMasterGain() {
    return this.masterGain;
  }

  /**
   * Cleanup and release resources.
   */
  dispose() {
    this.stop();
    this.stopLookaheadScheduler();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
