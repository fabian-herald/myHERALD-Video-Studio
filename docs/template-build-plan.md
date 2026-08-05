# Build plan: region contract and layer library

Execution plan for [`docs/template-system-plan.md`](template-system-plan.md) (the plan of
record) and [issue #1](https://github.com/fabian-herald/myHERALD-Video-Studio/issues/1).
That document says *what* and *why*. This one says *who runs what, against which files, and
how the result is verified*. Where the two disagree on a fact about the repo, this one wins
and the correction is called out below.

Built by Sonnet subagents, reviewed by Opus 5 (§9 of the plan of record), then checked by the
owner (§10, and `docs/OWNER-CHECK.md` when it exists).

---

## REMOVED — 2026-08-05

**The system described below was built in full, wired, tested end-to-end, and then deleted.**
~7,500 lines across 129 files: `src/core/compose/regions/`, `src/core/compose/layers/`,
`scripts/template-gallery.ts`, the `templates` setting and its wiring.

The deciding evidence, in order:

1. **Phase 0's gate failed** — 48.6% recurring clusters at tolerance 0.05 against a 60%
   threshold, measured twice by independent implementations that agreed to within 1%.
2. **A composer handed the entire library ignored it.** `gpt-5.6-luna` with `templates.portrait`
   on used zero region classes, zero `data-region` attributes and zero layer items, and never
   linked `regions.css`. Geometry-correct-by-construction, the premise of this whole document,
   never operated once. The owner reviewed the frames and still found overlaps and hidden text.
3. **The frame map was largely redundant with `blocks/base.css`**, whose `.scene` three-row grid
   already enforces it — stated in the map's own evidence file.
4. **The `foot` region already disagreed with where `.folio` actually paints**, on day one. That
   is the maintenance cost arriving before the system shipped.

What replaced it: a one-line information fix in `check.ts` (carry `containerSelector`, the
second party to every collision, through to the composer) and a model change (`composer: claude`).
Full record in [`docs/OWNER-CHECK.md`](OWNER-CHECK.md).

The measurement scripts and their reports are kept deliberately — `regions:evidence`,
`errors:geography`, `errors:baseline` — because they are the reason this was rejected, and
without them someone proposes it again in three months.

**Everything below is the record of what was built and why it did not survive measurement.**
It is kept for that reason, not as a plan to resume.

---

## Outcome so far — 2026-08-05

**Phase 0 failed its gate. Phases 1B through 4 have not been built, and should not be built as
this plan describes them.**

| | measured | threshold |
|---|---|---|
| recurring-cluster share at tolerance 0.05 | **48.6%** | 60% |
| at tolerance 0.03 | 26.7% | — |
| at tolerance 0.08 | 75.4% | — |

Measured twice, independently, by two implementations sharing no code: the Phase 0 agent
(`scripts/region-evidence.ts`) and a separate reviewer script. They agree — 48.6% against
48.6%, and 56.5% when the reviewer swapped first-match greedy clustering for a strictly better
max-coverage method. Element populations agree too: 1978 vs 1990 measured, 1361 vs 1366 after
dropping chrome. **The number is real.** Full report: [`docs/region-evidence.md`](region-evidence.md).

### The finding is more useful than the pass/fail bit

The corpus shares a **frame** and deliberately does not share a **middle**.

Four clusters appear in all ten compositions — the full-bleed field, the masthead band, the
section number, the foot line. Those are the chrome-adjacent edges of the stage, and a region
map that pinned them would be transcribing something real. Above the caption band and below the
masthead, each composition invents its own evidence: the receipt card, the three-day calendar,
the lanes, the stacked sheets. That middle is where 51.4% of elements live as one-offs, and it
is exactly what `CRAFT.md` §3 values ("draw sets, not shapes" — each of those *is* one
composition's own idea).

So the honest reading is neither "stop" nor "proceed as written":

- **Proceeding as written** would pin the middle of the frame with regions the evidence does
  not support, and the risk §11 names first — "every video looks *safe*" — is precisely what
  that would cause.
- **Stopping dead** discards a measured, reproducible finding about where the corpus does agree.

The scope the evidence supports is a **frame contract** — masthead, field, foot, rail — with
the middle left free. That is a much smaller system than §3–§8 of the plan of record describe.
It is the owner's call whether it is worth building, and the plan of record's §4 is explicit
that Phase 1 must not proceed on a hunch.

### What was built and verified anyway

Both are gate-independent and inert by default:

- **Phase 0's measurement**, re-runnable as `npm run regions:evidence`.
- **Phase 1A's plumbing and off-switch** — region schema and validator, deterministic CSS
  emitter, the `templates` setting defaulting to off per family, and the §0 directory-equality
  test. That test was verified to actually bite: perturbing a supplied block makes it fail and
  name the changed file. `prepareAuthoringDir` was deliberately left unwired, per §3's
  constraint, so "templates off" and "before this work existed" are the same code path by
  construction rather than by a flag.

Suite after both agents: **611 tests, 610 pass, 0 fail** (from a 592/591 baseline). Typecheck
clean.

### The thing actually worth having came out of asking why the gate failed

`text_occluded` and `content_overlap` are **two-element** findings. The HyperFrames CLI emits
both parties — the flagged element as `selector`, the offender as `containerSelector`.
`check.ts` read the first and dropped the second at the CLI boundary, so **68 of 77 layout
errors** reached the composer naming one half of a collision.

Fixed in `src/core/render/check.ts` (carry the field) and `src/core/gen/composer.ts` (render it
in `formatFindingForRepair`, the one path both the Claude and Codex adapters share). Five tests
in `src/core/gen/repair-findings.test.ts`. Verified end to end against a real failing
composition — a 2026-08-05 Luna attempt through the real checker — not against a mock.

The label is per code, because the repair differs: **hidden by** (move or re-track that
element), **overlapping** (peers, either may move), **inside** (a box to fit within).

Two of the real findings that surfaced: the supplied caption layer (`p.caption-page`) covering
composer text, and `div.section-number` crossing a `div.time-copy > h1`. Neither is a frame
problem, and no region map would have caught either.

### A correction to this document's own review

An earlier revision of this section claimed the region map was "calibrated to obsolete
geometry" because `base.css` had changed underneath the corpus. **That was wrong**, and the
recalibration agent caught it.

`base.css` still defines `--scene-top: calc(var(--stage-h) * 0.095)`, unchanged and
format-invariant. The `0.152` measured on the exemplar is the *exemplar's own* `styles.css`
overriding `.scene`'s padding — comment in the file: *"Extra masthead room so nothing enters
the lockup's clear space"* — a per-composition, per-asset decision, not the shared contract.
The map's `y = 0.095` was right all along.

What *was* genuinely wrong is narrower and was found by re-measuring: the grid's rows are
`auto`, and their content is sized in **flat pixels** (`--brand-size-section-number: 70px`),
which is a shrinking fraction of a taller canvas and a growing one of a shorter canvas. So
`section-number` occupies 0.0365 of a 9x16 stage but **0.0648** at 1x1 — 1.8×. The old map's
height, tuned to 9x16, undersized the region by nearly half at 1x1.

**One map cannot be exactly right for all three portrait formats' row heights.** `x`, `y` and
`width` are provably safe to share (`--stage-w` is 1080 at 9x16, 4x5 and 1x1 — only `--stage-h`
varies); the `auto` row heights are not. The map now errs generous, sizing from the 1x1 worst
case, and says so. Pinned by `src/core/compose/regions/frame-geometry.test.ts`.

And the honest conclusion, stated in `frame-only.md`: the frame regions are **largely redundant
with `base.css`**. A composition laying out with flow, as `CONTRACT.md` §4 already requires,
lands in these boxes without a region map. The map's only real value is a numeric floor for the
`auto`-sized rows and the masthead/section-number width split.

### One incidental repo finding, verified

`--gutter` changed definition mid-corpus. The July renders carry
`--gutter: calc(var(--stage-w) * 0.065)`; today's `base.css` has
`calc(var(--spine-x) + var(--spine-lane))`, which measures 0.062. Five of the ten compositions
sit on each value. Harmless for clustering — 3px on 1080 — but it means the corpus is not one
homogeneous population, and anything that treats it as one should say so.

---

## 0. Corrections to the plan of record

The plan of record was written before anyone opened the corpus. Three things in it are wrong
or missing, and an agent that follows it literally will produce nothing.

**(a) The rendered compositions are not under `work/portrait`.** That path does not exist.
They are under `data/videos/<video>/render/<format-dir>/`, and the format directory name
varies per video:

| video | render dir |
|---|---|
| `2026-08-04-consistency-point-view-claude-dba0` | `9x16-claude` |
| `2026-07-30-second-draft-7e83` | `9x16-v2` |
| `2026-07-30-short-hours-ideas-claude-2556` | `9x16` |
| `2026-07-30-first-draft-deadline-claude-ce0e` | `9x16` |
| `2026-07-29-filter-gone-claude-63ea` | `9x16` (also `-motion`, `-rate`, `-sustain`; use plain `9x16`) |
| `2026-07-29-finish-argument-then-write-claude-a83a` | `9x16` |
| `2026-07-28-calendar-only-measure-fullness-claude-a2ab` | `9x16` |
| `2026-07-28-promise-monday-understand-thursday-claude-5741` | `9x16` |
| `2026-07-28-slots-statt-gedanken-claude-2a0e` | `9x16` |
| `2026-07-28-eine-woche-ein-gedanke-claude-466b` | `9x16` |

Resolve it by globbing `render/9x16*` and preferring an exact `9x16` when several exist.
Every one is portrait 1080×1920. **There is no landscape composition in the corpus at all** —
see (d).

**(b) A rendered directory is not self-hiding, and `sampleMotion` is the wrong reference.**
`sampleMotion` in `src/core/render/motionGate.ts` shells out to the hyperframes CLI for PNG
snapshots; it never gives you a DOM. And the directory ships `vendor/gsap.min.js` and
`animation.js` but **no hyperframes runtime**, so opening `index.html` over `file://` gives
you every `.clip` visible at once, each frozen at its pre-tween state. Measuring
`getBoundingClientRect()` on that page measures a composition that never appears on screen.

The measurement procedure that actually works is spelled out in the Phase 0 brief (§2).
Use `playwright` directly — it is a devDependency and already used in `scripts/capture.ts`
and `scripts/wordmark.ts`.

**(c) The plan lists no way to run Phase 0.** It gets a script:
`scripts/region-evidence.ts`, wired as `npm run regions:evidence`, so the measurement is
re-runnable rather than a one-off an agent did in its head. Same for Phase 3:
`scripts/template-gallery.ts` / `npm run templates:gallery`.

**(d) Landscape maps have no evidence behind them.** All ten corpus compositions are 9x16.
Phase 1 therefore ships **portrait maps drawn from measurement** and, for landscape, either
nothing at all or maps explicitly marked `"evidence": "none"` in their description. Do not
let a landscape map that nobody measured sit next to a portrait map that somebody did,
undistinguished. This is the same failure §9.3 is guarding against.

Everything else in the plan of record stands, in particular §0 — **templates default to off,
and the off path must stay byte-identical.**

---

## 1. Order of work

```
Phase 0   1 agent    BLOCKING GATE   docs/region-evidence.md
   │
   ├── (runs concurrently, gate-independent) Agent 1A — plumbing + off-switch + equality test
   │
   ▼ gate passes
Phase 1   1 agent    region maps from the evidence + platform-safe-areas.json
   ▼
Phase 2   4 agents   field / structure / type / data, in parallel
   ▼
Phase 3   1 agent    gallery generator + integration smoke test
   ▼
Phase 4   1 agent    rebuild dba07c; record the sameness spread
   ▼
Opus 5 review (§9)  →  owner check (§10)
```

Agent 1A runs alongside Phase 0 on purpose: everything it writes is inert when
`templates` is off, and the directory-equality test it produces is worth having whether or
not the gate passes. Nothing else may start before the gate reports.

---

## 2. Agent brief — Phase 0 (`agent-p0-evidence`)

**Model:** Sonnet. **Blocking.** Nothing downstream starts until this reports.

### Question to answer

Do the ten approved/Claude compositions already place their elements in a small number of
recurring boxes? If yes, region maps are transcription. If no, this whole plan stops.

### Read first

- `docs/template-system-plan.md` §4 (this is your section) and §0
- `src/core/compose/CONTRACT.md` §4 (layout rules) and §5 (blocks) — you need to know which
  classes are supplied chrome rather than composed content
- `src/core/plan/formats.ts` — `captionZone()` gives the reserved caption band
- `scripts/capture.ts` for how this repo drives playwright

### Deliverables

1. `scripts/region-evidence.ts`, wired into `package.json` as
   `"regions:evidence": "tsx scripts/region-evidence.ts"`. It writes both outputs below and
   is deterministic — same corpus, same numbers.
2. `docs/region-evidence.md` — the report.
3. `docs/region-evidence.json` — the raw measurements, so the reviewer can recompute the
   headline number without re-running a browser.

### Measurement procedure — follow this exactly

For each of the ten videos (paths in §0(a) above):

1. Read `data/videos/<video>/plan.json`. Its `sections[]` carry `id`, `startMs`,
   `durationMs`. The scene midpoint in seconds is `(startMs + durationMs / 2) / 1000`.
2. Launch chromium, `viewport: {width: 1080, height: 1920}`,
   `deviceScaleFactor: 1`. Navigate to `file://<abs path>/index.html`.
3. Wait for `window.__timelines` to have at least one entry (`page.waitForFunction`).
   The composition id is on `#stage[data-composition-id]`; take the timeline by that key,
   falling back to the first value.
4. For each scene midpoint `t`:
   - `timeline.seek(t)` inside `page.evaluate`, then `await timeline.progress(timeline.progress())`
     is not needed — GSAP applies synchronously on seek. Do force a style flush by reading
     `document.body.offsetHeight` before measuring.
   - **Apply clip windows yourself**, because no runtime does it here. An element with
     `class="clip"` is active at `t` when
     `t >= +ds.start && t < +ds.start + +ds.duration`. Mark every inactive clip and all of its
     descendants as out of frame; do not measure them. Do not mutate the DOM to do this —
     compute it, so a later seek is unaffected.
   - Measure every remaining element that is **painted**: it has non-whitespace own text, or a
     computed `background-color` with alpha > 0, or a `background-image`, or a visible border.
     Skip it if computed `opacity` is 0, `visibility` is not `visible`, `display` is `none`,
     or its rect has zero width or height.
   - Record: video, section id, `t`, a CSS-path-ish selector, tag, class list, whether it
     carries text, and `getBoundingClientRect()` normalised to stage fractions
     `[x/1080, y/1920, w/1080, h/1920]`.
5. **Exclude supplied chrome from the clustering population**, but record it separately so the
   report can show where it lands: `.brand-rail`, `.brand-seal`, `.rail-rule`, `.rail-lockup`,
   `#caption-layer`, `.caption-layer`, `.caption-page`, `.signal-spine` and its children,
   `#stage` itself, `<audio>`, `<script>`, `<html>`, `<body>`. These are tier 3 in the plan
   and are not what the region map is for.
6. Exclude pure layout wrappers: an element whose rect is within 1% on all four numbers of its
   parent's rect **and** carries no own text and no background. Count how many you dropped this
   way and report it — a large number means the clustering population is thinner than it looks.

### Clustering

Cluster the normalised rects across all sixty-ish scenes. Use a simple, stated method — do not
reach for a library:

- Two rects are in the same cluster when all four normalised numbers are within a tolerance.
  Run it at **three tolerances: 0.03, 0.05, 0.08** and report all three. A result that only
  clears 60% at 0.08 is a different result from one that clears it at 0.03, and the reader
  needs to see which they have.
- A cluster is **recurring** when it contains elements from **three or more distinct videos**
  (not three or more elements — three or more videos; that is what makes it a shared structure
  rather than one composition's habit).
- Headline number: **the fraction of measured, non-chrome elements that fall into a recurring
  cluster.** Report it per tolerance.

### Report contents (`docs/region-evidence.md`)

1. What was measured: video count, scene count, element count, how many dropped as chrome and
   as wrappers.
2. The cluster table at each tolerance: cluster rect, video count, element count, share of
   population, whether members carry text, the most common class names in it.
3. The headline fraction at each tolerance, and **an explicit verdict sentence** naming the
   tolerance it is judged at: *"At tolerance 0.05, N% of elements fall into recurring clusters,
   so the gate passes / fails."*
4. **4–6 candidate portrait region maps** drawn from the clusters — id, description, and the
   `regions` object in the schema shape of plan §5. Regions must not intersect each other, and
   must not intersect `reserved`. `reserved` for portrait is the brand rail lane on the left and
   the caption band from `captionZone("portrait")` = `{x0: 0.06, y0: 0.73, x1: 0.94, y1: 0.88}`.
   Measure the rail's actual width from the corpus rather than guessing it.
5. A short honest section: **what the clusters do not explain.** Which elements are one-offs,
   and whether the one-offs are concentrated in particular videos or scene kinds.

### The gate

If the headline fraction at tolerance **0.05** is **below 60%**, STOP. Write the report, state
the verdict as a failure, do not write candidate maps as if they were usable, and return. Do
not soften the number, do not switch to the 0.08 reading to clear the bar, do not proceed.

### Return to the orchestrator

A short structured summary: pass/fail, the three fractions, element and scene counts, the
candidate map ids, and anything about the corpus that surprised you.

---

## 3. Agent brief — Phase 1A (`agent-p1a-plumbing`), concurrent with Phase 0

**Model:** Sonnet. Writes nothing that depends on region evidence.

### Read first

- `docs/template-system-plan.md` §0 and §12 — binding
- `src/core/settings.ts`, `src/core/compose/workdir.ts` (especially `prepareAuthoringDir`),
  `src/core/compose/workdir.test.ts`
- `src/core/plan/formats.ts`
- Any existing zod schema in `src/core/plan/schema.ts` for house style

### Deliverables

1. **`src/core/compose/regions/schema.ts`**
   - zod schema for a region map exactly as plan §5 specifies: `id`, `family`, `description`,
     `regions` (record of `{rect: [x,y,w,h], role, decorativeOnly?}`), `reserved`.
   - `validateRegionMap(map)` returning findings — at minimum: no two `regions` rects
     intersect; no `regions` rect intersects any `reserved` rect; every rect is inside
     `[0,1]` on both axes; `rect` values are fractions, not pixels (reject anything > 1).
   - A loader that reads `regions/<family>/*.json` and returns validated maps.
2. **`src/core/compose/regions/css.ts`** — `regionCss(map)` emits `.r-<name>` rules as absolute
   boxes in **percentages of the stage**, no pixel literals, no colour. Deterministic output
   (stable key order), because the gallery and the equality test both diff it.
3. **Settings off-switch.** Add to `settingsZ`:
   ```ts
   templates: z.object({
     portrait: z.boolean().default(false),
     landscape: z.boolean().default(false),
   }).default({portrait: false, landscape: false}),
   ```
   Plus `templatesEnabled(settings, family): boolean`. Do not add a UI for it and do not add a
   second knob. Read the comment at the top of `settings.ts` before you touch that file — the
   bar for a new setting is high and this one clears it only because §0 requires it.
4. **The off-path directory-equality test** — the §0 deliverable, and the most important thing
   you write. `src/core/compose/workdir.templates.test.ts`:
   - Runs `prepareAuthoringDir` with templates off.
   - Asserts the produced directory's file list and every file's **bytes** match a manifest of
     what it writes today (hash per file, checked in as a fixture the test regenerates only
     with an explicit env flag).
   - Asserts the prompt/BRIEF text contains no mention of regions or layer items when off.
   - This test must **fail loudly** if anyone later makes templates load-bearing. Write its
     failure message so the reader knows what broke and why the test exists.
5. Tests for 1–3 beside the code, `node --test`, matching the repo's existing style.

### Constraints

- `npm run typecheck` clean. `npm test` clean.
- No behaviour change on the default path. If wiring templates into `prepareAuthoringDir`
  cannot be done without touching the off path, **do not wire it** — leave the emitter
  standalone and say so in your return. The off switch is worth more than the integration.
- No colour literals, no canvas literals, no `../` paths in anything you emit.

---

## 4. Agent brief — Phase 1B (`agent-p1b-maps`), after the gate passes

**Model:** Sonnet. Depends on `docs/region-evidence.md`.

### Deliverables

1. `src/core/compose/regions/portrait/<id>.json` — **4–6 maps**, taken from the Phase 0
   candidate maps. Not invented: every map's description must name the clusters it came from,
   with their share of the population.
2. `src/core/compose/regions/landscape/` — see §0(d). Either empty with a `README.md` saying
   why, or maps carrying `"evidence": "none"` in the description. Your call; state which and
   why in your return.
3. `data/platform-safe-areas.json` — structure, platform list and **honest zeroes**, every
   entry `"verified": false`, per plan §5. **Do not invent inset numbers.** A wrong safe area
   is worse than none. Platforms: `instagram-reels`, `tiktok`, `youtube-shorts`,
   `linkedin-feed`. Include a `note` per platform naming the chrome that has to be measured.
4. A repo-level test asserting **no region map has intersecting rects** and **no map places a
   region inside `reserved`**, running over every file in `regions/`.
5. A zod schema + loader for the safe-area file, with a `verified` filter so nothing unverified
   can be used as a hard gate.

---

## 5. Agent briefs — Phase 2 (four agents, parallel)

**Model:** Sonnet, one agent each: `agent-p2-field`, `-structure`, `-type`, `-data`.

### Standing instructions — every Phase 2 agent, verbatim from plan §6

1. **Read `src/core/compose/CONTRACT.md` and `CRAFT.md` first.** Everything you write is
   subject to them. Where this plan and CONTRACT disagree, CONTRACT wins; say so and stop.
2. **No colour literals.** Brand tokens only, `var(--brand-*)`. Exception: neutral scrims
   `rgba(0,0,0,α)` / `rgba(255,255,255,α)`. `findRogueColors` (in `src/core/brand/tokens.ts`)
   must return `[]` for every file you write.
3. **No canvas literals.** No `1080`, `1920`, `1350`, `1440` in CSS or JS. Use `--stage-w`,
   `--stage-h`, `--u` (1% of the short edge, defined in `blocks/base.css`), or percentages.
   `cqw`/`cqh` are not available.
4. **No `../` paths.** Everything resolves inside the authoring directory.
5. **`transformOrigin` on every scale and rotate.** `checkTransformOrigin` must be clean.
6. **Never select an item by rule.** No regex, no keyword match, no `if (intent === …)`, no
   scoring function that picks an item. The model chooses from a described menu. This is the
   single hardest constraint in the plan and the one that killed the previous attempt —
   see the `dataSeriesZ` comment in `src/core/plan/schema.ts`.
7. **Do not pre-fill.** An item supplies boxes and mechanisms, never copy, never a chart type,
   never a scene sequence. The moment an item ships default text it has become a scene
   template. Placeholders in a *gallery preview* are fine and must live in the gallery, not in
   the item.
8. Tests beside the code, `node --test`, matching the repo's existing style.
9. Every element you emit carries `data-region="<name>"`.
10. Read `src/core/compose/exemplar/` — `index.html`, `styles.css`, `animation.js` — for
    density and typographic confidence before writing anything. It is calibration, not a
    template.

### Item file shape

```
src/core/compose/layers/<layer>/<id>/
  meta.json     the schema in plan §5
  html          a fragment, no <html>/<body>, root carries data-region
  css           scoped to .<id> or [data-layer-item="<id>"]
  js            optional; a function taking (timeline, at, len, WIDTH, HEIGHT)
```

`meta.json` fields: `id`, `layer`, `families`, `regionMaps` (`"any"` or a list of map ids),
`covers` (field only), `ink` (field only), `motion`, `summary`. The `summary` is what the
model reads when it chooses — write it as a description of what the item *is*, never as a
rule about when to use it.

### Agent F — field. 6–8 items.

Must include: a flat brand field; a **two-tone diagonal split** (the owner asked for this
specifically — contrast-rich, dark/light purple with yellow, slow drift, ~2% across the
scene); a warm surface; a plate-over-field; an inverted field for a turn. Every item declares
`covers` and `ink`. Motion must respect CONTRACT §1.8: mass goes *behind* type, never across
it, and a field wipe is one of the two highest-value moves in the system (CRAFT §7).

### Agent S — structure. 6–8 items.

Must include: a **continuous vertical spine** (read the progress-readout carve-out in
`checkPerpetualMotionSource` in `src/core/render/check.ts` — a full-runtime spine is legal
only with `ease: "none"` on its own axis); a repeated set of 3–5 identical cards; a labelled
tick strip; a rule with end caps; a stacked-sheet group with `data-layout-allow-overlap`
waivers declared on **both** the group and each child. CRAFT §3 is the brief here: draw sets,
not shapes.

### Agent T — type. 6–8 items.

Headline systems at display / h1 / h2, a label/kicker system, a source note, a
figure-with-unit pair. All consume `ink` rather than hardcoding colour. CRAFT §1 floors are
hard: body ≥32px, headlines ≥90px, labels ≥24px, rules 2–4px, decorative opacity ≥12%, all on
the 1080-short-edge canvas — expressed in `--u` or the `--brand-size-*` scale, never as
literals. Weight contrast 300 against 900. Tracking −0.03em to −0.05em at display sizes.
Type holds still while it is read (CONTRACT §6a).

### Agent D — data. 4–6 items.

Bars, counter, share, line, plus one "single enormous figure". Every one emits `data-value`,
`data-max` and `style="--fill: …"` per CONTRACT §5b, animates **from zero to the declared
final value** (a 25% bar drawn as 100% states the wrong fact), renders `.data-source`, and
passes `checkDataBarProportions`. Counters use `ease: "none"`.

---

## 5b. The one-element-per-region rule does not survive a free middle

§6's checklist carries "no two elements of the same layer declare the same region". That rule
assumes every region is a *slot*. `portrait-frame-only` has a region that is not: `stage-middle`
is a deliberately unconstrained area where a composition puts its receipt card, its calendar,
its stacked sheets — plural, by design, and `CRAFT.md` §3 is explicit that a repeated set of
five is the point.

Enforced literally, that rule would forbid the exact thing the corpus does best.

So for any map in this frame-only family:

- **Frame regions** (`masthead`, `section-number`, `foot`) are slots. One element of a layer
  each. The check applies.
- **`stage-middle` is multi-occupancy.** The check must skip it. It is identified by its role
  string, not by a hardcoded name — a second map may name its free area something else.

Whoever builds Phase 2's checks must implement the exemption, and must not implement it by
matching the literal id `stage-middle`, which would be rule-based selection creeping back in
through the gate rather than the composer.

## 6. Acceptance criteria — mechanical, per item (plan §7)

An item ships only when every one of these passes. No item ships on judgment alone.

```
□ findRogueColors            → []
□ checkTokens                → []      (includes animation.js)
□ checkCanvasLiterals        → []      across all formats in its families
□ checkTransformOrigin       → []
□ checkLayoutWaivers         → []      or waivers declared on both parties
□ no ../ in any file
□ every element carries data-region naming a region in the map
□ live type clears every verified platform safe area, or its region is decorativeOnly
□ no two elements of the same layer declare the same region
□ every region it names exists in every map it claims compatibility with
□ declared ink matches an approved kit.color.pairs combination
□ renders at every format in `families` with no new findings
```

Plus the two repo-level tests from §4.4.

**The suite exits 0 on failures in this repo** — that has already caused one bad commit here.
Read the actual findings array, do not read the exit code.

---

## 7. Phase 3 — gallery (`agent-p3-gallery`)

`scripts/template-gallery.ts`, wired as `"templates:gallery": "tsx scripts/template-gallery.ts"`,
writing `docs/template-gallery.html`: one self-contained page, no server, no build, openable
from the filesystem. It shows:

1. **Every region map**, per format, as labelled translucent boxes over a stage outline, with
   `reserved` drawn differently — so an overlap is visible at a glance.
2. **Every layer item** rendered on its own, at each format it claims.
3. **Eight random valid stacks** (field + structure + type + data on one region map) as static
   frames. Random means seeded and reproducible, and the seed is printed on the page.
4. **Rebuilt-dba07c beside the original contact sheet**
   (`src/core/compose/exemplar/reference-contact-sheet.png` is the exemplar's; dba07c's own
   render lives under its `render/9x16-claude/snapshots/`).
5. **Platform safe areas as hatched overlays**, toggleable per platform, clearly marked when
   `verified: false`.

Plus an integration smoke test: build one composition from a map + one item per layer, and run
the real `checkComposition` over it.

Placeholder copy belongs here and nowhere else (§5 instruction 7).

## 8. Phase 4 — reproduction proof (`agent-p4-proof`)

Rebuild `2026-08-04-consistency-point-view-claude-dba0` scene-for-scene using only region maps
and layer items. Not pixel-identical — structurally equivalent: same six scenes, same region
occupancy, same repeated sets, within **10%** on elements / cssRules / gsapCalls and within
**2** on `minElementsPerScene`.

Measure dba07c's real numbers from its files. Do not quote the numbers in the plan of record;
recompute them.

Then the **sameness floor**: generate 8 compositions from the library with different maps and
picks, and report the spread of elements-per-scene, distinct entrances, and
elements-in-repeated-sets. If eight runs converge on one look, say so plainly — that is the
finding, not a failure to be hidden.

If the approved composition cannot be expressed in the grammar, report what it could not
express. Do not bend the metric.

---

## 9. Opus 5 review protocol

Verbatim from plan §9, and it is not a rubber stamp:

1. **Re-run every acceptance check independently.** Do not trust a reported pass.
2. **Grep for rule-based selection.** Any regex, keyword match or intent switch that picks a
   template is a stop-ship.
3. **Verify the region-evidence gate was honestly applied** — that the 60% threshold was
   measured, not asserted, and read at tolerance 0.05.
4. **Check the reproduction proof against dba07c's real numbers**, recomputed.
5. **Read the diff for pre-filled copy.** Any default text in an item is a scene template
   wearing a layer's clothes.
6. **Confirm density did not fall.** Corpus reference: exemplar 536 elements / 99 css rules /
   107 gsap calls / minEl 11. Recompute rather than quote.
7. **Verify the off path.** Run the §0 equality test, and check by hand that `git diff` touches
   no existing behaviour on the default path.

## 10. How the owner checks it

```bash
npm run templates:gallery
```

then open `docs/template-gallery.html`. `docs/OWNER-CHECK.md` (written at the end) lists what
to look for and what a bad answer looks like, so the check is a judgment about the pictures
rather than a hunt for what to judge.

## 11. Out of scope, stated so a green gallery does not imply otherwise

**Motion quality.** Roughly half of what reads as unfinished is animation. Nothing here
improves easing, timing, or whether a transition feels deliberate. Separate, unstarted work.

**Screens, focus rects, presenter slots.** They exist in the schema and no exemplar
demonstrates any of them. Strongest future case for this system; deferred until the grammar
proves itself on ordinary scenes.

**Landscape.** No measured evidence exists — §0(d).
