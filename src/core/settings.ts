import fs from "node:fs/promises";
import {writeJsonFile} from "./util/writeJson.ts";
import path from "node:path";
import {z} from "zod";
import {DATA_DIR} from "./paths.ts";
import {CONTENT_LANGUAGES} from "./plan/language.ts";

/**
 * Studio-wide preferences. Deliberately tiny.
 *
 * The old repo turned into ~150 knobs, so the bar for adding one here is that leaving
 * it out would force the owner to retype the same thing on every video. Content
 * language clears that bar; almost nothing else does.
 */
export const settingsZ = z.object({
  /** The default language new videos are written and narrated in. */
  contentLanguage: z.enum(CONTENT_LANGUAGES).default("en"),
  /** The conversational studio agent. Both values refer to local subscription CLIs. */
  agent: z.enum(["claude", "codex"]).default("claude"),
  /** The one-shot strategy, script and VideoPlan generator. */
  planner: z.enum(["claude", "codex"]).default("claude"),
  composer: z.enum(["claude", "codex"]).default("claude"),
  /**
   * Which model the Codex CLI runs, and how hard it thinks when it composes.
   *
   * These clear the bar above narrowly, and for the same reason. Swapping the Codex model
   * is a thing the owner does once and then wants to stay done — retyping `CODEX_MODEL=…`
   * on every `npm run make` is exactly what settings exist to stop. And the two travel
   * together: `codex` accepts an unknown effort value silently rather than erroring, so a
   * model that does not support `xhigh` fails a whole run with no useful message. Whoever
   * changes one needs the other in the same place.
   *
   * Free-form on purpose — new model ids ship faster than this schema does, and an enum
   * would reject the one the owner is trying to test. Empty means "use the default".
   */
  codexModel: z.string().default(""),
  /**
   * Effort applies to composing only. Planning and the studio conversation are structured
   * extraction and chat — neither is a design decision, and neither is where the visual
   * gap was measured. Hence the name.
   */
  codexComposeEffort: z.enum(["medium", "high", "xhigh"]).default("xhigh"),
  /**
   * Which model the Claude CLI runs, for the same reason and with the same shape.
   *
   * A role could be switched between the two providers but only one of them could be
   * pointed at a model, which made the pair read as if Claude had no model — it has one,
   * it was simply whatever the SDK picked. An alias (`opus`, `sonnet`, `haiku`) or a full
   * id both work; empty keeps the SDK's own default rather than pinning a version here
   * that goes stale. Free-form for the same reason as `codexModel`.
   */
  claudeModel: z.string().default(""),
  marketingSkills: z.object({
    adCreative: z.boolean().default(true),
    social: z.boolean().default(true),
    marketingPsychology: z.boolean().default(true),
  }).default({adCreative: true, social: true, marketingPsychology: true}),
});

export type Settings = z.infer<typeof settingsZ>;

const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

export async function readSettings(): Promise<Settings> {
  const raw = await fs.readFile(SETTINGS_PATH, "utf8").catch(() => "{}");
  const parsed = settingsZ.safeParse(JSON.parse(raw || "{}"));
  return parsed.success ? parsed.data : settingsZ.parse({});
}

export async function writeSettings(settings: Settings): Promise<Settings> {
  const validated = settingsZ.parse(settings);
  await writeJsonFile(SETTINGS_PATH, validated);
  return validated;
}
