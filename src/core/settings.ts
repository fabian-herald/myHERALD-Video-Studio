import fs from "node:fs/promises";
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
  composer: z.enum(["claude", "codex"]).default("claude"),
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
  await fs.mkdir(DATA_DIR, {recursive: true});
  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return validated;
}
