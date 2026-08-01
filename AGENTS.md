# Project instructions

## Model roles and marketing guidance

The owner chooses Studio assistant, Strategy & script, and Visual composer independently
in Settings. Respect `agent`, `planner`, and `composer` from `src/core/settings.ts`; do not
collapse them into one provider choice or silently fall back between providers.

Codex always means the local ChatGPT/Codex subscription. It must pass the `chatgpt` auth
check in `src/core/gen/codexCli.ts`, and Codex child processes must not inherit
`OPENAI_API_KEY` or `CODEX_API_KEY`. If that subscription is unavailable, report it as
unavailable before work begins rather than using metered API billing.

Only three optional marketing aids belong in planning: `ad-creative`, `social`, and
`marketing-psychology`. Each is independently switchable. Route them through
`src/core/marketing/guidance.ts`: ad creative only for `performance-ad`, social only for
non-performance-ad profiles, and ethical psychology framing for all profiles. Video
intent, narration profile, brand voice, approved facts, copy rules, and claim validation
override every marketing heuristic. Do not add campaign budgets, targeting, analytics,
metrics, or an A/B-test framework to the Video Studio.

## Narration production baseline

The approved English thought-leadership reference is `B886-controlled` from 2026-07-31.
Do not replace this profile merely because another take is shorter or ranks higher on a
generic TTS leaderboard.

For `thought-leadership` narration:

- Use Gemini `gemini-3.1-flash-tts-preview` with the prebuilt `Achird` voice.
- Generate one continuous take. Never return to per-line synthesis as the normal path;
  it caused audible speaker drift. Per-line synthesis is only the safety fallback when
  a continuous take cannot be aligned and verified.
- Use the production thought-leadership prompt in `src/core/tts/gemini.ts`: calm
  authority, measured forward motion, three sparse performance tags, and pause markers
  only between spoken sections.
- Evaluate the raw take around 2.05 words/second. A fast ad-like read above 2.25 W/s is
  not preferred simply for being shorter.
- After verified ASR alignment, shorten only silence between known section boundaries to
  at most 650 ms. Preserve all speech and within-section pauses. Never use `atempo`,
  pitch shifting, or generic silence removal.
- Master the resulting track through the shared 48 kHz, -16 LUFS path and retime the
  plan from the adjusted alignment.

`B886-controlled` is 78.596 seconds for its specific 175-word script. That duration is
a reference, not a universal target. The production prompt derives an approximate target
from script length; the audio and verified alignment remain the source of truth.

Provider decisions:

- Sonic 3.5 is rejected for this product voice. Theo sounded overly polished/artificial;
  Kyle produced audible breath/groan artifacts.
- Chirp 3 HD is rejected on voice quality.
- Do not switch providers, voices, or the thought-leadership pacing profile without a
  fresh controlled comparison and explicit user approval.
- English `B886-controlled` and its German companion take from 2026-07-31 are approved
  thought-leadership references. Keep the same structural profile in both languages;
  a different language still needs its own captions-off listening approval.

The full rationale, exact gates, and bake-off commands are in
`docs/narration-production.md` and `docs/narration-bakeoff.md`.

## Other narration intents

Do not reuse the thought-leadership delivery for every video. Reuse its production
method: one continuous take, sparse arc tags, an intent-specific raw-pace gate, verified
alignment, and silence-only section-gap control.

- `social-promotional`: controlled social-campaign energy, raw target 2.45 W/s, 800 ms section gaps.
- `performance-ad`: direct-response energy, raw target 2.80 W/s, 450 ms section gaps.
- `educational`: patient and easy to follow, raw target 1.95 W/s, 650 ms section gaps.
- `announcement`: brisk and concrete without hype, raw target 2.25 W/s, 800 ms gaps.
- `thought-leadership`: calm authority, raw target 2.05 W/s, 650 ms gaps.

These values live in `src/core/tts/intent-profile.ts`; do not duplicate or override them
in agent prose. Listening status from 2026-07-31:

- `educational`: approved from `BF4C-educational`.
- `promotional`: approved from `048D-promotional` for social-media campaigns and
  challenges. It preserves natural transitions up to 800 ms. Do not treat this as the
  delivery for a pure performance ad. The earlier pause-compacted `B749-promotional`
  remains rejected.
- `performance-ad`: approved from `0650-performance-ad-1` on 2026-08-01. It is the
  default narration profile for the paid-media `promotional` intent. The slower
  `38E1-performance-ad-2` remains rejected because its raw 2.41 W/s missed the pace gate.
- `announcement`: approved from `BC5C-announcement`, with modest positive excitement,
  unchanged brisk pace, and no launch-day hype.
- `thought-leadership`: approved in English and German.

For `promotional`, always resolve the requested delivery before synthesis. Omitted means
`performance-ad`, matching the intent's paid-media planning rules. Pass
`social-promotional` explicitly for organic campaigns or challenges. Never silently
substitute one for the other.
