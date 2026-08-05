# What came out of the template investigation

**The template system was built, measured, and removed. Two fixes and one setting change
survive it, and they are the part worth your attention.**

Read §1. The rest is the record of why the big idea did not survive contact with measurement,
kept so nobody proposes it again without new evidence.

---

## 1. The change that should actually improve your videos

`text_occluded` and `content_overlap` are **two-element** findings: something hid your text,
something else overlapped it. The HyperFrames CLI reports **both** parties — the flagged
element as `selector`, the offender as `containerSelector`. `check.ts` read the first and
dropped the second at the CLI boundary.

So every repair prompt this studio ever sent said *what* broke without saying *what broke it*.
Across the corpus that is **68 of 77 layout errors**. The composer had to find the collision
partner from pixel coordinates.

Before / after:

```
- [error] text_occluded: Text is hidden beneath an opaque element.
  at 1.14s at x=1718.67, y=10.39 (selector: div.fast-ghost)
+ hidden by: i.fast-bar.fast-bar-a
```

The label is chosen per finding, because the repair differs: **hidden by** (move or re-track
that element), **overlapping** (peers, either may move), **inside** (a box to fit within).

Verified end to end in a live run. Both the Claude and Codex adapters share this rendering, so
it reaches either composer. Pinned by `src/core/gen/repair-findings.test.ts`.

## 2. Two smaller changes

**The freeze gate now blocks at 4s, not 2.5s.** `CONTRACT.md` still says 2.5s — that stays the
craft target the composer aims at; 4s is the tolerance at which a finished render is refused.
Set from a real case: a Sonnet run held its outro 2.93s, was blocked on both formats after
three clean compose attempts, and you watched it and judged it good. A gate that rejects a
video its owner would ship is measuring the wrong thing. See `FREEZE_BLOCK_SECONDS` in
`src/core/render/qc.ts`.

**`npm run recompose` now reports cost.** It always received `costUsd` from
`composeWithRepair` and threw it away, which made the one workflow built for comparing
composers the only one with no price on it.

## 3. The model comparison, which is the practical finding

All four runs below used the **same plan** — same seven sections, same script, same data
block. Only the composer changed. That is a controlled comparison; the earlier ones were not,
because the planner re-runs and is stochastic.

| composer | model | elements | gsap | attempts | qc |
|---|---|---|---|---|---|
| claude | **opus-5** | 185 | **117** | 3 | passed |
| codex | luna (xhigh) | 199 | **53** | 5 | passed |
| codex | luna + templates | 227 | 118 | 2 | passed |
| codex | terra (high) | 194 | **48** | 3 | passed |

Approved baseline for reference (`dba07c`, made by Claude): 183 elements, 107 gsap.

**Opus 5 is the only model that matches the approved work on both density and motion.** Terra
produces the cleanest codex layout but the least motion of anything measured. Luna produced
overlaps and hidden text.

Cost: Opus is ~**$9.54** at API list prices, $0 charged under the subscription. Codex runs
report no token usage at all through the CLI, so they cannot be priced — not a bug, a limit.

**Caveat worth keeping:** one run per model on one brief. Opus won both runs it did, which is
the strongest signal available and still a small sample.

## 4. Why the template system was removed

Roughly 7,500 lines across 129 files — region maps, 27 layer items, a gallery generator.
Deleted. Four reasons, in order of weight:

1. **Its own gate failed.** Phase 0 asked whether your ten approved compositions already share
   a region structure: **48.6%** of elements fall into recurring clusters at tolerance 0.05,
   against a 60% threshold. Measured twice by independent implementations that agreed.
   `npm run regions:evidence` re-runs it.
2. **A composer handed the whole library ignored it.** Luna with templates on used **zero**
   region classes, **zero** `data-region` attributes, **zero** layer items, and never linked
   `regions.css`. The mechanism the plan was built on — geometry correct by construction —
   never operated. Its numbers improved; you looked at the frames and still saw overlaps and
   hidden text.
3. **The frame map was largely redundant with `base.css`.** `.scene` is already a three-row
   grid that re-derives per format. The map's own evidence file said so.
4. **It would have to be maintained forever.** The `foot` region already disagreed with where
   `.folio` actually paints, on day one.

The corpus shares a **frame** — masthead, field, foot, rail — and deliberately does not share a
**middle**, where 51.4% of elements are one-offs. That is a real finding about your work, and
arguably why the good ones are good.

## 5. What is still open

- **Narration pace.** Measured 2.25–2.33 wps across these runs. `narratorSeed: 3` pinned the
  *voice* and held; pace was never addressed and is a script-density question, not a playback
  one.
- **The planner ignores its own research.** `data/knowledge/facts.json` holds 48 facts; these
  runs did zero research steps, and three of four plans asked for no chart, number or source
  at all. For thought-leadership content a video with no evidence in it is arguably worse than
  a layout wobble. The composer renders evidence correctly when asked — verified.
- **Motion quality**, still unmeasured. There is no equivalent of `region-evidence.md` for
  animation, and it remains the half of "looks unfinished" that nothing here touched.

## 6. What is left on disk

Kept: the collision fix, the freeze threshold, recompose cost reporting, and the three
measurement scripts with their reports — `regions:evidence`, `errors:geography`,
`errors:baseline`. Those reports are the record of *why* this was rejected.

Also kept: `src/core/compose/workdir.manifest.test.ts`, which pins the composer's entire
authoring directory byte-for-byte. It was written to prove templates could be switched off
harmlessly; it outlived them because the property was always the valuable part — **the
composer's inputs do not change by accident.** After the removal it passes unchanged against a
manifest pinned before any of this existed, which is the proof that deleting 7,500 lines
changed nothing about what the composer sees.
