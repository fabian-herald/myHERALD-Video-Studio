# Codex-only live test — 2026-08-01

## Scope and result

The Studio was exercised through its UI with Codex selected for the assistant, planner,
and visual composer. The requested output was an English 16:9 thought-leadership video.

- Video: `thought-leadership-d93908` — **Iteration Debt**
- Output: `out/thought-leadership-d93908/master-16x9.mp4`
- Duration: 49.0667 seconds video, 49.0660 seconds audio
- QC: passed, 1920×1080, 30 fps, H.264/AAC, no freeze or black-frame events
- Research: two searches, two source pages read, one approved figure used
- Approved figure: “The norm is five rounds before approval.”
- Source: BetterBriefs, *The cost of poor feedback*
- Final ledger state: `ready`

This proves that the repaired Codex path can research, pause for owner approval, plan,
narrate, compose, visually inspect its own rendered frames, repair, render, and pass QC.
It does not prove that the current visual direction or narration take is publication-ready.

## What happened and what changed

### 1. Research crossed the brand-fact boundary

**Observed:** The agent used `research_web` on a third-party page. That tool is intended
for importing brand/product facts and proposed 20 unrelated statements for approval.
They were rejected in the UI.

**Repair:** `research_web` now accepts only the configured brand domain and its
subdomains. Third-party evidence must use `read_source`. Regression tests cover the
boundary.

**Remaining:** The saved research brief is immutable and still says the five-round figure
was not approved, although the later approval is correctly stored elsewhere. The Sources
UI should distinguish “brief as written” from current approval state.

### 2. The requested format was silently replaced by defaults

**Observed:** The first build announced landscape but called the pipeline with the default
`9x16` and `4x5` formats.

**Repair:** An explicit ratio in the brief is now inferred when the tool argument is
missing, and the assistant instructions require the owner’s exact ratio to be passed.
The live retry logged and produced only `16x9`.

### 3. Narration missed its pace gate but continued

**Observed:** Both Gemini thought-leadership takes were below the configured raw pace
range: 1.43 and 1.49 words/second against 1.85–2.25. The pipeline kept the better take
with one unmet check.

**Status:** Logged, not fixed. The current pace gate is advisory after two attempts. The
voice is continuous Achird and the alignment is verified, but this take needs a human
captions-off listening decision before publication.

### 4. Codex repairs initially made the composition worse

**Observed:**

1. Attempt 1: 4 errors, 14 warnings, 1 frozen motion window.
2. Attempt 2: 8 errors, 27 warnings, 1 frozen motion window.
3. Attempt 3: 3 errors, including 2 layout errors and 1 frozen window.
4. Attempt 4: clean, 0 frozen windows.

The main cause of the worsening second attempt was an unfocused repair prompt that asked
the composer to act on warnings as well as blocking errors.

**Repair:** Repairs now receive only blocking findings, exact checker hints, timestamps,
bounding boxes, checker snapshots, cropped finding evidence, and frozen-frame pairs.
Claude and Codex receive the same evidence. Codex gets the images as real image inputs.

### 5. Codex did perform visual review, but the UI made it look stalled

**Observed:** After the clean technical check, Codex rendered and inspected six section
frames plus a contact sheet. It found that the persistent wordmark had insufficient
contrast on the two dark-purple scenes and changed the wordmark treatment.

At the same time, Vite watched generated files under `data/` and `out/`. Runtime writes
reloaded the Studio and removed the visible live state, so a healthy run looked stuck.
The run was stopped after the visual correction but before its shared recheck/render.

**Repair:** `data/` and `out/` are ignored by the development file watcher. Codex child
processes also have a 120-second no-output/no-file-change idle bound for genuinely silent
processes. A child that has written useful files is validated rather than discarded.

### 6. The recovery edit exposed a false-success state

**Observed:** A one-character display-copy edit targeted a headline split across `<br>`
and `<mark>` elements. The plan changed, the authored HTML did not, QC passed, and the
ledger correctly became `stale`. The assistant nevertheless claimed that the copy had
changed and the video was finished.

**Repair:**

- The edit path recognises target display copy already present across styled elements.
- The assistant must treat any non-empty `needsCompose` result as stale even when QC
  passes, and must name the unresolved visual change.
- The final recovery restored the approved copy, returned an empty `needsCompose`, passed
  QC, and moved the ledger to `ready`.

### 7. Display-only edits repeated speech processing

**Observed:** Changing only on-screen punctuation reused the cached Gemini WAV but still
uploaded the same 53-second take to Groq for word alignment. This added delay and could
consume paid/free quota without changing speech.

**Repair:** Display-only edits now reuse the existing mastered narration and measured
timings. Changes to spoken text, phrase order, gaps, energy, language, intent, voice, or
narration profile still trigger the full verified narration path.

### 8. End hold and branding

**Verified:** The final spoken caption clears at 48.35 seconds and the branded closing
frame remains until 49.0667 seconds. Audio and video durations match within one frame, so
the previous abrupt cutoff is not present.

**Verified:** The rail and closing card use supplied logo image assets. The large closing
lockup is not a text-only substitute. The BetterBriefs five-round figure and attribution
are visible in the proof scene.

### 9. Quoted proof was missing from fact-usage history

**Observed:** The approved five-round statement was spoken and displayed, but the ledger
recorded `factIds: []`. Usage tracking previously counted only values stored in formal
chart blocks.

**Repair:** The ledger now records approved facts quoted exactly in spoken or display copy
as well as chart citations, with deduplication. The live video now carries
`f-msagdrty-0` in its fact history.

**Remaining:** The hard numeric-claim gate recognises digit forms such as `5` and `39.2%`,
but not spelled-out multilingual number words such as “five”. In this run the planner used
the exact approved statement and the visible source, but extending the rejection gate to
number words still needs a language-aware design.

## Visual assessment

The result is materially better than the first Codex run: safe areas are respected, the
six scenes are structurally distinct, the 16:9 canvas is intentionally occupied, and the
dark-scene logo contrast was corrected by Codex’s own image review.

The remaining creative limitation is not a broken layout. It is ambition. The video is a
clean editorial motion-graphics piece, but it still feels template-like and sparse rather
than visually impressive. There are no product screenshots or other approved media bound
to the plan, so the composition stays conceptual by design. A stronger result needs a
clearer art-direction target or approved visual evidence, not another generic layout
repair.

## Remaining flow improvements

1. Decide whether a narration pace miss should block publication or require an explicit
   owner override instead of silently shipping the better failed take.
2. Show current approval state next to immutable research-brief text in Sources.
3. Add an explicit composition recheck/recovery action. A stopped run currently needs an
   edit or full rebuild to re-enter validation and render.
4. Persist or reconstruct provenance when an interrupted initial build is recovered
   through the edit path. This recovered output has QC and ledger history but no
   `provenance.json` because the original run stopped before that final write.
5. Reduce assistant orchestration latency for fully specified edits. The last one-character
   recovery waited about a minute before calling the deterministic tool.
6. Consider generating checker evidence only after a fast check fails. Always requesting
   snapshots improves repairs but adds avoidable time to clean edit checks.
7. Extend the unverified-number gate to language-aware number words without turning years,
   ordinals, or ordinary prose into false positives.

## Verification

- Full automated suite: 384 tests passed after all repairs.
- TypeScript typecheck: passed.
- Production build: passed.
