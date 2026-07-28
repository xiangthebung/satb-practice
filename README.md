# Choir Practice

A browser rehearsal tool for choir singers. Open a MusicXML score, choose the
line you sing, and balance the other voices around it. Everything runs locally:
no accounts, no uploads, no build step.

## Features

- **Scores** — uncompressed `.musicxml` / `.xml` and compressed `.mxl` files,
  opened from the file picker or by drag and drop. Three sample pieces are
  included.
- **Your part** — pick the voice you sing; the app remembers it and selects the
  matching part in the next score you open.
- **Balance** — four rehearsal mixes (mostly your part, only your part, everyone
  but you, everyone) plus per-part volume and mute.
- **Playback** — synthesised voices or plain tones, tempo from 40 to 240 BPM,
  room reverb, fermata hold length, looping, and a metronome that accents real
  barlines (including pickup bars and time-signature changes). Each voice part
  is rendered as a section of singers, and sung vowels follow the lyrics.
- **Score view** — scrolling notation with the playhead pinned in view, key
  signatures, beams, ties, slurs, tuplets and fermatas; click to jump, drag to
  scrub, scroll sideways to read ahead.
- **Microphone guidance** — optional pitch feedback against the written note,
  shown as a calm left/right indicator plus a trail on your stave.
- **Export** — a WAV of the current mix, or MusicXML with your tempo and part
  names written back in.

## Run locally

Serve the folder with any static web server, then open it in a modern browser.
A server is required because the sample scores are fetched at runtime.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Keyboard

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Play or pause |
| <kbd>←</kbd> <kbd>→</kbd> | Previous or next bar |
| <kbd>Home</kbd> | Back to the start |
| <kbd>M</kbd> | Metronome |
| <kbd>R</kbd> | Loop |
| <kbd>?</kbd> | Help |

## Privacy

Scores never leave the device. When microphone guidance is on, audio is analysed
in the page and is never recorded, stored, or sent anywhere.

## Project layout

```
index.html            markup and static structure
css/styles.css        design tokens, layout, and component styles
js/app.js             session state and coordination
js/ui/                parts panel, transport, overlays
js/musicxml-parser.js MusicXML and .mxl reading
js/notation-renderer.js  canvas notation and playback cursor
js/audio-engine.js    scheduling and synthesis, live and offline
js/timbre.js          voice profiles, vowel formants, glottal source maths
js/pitch-detector.js  microphone pitch estimation (YIN)
js/metronome.js       click scheduling
js/mix.js             rehearsal mix presets
js/theme.js           canvas palette derived from the CSS tokens
js/prefs.js           saved preferences
js/exporters.js       WAV and MusicXML export
tests/run-tests.js    unit tests for the pure logic
```

## Tests

```sh
node tests/run-tests.js
```

The suite covers the parts that can be reasoned about without a browser: pitch
and note maths, measure layout, mix presets, key signatures and accidentals,
archive reading, and the formatting helpers.

Before a release, also check in the browsers you support: playback and seeking,
the metronome, WAV export, microphone permission (allowed and blocked), keyboard-
only navigation, a phone-sized viewport, and both light and dark appearance.
