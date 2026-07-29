import {query} from "@anthropic-ai/claude-agent-sdk";
import type {BrandKit} from "../brand/kit.ts";
import {intentPreset} from "../intents/index.ts";
import type {OutputFormat} from "../plan/formats.ts";
import {languageName, type ContentLanguage} from "../plan/language.ts";
import {seedGaps} from "../plan/retime.ts";
import {videoPlanZ, type Intent, type VideoPlan} from "../plan/schema.ts";
import {CAPTION_MAX_CHARS, CAPTION_MAX_WORDS} from "../render/qc.ts";

export interface PlanRequest {
  id: string;
  brief: string;
  intent: Intent;
  formats: OutputFormat[];
  language: ContentLanguage;
  kit: BrandKit;
  /** Theses already covered, so the planner sharpens rather than repeats. */
  priorTheses: readonly {id: string; thesis: string}[];
  knowledge: readonly string[];
}

export interface PlanResult {
  plan: VideoPlan;
  costUsd: number;
  model: string;
}

const SYSTEM_PROMPT = `You are a video strategist and scriptwriter. You produce a strict
JSON plan for one video — the structure, the on-screen copy and the spoken narration.

You do not design and you do not write code. A separate composer turns your plan into a
composition, so describe what each section must accomplish rather than how it should look.

Return raw JSON only. No prose, no markdown fences, no commentary.`;

export async function planVideo(
  request: PlanRequest,
  onLog: (line: string) => void = () => {},
  signal?: AbortSignal,
): Promise<PlanResult> {
  const prompt = buildPrompt(request);
  let lastError = "";
  let costUsd = 0;
  let model = "claude";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const text = await ask(
      attempt === 1 ? prompt : `${prompt}\n\nYour previous answer was rejected:\n${lastError}\n\nReturn corrected JSON only.`,
      signal,
      (usage) => {
        costUsd += usage.costUsd;
        model = usage.model;
      },
    );

    const parsed = parseJson(text);
    if (!parsed) {
      lastError = "The response was not parseable JSON.";
      onLog(`plan          attempt ${attempt} produced unparseable JSON; retrying.`);
      continue;
    }

    const result = videoPlanZ.safeParse(parsed);
    if (!result.success) {
      lastError = result.error.issues
        .slice(0, 12)
        .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
      onLog(`plan          attempt ${attempt} failed schema validation; retrying.`);
      continue;
    }

    const violation = checkCopyRules(result.data, request.kit);
    if (violation) {
      lastError = violation;
      onLog(`plan          attempt ${attempt} broke a copy rule; retrying.`);
      continue;
    }

    return {plan: seedGaps(normalise(result.data, request)), costUsd, model};
  }

  throw new Error(`Could not produce a valid plan after 3 attempts. Last problem:\n${lastError}`);
}

async function ask(
  prompt: string,
  signal: AbortSignal | undefined,
  onUsage: (usage: {costUsd: number; model: string}) => void,
): Promise<string> {
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), {once: true});

  let text = "";
  let model = "claude";
  for await (const message of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: [],
      settingSources: [],
      permissionMode: "default",
      canUseTool: async (toolName) => ({
        behavior: "deny" as const,
        message: `${toolName} is not available while planning.`,
      }),
      maxTurns: 1,
      abortController: controller,
    },
  })) {
    if (message.type === "assistant") {
      model = message.message.model ?? model;
      for (const block of message.message.content) {
        if (block.type === "text") text += block.text;
      }
    } else if (message.type === "result") {
      onUsage({costUsd: message.total_cost_usd ?? 0, model});
    }
  }
  return text;
}

function buildPrompt(request: PlanRequest): string {
  const preset = intentPreset(request.intent);
  const [minSeconds, maxSeconds] = preset.durationBandSeconds;
  const [minSections, maxSections] = preset.sectionRange;
  const language = languageName(request.language);

  return `# Brief

${request.brief}

# Intent: ${preset.label}

${preset.guidance}

- Target length: ${minSeconds}–${maxSeconds} seconds.
- Sections: ${minSections}–${maxSections}.
- Call to action: ${preset.requiresCta ? "required — the last section must have kind \"cta\"" : "none — do not pitch, do not add a cta section"}.

# Brand

- Product: ${request.kit.name} — ${request.kit.tagline}
- Website: ${request.kit.website}
- Address the viewer as "${request.kit.voice.addressAs}".

Tone rules:
${request.kit.voice.toneRules.map((rule) => `- ${rule}`).join("\n")}

Banned words — these must appear nowhere in spoken or on-screen copy:
${request.kit.voice.bannedWords.join(", ")}

${request.knowledge.length ? `# Approved product facts\n\nThese are the only product claims you may make. Do not invent others, and never state a number that is not here.\n\n${request.knowledge.map((fact) => `- ${fact}`).join("\n")}` : "# Product facts\n\nNone are approved yet. Make no factual or numeric claims about the product at all — stay at the level of the idea."}

${request.priorTheses.length ? `# Already covered\n\nThese videos exist. Do not repeat a thesis; either sharpen it into something new or take a different angle, and say which in your \`alternates\`.\n\n${request.priorTheses.map((prior) => `- ${prior.id}: ${prior.thesis}`).join("\n")}` : ""}

# Output

Return JSON matching this shape exactly:

\`\`\`
{
  "schemaVersion": 1,
  "id": "${request.id}",
  "createdAt": "<ISO 8601>",
  "brief": <the brief above, verbatim>,
  "intent": "${request.intent}",
  "formats": ${JSON.stringify(request.formats)},
  "language": "${request.language}",
  "title": "<short internal title>",
  "thesis": "<the single claim this video makes, one sentence>",
  "sections": [
    {
      "id": "<kebab-case, unique>",
      "kind": "hook|point|proof|turn|payoff|cta|title|chapter|screen|quote|outro",
      "intentNote": "<what this section must accomplish — guidance for the designer, never rendered>",
      "energy": "quiet|settled|lift|edge",
      "onScreen": "<the display copy, rendered verbatim on screen>",
      "phrases": [{"id": "<kebab-case, unique within the section>", "text": "<one spoken sentence>"}]
    }
  ],
  ${preset.requiresCta ? `"cta": {"label": "<benefit-led action>", "url": "${request.kit.website}"},` : ""}
  "alternates": [{"thesis": "...", "angle": "...", "why": "..."}],
  "narration": {"provider": "gemini", "voice": "Achird", "style": ${JSON.stringify(request.kit.voice.narrationStyle)}}
}
\`\`\`

Rules:

1. All copy is in ${language}.
2. Each \`phrases\` entry becomes one caption page **and** one text-to-speech clip.
   Keep each to at most ${CAPTION_MAX_WORDS} words and ${CAPTION_MAX_CHARS} characters, and make it a
   naturally speakable unit — a clause someone would say in one breath.
3. \`onScreen\` is short: at most six words. It is typography, not a sentence. It may be
   empty for a purely visual section. It must never duplicate the spoken line word for word.
4. Omit \`startMs\`, \`durationMs\` and \`gapAfterMs\` entirely — timings are measured from
   the real narration audio afterwards and anything you write there is discarded.
5. Give 2–3 \`alternates\`: genuinely different angles on the same brief, so a different
   direction is one click away.
6. Every section needs at least one phrase unless it is deliberately silent.
7. **Vary the rhythm deliberately.** Lines of the same length back to back are what make
   a calm piece sound flat. Across the whole script include at least one line of three or
   four words, and at least one that runs noticeably longer than the rest. A short line
   after two long ones is the cheapest emphasis there is, and it costs nothing.
8. **Give the piece an energy curve.** \`energy\` says how hard each section pushes:

   - \`settled\` — the baseline. Even, certain, nothing to prove.
   - \`edge\` — sharper and flatter, for naming the thing that is wrong.
   - \`quiet\` — pulled back, for the line that has to land on its own.
   - \`lift\` — leaning in, more forward. Conviction, never enthusiasm or selling.

   It drives both the voice and the motion. Do not mark everything \`settled\`; a curve
   with no shape is the problem this field exists to solve. Equally, do not mark
   everything \`lift\` — a lift only reads as one against a settled line before it. Use
   \`quiet\` at least once and end on \`lift\` unless there is a reason not to.`;
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Rules the schema cannot express but that must never reach the composer. */
function checkCopyRules(plan: VideoPlan, kit: BrandKit): string | null {
  const problems: string[] = [];

  const rawCopy = plan.sections
    .flatMap((section) => [section.onScreen, ...section.phrases.map((phrase) => phrase.text)])
    .join(" ");
  const allCopy = rawCopy.toLowerCase();

  for (const word of kit.voice.bannedWords) {
    if (new RegExp(`\\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(allCopy)) {
      problems.push(`- the banned word "${word}" appears in the copy`);
    }
  }
  if (rawCopy.includes("—")) {
    problems.push('- an em-dash (—) appears in the copy; the brand guide forbids it');
  }

  for (const section of plan.sections) {
    for (const phrase of section.phrases) {
      const words = phrase.text.trim().split(/\s+/).length;
      if (words > CAPTION_MAX_WORDS || phrase.text.length > CAPTION_MAX_CHARS) {
        problems.push(
          `- ${section.id}/${phrase.id} is ${words} words / ${phrase.text.length} chars `
          + `(max ${CAPTION_MAX_WORDS} / ${CAPTION_MAX_CHARS}): "${phrase.text}"`,
        );
      }
    }
    if (section.onScreen.trim().split(/\s+/).length > 6 && section.onScreen.trim()) {
      problems.push(`- ${section.id} onScreen copy is longer than six words: "${section.onScreen}"`);
    }
  }

  const ids = plan.sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) problems.push("- section ids are not unique");

  return problems.length ? problems.join("\n") : null;
}

/** The planner proposes; the pipeline owns identity, formats and provider config. */
function normalise(plan: VideoPlan, request: PlanRequest): VideoPlan {
  return {
    ...plan,
    id: request.id,
    brief: request.brief,
    intent: request.intent,
    formats: request.formats,
    language: request.language,
    narration: {
      provider: plan.narration.provider || "gemini",
      voice: plan.narration.voice || "Achird",
      // Both come from the kit, not from the model: the narrator is a brand fact, and a
      // planner free to restate it would be free to drift it.
      style: request.kit.voice.narrationStyle,
      register: request.kit.voice.narratorRegister,
      // Nothing has been synthesised yet, so every timestamp below is still a guess.
      // Whichever retime runs overwrites this with how it actually measured them.
      timing: "planned",
    },
  };
}
