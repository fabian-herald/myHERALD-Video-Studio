import fs from "node:fs/promises";
import path from "node:path";
import {intentPreset} from "../src/core/intents/index.ts";
import {INTENTS, type Intent} from "../src/core/plan/schema.ts";
import {OUTPUT_FORMATS, type OutputFormat} from "../src/core/plan/formats.ts";
import {CONTENT_LANGUAGES, isContentLanguage, languageName} from "../src/core/plan/language.ts";
import {readSettings} from "../src/core/settings.ts";
import {runPipeline} from "../src/core/pipeline/run.ts";
import {ROOT, rel} from "../src/core/paths.ts";
import type {Quality} from "../src/core/render/hyperframes.ts";

await loadEnv();

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const brief = argv.filter((value, index) =>
  !value.startsWith("--") && !argv[index - 1]?.startsWith("--")).join(" ").trim();

if (!brief) {
  console.error(`Usage: npm run make -- "<what the video is about>" [options]

  --intent      ${INTENTS.join(" | ")}   (default: thought-leadership)
  --formats     comma-separated from ${OUTPUT_FORMATS.join(",")}  (default: the intent's own)
  --language    ${CONTENT_LANGUAGES.join(" | ")}   (default: the studio setting)
  --composer    claude | codex           (default: the studio setting; both use a CLI subscription)
  --quality     draft | standard | high  (default: high)
  --baseline    skip the model and use the deterministic fallback composition
`);
  process.exit(1);
}

const intent = (flag("intent") ?? "thought-leadership") as Intent;
if (!INTENTS.includes(intent)) {
  console.error(`Unknown intent "${intent}". Choose one of: ${INTENTS.join(", ")}.`);
  process.exit(1);
}

const preset = intentPreset(intent);
const formats = (flag("formats")?.split(",").map((value) => value.trim()) ?? preset.defaultFormats) as OutputFormat[];
for (const format of formats) {
  if (!OUTPUT_FORMATS.includes(format)) {
    console.error(`Unknown format "${format}". Choose from: ${OUTPUT_FORMATS.join(", ")}.`);
    process.exit(1);
  }
  if (!preset.formats.includes(format)) {
    console.error(`${preset.label} does not support ${format}. Allowed: ${preset.formats.join(", ")}.`);
    process.exit(1);
  }
}

const settings = await readSettings();
const languageFlag = flag("language");
if (languageFlag !== undefined && !isContentLanguage(languageFlag)) {
  console.error(`Unknown language "${languageFlag}". Choose from: ${CONTENT_LANGUAGES.join(", ")}.`);
  process.exit(1);
}
// Without a flag the studio setting decides, so `make` and the chat agree on language.
const language = languageFlag ?? settings.contentLanguage;

const started = Date.now();
const result = await runPipeline({
  brief,
  intent,
  formats,
  language,
  composerId: flag("composer") ?? settings.composer,
  quality: (flag("quality") ?? "high") as Quality,
  baselineOnly: has("baseline"),
});

console.log("");
console.log(`video         ${result.videoId}${result.usedBaseline ? " (baseline composition)" : ""}`);
console.log(`spoken in     ${languageName(language)}`);
for (const output of result.outputs) {
  console.log(`  ${output.format.padEnd(6)}      ${rel(output.path)} · qc ${output.qc.passed ? "passed" : "FAILED"}`);
}
if (result.contactSheet) console.log(`contact sheet ${rel(result.contactSheet)}`);
console.log("");
console.log(`cost          $${result.cost.chargedUsd.toFixed(2)} actually charged`);
console.log(`              $${result.cost.apiEquivalentUsd.toFixed(2)} the same work at API list prices`);
for (const entry of result.cost.entries) {
  console.log(
    `  ${entry.provider.padEnd(12)}${entry.step.padEnd(11)}`
    + `$${entry.chargedUsd.toFixed(2)} / $${entry.apiEquivalentUsd.toFixed(2)}  ${entry.note}`,
  );
}
console.log(`wall clock    ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log("");
console.log("Now open the contact sheet and answer the only question that matters:");
console.log("are these frames structurally different from one another?");

if (result.outputs.some((output) => !output.qc.passed)) process.exitCode = 1;

/** Minimal .env.local loader — no dependency, no surprises. */
async function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const raw = await fs.readFile(path.join(ROOT, file), "utf8").catch(() => null);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match?.[1]) continue;
      const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value && !process.env[match[1]]) process.env[match[1]] = value;
    }
  }
}
