# Narration production decision

Decision date: 2026-07-31

## Approved thought-leadership reference

`B886-controlled` is the approved English direction:

- provider/model: Google Gemini `gemini-3.1-flash-tts-preview`;
- voice: `Achird`;
- one continuous take;
- calm authority and measured forward motion;
- three sparse performance tags (`observant`, `conviction`, `confident`);
- generated section-pause markers only, never one pause marker per phrase;
- overlong section silence shortened to 650 ms after verified alignment;
- no time stretching or pitch processing;
- 48 kHz mono, -16 LUFS mastering.

For the reference script, the raw calm take was 86.64 seconds. Gemini rendered six
`[short pause]` markers at roughly two seconds each. Shortening only those six known
section gaps produced the approved 78.596-second take. The faster 65.52-second take was
rejected as hectic and better suited to advertising than thought leadership.

The reference file and edit provenance are retained under:

`out/narration-bakeoff/thought-leadership-7e83b7/2026-07-31T20-03-00-954Z-f6e023/`

## Production enforcement

This decision is implemented, not only documented:

1. `buildThoughtLeadershipTakePrompt` selects the approved prompt when the plan intent is
   `thought-leadership`.
2. The take selector accepts a calm raw band of 1.85–2.25 words/second and targets 2.05.
   It does not use shortest duration as the tie-breaker for this intent.
3. ASR locates and verifies every phrase before any edit.
4. `compactSectionGaps` removes only the centre of silence above 650 ms where the last
   phrase of one known section meets the first phrase of the next.
5. The aligned phrase starts are shifted by exactly the removed silence; their durations
   do not change.
6. Provenance records the timing treatment, gap target, and number of shortened gaps.

If alignment fails, the existing phrase-clip fallback remains available for safety. It
is not considered equivalent voice quality and must be visible in provenance as
`phrase-clips`.

## Provider status

- Gemini/Achird: selected for English thought leadership.
- Sonic 3.5: rejected after Theo and Kyle listening tests.
- Chirp 3 HD: rejected after English and German listening tests.
- MiniMax: reserve only; not implemented.

The German thought-leadership companion take passed captions-off human review on
2026-07-31 and is approved with the same provider, voice, and structural treatment.

## Intent-specific production profiles

The B886 method now applies to every intent, but its tone does not. Each intent owns its
own prompt, raw pace range, and controlled section beat:

| Profile | Delivery | Raw target | Accepted raw range | Section gap |
|---|---|---:|---:|---:|
| Social promotional | Controlled social-campaign energy, fast but articulated | 2.45 W/s | 2.10–3.00 W/s | 800 ms |
| Performance ad | Direct-response energy, immediate but articulated | 2.80 W/s | 2.45–3.30 W/s | 450 ms |
| Educational | Patient, conversational explanation | 1.95 W/s | 1.65–2.35 W/s | 650 ms |
| Thought leadership | Calm authority and measured forward motion | 2.05 W/s | 1.85–2.25 W/s | 650 ms |
| Announcement | Brisk, concrete product update without hype | 2.25 W/s | 1.90–2.75 W/s | 800 ms |

All profiles use one continuous Achird take, three sparse arc tags, verified alignment, and
silence-only section-gap control. Provenance names the selected profile and whether the
pipeline fell back to phrase clips.

Human listening status from 2026-07-31:

- Educational `BF4C-educational` is approved.
- Promotional `048D-promotional` is approved for social-media campaigns and challenges.
  It uses native pauses and preserves section transitions up to 800 ms. The earlier
  pause-compacted `B749-promotional` remains rejected because of perceived warping. Pure
  performance ads use the separate `performance-ad` profile.
- Performance ad `0650-performance-ad-1` is approved as of 2026-08-01 and is the default
  delivery for the paid-media `promotional` intent. It runs at 2.73 W/s with native
  pauses and required no audio cuts. `38E1-performance-ad-2` remains rejected because
  its raw 2.41 W/s missed the profile's minimum pace before local gap control.
- Announcement `BC5C-announcement` is approved. It adds modest positive excitement while
  preserving the brisk pace and avoiding launch-day hype.
- Thought leadership is approved in English and German.

All five current narration deliveries now have a human-approved listening reference.
