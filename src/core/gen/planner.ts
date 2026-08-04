import {query} from "@anthropic-ai/claude-agent-sdk";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {BrandKit} from "../brand/kit.ts";
import type {ProductFact} from "../knowledge/facts.ts";
import {intentPreset} from "../intents/index.ts";
import {planClaimsViolation} from "../plan/claims.ts";
import type {OutputFormat} from "../plan/formats.ts";
import {languageName, type ContentLanguage} from "../plan/language.ts";
import {copyRulesViolation} from "../plan/copyRules.ts";
import {seedGaps} from "../plan/retime.ts";
import {videoPlanZ, type Intent, type NarrationProfileId, type VideoPlan} from "../plan/schema.ts";
import {CAPTION_MAX_CHARS, CAPTION_MAX_WORDS} from "../render/qc.ts";
import {codexChildEnv, codexModel, requireCodexSubscription} from "./codexCli.ts";

export type PlannerId = "claude" | "codex";

export interface PlanRequest {
  id: string;
  brief: string;
  intent: Intent;
  narrationProfile: NarrationProfileId;
  formats: OutputFormat[];
  language: ContentLanguage;
  kit: BrandKit;
  /** Theses already covered, so the planner sharpens rather than repeats. */
  priorTheses: readonly {id: string; thesis: string}[];
  knowledge: readonly string[];
  /**
   * The full fact set, so the sourcing gate `run.ts` applies after planning can also run
   * inside the retry loop. `citableFacts` cannot stand in: it carries neither `state` nor
   * `evidence`, and both decide whether a fact may back a figure.
   */
  facts: readonly ProductFact[];
  /**
   * Approved facts that carry a number, with their ids, so a `data` block can cite one.
   * Separate from `knowledge` because citing needs an id and reading needs a sentence.
   */
  citableFacts?: readonly {
    id: string;
    statement: string;
    source: string;
    /** How many published videos already charted it, and when it was last used. */
    used?: {count: number; lastAt: string};
  }[];
  /**
   * The library, as the planner may see it: an id, a shape and a caption. Never a path —
   * the planner binds by id and the assembler copies the real file under that name, so a
   * screenshot cannot be invented or pointed somewhere it should not go.
   */
  media?: readonly {id: string; aspect: string; device: string; caption: string; tags: string[]}[];
  /** The local subscription CLI responsible for strategy, script and plan JSON. */
  plannerId?: PlannerId;
  /** Already routed and guarded by intent; empty means no marketing aid is active. */
  marketingGuidance?: {ids: readonly string[]; prompt: string};
}

export interface PlanResult {
  plan: VideoPlan;
  costUsd: number;
  model: string;
}

/**
 * The facts a chart may cite, by id.
 *
 * Only facts that already carry a number are offered. Inviting a `data` block against a
 * qualitative fact produces a chart of made-up values with a real id attached to them,
 * which is worse than no chart — it looks sourced.
 *
 * Unused figures come first, and a used one says so. Verifying a number is slow, so the pool
 * of them is small, and a small pool with no memory is how the same three statistics end up
 * in nine videos — each individually justified, the body of work repeating itself. Stated as
 * a fact about the archive rather than a rule: sometimes the number *is* the video, and the
 * second piece about it is the better one.
 */
export function citableBlock(request: PlanRequest): string {
  const citable = (request.citableFacts ?? [])
    .filter((fact) => /\d/.test(fact.statement))
    // Fresh first, then least-recently-charted. `localeCompare` on ISO timestamps is a
    // chronological sort, which is the one property of that format worth relying on.
    .slice()
    .sort((a, b) => (a.used?.count ?? 0) - (b.used?.count ?? 0)
      || (a.used?.lastAt ?? "").localeCompare(b.used?.lastAt ?? ""));
  if (!citable.length) return "";

  const spent = citable.filter((fact) => fact.used).length;
  return `# Figures you may chart\n\n`
    + "Only these. A `data` block cites one of these ids per value, and the run is refused "
    + "if it cites anything else.\n\n"
    + citable.map((fact) => {
      const source = fact.source ? ` [${fact.source}]` : "";
      const used = fact.used
        ? ` — already charted in ${fact.used.count} video(s), last ${fact.used.lastAt.slice(0, 10)}`
        : "";
      return `- \`${fact.id}\` — ${fact.statement}${source}${used}`;
    }).join("\n")
    + (spent
      ? "\n\nThe ones marked as already charted have been on screen before. Prefer one that "
      + "has not, unless this video is specifically about that number — a viewer who follows "
      + "the account sees the repetition long before you do."
      : "")
    + "\n";
}

/** The screenshots available to bind, by id. Never a path — see `PlanRequest.media`. */
function mediaBlock(request: PlanRequest): string {
  const media = request.media ?? [];
  if (!media.length) return "";
  return `# Screenshots available\n\n`
    + "Bind one with a `screen` block. Only these ids exist; anything else renders as an "
    + "empty panel.\n\n"
    + media.map((item) =>
      `- \`${item.id}\` — ${item.device}, ${item.aspect}${item.caption ? ` — ${item.caption}` : ""}`
      + (item.tags.length ? ` (${item.tags.join(", ")})` : "")).join("\n")
    + "\n";
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
  const plannerId = request.plannerId ?? "claude";
  let lastError = "";
  let costUsd = 0;
  let model = "claude";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const text = await ask(
      plannerId,
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

    const violation = copyRulesViolation(result.data, request.kit.voice);
    if (violation) {
      lastError = violation;
      onLog(`plan          attempt ${attempt} broke a copy rule; retrying.`);
      continue;
    }

    // Copy rules first: they are cheaper to check and their feedback is more actionable. A
    // figure the model cannot source is still worth another attempt though — `run.ts` used to
    // be the only place this ran, and there it kills the whole run with nothing to retry.
    const unsourced = planClaimsViolation(result.data, request.facts, request.knowledge);
    if (unsourced) {
      lastError = unsourced;
      onLog(`plan          attempt ${attempt} stated a figure it cannot source; retrying.`);
      continue;
    }

    return {plan: seedGaps(normalise(result.data, request)), costUsd, model};
  }

  throw new Error(`Could not produce a valid plan after 3 attempts. Last problem:\n${lastError}`);
}

async function ask(
  plannerId: PlannerId,
  prompt: string,
  signal: AbortSignal | undefined,
  onUsage: (usage: {costUsd: number; model: string}) => void,
): Promise<string> {
  if (plannerId === "codex") return askCodex(prompt, signal, onUsage);

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

async function askCodex(
  prompt: string,
  signal: AbortSignal | undefined,
  onUsage: (usage: {costUsd: number; model: string}) => void,
): Promise<string> {
  const executable = await requireCodexSubscription();
  const model = codexModel();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "myherald-codex-plan-"));
  const outputPath = path.join(tempDir, "plan.json");

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [
        "exec",
        "--ignore-user-config",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--model", model,
        "-c", "features.shell_tool=false",
        "--output-last-message", outputPath,
        "-",
      ], {
        cwd: tempDir,
        env: codexChildEnv(),
        stdio: ["pipe", "ignore", "pipe"],
      });
      let errorTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errorTail = `${errorTail}${chunk.toString("utf8")}`.slice(-4000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Codex planning stopped with code ${code}: ${errorTail.trim()}`));
      });
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, {once: true});
      child.stdin.end(`${SYSTEM_PROMPT}\n\n${prompt}`);
    });
    onUsage({costUsd: 0, model});
    return await fs.readFile(outputPath, "utf8");
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
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

${citableBlock(request)}
${mediaBlock(request)}
${request.priorTheses.length ? `# Already covered\n\nThese videos exist. Do not repeat a thesis; either sharpen it into something new or take a different angle, and say which in your \`alternates\`.\n\n${request.priorTheses.map((prior) => `- ${prior.id}: ${prior.thesis}`).join("\n")}` : ""}

${request.marketingGuidance?.prompt ?? ""}

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
      "phrases": [{"id": "<kebab-case, unique within the section>", "text": "<one caption line, punctuated as it is spoken>"}]
      // optional, only where they earn their place — see rules 7 and 8:
      // "screen": {"mediaId": "<an id listed above>", "fit": "contain|device-frame|browser-chrome",
      //            "focus": [{"atMs": <ms into THIS section>, "rect": [x, y, w, h], "label": "<short>"}]}
      // "data": {"shape": "bars|line|counter|share", "unit": "<e.g. %>", "caption": "<source note, rendered>",
      //          "points": [{"label": "<short>", "value": <number>, "factId": "<an id listed above>"}]}
    }
  ],
  ${preset.requiresCta ? `"cta": {"label": "<benefit-led action>", "url": "${request.kit.website}"},` : ""}
  "alternates": [{"thesis": "...", "angle": "...", "why": "..."}],
  "narration": {"provider": "gemini", "voice": "Achird", "style": ${JSON.stringify(request.kit.voice.narrationStyle)}}
}
\`\`\`

Rules:

1. All copy is in ${language}.
2. Each \`phrases\` entry becomes one caption page. Keep each to at most ${CAPTION_MAX_WORDS} words
   and ${CAPTION_MAX_CHARS} characters — a clause someone would say in one breath.

   **The phrases are read aloud as one continuous script, so punctuate them that way.**
   They are joined in order and spoken in a single take: a full stop tells the voice to
   fall and pause, and a line that ends in one when the thought carries on is heard as a
   sentence that stopped early. Write "Optimizely's 2026 survey found 25%," then
   "of marketers knowingly publish off-brand AI content" — not two full stops, which reads
   aloud as a statistic with nothing attached to it. End a line with a full stop only where
   the thought genuinely ends. Commas, colons and no terminal mark at all are all available,
   and a script of eight sentences reads better than the same words cut into fourteen.
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
   \`quiet\` at least once and end on \`lift\` unless there is a reason not to.
9. **A \`screen\` block only where a real screenshot proves something.** ${preset.mediaPolicy === "required"
    ? "This intent needs them: show the actual product where it makes a point, and give each one focus rects so the frame arrives at the detail the narration is describing."
    : preset.mediaPolicy === "rare"
      ? "This intent rarely wants one. Prefer staying at the level of the idea."
      : "Optional. Use one only where seeing the thing beats describing it."}
   Bind by \`mediaId\` from the list above and nothing else. \`focus\` rects are fractions of
   the image, \`atMs\` is measured from the start of that section, and the times should track
   the narration line that talks about each detail. A screenshot with no focus rects is a
   still picture held for eight seconds; two or three rects is usually right.
10. **A \`data\` block only where a number carries the argument.** Every \`value\` must cite a
   \`factId\` from the figures listed above — the run is refused otherwise, so do not invent
   an id, do not reuse one for a value it does not state, and do not round a figure to look
   neater. \`caption\` is the source note and is rendered on screen, so it must say where
   the number is from. If no figures are listed above, omit \`data\` entirely.${preset.mediaPolicy === "required" ? "" : "\n   Most videos need no chart at all; one good number beats four."}`;
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
      profile: request.narrationProfile,
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
