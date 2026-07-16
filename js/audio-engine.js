/**
 * Web Audio API Playback Engine
 * Synthesizes notes for each part using oscillators with per-part volume control.
 * Uses lookahead scheduling for sample-accurate timing.
 */

import { noteToFrequency } from './utils.js';

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
    this.currentBeat = 0;
    this.scheduledNodes = [];
    this.lookaheadTime = 0.1; // seconds to look ahead
    this.scheduleInterval = 25; // ms between scheduling checks
    this.schedulerTimer = null;
    this.nextScheduledBeat = 0; // next beat index to schedule in lookahead
    this.onBeatUpdate = null; // callback(currentBeat)
    this.animationFrame = null;
    this.schedule = []; // cached note schedule
    this.scheduleIndex = 0; // current position in schedule for lookahead
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
      // Recalculate startTime so current beat position is preserved at new tempo
      const elapsed = this.audioContext.currentTime - this.startTime;
      const currentBeatPos = elapsed / beatDuration(this.tempo);
      this.startTime = this.audioContext.currentTime - beatToTime(currentBeatPos, newTempo);
      // Cancel all future scheduled notes and reschedule from current position
      this.stopAllNodes();
      this.scheduleIndex = 0;
      // Reset scheduleIndex to find the right position
      for (let i = 0; i < this.schedule.length; i++) {
        if (this.schedule[i].startBeat >= currentBeatPos) {
          this.scheduleIndex = i;
          break;
        }
        if (i === this.schedule.length - 1) {
          this.scheduleIndex = this.schedule.length;
        }
      }
    }
    this.tempo = newTempo;
  }

  /**
   * Build a schedule of all notes with their start times and durations.
   * @returns {Array} array of { partId, frequency, startBeat, durationBeats }
   */
  buildSchedule() {
    const schedule = [];
    for (const part of this.parts) {
      let beatOffset = 0;
      for (const measure of part.measures) {
        for (const note of measure.notes) {
          if (note.isChord) continue;
          if (!note.isRest && note.pitch) {
            const frequency = noteToFrequency(note.pitch.noteName, note.pitch.octave);
            if (frequency && frequency > 0) {
              schedule.push({
                partId: part.id,
                frequency,
                startBeat: beatOffset,
                durationBeats: note.durationBeats
              });
            }
          }
          beatOffset += note.durationBeats;
        }
      }
    }
    return schedule;
  }

  /**
   * Get total beats across all parts.
   * @returns {number}
   */
  getTotalBeats() {
    let maxBeats = 0;
    for (const part of this.parts) {
      let beats = 0;
      for (const measure of part.measures) {
        for (const note of measure.notes) {
          if (!note.isChord) {
            beats += note.durationBeats;
          }
        }
      }
      maxBeats = Math.max(maxBeats, beats);
    }
    return maxBeats;
  }

  /**
   * Start or resume playback.
   */
  play() {
    if (!this.audioContext) return;

    if (this.isPaused) {
      // Resume from paused position
      this.startTime = this.audioContext.currentTime - this.pauseTime;
      this.isPaused = false;
    } else {
      // Start from beginning or current position
      this.startTime = this.audioContext.currentTime -
                       beatToTime(this.currentBeat, this.tempo);
    }

    this.isPlaying = true;

    // Build and cache the schedule, set scheduleIndex to current position
    this.schedule = this.buildSchedule();
    this.schedule.sort((a, b) => a.startBeat - b.startBeat);
    this.scheduleIndex = 0;
    for (let i = 0; i < this.schedule.length; i++) {
      if (this.schedule[i].startBeat >= this.currentBeat) {
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
      const noteStartTime = this.startTime + beatToTime(event.startBeat, this.tempo);

      if (noteStartTime > scheduleUntilTime) {
        break; // This note is beyond our lookahead window
      }

      // Only schedule if the note hasn't already passed
      if (noteStartTime >= currentTime - 0.01) {
        const noteDuration = beatToTime(event.durationBeats, this.tempo);
        this.scheduleNote(event.partId, event.frequency, noteStartTime, noteDuration);
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
    const playbackStartBeat = this.currentBeat;

    for (const event of schedule) {
      if (event.startBeat < playbackStartBeat) continue;

      const beatDelta = event.startBeat - playbackStartBeat;
      const noteStartTime = currentTime + beatToTime(beatDelta, this.tempo);
      const noteDuration = beatToTime(event.durationBeats, this.tempo);

      this.scheduleNote(event.partId, event.frequency, noteStartTime, noteDuration);
    }
  }

  /**
   * Schedule a single note using an oscillator.
   * @param {string} partId
   * @param {number} frequency
   * @param {number} startTime - AudioContext time
   * @param {number} duration - seconds
   */
  scheduleNote(partId, frequency, startTime, duration) {
    const gainNode = this.partGains.get(partId);
    if (!gainNode) return;

    const oscillator = this.audioContext.createOscillator();
    const noteGain = this.audioContext.createGain();

    // Use triangle wave for smoother choral sound
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, startTime);

    // Envelope: gentle attack and release
    noteGain.gain.setValueAtTime(0, startTime);
    noteGain.gain.linearRampToValueAtTime(0.4, startTime + 0.02);
    noteGain.gain.setValueAtTime(0.4, startTime + duration - 0.05);
    noteGain.gain.linearRampToValueAtTime(0, startTime + duration);

    oscillator.connect(noteGain);
    noteGain.connect(gainNode);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.01);

    const endTime = startTime + duration + 0.01;
    const nodeEntry = { oscillator, noteGain, endTime };
    this.scheduledNodes.push(nodeEntry);

    // Cleanup after note ends
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
      this.currentBeat = elapsed / beatDuration(this.tempo);

      // Check if playback has ended
      const totalBeats = this.getTotalBeats();
      if (this.currentBeat >= totalBeats) {
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
