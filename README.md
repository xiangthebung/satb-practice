# Choir Practice Tool

A browser-based rehearsal tool for choir parts. Open a MusicXML score, select your section, adjust the mix, and practice with playback, a metronome, optional microphone pitch guidance, and MusicXML/WAV export.

## Run locally

Serve this folder with any static web server, then open `index.html` in a modern browser. A server is required because the included sample scores are loaded with `fetch`.

## Supported files

Upload uncompressed `.musicxml` files. Compressed `.mxl` archives are not currently supported.

## Privacy

When microphone practice is enabled, microphone audio is analysed locally in the browser. The app does not record or upload microphone audio.

## Verification

Run the unit test suite with:

```sh
node tests/run-tests.js
```

Before a release, manually check playback, WAV export, microphone permission, keyboard-only navigation, and the layout on a phone-sized viewport in the browsers you support.
