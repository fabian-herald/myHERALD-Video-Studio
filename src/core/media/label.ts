import path from "node:path";
import {query} from "@anthropic-ai/claude-agent-sdk";
import {z} from "zod";
import {MEDIA_DIR} from "../paths.ts";

/**
 * Haiku, deliberately, and this is the one place in the pipeline where a small model is
 * the right answer rather than a compromise.
 *
 * Labelling is high-volume and mechanical: look at a screenshot, say what is on it. There
 * is no composition to judge and no argument to make, so the capability that separates the
 * larger models buys nothing here — while the cost difference decides whether labelling
 * two hundred uploads is something you do or something you mean to do.
 *
 * Note what this does NOT touch: compose is 85% of a run's wall clock and is exactly where
 * quality lives, so nothing about this generalises to swapping the composer down.
 */
export const LABEL_MODEL = "claude-haiku-4-5-20251001";

/** Tags are a controlled vocabulary, so a plan can filter on them and get what it expects. */
export const MEDIA_TAGS = [
  "overview", "workflow", "approval", "planning", "context", "input",
  "empty-state", "settings", "detail", "list", "editor", "chart", "marketing",
] as const;

const labelZ = z.object({
  /**
   * What this is evidence *of*, not what it looks like. The planner reads this line to
   * decide whether a screenshot proves the point a section is making.
   */
  caption: z.string().min(8).max(160),
  tags: z.array(z.enum(MEDIA_TAGS)).min(1).max(4),
  /**
   * Anything on screen that should not be published: a real name, an email address, a
   * customer, a token. Reported rather than acted on — whether a shot is publishable is
   * the owner's call, and this only makes the call an informed one.
   */
  sensitive: z.array(z.string()).default([]),
});

export type MediaLabel = z.infer<typeof labelZ>;

const SYSTEM_PROMPT = `You label product screenshots for a video studio.

You are shown one image. Return a caption, tags and any sensitive content you can see.

The caption says what the screenshot is EVIDENCE OF — the thing a video could point at it
to prove — not a description of the layout.

**One sentence, at most 140 characters.** That limit is the point, not a formality: a
caption long enough to list the navigation and the buttons is a description, and a
description is no use to someone deciding whether this shot proves a claim. Naming what is
on screen is easy; saying what it demonstrates is the job.

  good  "The review queue, where a draft waits for a human yes."
  bad   "A page with a sidebar, a table of drafts, a filter row and an Approve button."

Never invent product names, numbers or features you cannot see in the image.

Return raw JSON only. No prose, no markdown fences.`;

/**
 * Read one screenshot and describe it.
 *
 * The image reaches the model through the `Read` tool rather than as a base64 block in the
 * prompt, so a 4 MB screenshot is never held in a string, and the working directory is
 * pinned to the media folder — the model can read the picture it was asked about and
 * nothing else on the disk.
 */
export async function labelScreenshot(
  file: string,
  onLog: (line: string) => void = () => {},
): Promise<{label: MediaLabel; costUsd: number} | null> {
  const absolute = path.resolve(MEDIA_DIR, file);
  if (!absolute.startsWith(`${MEDIA_DIR}${path.sep}`)) {
    throw new Error(`Refusing to label a file outside the media library: ${file}`);
  }

  let text = "";
  let costUsd = 0;
  for await (const message of query({
    // Absolute, even though `cwd` is set. Given a relative path the model prepends a
    // slash, gets "File does not exist", and spends two of its turns recovering — which
    // on a four-turn budget is the whole budget.
    prompt: `Read the image at ${absolute} and label it.\n\n`
      + `Allowed tags — use only these: ${MEDIA_TAGS.join(", ")}\n\n`
      + `Return: {"caption": "...", "tags": ["..."], "sensitive": ["..."]}`,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: LABEL_MODEL,
      cwd: MEDIA_DIR,
      allowedTools: ["Read"],
      settingSources: [],
      permissionMode: "default",
      maxTurns: 6,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") text += block.text;
      }
    } else if (message.type === "result") {
      costUsd += message.total_cost_usd ?? 0;
    }
  }

  const parsed = parseLabel(text);
  if (!parsed) {
    // A failed label is not a failed capture. The shot keeps whatever caption it had and
    // the run continues — an unlabelled screenshot is worse than a labelled one and much
    // better than no screenshot.
    onLog(`  label       ${file} — could not be labelled, leaving as captured`);
    return null;
  }

  return {label: parsed, costUsd};
}

function parseLabel(text: string): MediaLabel | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const result = labelZ.safeParse(JSON.parse(body.slice(start, end + 1)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
