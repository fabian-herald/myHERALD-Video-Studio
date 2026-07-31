# Bilingual narration bake-off

This is an audio-only evaluation harness. It does not change the production narrator,
retime a video plan, or render a video. A candidate can reach production only after both
of its takes pass the automatic gates and the blinded review sheet is completed.

## Candidate matrix

| Candidate | English | German | Notes |
|---|---:|---:|---|
| Historical take, shortened offline | yes | no | Baseline only; both copies share one historical source and do not prove repeatability. |
| Gemini directed full take — Achird | yes | yes | Studio-style audio profile, director note, scene, context, and performance tags. |
| Gemini current production prompt — Achird | opt-in | opt-in | Exact current one-take production prompt for prompt-only comparisons. |
| Gemini simplified directed full take — Achird | opt-in | opt-in | Minimal audio profile, direct 75-second pace target, and only three expression tags. |
| Gemini balanced thought-leadership take — Achird | selected | pending review | Production profile: calm authority, length-relative target, and 650 ms controlled section gaps. |
| Gemini directed full take — Algenib | yes | yes | Exact same prompt as Achird; voice is the only changed variable. |
| Gemini seven-section profile | yes | yes | Seven requests with an unchanged speaker profile; never per-line. |
| Chirp 3 HD Achird | rejected | rejected | Retained for reproducibility but omitted from default runs after the bilingual quality test. |
| Simba 3.2 | yes | no | English-only production candidate. |
| Qwen-Audio 3.0 Plus | yes | no | One WebSocket task with seven continued inputs. |
| Sonic 3.5 | rejected | rejected | Retained for reproducibility after Theo and Kyle both failed the human voice-character screen. |
| Sonic 3.5 default HTTP | rejected | rejected | Moving-alias control retained only as historical evidence. |
| Sonic 3.5 Kyle contemplative | rejected | rejected | Kyle's audible breath/groan artifacts failed the human listening screen. |
| Simba 3.0 German | no | diagnostic | Kept visibly separate from Simba 3.2. |

MiniMax Speech 2.8 HD is intentionally not implemented. Add it only if Gemini, Chirp,
and Sonic all fail the bilingual quality or consistency gates.

## Prepare without external requests

```sh
npm run narration:bakeoff -- --prepare
```

This validates both scripts and writes the complete 24-slot schedule under
`out/narration-bakeoff/<video-id>/<run-id>/` without sending text or audio anywhere.

## Generate

Copy the required variables from `.env.example` into `.env.local`. Only configured
providers run; an unconfigured provider is recorded as skipped before an API call.

```sh
npm run narration:bakeoff
```

Useful narrower run:

```sh
npm run narration:bakeoff -- \
  --candidates existing-shortened,gemini-pause-tags,gemini-seven-sections \
  --languages en,de \
  --takes 2
```

For a first listening screen without sending generated audio to Groq:

```sh
npm run narration:bakeoff -- --screening --takes 1 \
  --candidates gemini-pause-tags,gemini-directed-algenib,sonic-3.5 \
  --languages en,de
```

Interrupted runs can reuse existing raw provider files:

```sh
npm run narration:bakeoff -- --resume <run-id> --reprocess
```

Generation sends the unpublished language-specific script to the selected TTS provider.
Quality evaluation sends each raw audio file to Groq for word timestamps. Do not run it
unless those transfers are approved for the material.

## What is retained

Every run contains:

- exact English and German scripts;
- raw provider output and any raw section or stream files;
- provider, model and pinned snapshot;
- voice ID, locale, non-secret request parameters, request/context/task IDs;
- estimated list-price cost;
- ASR model, WER, alignment confidence, clipping and terminal-fade checks;
- provider-native continuous timing and the aligned phrase boundaries used for measurement;
- language-separated pace measurements;
- 48 kHz, -16 LUFS anonymized listening WAVs;
- a blind index, sealed answer key, human review sheet, and two-take group gates.

The 2% WER, clipping, truncation, fade, and unexplained-silence gates are automatic.
Identity drift, intelligibility without captions, voice character, and English/German
character retention stay human judgments in `review-sheet.json`.

No candidate is production-approved merely because it appears in the listening folder.
The final video must still be approved once with captions off.

## Decision recorded 2026-07-31

`B886-controlled` was approved for English thought leadership. It keeps the calm raw
Gemini/Achird performance and shortens only the six known section-pause markers to 650 ms,
landing at 78.596 seconds without altering speech speed or pitch. The production path and
future-agent rules are documented in `docs/narration-production.md` and `AGENTS.md`.
