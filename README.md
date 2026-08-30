# Choir Practice

A browser rehearsal tool for choir singers. Open a MusicXML score, choose the
line you sing, and balance the other voices around it. Everything runs locally:
no accounts, no uploads, no build step.

## Features

- **Scores** — uncompressed `.musicxml` / `.xml` and compressed `.mxl` files,
  opened from the file picker or by drag and drop. Three sample pieces are
  included; see [Bundled scores](#bundled-scores).
- **Your part** — pick the voice you sing; the app remembers it and selects the
  matching part in the next score you open.
- **Balance** — four rehearsal mixes (mostly your part, only your part, everyone
  but you, everyone) plus per-part volume, mute and solo. The panel opens beside
  the score on a wide window and under it on a narrow one, and closes either way,
  so you can move a fader while the music is playing.
- **Playback** — synthesised voices or plain tones, tempo from 40 to 240 BPM,
  room reverb, fermata hold length, looping, and a metronome whose accents *and*
  spacing follow the score's own bars, including pickup bars and a change of
  metre partway through. Each voice part is rendered as a section of singers, and
  the sung vowels follow the words of whichever verse is on screen.
- **Score view** — scrolling notation with the playhead pinned in view; click to
  jump, drag to scrub, scroll sideways to read ahead. What it draws and what it
  plays are set out in [Notation coverage](#notation-coverage), because those two
  lists are not the same.
- **Microphone guidance** — optional pitch feedback against the written note,
  shown as a calm left/right indicator plus a trail on your stave.
- **Export** — a WAV of the current mix, or MusicXML with your tempo and part
  names written back in.

## Notation coverage

Real scores contain more than any one tool reads, and the expensive failure is
not an unsupported marking — it is an unsupported marking that disappears
silently, so the ear and the page disagree and you cannot tell which is wrong.
This is what the app actually does with each one. *Drawn* means it appears on the
canvas; *played* means it changes what you hear.

| | drawn | played |
| --- | :---: | :---: |
| Notes, rests, chords, dotted values | yes | yes |
| Ties, including across a barline | yes | yes |
| Slurs | yes | yes (as legato) |
| Beams and tuplets, bracketed or not | yes | yes |
| Key signatures, and changes mid-score | yes | n/a |
| Time signatures, and changes mid-score | yes | yes |
| Pickup bars | yes | yes |
| Clefs: treble, bass, alto, tenor, octave-down treble | yes | yes |
| Accidentals, including double sharps and flats | yes | yes |
| Lyrics: several verses, hyphens, melismas | yes | yes (chooses the vowel) |
| Divisi — two or more voices on one staff | yes | yes |
| Transposing parts | written pitch | sounding pitch |
| Fermatas, on notes and on barlines | yes | yes (hold is adjustable) |
| Repeat barlines, including `times` | yes | yes |
| First and second endings | yes | yes |
| Final and double barlines | yes | n/a |
| Dynamics and hairpins | **no** | yes |
| Articulations: staccato, accent, tenuto, marcato | **no** | yes |
| Tempo marks and mid-score tempo changes | **no** | yes |
| Grace notes | yes | **no** |
| Ornaments: trill, mordent, turn | **no** | **no** |
| D.C., D.S., Coda, Fine | **no** | **no** |

When a score contains something in the last two rows, the app says so in a
message as it opens, rather than performing it straight through and leaving you
to work out why the recording and the page disagree.

Not read at all: non-traditional key signatures (`<key-step>`), unmetred music
(`senza-misura`), common and cut time symbols (drawn as `4/4` and `2/2`),
multi-measure rests, system and page breaks from `<print>`, unpitched and
percussion notes, and cue notes — a cue note is sung at full size. A mid-score
clef change repositions the notes correctly but prints no new clef. Only the
first `<transpose>` in a part is honoured. `score-timewise` documents are
rejected with a message asking for a partwise export, which is what notation
software writes by default.

## Bundled scores

Three samples ship in `public/sample-pieces/`, in the order the home screen offers
them — easiest first. All three are music.

| Score | Parts | Length | Notes |
| --- | --- | --- | --- |
| Happy birthday | SATB | 9 bars | arr. David Bauguess. Ab major, two tempi, divisi in the last two bars, and a fermata to end on. A first score. |
| Draw on, sweet night | SSAATB | 70 bars | John Wilbye, 1609. Imitative six-part counterpoint. |
| Quick! We have but a second | SATB | 104 bars | C. V. Stanford. Fast, and in shifting compound metre. |

None of the three has a repeat in it, which is how the repeat signs came to be
performed and never drawn. The browser tests carry two scores of their own for
the shapes no sample has:

- `e2e/fixtures/repeat-with-endings.js` — a repeat with first and second endings.
- `e2e/fixtures/two-voices-on-one-staff.js` — two voices sharing a staff, which is
  where forced down-stems used to be drawn through the words. This shipped as a
  fourth sample called "Warm-up in four parts" and was removed: it is a harmony
  exercise rather than a piece, and a rehearsal tool should offer music.

Both are loaded through the app's own file input, the same path a singer's own
file takes.

"Happy Birthday" is generated, so the music can be edited rather than re-engraved:

```sh
node tools/make-happy-birthday-sample.js
```

It is David Bauguess's arrangement, included under his own notice on the score:
"This arrangement may be freely reproduced. A PDF file is available at
tinyurl.com/yazlt88y or from davidbauguess@yahoo.com". The song underneath is
public domain — Mildred J. Hill's 1893 melody, with lyrics held unprotected in
`Marya v. Warner/Chappell Music` (C.D. Cal. 2015, settled June 2016). The
generator's header records how the notes were read off the published PDF and how
that reading was checked.

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

Microphone guidance needs a secure context, which `http://localhost` counts as.
Opening the same server over a LAN address will not offer the microphone at all,
and the app says so rather than blaming your permissions.

## Deploying

The site is a Cloudflare Worker with static assets, configured in
`wrangler.jsonc`. There is no build step: `public/` is published as it stands.

Deploys happen through Cloudflare's **Workers Builds** GitHub app, which is already
connected to this repository. It builds every push by itself and needs no secret
here — there is deliberately no `wrangler deploy` job in the CI workflow, because it
would only duplicate or race that.

Which push reaches the live site depends on the **production branch** set in the
Cloudflare dashboard, under Workers → satb-practice → Settings → Builds. Only the
production branch publishes to `satb-practice.xiangli3625.workers.dev`; every other
branch gets a preview build. Keep that setting and this repository's default branch
pointing at the same branch, or the site quietly stops tracking the code — that is
exactly how the deployed site came to be sixteen commits behind.

This has now gone wrong twice, so it is worth knowing how to check rather than
how to remember: open the live site and compare the scores on its home screen
with the files in `public/sample-pieces/`. That list changes often enough to be a
reliable tell, and it needs no dashboard access. If the live site offers a score
this repository does not have, the site is not tracking this branch, and no
amount of pushing will change that — the fix is the production-branch setting
above, or the Workers Builds integration having been disconnected.

Cloudflare deploys on push without waiting for the suites above, so a red build can
still reach the site. Gating it means moving the deploy into
`.github/workflows/ci.yml` behind `needs: [checks, browser]`, adding a
`CLOUDFLARE_API_TOKEN` repository secret (**Edit Cloudflare Workers** token
template, plus `CLOUDFLARE_ACCOUNT_ID` if it can see more than one account), and
turning the Workers Builds integration off so the two do not both fire.

To deploy by hand:

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
| <kbd>[</kbd> <kbd>]</kbd> | Loop from or to here |
| <kbd>\\</kbd> | Loop the whole score |
| <kbd>,</kbd> | Settings |
| <kbd>?</kbd> | Help |

Every control is reachable by tab, in reading order, and the score canvas is one
of the stops. Moving a bar at a time announces the bar number and what your own
part sings there — "Bar 12, F sharp 4" — because a canvas tells a screen reader
nothing on its own. The four voices are colour-coded, and every place that uses
the colour also carries the part's name in text: in the left gutter of the score,
and on each row of the parts panel.

## Privacy

Scores never leave the device: they are read with `File.arrayBuffer()` and parsed
in the page. The three bundled samples are fetched from the same origin that
serves the app, and nothing else is requested over the network. When microphone
guidance is on, audio is analysed in the page by `public/js/pitch-detector.js` and
is never recorded, stored, or sent anywhere; turning it off stops the media
tracks, so the browser's recording indicator goes out. Preferences — your voice
part, tempo, mix and the rest — are kept in `localStorage` on your own device.
There is no analytics, no telemetry and no third-party script anywhere in
`public/`.

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
public/og.png                the link-preview card
tests/run-tests.js           unit tests for the pure logic
tests/check-static.js        markup, module graph and call-site wiring
tests/check-docs.js          this README against the code it describes
e2e/practice.spec.js         browser tests
tools/serve.js               the local static server
tools/og-shot.js             redraws the link-preview card from the running app
wrangler.jsonc               Cloudflare Worker and assets configuration
```

## Tests

```sh
npm run check      # lint, wiring, docs, unit tests, parser against real scores
npm run e2e        # browser tests; npm run e2e:install once, first
npm run verify     # both
```

`npm test` runs the unit suite alone. It covers the parts that can be reasoned
about without a browser: pitch and note maths, measure layout, mix presets, key
signatures and accidentals, archive reading, the rules that decide what a solo or
a mute lets through, and the formatting helpers.

`npm run test:docs` reads this file and fails if it has drifted from the code —
if the keyboard table and the key handler disagree, if a bundled score is not
offered on the home screen, if a path in the layout above does not exist, or if a
command named here is not in `package.json`. It exists because every one of those
had gone stale at least once.

The browser suite drives the real app in two viewports and asserts geometry
rather than class names where the geometry is the point: that the parts panel
never covers the score, that the repeat signs are painted from the score's own
barlines, and that the words are painted clear of the notes above them.

What no suite here checks, and what still wants a person: how the synthesised
voices actually sound, whether the microphone guidance tracks a real voice in a
real room, and how any of it behaves in Safari or Firefox. Nothing in this
repository has been run in either.

## The link preview

`public/index.html` carries Open Graph and Twitter card tags, so pasting a link
to this app into a chat shows a title, a sentence and a picture rather than a
bare URL. The sentence is the same one as the meta description: one claim about
the app, in one place, so there is only one thing to keep true.

The picture is `public/og.png`, and it is a photograph rather than a drawing.
`npm run og` opens *Draw on, sweet night* in a real browser, chooses a part the
way a singer does, moves off the opening bars where most of the voices are still
resting, and lays that frame into the titled card. It needs the app being served:

```sh
node tools/serve.js 8199   # one terminal
npm run og                 # another
```

Re-run it after a change to the notation, the parts panel or the palette. A card
that no longer looks like the app is worse than no card, because it is the first
thing anybody sees. Two things it cannot check itself: the card is set in the
platform's own UI typeface, so it will not be pixel-identical from a different
machine, and whether the sentence in the tags is still true of the app is a
question for a person.
