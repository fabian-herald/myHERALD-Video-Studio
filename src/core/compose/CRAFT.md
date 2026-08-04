# Craft

CONTRACT.md is binding and this is not. It exists because the visual review judges four
things the contract never puts a number or a name to, and "make it good" is not guidance.

**This file is about what is on the frame and how it is sized, not about how much moves.**
Where anything here seems to license more motion, CONTRACT §6a wins: at most two things
move at once, type holds still while it is read, and a decorative element that drifts for
no reason is a defect. A busy frame and a dense one are different, and only one is wanted.

## 1. Size floors

Web sizes are invisible on video, and the video plays small inside a scrolling feed. The
contract says to derive sizes from `--brand-size-*` and `--u`; it does not say how small is
too small. These are the floors, in rendered pixels on the 1080-short-edge canvas.

| | web habit | here |
|---|---|---|
| headline | 32–48px | **≥ 90px** |
| body / supporting copy | 14–16px | **≥ 32px** |
| labels, kickers, sources | 12px | **≥ 24px** |
| borders and rules | 1px | 2–4px |
| decorative opacity | 3–8% | 12–25% |
| padding | 16–32px | 60–140px |

Under 24px, justify it. Decorative opacity under 10% is not subtle, it is absent — H.264
quantises it away before anyone sees it.

**Weight contrast is 300 against 900, not 400 against 700.** The difference has to be
legible at a glance, at thumbnail size, in motion. Tracking runs tighter than on the web —
`-0.03em` to `-0.05em` at display sizes — because compression eats letter detail.

## 2. Three layers, not three elements

CONTRACT §6a requires at least three visual elements. That is a count; this is the shape.
A frame that reads as produced rather than assembled has all three of:

- **Background** — a field, an oversized ghost numeral, a grid, a panel of colour, grain.
  It sets the register before anything is read. An intentionally flat field is a choice,
  and it needs a reason.
- **Midground** — the argument. The headline, the artefact, the number, the evidence.
- **Foreground** — the details that make it look made: a hairline rule, a monospace slug,
  a registration mark, a labelled tick, a source note.

Most thin compositions have only a midground. The cure is almost never a bigger headline;
it is a background that commits and a foreground that has been noticed.

Every scene needs one colour that pulls the eye. Muted is fine; flat is not. Tint neutrals
toward the brand hue — dead grey reads as undesigned.

## 3. The sequence has a shape

Six good scenes in a row is not a good video. The sequence needs a peak and something
either side of it.

- Decide which scene is the peak before laying anything out. It is usually the turn or the
  payoff, and it should be the densest, the highest-contrast, or the one that inverts the
  field. Nothing after it may compete.
- The scene before the peak should be the quietest. A lift only reads as a lift against
  something settled — the same rule the narration's energy curve already follows, so read
  the plan's `energy` field and let the picture agree with it.
- Open with the strongest single image, not with a warm-up.
- Close resolved. The last frame is the one that gets screenshotted.

## 4. Easing means something

- **`power2.out` / `power3.out`** — arriving. Fast in, settles. Almost every entrance.
- **`power2.in`** — leaving. Slow start, accelerates away.
- **`power1.inOut`** — a state change between two resting positions.
- **`back.out`** — weight and personality. Once per piece, at most.
- **`none`** — a mechanical readout: a counter, a progress step, a bar filling.

Heavier objects move slower. A full-bleed field wiping across takes 0.6–0.9s; a hairline
rule drawing takes 0.3–0.5s; a label appearing takes 0.15–0.25s. A large object moving at
label speed reads as cheap, and the reverse reads as sluggish.

A stagger is a rhythm, not a queue: keep the whole run under 500ms end to end. Longer and
the last item arrives after the viewer has stopped waiting for it.

Within a scene: **build, breathe, resolve.** Elements arrive in a deliberate order, the
frame holds long enough to read, then one thing changes to close the thought. The hold is
not dead time — it is the part the viewer actually uses.

## 5. Tells

Things that mark a composition as generated rather than designed:

- A centred stack of text with air on all four sides.
- Everything entering from `y: 30, opacity: 0`.
- A line that ends in a dot, labelled nothing, explaining nothing.
- Equal margins everywhere; nothing anchored to an edge.
- A gradient across a full dark frame. It bands visibly under H.264 — use a radial
  gradient, a solid fill, or a solid with one localised glow.
- Three of anything, evenly spaced, because three felt like enough.
- Rounded corners on everything, at the same radius.

## 6. Text in motion

Describe what moves, do not name an effect. There is no effects library here; there is
GSAP and the DOM, and every one of these is a few lines of it:

- Words arriving one at a time — split the line into spans, stagger their `autoAlpha`.
- A line revealing behind a mask — a wrapper with `overflow: hidden`, the inner element
  moving from `yPercent: 100` to `0`.
- A number counting — tween a plain object's property and write it into `textContent`.
- A rule drawing — `scaleX: 0` to `1` with `transformOrigin` naming the edge it grows from.
- A field wiping — the same, on a full-bleed element behind the type.

The last two are the highest-value motion in this system: they are cheap, they read at
thumbnail size, and they change enough of the frame to satisfy the freeze measure that a
hairline spine cannot.
