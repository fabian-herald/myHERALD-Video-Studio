# myHERALD Video Studio

A context-first video studio. You feed it your brand and what your product actually is,
once. After that, one sentence produces a finished video.

It is not an ad tool. Four intents share the same machinery — promotional, educational,
thought leadership and product announcements — and only the intent decides tone,
structure and whether there is a call to action at all.

There is no publishing. Videos come out as files; you post them yourself.

## How it works

```
Brand kit + product facts + media ─┐
Brief + intent + format            ─┼─► PLAN     → plan.json  (schema-enforced, hand-editable)
Ledger check (already covered?)    ─┘
                │
plan.json ─► one TTS clip per phrase ─► ffprobe measures ─► RETIME
                │                                            ↑
                │                              the audio owns the timing
                │
retimed plan + tokens.css + blocks ─► COMPOSE   (an agent authors real HTML/CSS/GSAP)
                │
        hyperframes check --strict ─► repair ≤3 ─► render ─► qc ─► contact sheet
```

Two things are worth understanding before reading any code.

**The composer writes a real composition, it does not fill a template.** Templated
scene libraries were the previous design and they produced one layout repeated six
times. Here the agent authors HTML, CSS and GSAP against a contract
(`src/core/compose/CONTRACT.md`), a generated token file it may not deviate from, and a
set of layout primitives — then validates its own work and repairs it. The bar is not
"it validates"; it is that the eight frames of the contact sheet read as eight
structurally different compositions.

**Every section sits on an energy curve.** A single delivery setting for a whole video
is what makes it monotone, however good that setting is: a calm voice held at one level
for forty seconds stops reading as calm and starts reading as flat. Each section carries
`quiet`, `settled`, `lift` or `edge`, which drives both how the line is spoken and how
fast the picture moves. A lift only reads as a lift because the section before it did
not.

**The audio owns the timing.** Every phrase is synthesised as its own clip and measured,
then the plan is rebuilt from those measurements. Nothing is ever time-stretched to fit
a guess, and caption page boundaries come out exact for free — no ASR, no forced
alignment.

## The studio

```bash
npm run studio     # UI on 127.0.0.1:5173, API on 5174
```

Chat is the main surface. The agent reads the brand kit, checks the ledger so it
sharpens a previous angle instead of repeating it, then makes the video. Alongside it
the canvas is an artefact inspector: **Video** (player and contact sheet), **Script**
(copy and pacing, editable), **Scenes**, **Sources** (the research), **Assets**,
**Checks** (the QC report), **Files**.

**Sources** is the one tab that is not about the finished file. It holds the research for
the whole thread — every search run, every page read, every figure found with the sentence
it came from — written by the tools as they go, plus the brief the agent writes over the
top. The trail is a record and the brief is a claim, kept apart on purpose: when the brief
says something the sources do not support, that is visible here, and it stays visible
because the record is not the agent's to rewrite. It opens before a video exists, which is
when the research is being done. Read-only: a figure becomes usable by approving it in
`/brand`, which is still the only place that can.

The rule that decides where a change goes: **what lives in `plan.json` you edit
directly; what changes the shape of a scene you discuss with the agent.** A wording or
timing edit re-synthesises only the phrases you touched and re-renders in seconds, with
no model call and no cost.

`/brand` holds the context in three tabs: **Identity** (logos, the palette with live
contrast pairs, type stacks and scale, tone rules), **Product** (facts, each with a
state), and **Research**.
Facts stay `proposed` until you approve them; nothing unapproved ever reaches a prompt.

The interface is English. **The language a video is written, spoken and captioned in is
a separate choice**, set next to the Send button and remembered — so writing to the
agent in German does not quietly produce a German video, and asking in English for a
German one works.

Threads are split on purpose. One studio thread for global work, one per video. Neither
is the memory — that is `data/videos/index.json`, a structured ledger, because a long
transcript gets compacted and loses exactly the detail that prevents a duplicate.

## Setup

```bash
npm install
cp .env.example .env.local     # add GEMINI_API_KEY
npm run tokens                 # generate data/brand/tokens.css and verify contrast pairs
```

Requires Node 22+ for rendering (HyperFrames) and `ffmpeg`/`ffprobe` on PATH. If your
default `node` is older, set `HYPERFRAMES_NODE_PATH` — `/usr/local/bin/node` is probed
automatically.

The composer authenticates through your local `claude` CLI subscription — no API key.
`--composer codex` uses the Codex CLI instead, on your ChatGPT subscription; it is
usually not on `PATH`, so set `CODEX_CLI_PATH` in `.env.local` before selecting it.

## Make a video

```bash
npm run make -- "myHERALD turns one rough thought into a coherent week"
```

Options:

| Flag | Values | Default |
|---|---|---|
| `--intent` | `promotional`, `educational`, `thought-leadership`, `announcement` | `thought-leadership` |
| `--formats` | `9x16`, `4x5`, `1x1`, `16x9` (comma-separated) | the intent's own |
| `--language` | `en`, `de`, `fr`, `es`, `it`, `nl`, `pt`, `pl` | the studio setting |
| `--quality` | `draft`, `standard`, `high` | `high` |
| `--composer` | `claude`, `codex` | the studio setting |
| `--baseline` | skip the model, use the deterministic fallback | off |

`--baseline` renders a hand-written composition instead of calling the agent. It is the
fallback when the repair budget runs out, and it makes the whole render/QC path testable
for free.

Output lands in `out/<video-id>/`: one MP4 per format, a cover, an 8-up contact sheet,
per-format QC reports, and `provenance.json`.

## Screenshots

Product screenshots are captured once into a reusable library, not per video.

```bash
npm run capture -- login  --workspace <id>   # sign in yourself, once
npm run capture -- record --workspace <id>   # freeze the app's responses into a HAR
npm run capture -- shots                     # replay that recording, offline
npm run capture -- list
```

Two things are deliberate. **Capture is fail-closed**: without an explicitly pinned
workspace it refuses to run against the live app, so a screenshot can never quietly
contain someone's real data. And **record/replay removes the need to seed anything**:
you fill a workspace once by using the product, the responses are frozen into a HAR
bundle, and every later capture replays it. The screenshots then stop changing
underneath the videos that use them, and no database or running app is needed.

Dev-build furniture is stripped before the shutter: the Next.js indicator, Vite and
Astro overlays, the Vercel toolbar and the usual chat widgets, by stylesheet and by
removing the host nodes, because `nextjs-portal` lives in a shadow root.

Device presets decide shape, and **shape decides where a screenshot may be used**:

| Preset | Viewport | Serves |
|---|---|---|
| `desktop-wide` | 1920×1080 | 16:9 |
| `macbook` | 1512×860 | 16:9 |
| `tablet-portrait` | 1024×1366 | 9:16, 4:5, 1:1 |
| `mobile` | 390×844 | 9:16, 4:5, 1:1 |
| `mobile-short` | 390×620 | 9:16, 4:5, 1:1 |

The composer is only shown media whose aspect suits the target format, and the
pre-render check rejects a landscape screenshot bound into a vertical video.

## Research

```bash
npm run research -- https://myherald.io https://myherald.io/product [--dry-run]
```

Reads public pages and pulls out two things: what the product says about itself, and the
colours and type it presents itself in. Also available as a button in `/brand → Research`
and as a tool the agent can call.

Nothing it finds is applied. Statements land as `proposed` facts for you to approve one
by one; colours and fonts are reported next to the tokens you already have (*"already
yours as purple"*) and copied across by hand if worth keeping. That is not caution for
its own sake: a web page is text someone else wrote, so anything it says has to pass a
person before it can act. The fetch refuses private, local and loopback addresses,
re-checking on every redirect hop, caps responses at 750 KB, and follows only
same-origin stylesheets.

A statement carrying a figure is saved with an empty evidence note, which means it stays
withheld from prompts even after you approve it, until you write down where the number
comes from.

## Logos

`data/brand/logos/` holds the marks, registered in the kit with a role (`seal`,
`wordmark`, `lockup`), the field they are drawn *for* (`light`, `dark`, `any`), their
intrinsic size and their clear space. Add and remove them in `/brand → Identity`; each
previews on the background it belongs to, because a cream wordmark is invisible on white
and that is exactly the mistake worth catching early.

Every mark is copied into the compose workdir as `media/logo-<id>.png` and named in the
brief, so the composer places the file instead of typesetting the name.

```bash
npm run wordmark   # re-render the wordmark-only PNGs from the vendored fonts
```

## Cost

Two figures, never one:

- **charged** is money that leaves an account for this run
- **API-equivalent** is what the same token usage would cost at metered list prices

Under a CLI subscription the model work is covered by the monthly plan, so charged is
zero and the equivalent figure is a comparison, not a bill. `STUDIO_BILLING_MODE`
overrides the detection; otherwise the presence of `ANTHROPIC_API_KEY` decides. The
split shows in the terminal, under each chat turn, and in the Assets tab.

## Layout

```
src/core/
  brand/       kit schema, contrast verification, generated tokens.css, the token-only lint
  plan/        VideoPlan schema, format specs, retiming from measured audio
  intents/     the four presets — tone, duration band, CTA policy, allowed formats
  tts/         provider interface, Gemini adapter, narration assembly, caption building
  compose/     CONTRACT.md, block primitives, the exemplar, the baseline fallback
  gen/         composer interface, planner, Claude Agent SDK adapter
  render/      hyperframes CLI, the three-gate check, QC, contact sheet
  pipeline/    orchestration and the repair loop
  knowledge/   product facts, the numeric-claim gate, SSRF-safe research, figure extraction
  search/      provider interface, Brave and Exa adapters, the excerpt store
  settings.ts  the two studio-wide preferences: content language, composer
data/
  brand/       kit.json, logos, generated tokens.css
  knowledge/   approved product facts
  research/    per-thread research trail: searches run, pages read, figures found
  videos/      per-video plan, narration, compose workdirs, failed attempts, ledger
```

## Guarantees, and where they are enforced

These are checks in code, not instructions in a prompt — a prompt rule is a suggestion.

- **No colour outside the brand palette.** `findRogueColors` scans authored CSS for hex
  and `rgb()` literals; anything that is not a token is a hard failure.
- **No unverified numbers.** Only approved facts reach a prompt, and an approved fact
  containing a figure without an evidence note is withheld.
- **No banned words on screen.** Checked against the rendered DOM.
- **No copy drift.** Every `onScreen` string must appear verbatim inside its own scene,
  which is also what keeps a text edit re-renderable without the agent.
- **No timing drift.** Scene `data-start` / `data-duration` must match the plan within a
  frame, and `animation.js` must read them from the DOM rather than repeat them, so a
  pacing edit cannot desync picture from narration.
- **No hardcoded canvas size.** One composition serves every format in its family at a
  different root size, so a pixel literal equal to a dimension that varies across them
  (portrait height: 1920 / 1350 / 1080) is rejected — it would be right in one format
  and off-canvas in the rest.
- **No em-dash on screen.** The brand guide's one house rule, checked against `<body>`.
- **No hand-set wordmark.** The brand name standing alone as type is rejected: the mark
  is two typefaces at two sizes on one baseline, so it is placed as a file, never
  reproduced by eye. Splitting it across `<span>`s to style the halves does not evade
  the check.
- **Nothing spoken that is not in the script.** A text-to-speech model handed a
  transcript *and* a delivery direction can read the direction aloud, and the result is
  valid audio that nothing downstream would question. Every clip is measured against the
  word count of its own line; one far longer than speech allows is retried without the
  direction and then refused. This is not hypothetical — it shipped a 17.6-second clip
  for an eight-word line before the guard existed.
- **No silent money.** The agent has no paid tool. Avatar generation will require an
  approval token that only a real click mints, bound to one video and one exact cost, so
  a prompt injected through a fetched web page cannot spend anything.

## Verify

```bash
npm run typecheck
npm test
npm run tokens
npm run research -- https://myherald.io --dry-run
npm run make -- "<a sentence>" --baseline --quality draft
```

Then open `out/<video-id>/contact-sheet.png` and answer the only question no automated
check can settle: **are these frames structurally different from one another?**
