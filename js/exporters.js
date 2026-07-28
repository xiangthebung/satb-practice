/**
 * File exports: a practice mix as WAV audio, or the score as MusicXML with the
 * rehearsal tempo and any renamed parts written back into it.
 */

import { AudioEngine } from './audio-engine.js';
import { buildPartNameUpdates } from './musicxml-parser.js';

/** Strip a score extension so exports can add their own. */
export function getExportBaseName(fileName, fallback = 'score') {
  const name = String(fileName || '').trim();
  if (!name) return fallback;
  return name.replace(/\.(musicxml|xml|mxl)$/i, '') || fallback;
}

/** Trigger a browser download for a blob. */
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Write the current tempo and part names back into the original MusicXML.
 * @param {string} rawXml
 * @param {{ parts: Array, tempo: number }} options
 * @returns {string} serialized MusicXML
 */
export function patchMusicXML(rawXml, { parts = [], tempo = 120 } = {}) {
  const doc = new DOMParser().parseFromString(rawXml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('The original file could not be re-read for export.');
  }

  // One <part-name> can back several editable voices, so split names are
  // rejoined into a compound label the parser can expand again on import.
  const partNameUpdates = buildPartNameUpdates(parts);
  for (const scorePart of doc.querySelectorAll('part-list score-part')) {
    const id = scorePart.getAttribute('id');
    const nameElement = scorePart.querySelector('part-name');
    if (nameElement && partNameUpdates.has(id)) {
      nameElement.textContent = partNameUpdates.get(id);
    }
  }

  // Set the first tempo marking, leaving later changes (accelerandos and the
  // like) at their original values relative to it.
  const existingTempo = doc.querySelector('sound[tempo]');
  if (existingTempo) {
    existingTempo.setAttribute('tempo', String(tempo));
  } else {
    const firstMeasure = doc.querySelector('part > measure');
    if (firstMeasure) {
      const direction = doc.createElement('direction');
      direction.setAttribute('placement', 'above');
      const sound = doc.createElement('sound');
      sound.setAttribute('tempo', String(tempo));
      direction.appendChild(sound);
      firstMeasure.insertBefore(direction, firstMeasure.firstChild);
    }
  }

  const xml = new XMLSerializer().serializeToString(doc);
  return xml.startsWith('<?xml')
    ? xml
    : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}

/**
 * Export the score as MusicXML.
 * @param {{ rawXml: string, parts: Array, tempo: number, fileName: string }} options
 */
export function exportMusicXMLFile({ rawXml, parts, tempo, fileName }) {
  if (!rawXml) throw new Error('This score cannot be exported.');
  const xml = patchMusicXML(rawXml, { parts, tempo });
  downloadBlob(
    new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }),
    `${getExportBaseName(fileName)}.musicxml`
  );
}

/**
 * Render the current mix offline and export it as a WAV file.
 * @param {AudioEngine} audioEngine
 * @param {{ fileName: string, onProgress?: (ratio: number) => void }} options
 */
export async function exportWavFile(audioEngine, { fileName, onProgress } = {}) {
  const buffer = await audioEngine.exportAudio({ onProgress });
  downloadBlob(AudioEngine.audioBufferToWav(buffer), `${getExportBaseName(fileName)}.wav`);
}
