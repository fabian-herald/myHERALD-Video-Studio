# A region contract and a layer library

Plan of record for the template work. Written for a fresh session that will run Sonnet
subagents to build it, reviewed afterwards by Opus 5, then checked by the owner in a browser.

---

## 0. This is optional, and it is off until it earns being on

Read this before anything else, because it constrains every other decision here.

**Nothing in this plan may become load-bearing.** With templates disabled the studio must
behave exactly as it does today — same prompt, same freedom, same output quality — and that is
a property to be tested, not assumed. Concretely:

- The setting is `templates` in `data/settings.json`, resolved per format family, and it
  **defaults to `off`**. Templates are unproven; today's path is not. The default flips only
  after the reproduction proof in §8 passes and the owner has looked at the gallery.
- When off, the region CSS is not linked, no layer item is mentioned in the prompt, and the
  authoring directory is byte-identical to what `prepareAuthoringDir` writes today. A test must
  assert that directory equality — it is the only way to know the escape hatch still works.
- No checker rule may depend on a region map existing. Every gate added by this work is skipped
  when templates are off, and no existing gate changes behaviour.
- Nothing here edits `CONTRACT.md`, the exemplar, or the supplied blocks.

If any deliverable cannot satisfy that, it is out of scope. The freedom to turn this off is
worth more than anything it buys.

---

## 1. Why, in one measurement

Every blocking error across the two Luna runs of 2026-08-05, categorised:

```
24  layout: Two text blocks overlap and may render unreadable
20  layout: Text is hidden beneath an opaque element
14  layout: Text extends outside its nearest visual/container box
 3  layout: Rotating element is not spinning about its own center
```

**61 of 61 are geometry.** Not one says the idea was weak, the chart was wrong, or the
sequence was flat. The composer's judgment is not what fails. Its ability to place a box is.

That is the case for constraining geometry and nothing else.

### The harder half: clean is not good

A second observation, from the owner, on a run that passed:

> it still often looks not good/finished — still overlapping items, the animations are often
> not looking good

This is the fact that matters most to whoever picks this work up, and it cuts two ways.

**It strengthens the plan.** The checker validates geometry *after* the model has guessed at it,
and a composition can satisfy every rule and still read as unfinished — overlaps the gates score
as legal, motion that is technically correct and visually wrong. Validation after the fact has a
ceiling, and this is what the ceiling looks like. Regions make the geometry correct *by
construction* rather than correct *on inspection*, which is the only structural answer to
"passes and still looks bad."

**It also warns against over-trusting the plan.** Region maps address placement. They do not
address whether an animation is any good, and roughly half of what the owner is describing is
motion, not layout. Nothing in this document improves easing, timing, or whether a transition
reads as deliberate. Do not let a green gallery imply the problem is solved — §8's sameness
spread and §10's stacks are the honest evidence, and both are about layout only.

Motion quality is a separate, unstarted piece of work. Say so rather than quietly folding it in.

## 2. The failure this must not repeat

`src/core/plan/schema.ts` records what happened last time, in the comment on `dataSeriesZ`:

> A kind would hand the composer a scene template to fill, which is the failure this whole
> architecture exists to escape — the previous studio chose from twelve hardcoded layouts by
> regex and produced one layout six times.

Two things were bolted together there: **complete scene layouts**, and **selection by regex**.
This plan rejects both. Nothing here decides a chart type, a sequence, or a piece of copy, and
nothing here is ever selected by code — the model always chooses.

## 3. Structure: neither pure layers nor complete scenes

The owner's question was whether to build independent layer stacks or whole structures. The
error counts answer it, and the answer is a third thing.

- **Pure independent layers cannot work.** 20 of 61 errors are "text hidden beneath an opaque
  element" — a *cross-layer* collision. If an agent can freely pick background #7 and label
  system #3, nothing knows that #7's diagonal panel lands where #3 puts its caption. Free
  composition of layers ships that bug as an architecture.
- **Complete scene structures bring back "one layout six times."**

What both need, and what neither supplies, is a **shared region map**. So: three tiers.

| tier | what it is | how many | who varies it |
|---|---|---|---|
| **1. Region map** | named, non-overlapping boxes as stage fractions, per format family | few (4–6 per family) | rarely; this is the contract |
| **2. Layer library** | field / structure / type / data items, each declaring the regions it uses | many | this is where variety lives |
| **3. Supplied blocks** | caption layer, brand rail | unchanged | not touched by this work |

A region map is geometry only — no colour, no copy, no motion, no brand. That is what keeps it
reusable for another company later: a new client is a new `tokens.css`, not new templates.

### What this buys, precisely

Do not overclaim. Being honest about each:

- **Overlap between regions — eliminated by construction.** Regions do not intersect, and an
  element declares exactly one. Two elements in one region is a one-line static check.
- **Text under an opaque element — becomes a static check.** Every painting item declares which
  regions it covers and what ink it leaves. A type item in a covered region with the wrong ink
  is detectable without a browser.
- **Text overflowing its container — improved, not solved.** The region gives the composer a
  real box to size against, and turns a vague failure into a local one. It does not make text
  fit by itself.
- **Rotation origin — unaffected.** Already gated as an error; leave it alone.

Expect this to remove the first two classes (44 of 61) and shrink the third. That is the claim
to test, and Phase 4 tests it.

### Where the owner's background idea lands

"Diagonally cut, two contrast-rich colours, slowly moving" is a **tier-2 field item**. It
declares:

```json
{"covers": ["head", "lede"], "ink": {"head": "on-dark", "lede": "on-dark", "figure": "on-light"}}
```

which is what makes a type item's colour choice checkable against it. Exactly the right shape.

---

## 4. Phase 0 — the stop/go gate. Do this before building anything.

**Question:** do the approved Claude compositions already share a region structure?

If they do, the maps are transcription and the rest of this plan is worth building. If they
do not, templates will fight the work the owner likes, and the plan should stop here.

**Corpus** — ten compositions in `data/videos/`:

```
2026-08-04-consistency-point-view-claude-dba0   ← approved
2026-07-30-second-draft-7e83                    ← approved
2026-07-30-short-hours-ideas-claude-2556
2026-07-30-first-draft-deadline-claude-ce0e
2026-07-29-filter-gone-claude-63ea
2026-07-29-finish-argument-then-write-claude-a83a
2026-07-28-calendar-only-measure-fullness-claude-a2ab
2026-07-28-promise-monday-understand-thursday-claude-5741
2026-07-28-slots-statt-gedanken-claude-2a0e
2026-07-28-eine-woche-ein-gedanke-claude-466b
```

**Method.** Do not read the CSS and guess. Measure where elements actually land:

1. For each composition, `prepareAuthoringDir`-equivalent is not needed — the rendered dirs
   under `work/portrait` already have every stylesheet.
2. Load `index.html` in a headless browser (the project already drives one; see
   `sampleMotion` in `src/core/render/check.ts`) and read `getBoundingClientRect()` for every
   element carrying text or a background, at the midpoint of each scene.
3. Normalise to stage fractions.
4. Cluster the boxes across all sixty scenes. Report: how many distinct box positions recur in
   three or more compositions, and what fraction of all elements they account for.

**Deliverable:** `docs/region-evidence.md` — the cluster table, plus 4–6 candidate region maps
per family drawn from the clusters, plus an explicit verdict sentence.

**Gate:** if fewer than 60% of elements fall into recurring clusters, stop and report. Do not
proceed to Phase 1 on a hunch.

---

## 5. File layout

```
src/core/compose/regions/
  portrait/<id>.json          region maps, stage fractions
  landscape/<id>.json
  schema.ts                   zod schema + non-overlap validator
  css.ts                      region map → CSS (.r-<name> absolute boxes)
src/core/compose/layers/
  field/<id>/{meta.json,html,css,js}
  structure/<id>/…
  type/<id>/…
  data/<id>/…
  schema.ts
docs/region-evidence.md       Phase 0 output
docs/template-gallery.html    generated; the owner's check
```

### Region map schema

```json
{
  "id": "portrait-editorial-split",
  "family": "portrait",
  "description": "Headline band, split body with a figure right, full-width support strip.",
  "regions": {
    "head":    {"rect": [0.074, 0.10, 0.852, 0.10], "role": "headline"},
    "lede":    {"rect": [0.074, 0.24, 0.520, 0.28], "role": "body"},
    "figure":  {"rect": [0.620, 0.24, 0.306, 0.28], "role": "figure"},
    "support": {"rect": [0.074, 0.56, 0.852, 0.16], "role": "support"},
    "foot":    {"rect": [0.074, 0.74, 0.852, 0.05], "role": "meta"}
  },
  "reserved": {
    "rail":    {"rect": [0.000, 0.00, 0.055, 1.00]},
    "caption": {"rect": [0.055, 0.80, 0.890, 0.18]}
  }
}
```

`rect` is `[x, y, width, height]` as fractions of the stage. `reserved` belongs to the supplied
blocks; no layer item may place there. Roles are advisory labels, not selectors.

### Platform safe areas

A region map answers "do these boxes collide with each other." It says nothing about the app
chrome painted **on top of** the finished video — Instagram's action rail and caption block,
TikTok's right-hand column, Shorts' title bar. A headline placed perfectly inside its region
can still sit under a share button, and no gate in this repo would notice.

Safe areas are the third rectangle set, beside `regions` and `reserved`, and they live outside
the maps because they belong to a platform rather than to a layout:

```
data/platform-safe-areas.json
{
  "instagram-reels": {
    "9x16": {"top": 0.00, "right": 0.00, "bottom": 0.00, "left": 0.00, "verified": false},
    "note": "action rail right, caption and username bottom, status bar top"
  },
  "tiktok":          {"9x16": {…, "verified": false}},
  "youtube-shorts":  {"9x16": {…, "verified": false}},
  "linkedin-feed":   {"1x1": {…}, "4x5": {…}, "verified": false}
}
```

**Do not invent these numbers.** Every inset ships `verified: false` and a zero until someone
measures it from a current screenshot of the app at a known device size — the overlays move
between app versions, and a confidently wrong safe area is worse than none because it silently
pushes every composition inward for nothing. Phase 1's agent produces the file with the
structure, the platform list and honest zeroes; a separate task fills it in from screenshots
and flips `verified`.

Wiring, once values exist:

- The plan (or settings) names the target platforms for a video. The check evaluates region maps
  against the **union** of their safe areas, since one render is usually posted several places.
- A region carrying live type that intersects a verified safe area is a **warning**, naming the
  platform and the overlap. Not an error: a decorative field bleeding under the caption block is
  correct and common, and only text and data figures genuinely have to clear it.
- A region may declare `"decorativeOnly": true` to opt out, which is the honest way to say
  "this one is a background and may sit under the chrome."
- The gallery (§10) draws safe areas as hatched overlays per platform, toggleable. That is the
  fastest way for the owner to judge, and it works whether or not the numbers are verified yet.

Safe areas are inert while templates are off, per §0.

### Layer item schema

```json
{
  "id": "field-diagonal-duotone",
  "layer": "field",
  "families": ["portrait", "landscape"],
  "regionMaps": "any",
  "covers": ["head", "lede"],
  "ink": {"head": "on-dark", "lede": "on-dark"},
  "motion": "drift",
  "summary": "Two-tone diagonal split that drifts 2% across the scene."
}
```

`layer` is one of:

- **field** — backgrounds, plates, duotone splits. Paints. Must declare `covers` and `ink`.
- **structure** — rules, spines, ticks, repeated sets, frames. Little or no text.
- **type** — headline / label / figure / source systems. Consumes `ink`.
- **data** — bars, counter, share, line. Must honour the CONTRACT §5b data attributes.

---

## 6. Work breakdown for the Sonnet subagents

Run phases in order; agents **within** a phase run in parallel.

| phase | agents | deliverable |
|---|---|---|
| 0 | 1 | `docs/region-evidence.md` + candidate maps. **Blocking gate.** |
| 1 | 2 (portrait, landscape) | region maps + `schema.ts` + `css.ts` + `platform-safe-areas.json` (structure, honest zeroes) + the off-path directory-equality test from §0 + tests |
| 2 | 4 (one per layer) | 6–8 items each, with meta, files and tests |
| 3 | 1 | gallery generator + integration smoke test |
| 4 | 1 | reproduction proof (see §8) |

### Standing instructions for every agent

1. **Read `src/core/compose/CONTRACT.md` and `CRAFT.md` first.** Everything you write is
   subject to them. Where this plan and CONTRACT disagree, CONTRACT wins; say so and stop.
2. **No colour literals.** Brand tokens only, `var(--brand-*)`. `findRogueColors` must return
   empty for every file you write.
3. **No canvas literals.** No `1080`, `1920`, `1440` in CSS or JS. Use `--stage-w`, `--stage-h`,
   `--u`, or percentages.
4. **No `../` paths.** Everything resolves inside the authoring directory.
5. **`transformOrigin` on every scale and rotate.** `checkTransformOrigin` must be clean.
6. **Never select an item by rule.** No regex, no keyword match, no `if (intent === …)`. The
   model chooses from a described menu. This is the single hardest constraint in the plan and
   the one that killed the previous attempt.
7. **Do not pre-fill.** A template supplies boxes and mechanisms, never copy, never a chart
   type, never a scene sequence. The moment an item ships default text it has become a scene
   template.
8. Write tests beside the code, `node --test`, matching the repo's existing style.

### Phase 2 division

- **Agent F — field.** 6–8 items. Must include: flat brand field; two-tone diagonal split (the
  owner asked for this specifically — contrast-rich, dark/light purple with yellow, slow drift);
  a warm surface; a plate-over-field; an inverted field for a turn. Each declares `covers`/`ink`.
- **Agent S — structure.** 6–8 items. Must include: a continuous vertical spine (see the
  progress-readout carve-out in `checkPerpetualMotionSource` — this is legal, the exemplar does
  it); a repeated set of 3–5 identical cards; a labelled tick strip; a rule with end caps; a
  stacked-sheet group with waivers declared on **both** the group and each child.
- **Agent T — type.** 6–8 items. Headline systems at display/h1/h2, a label/kicker system, a
  source note, a figure-with-unit pair. All must consume `ink` rather than hardcoding colour.
  Sizes respect the CRAFT.md floors: body ≥32px, headlines ≥90px, labels ≥24px.
- **Agent D — data.** 4–6 items. Bars, counter, share, line, plus one "single enormous figure".
  Every one must emit `data-value`, `data-max` and `style="--fill: …"` per CONTRACT §5b and pass
  `checkDataBarProportions`.

---

## 7. Acceptance criteria — mechanical, per item

An item is done when all of these pass. No item ships on judgment alone.

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

Add one repo-level test asserting **no region map has intersecting rects**, and one asserting
**no layer item places inside `reserved`**.

---

## 8. Reproduction proof — the thing that decides whether this was worth it

Phase 4, one agent, and it is the real acceptance test for the whole system:

**Rebuild `dba07c` scene-for-scene using only region maps and layer items.** Not pixel-identical
— structurally equivalent: same six scenes, same region occupancy, same repeated sets, within
10% on `compositionSize` elements / cssRules / gsapCalls and within 2 on `minElementsPerScene`.

If the approved composition cannot be expressed in the grammar, the grammar is wrong. Report
what it could not express rather than bending the metric.

Also record the **sameness floor**: generate 8 compositions from the library with different
region maps and layer picks, and report the spread of elements-per-scene, distinct entrances,
and elements-in-repeated-sets. If eight runs converge on one look, say so plainly.

---

## 9. Opus 5 review protocol

After the agents finish, Opus 5 reviews. Not a rubber stamp — the specific things to verify:

1. **Re-run every acceptance check independently.** Do not trust a reported pass; the suite
   exits 0 on failures, which has already caused one bad commit in this project.
2. **Grep for rule-based selection.** Any regex, keyword match or intent switch that picks a
   template is a stop-ship. This is the documented previous failure.
3. **Verify the region-evidence gate was honestly applied** — that the 60% threshold was
   measured, not asserted. An unmeasured claim has already been shipped once in this work.
4. **Check the reproduction proof against dba07c's real numbers**, not against numbers the
   agent reported.
5. **Read the diff for pre-filled copy.** Any default text in an item is a scene template
   wearing a layer's clothes.
6. **Confirm density did not fall.** Compare against the corpus: exemplar 536 css / 99 rules /
   107 gsap / minEl 11, dba07c the same. The CRAFT.md episode showed guidance can cost a third
   of a composition's structure without anyone noticing.

---

## 10. How the owner checks it

`npm run templates:gallery` writes `docs/template-gallery.html`, a single self-contained page,
openable in the Browser pane. It shows:

1. **Every region map**, per format, drawn as labelled translucent boxes over a stage outline —
   so overlaps and reserved-area collisions are visible at a glance.
2. **Every layer item**, rendered on its own, at each format it claims.
3. **Eight random valid stacks** — field + structure + type + data on one region map — as static
   frames, which is the fastest way to judge whether they all look the same.
4. **A side-by-side of rebuilt-dba07c against the original contact sheet.**

The page needs no server and no build. Open it, scroll, and disagree.

---

## 11. Risks, and the honest reading

- **Sameness.** Real, and measurable rather than arguable — §8 records the spread. The subtler
  version is not "every video looks alike" but "every video looks safe": a composer stops
  inventing when the frame is already half-filled. Watch `minElementsPerScene` and
  elements-in-repeated-sets.
- **Density collapse.** Demonstrated this week: a numeric ceiling in CRAFT.md was read as a
  target and text runs fell 61 → 24 with a third of the elements. Templates are a much louder
  signal than a paragraph. §9.6 exists for this.
- **Regressing to the twelve-layouts studio.** The one-line defence is instruction 6: the model
  picks, code never does.
- **Brand lock-in.** Mitigated by keeping region maps geometry-only. Worth re-testing once by
  swapping `tokens.css` for a fake second brand and rendering the gallery.
- **Screens and avatars.** The strongest case for this work and the least served today —
  `screen`, `focusRect` and `presenterSlot` exist in the schema and **no exemplar demonstrates
  any of them**. Deliberately out of scope for this pass; add region maps for them next, once
  the grammar has proven itself on ordinary scenes.

## 12. Off switch

Specified in §0, which is binding. Restated here so it is not missed: `templates` in
`data/settings.json`, resolved **per format family** rather than globally — so screens and
avatars can be templated later while ordinary narrated scenes stay free — and **defaulting to
off** until §8's reproduction proof passes. The directory-equality test in §0 is the deliverable
that proves the off path is really untouched.
