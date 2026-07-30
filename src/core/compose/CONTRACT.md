# Composition contract

You are authoring a **HyperFrames composition** — real HTML, CSS and GSAP that renders
deterministically to video, frame by frame, in headless Chrome.

You will be given: a `plan.json`, a generated `tokens.css`, a set of block stylesheets,
a reference exemplar, and a working directory. You write three files into that directory:

```
index.html      the composition
styles.css      scene-specific styling (imports nothing; blocks are linked separately)
animation.js    one paused GSAP timeline
```

Everything else in the directory is provided and must not be modified.

---

## 1. Hard framework rules — violating any of these produces a broken render

1. The root element carries `data-composition-id`, `data-width`, `data-height`,
   `data-duration`, `data-fps`. **These are pre-filled in the scaffold — do not change them.**
2. Every timed element needs **all four**: `class="clip"`, `data-start`, `data-duration`,
   `data-track-index`. Seconds, not milliseconds. An element missing `class="clip"` will
   not be hidden outside its window.
3. The timeline must be **paused** and registered:
   ```js
   window.__timelines = window.__timelines || {};
   window.__timelines["<composition-id>"] = timeline;   // gsap.timeline({paused: true})
   ```
   The renderer seeks this timeline per frame. A timeline that plays itself renders wrong.
4. **Deterministic only.** No `Date.now()`, no `Math.random()`, no `fetch`, no remote
   fonts, images, scripts or stylesheets. Everything is local and already present.
5. Audio is a single `<audio class="clip">` element pointing at the provided narration.
   Videos use `muted` plus a separate `<audio>` if they carry sound.
6. Animate with GSAP only — its clock is seekable. CSS `@keyframes` animations are not
   frame-accurate under seek and will render as frozen or wrong.
7. Prefer `autoAlpha`, `x`/`y`, `scale`, `rotation`, `clipPath`, `scaleX`/`scaleY`,
   `strokeDashoffset`. Set `transformOrigin` explicitly whenever you scale or rotate.
8. **Nothing may sit completely still for more than one second.** After a scene's
   entrance finishes it must keep moving — a slow drift, a growing rule, a rotating
   mark, a staggered late reveal. A held still frame reads as a stall to a viewer and
   fails the freeze check, which no amount of passing `check` will save.

   **What moves has to have area.** The check averages the change across the whole
   frame, so a hairline crossing a 1080×1920 canvas alters a few thousand pixels out of
   two million and counts as nothing at all. A field, a card, a large mask, a counting
   figure, a shifting block of colour: those register. A one-pixel rule does not, however
   far it travels — this is measured, and a full-duration `.signal-spine` on its own has
   already failed it. BRIEF.md gives you, per scene, the longest stretch in which the
   caption layer changes nothing; in those stretches your motion is the only thing in the
   picture, and it is sampled **before** the video is rendered, not after.
9. **Never hardcode a scene's time in `animation.js`. Read it from the DOM.**

   ```js
   const at = (id) => parseFloat(document.querySelector(id).dataset.start);
   const len = (id) => parseFloat(document.querySelector(id).dataset.duration);

   timeline.fromTo("#scene-hook h1", {autoAlpha: 0, y: 60},
     {autoAlpha: 1, y: 0, duration: 0.5}, at("#scene-hook") + 0.06);
   ```

   Position every scene-local tween as `at("#scene-x") + offset`, and derive anything
   that runs to the end of a scene from `len("#scene-x")`. Only the composition's own
   total duration may be read once from the root element.

   This is not a style preference. The owner edits copy and pacing directly in the
   plan, which shifts every later scene; if your timings are literals the picture and
   the narration drift apart on the very next edit, and fixing it costs a full
   re-author. Reading from the DOM makes those edits free and correct.

10. **The same goes for the canvas size. Never write a pixel dimension as a literal.**

    ```js
    const stage  = document.querySelector("[data-composition-id]");
    const HEIGHT = parseFloat(stage.dataset.height);
    const WIDTH  = parseFloat(stage.dataset.width);

    timeline.fromTo(".spine-node", {y: 0}, {y: HEIGHT, duration: TOTAL, ease: "none"}, 0);
    ```

    **One composition serves every format in its family**, re-emitted at a different
    root size: portrait is 1080×1920, 1080×1350 and 1080×1080. A `1920` written into
    `animation.js` is right in the one format you happened to picture and wrong in the
    other two, where the element travels off the canvas and stays there. This is
    checked, and it is an error.

    Better still, reach for units that need no number at all — `cqw` / `cqh`,
    percentages, and the `--u` scale variable adapt on their own.

## 2. Colour: tokens only

`tokens.css` is linked first and defines every colour you may use, as `var(--brand-*)`.

- **Never write a hex, `rgb()` or `hsl()` colour literal in `styles.css`.**
- The only exceptions are neutral scrims: `rgba(0,0,0,α)` and `rgba(255,255,255,α)`.
- A rogue colour literal is a **hard failure** and the composition is rejected.
- Only use foreground/background combinations listed in the plan's approved contrast
  pairs. Inventing a pair will fail the WCAG contrast pass.

## 3. Plan conformance — this is what makes the video re-editable

The plan is the durable artefact; your composition is keyed to it.

- One top-level `<section class="scene clip">` per plan section, with
  `id="scene-<section.id>"`.
- `data-start` = `section.startMs / 1000`, `data-duration` = `section.durationMs / 1000`.
  Use the exact numbers from the plan. Do not re-time anything — the timings come from
  measured narration audio and are already correct.
- **Every `section.onScreen` string must appear verbatim in that section's DOM text.**
  You may split it across elements and wrap parts in `<em>` or `<span>`, but the
  concatenated text content must contain the string exactly, including punctuation.
  Do not paraphrase, do not translate, do not change case via text (use CSS for that).
- Do not invent additional copy that makes claims. Decorative labels ("ANGLE", "MON",
  "STATUS") are fine; new factual statements are not.
- If a section has `mediaId`, render `<img src="media/<mediaId>.png">` (or `<video>` for
  a clip). The real file is copied in under that exact name. Never invent a path.
- If a section has `slot`, render `<div class="presenter-slot style-<slot.style>"
  data-placeholder-label="PRESENTER — Ns">` sized and positioned for a person.
  Do not put a `<video>` inside it — the assembler binds media later.

## 4. Layout rules

- The composition serves several canvas sizes in the same family. **Lay out with flow,
  not absolute top offsets.** `.scene` is a three-row grid (masthead / body / footer);
  put your content in `<div class="scene-body">`.
- Sizes derive from `--stage-w`, `--stage-h`, `--gutter` and the `--brand-size-*` scale.
  Absolute pixel values are acceptable only for hairlines, dots and small fixed marks.
- **`--gutter` is the content inset and the left edge of everything readable.** The strip
  between the canvas edge and `--gutter` is a reserved lane: it carries the full-height
  spine at `--spine-x` and nothing else. Never position copy, a label or the logo as a
  fraction of the gutter — that is how they end up flush against a moving accent line.
- The bottom caption band is reserved by `.scene` padding. **Never place copy there.**
- `position: absolute` inside a scene is fine when anchored to an edge or a percentage —
  just never to a hardcoded vertical pixel offset.
- Add `data-layout-allow-overflow` to any element that intentionally bleeds off-canvas,
  otherwise the layout check flags it.

## 5. Blocks

Linked before your `styles.css`. Use them; do not reimplement them.

| Block | Class | Status |
|---|---|---|
| `base.css` | `#stage`, `.clip`, `.scene`, `.scene-body`, `.field`, `h1`, `h2` | always active |
| `brand-rail.css` | `.brand-rail`, `.brand-seal`, `.rail-rule` | **mandatory** — one, full duration, high track |
| `caption-layer.css` | `.caption-layer`, `.caption-page` | **mandatory** — one empty `<div id="caption-layer">` |
| `cta-lockup.css` | `.cta-lockup`, `.cta-seal`, `.cta-url` | **mandatory when the plan has a `cta` section** |
| `editorial.css` | `.kicker`, `.section-number`, `.folio`, `.editorial-grid`, `.signal-spine`, `.rule`, `.paper-card`, `.tag` | mostly optional — but see below |
| `presenter-slot.css` | `.presenter-slot` | required when a section has a slot |
| `screen.css` | `.screen-stage`, `.screen-shot`, `.screen-frame`, `.screen-window`, `.focus-label`, `.data-bar`, `.data-figure`, `.data-source` | required when a section has a `screen` or `data` block |

**One continuous element is mandatory.** Include `.signal-spine` — or an equivalent of
your own design — as a full-duration clip on a low track, animated across the entire
composition (the spine's line grows and its node travels). It carries the brand's "one
thread through the whole piece" rule.

It does **not** satisfy §1.8 on its own. A spine is a hairline, and the freeze measure
averages change across the whole frame: compositions carrying a perfectly good spine have
frozen anyway, because a line one pixel wide changes too little of the canvas to count.
The spine is the thread; the motion with area is a separate thing each scene needs.

Add `.on-light` to `.brand-rail`, `.kicker`, `.section-number` and `.rule` when they sit
on a light field; `.on-dark` to `.cta-lockup` when it sits on the dark field.

### 5a. Screenshots, and moving through them

When a section carries a `screen` block, the brief gives you the file, the chrome and a
list of focus rects with times. The shot is real product evidence — never redraw it, never
fake a UI, never crop it to hide something.

```html
<div class="screen-stage">
  <img class="screen-shot" src="media/<mediaId>.png" alt="">
</div>
```

To move to a focus rect whose fraction of the image is `x, y, w, h`:

```js
gsap.to("#scene-x .screen-shot", {
  transformOrigin: `${(x + w / 2) * 100}% ${(y + h / 2) * 100}%`,
  scale: 1 / Math.max(w, h),   // the rect fills the stage's shorter axis
  duration: 0.9, ease: "power3.inOut",
});
```

Set `transformOrigin` on the same tween, not before it. Left at its default the frame
drifts toward the middle of the image no matter which detail it was aimed at, which is the
one failure that looks deliberate and is not.

**A full-page screenshot at stage size teaches nothing.** If a section talks about a
control, the frame has to arrive at that control. A shot held whole for eight seconds while
the narration describes a detail inside it is a failed scene even though every check passes.

### 5b. Figures on screen

When a section carries a `data` block, the brief gives you labels, values, a unit and a
suggested shape. **The shape is a suggestion.** Four values might be bars, or one enormous
figure with three small ones under it, or a single count-up — pick what suits the scene you
are building, and do not let a chart become the only thing in the frame.

Two things are not negotiable:

- **Animate the arrival.** `.data-bar > span` grows by tweening `--fill` from 0 to 1; a
  `.data-figure` counts up. A chart that cuts in at its final value has no reason to be a
  video.
- **Render the source note** in `.data-source`. The brief gives you the text. A figure on
  screen with no attribution is not something anyone can cite, and you cannot invent one.

Never state a figure the brief did not give you, and never round one to look neater.

## 6. The rule that actually decides whether this is any good

**Every scene must be a structurally different composition.**

This is the single failure mode that matters. A sequence of six centred cards with
different text is a failed video even when every check passes. The frames of a good
piece are recognisably different from each other at thumbnail size.

Give each scene a distinct spatial archetype. Pick from — and extend — ideas like:

- one enormous headline with everything else stripped away
- a paper artefact at an angle, with fragments scattered around it
- two columns with a transformation mark between them
- a vertical spine with staggered entries hanging off it
- a full-bleed colour field where the palette inverts entirely
- a single object dead-centre with concentric rings
- a corner-anchored lockup with a hairline running to the opposite edge
- a horizontal band across the middle with the canvas empty above and below

Vary these axes across the sequence: **where the mass sits** (left / right / centre /
edge), **the dominant shape** (type / card / line / circle / field), **the background**
(paper / white / accent / the rare inverse field), and **the direction of motion**
(in from the left / up from below / scale from centre / wipe from the bottom).

Two adjacent scenes must never share an archetype. If your composition would render six
variations of one layout, throw it away and start again — that is exactly the outcome
this whole system exists to prevent.

Motion follows the same rule: entrances differ per scene. Everything sliding up with a
stagger is the motion equivalent of six identical cards.

### Fill the frame, and keep it alive

A headline floating in an otherwise empty canvas is the second failure mode after
repetition. Every scene needs **at least three visual elements working together** —
typically the headline plus two of: a supporting artefact (card, note, strip), a
structural line or rule, a set of small labelled marks, a number or counter, a diagram,
a field of colour. Corner slugs and the section number are chrome, not content; they do
not count.

Aim for a composition that would still read as deliberate with the type removed. If a
frame has one object in the middle and air everywhere else, add structure: anchor
something to an edge, run a line across the canvas, stack a second layer behind.

Movement is continuous, not a single entrance. Alongside the entrance give each scene
**one** sustained motion for as long as it is on screen: a slow drift or scale, a line
that keeps drawing, a mark that rotates, elements that settle in late. Silence in the
picture is as noticeable as silence in the audio.

One, not one per element. Three rules, because "sustained" has been read as licence to
vibrate:

- **Sustained means one direction.** A drift travels; it does not return. If you cycle
  something, the full cycle is **4 seconds or longer** — anything faster is not drift, it
  is a shake, and fifteen of them at 0.7s across one composition is a picture that will
  not sit still.
- **Slow is fine; small is not.** A ramp of a fraction of a pixel per frame reads as calm
  rather than as nothing, and the eye integrates it over seconds — but only if what is
  ramping covers real area. The two are independent, and the failure that keeps happening
  is a composition that got the speed right on something far too thin to see.
- **At most two moving things per scene.** The point of motion is that something is
  moving *against* something that is not. When everything drifts, nothing does.
- **Never move type while it is being read.** Headlines, on-screen copy and captions
  enter, hold still, and leave. Moving the words is the one thing the viewer cannot
  ignore and the one thing they came for. Frames, rules, fields and marks may move behind
  them.

## 7. Brand

The plan carries the brand kit's tone rules, do/don'ts, banned words and motion
constraints. They are not suggestions. In particular:

- **Never invent a product interface.** With no real screenshot, stay conceptual.
- Editorial typography is the primary device — large serif display type, monospace labels.
- One continuous accent element should carry through the whole piece.
- Never centre every scene.

## 8. Validate before you finish

```bash
npx hyperframes check . --json --strict
```

Fix every error, then run it again. Do not report the composition as done while any
error remains. Warnings should be read and consciously accepted.

Useful during authoring:

```bash
npx hyperframes snapshot . --at 1,4,8,12 --output snapshots/
```

Look at the snapshots. Ask yourself the section-6 question honestly: **are these frames
structurally different from one another?** If not, rework the layout before finishing.

## 9. Reference exemplar

`exemplar/` holds a complete, high-quality composition with its rendered contact sheet.
Study it for **density, typographic confidence and the variety of its six scenes**.

Do not copy its scenes. It is calibration, not a template — its layouts are already used.
