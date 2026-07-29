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

The site is `public/`. Serve that directory — not the repository root — with any
static web server, then open it in a modern browser. A server is required because
the sample scores are fetched at runtime.

```sh
npm run serve
# then open http://localhost:8000
```

`npm run serve` serves `public/` on port 8000. Anything else that serves a
directory works too, as long as it is pointed at `public/`:

```sh
python3 -m http.server 8000 --directory public
```

## Deploying

The site is a Cloudflare Worker with static assets, configured in
`wrangler.jsonc`. There is no build step: `public/` is published as it stands.

Pushing to `main` deploys it. The `deploy` job in `.github/workflows/ci.yml` runs
after the unit and browser suites and is skipped unless both pass, so the live site
cannot move ahead of a green build. It needs one repository secret:

| Secret | Required | What it is |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | yes | An API token with the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | only if the token can see more than one account | The account to deploy into |

Add them under Settings → Secrets and variables → Actions.

To deploy by hand instead:

```sh
npx wrangler login     # once, opens a browser
npx wrangler deploy
```

Before either, `npx wrangler deploy --dry-run` prints how many files it is about
to publish. That number should be the size of `public/` and nothing like it if
something has gone wrong — it read 5,134 files when the assets directory was still
the repository root.

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

Everything the browser loads is under `public/`, and everything outside it —
tests, tooling, configuration — is not published. That split is the deploy
surface: the Worker's assets directory is `public/`, so a new file can only reach
the live site by being put there deliberately.

```
public/index.html            markup and static structure
public/css/styles.css        design tokens, layout, and component styles
public/js/app.js             session state and coordination
public/js/ui/                parts panel, transport, overlays, settings
public/js/musicxml-parser.js MusicXML and .mxl reading
public/js/notation-renderer.js  canvas notation and playback cursor
public/js/audio-engine.js    scheduling and synthesis, live and offline
public/js/timbre.js          voice profiles, vowel formants, glottal source maths
public/js/pitch-detector.js  microphone pitch estimation (YIN)
public/js/metronome.js       click scheduling
public/js/mix.js             rehearsal mix presets
public/js/theme.js           canvas palette derived from the CSS tokens
public/js/prefs.js           saved preferences
public/js/exporters.js       WAV and MusicXML export
public/sample-pieces/        the bundled scores
tests/run-tests.js           unit tests for the pure logic
e2e/practice.spec.js         browser tests
tools/serve.js               the local static server
wrangler.jsonc               Cloudflare Worker and assets configuration
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
