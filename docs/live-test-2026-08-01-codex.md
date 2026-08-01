# Codex all-provider live test — 2026-08-01

## Scope

End-to-end Studio UI test with Codex selected for:

- Studio assistant and orchestration
- strategy and video planning
- visual HyperFrames composition

Gemini remained the configured narration provider. The test brief was a short English
educational video explaining the difference between a content topic and a content thesis.
It explicitly prohibited web research and statistics.

## Durable evidence

- Successful test thread: `data/threads/t-2291d9f1.json`
- Failed setup threads: `t-3a053411`, `t-50111f90`, `t-3165c2b3`
- Final test video: `educational-55a842`
- Master: `out/educational-55a842/master-16x9.mp4`
- QC: `out/educational-55a842/qc-16x9.json`
- Provenance: `out/educational-55a842/provenance.json`
- Codex planner: `gpt-5.6-terra`, subscription billing
- Codex composer: `gpt-5.6-terra`, subscription billing, two pre-render attempts
- Narration: Gemini 3.1 Flash TTS Preview, Achird, educational profile

## Outcome

All three Codex roles were exercised through the UI. The Studio agent called real local
tools, the planner produced the saved plan, and the composer authored the HyperFrames
files and responded to validation findings. The final media file is playable and has the
expected 1920x1080 H.264 video, 48 kHz AAC audio, 53.37-second duration, exact captions,
and acceptable loudness and peak levels.

The video is **not approved**. Final QC failed because a completely static frame lasts
1.63 seconds from 41.43s to 43.07s. The failing check is `noLongFreeze`.

## Incident log

### LT-01 — Studio MCP tools were absent in the first Codex run

- Symptom: Codex answered conversationally but could not call `read_context` or any Studio
  action.
- Impact: A previous smoke test looked successful even though no real tool was called.
- Cause: The Codex Studio process was not configured to require the local MCP bridge.
- Resolution: The Studio MCP server is now marked required.
- Follow-up: Add an integration test that fails unless Codex completes a real
  `read_context` call.

### LT-02 — Streamable HTTP MCP handshake returned HTTP 500

- Symptom: Codex connected, then the initialize/list-tools sequence failed on the second
  request.
- Impact: The Studio agent could not use local tools.
- Cause: A stateless transport instance was reused for a multi-request Streamable HTTP
  handshake.
- Resolution: Generate and retain a session id for the transport.
- Follow-up: Exercise initialize, initialized notification, and tools/list in one automated
  transport test.

### LT-03 — Non-interactive Studio tool calls were treated as cancelled

- Symptom: `read_context` was available but returned as if the user had cancelled it.
- Impact: A subscription-backed Studio agent could not do any useful work.
- Cause: Local MCP tools had no explicit non-interactive approval mode.
- Resolution: Set the Studio MCP server's default tool approval mode to `approve`. This is
  scoped to the local authenticated bridge; the bridge still controls the exposed tools.
- Follow-up: Assert the generated Codex config contains both `required=true` and the scoped
  approval mode.

### LT-04 — Composer shell resolved Node 20 while HyperFrames requires Node 22+

- Symptom: Composer validation first failed on Node 20.18.1 and attempted to download a
  replacement with `npx`.
- Impact: The initial run stalled on unavailable registry access and was stopped.
- Cause: Codex executes shell commands through a login shell, which reapplies the user's
  nvm default after the parent process modifies `PATH`.
- Resolution: The parent now discovers an installed compatible Node and passes its path to
  the composer. The model eventually found the installed Node 24 runtime.
- Follow-up: Do not ask the sandboxed composer to run the authoritative browser check. The
  pipeline already runs that check outside the composer sandbox. If a model-side command is
  ever needed, include the exact inline `PATH` override rather than relying on inherited
  `PATH`.

### LT-05 — Composer strict check cannot bind localhost in its sandbox

- Symptom: Static lint passed, but `hyperframes check` ended with
  `listen EPERM 127.0.0.1`.
- Impact: Codex spent time investigating an environment limitation it cannot fix.
- Cause: The composer sandbox correctly blocks opening a local listener; HyperFrames' full
  browser check needs one.
- Resolution: The central pipeline performed the full check successfully outside that
  sandbox.
- Follow-up: Composer prompts should tell the model to write the files and return. Central
  validation remains authoritative.

### LT-06 — First composition failed layout and contrast checks

- Findings included overflowing orbit text, decorative panels outside the canvas, escaped
  scale geometry, and a 1.11:1 contrast failure.
- Impact: A repair pass was required before rendering.
- Resolution: Codex made a minimal composition-only repair. Static lint and the central
  pre-render check then passed.
- Follow-up: Keep this repair loop. Collapse repeated identical findings before they are
  sent to the model so the prompt is smaller and easier to reason about.

### LT-07 — Final encoded video failed `noLongFreeze`

- Symptom: A static interval from 41.43s through 43.07s survived the pre-render motion
  sampling.
- Impact: The generated video is playable but not approved.
- Cause: The sparse pre-render motion samples did not catch the same interval as ffmpeg's
  continuous post-render freeze detector.
- Current status: Open.
- Follow-up: Either sample the whole longest caption-stable window densely enough to match
  the final threshold, or make the post-render repair path mandatory before returning a
  completed video.

### LT-08 — QC repair did not produce a composition change

- Symptom: A Codex repair process was started for `noLongFreeze`, but it produced no patch
  or completion event before the pipeline continued with the existing composition.
- Impact: The unchanged video was rendered again and failed identically.
- Cause: The repair child can terminate or become unresponsive without a durable structured
  result. The caller catches the failure, but the UI does not distinguish "repair failed"
  from "rerendering repaired composition."
- Current status: Open.
- Follow-up: Add a repair result contract containing `changedFiles`, `exitReason`, duration,
  last progress time, and a hard timeout. Never rerender after a failed repair unless a
  relevant file hash changed.

### LT-09 — `edit_video` accepted no-op edits and rerendered unchanged media

- Symptom: The Studio agent attempted two "fresh" fixes through `edit_video`, but that path
  only rewrites plan copy/timing and preserves the authored composition. Both calls
  rerendered the same frozen animation.
- Impact: Time was wasted, narration/transcription stages were re-entered, and the UI stated
  that a fresh composition pass was happening when it was not.
- Cause: There is no Studio tool for a composition-only repair or recompose, and
  `edit_video` does not reject edits that leave the plan unchanged.
- Current status: Open; highest priority.
- Follow-up:
  1. Add `repair_video(videoId, findings)` for composition-only repair plus render/QC.
  2. Add `recompose_video(videoId)` for an explicitly fresh visual composition.
  3. Reject a no-op `edit_video` before TTS, file writes, or rendering.
  4. Report whether narration, plan, composition, or only encoding actually changed.

### LT-10 — Run state and elapsed-time feedback became misleading

- Symptom: The visible elapsed timer disappeared, while earlier output made the job look as
  though it might still be active. The final message appeared only after repeated work.
- Impact: The owner could not tell whether the process was running, stalled, or finished.
- Cause: Agent-turn state, long-running pipeline state, child-model state, and output-file
  state are represented as one generic "working" state.
- Current status: Open.
- Follow-up: Show named stages with independent status: agent, planning, narration,
  composition, validation, render, QC, repair. Persist start time, last progress time, and
  terminal reason. Mark "stalled" after a configurable quiet period and offer retry/cancel.

### LT-11 — Raw Codex CLI output overwhelmed the Studio thread

- Symptom: Tens of thousands of low-level log lines, including large instruction and file
  dumps, were forwarded into the conversation.
- Impact: The useful timeline and errors became difficult to inspect; thread files grew
  unnecessarily large.
- Cause: Every stdout/stderr line is forwarded directly as a Studio event.
- Current status: Open.
- Follow-up: Parse structured Codex events. Show only stage changes, commands, concise
  results, and errors in the UI; keep a bounded raw log as a downloadable diagnostic.

### LT-12 — Diagnostic command exposed credential-bearing config in internal output

- Symptom: A local MCP diagnostic returned unredacted environment-backed configuration to
  the internal tool trace.
- Impact: No credential was written to the repository, but diagnostic output was broader
  than necessary.
- Cause: The diagnostic listed full server configuration rather than a redacted capability
  summary.
- Resolution: The value was not copied into code, documents, or user-facing output.
- Follow-up: Never use full MCP config listing for health checks. Add a redacted status
  endpoint that returns server name, transport, connection state, and tool count only.

### LT-13 — Codex composition passed structural checks but failed visual quality

- Owner assessment: The Codex visuals are materially weaker than the previous Claude
  compositions. Elements were at times outside the visible area or poorly placed, and the
  16:9 canvas often felt conspicuously empty.
- Contact-sheet evidence:
  - `why-it-works` ("Now there is tension") leaves most of the landscape canvas without a
    meaningful visual anchor; its balance graphic reads as a small peripheral decoration.
  - `closing-takeaway` concentrates the message and step graphic into separate low-density
    islands instead of resolving them into one strong final composition.
  - The opening disc, territory bands, target rings and clue label all rely on cropped or
    edge-adjacent geometry. Some of those crops were intentional, but the collection reads
    less controlled than the previous Claude work.
  - Across nine scenes, the model delivered nine named archetypes, but variety did not
    produce consistent hierarchy, density or a coherent landscape rhythm.
- Automated evidence: The first central check independently reported text overflow,
  out-of-canvas panels, container overflow and escaped positioned geometry. Codex repaired
  the hard errors, but a technically legal final frame can still be weakly composed.
- Comparison limit: Existing Claude contact sheets are predominantly 9:16 and cover other
  scripts, so this is not a controlled provider benchmark. It is still strong product
  evidence because the owner's preference and the observable density/hierarchy differences
  point in the same direction.
- Causes:
  1. Codex never visually reviewed its rendered frames. Its sandbox could not run the
     browser-based check, while the central pipeline judged rules and motion rather than
     aesthetic balance.
  2. The composition contract strongly rewards a different archetype in every scene. Codex
     satisfied that literally, sometimes prioritising novelty over visual hierarchy and
     landscape coherence.
  3. The contact sheet is generated after the composition loop, so neither provider receives
     the actual frames as feedback before the final render.
  4. The composer preamble said "eight rendered frames" even though this plan had nine
     sections. The contract should never hardcode a scene count.
  5. Intentional-overflow annotations can make a crop technically acceptable without making
     it visually convincing.
- Current status: Open; Codex visual composition should not become the production default on
  the strength of this run.
- Follow-up:
  1. Run a controlled Claude-versus-Codex 16:9 comparison with the same plan, narration,
     assets and quality gates.
  2. Add a visual-review pass that gives representative rendered frames back to the composer
     and asks for a minimal hierarchy, density, alignment and crop correction.
  3. Add landscape-specific review criteria: deliberate focal mass, balanced negative space,
     readable secondary type and no isolated decorative island.
  4. Remove hardcoded scene counts from both composer prompts.
  5. Do not allow a model to silence an overflow finding with an annotation unless the
     resulting crop is also present in an owner-approved contact sheet.

## Recommended implementation order

1. Add `repair_video`/`recompose_video`, reject no-op edits, and refuse rerender when the
   composition hash did not change after a claimed repair.
2. Persist a structured per-run event/error log and expose stage, last progress time, and
   terminal reason in the UI.
3. Add a composer inactivity timeout and a process-tree cleanup path.
4. Stop running browser-based HyperFrames checks inside the Codex sandbox; keep central
   validation authoritative.
5. Replace raw CLI forwarding with concise structured progress plus a bounded diagnostic
   attachment.
6. Align pre-render motion sampling with final freeze detection.
7. Add end-to-end regression coverage for the MCP handshake and one real Studio tool call.
8. Add a frame-based visual review loop and run a controlled 16:9 Claude/Codex bake-off
   before enabling Codex as the default visual composer.

## Approval status

- Provider routing: verified for all three Codex roles.
- Subscription use: verified for planner and composer; no OpenAI API key was inherited.
- Final video: **rejected** until `noLongFreeze` passes.
- Production readiness of the all-Codex flow: **not yet**. The provider integration works,
  but repair, observability, and no-op edit handling need the P0 fixes above.
