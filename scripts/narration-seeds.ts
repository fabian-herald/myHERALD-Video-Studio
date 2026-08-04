/**
 * Render one script across a range of seeds, so the brand voice is chosen rather than
 * accepted.
 *
 *   npm run narration:seeds
 *   npm run narration:seeds -- --seeds 1,2,3,4,5,6 --video <videoId>
 *
 * Stating the register in words narrowed the spread and did not close it: twenty-seven
 * takes landed between 118 and 154 Hz, and two videos side by side came out four semitones
 * apart. A seed holds it — five takes at one seed measured 121, 121, 121, 121, 114 Hz
 * against 138, 127, 113, 138, 123 without one.
 *
 * Which seed is a listening decision and nothing here can make it. This renders the
 * candidates, measures each, and leaves the choosing to a person; put the winner in
 * `data/brand/kit.json` under `voice.narratorSeed`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {loadBrandKit} from "../src/core/brand/kit.ts";
import {ROOT, OUT_DIR, VIDEOS_DIR} from "../src/core/paths.ts";
import {loadPlan} from "../src/core/plan/schema.ts";
import {medianF0, semitones} from "../src/core/tts/pitch.ts";
import {intentNarrationProfile} from "../src/core/tts/intent-profile.ts";
import {ttsProvider} from "../src/core/tts/provider.ts";
import "../src/core/tts/gemini.ts";

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

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const seeds = (flag("seeds") ?? "1,2,3,4,5,6,7,8")
  .split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);

// Any finished video will do — the point is one script held constant while the seed varies.
const videoId = flag("video")
  ?? (await fs.readdir(VIDEOS_DIR)).sort().reverse()
    .find((id) => id.startsWith("2026-"));
if (!videoId) throw new Error("No video to read a script from. Pass --video <videoId>.");

const plan = await loadPlan(path.join(VIDEOS_DIR, videoId, "plan.json"));
const kit = await loadBrandKit();
const spoken = plan.sections.filter((section) => section.phrases.length);
const profile = intentNarrationProfile(plan.intent, plan.narration.profile);
const provider = ttsProvider(plan.narration.provider);
const out = path.join(OUT_DIR, "narration-seeds");
await fs.mkdir(out, {recursive: true});

console.log(`script: ${videoId} · voice ${plan.narration.voice}`);
console.log(`register: ${kit.voice.narratorRegister || "(none stated)"}\n`);

const measured: {seed: number; hz: number | null; file: string}[] = [];
for (const seed of seeds) {
  const outputPath = path.join(out, `seed-${String(seed).padStart(3, "0")}.wav`);
  await provider.synthesizeTake!({
    text: plan.sections.flatMap((section) => section.phrases.map((phrase) => phrase.text)).join("\n"),
    blocks: spoken.map((section) => ({
      direction: "",
      lines: section.phrases.map((phrase) => phrase.text),
    })),
    intent: plan.intent,
    profileId: profile.id,
    voiceId: plan.narration.voice,
    style: plan.narration.style,
    register: plan.narration.register,
    seed,
    arc: "",
    language: plan.language,
    outputPath,
  }, () => {});
  const hz = await medianF0(outputPath);
  measured.push({seed, hz, file: outputPath});
  console.log(`seed ${String(seed).padStart(3)}  ${hz ? `${hz.toFixed(0)} Hz` : "unmeasurable"}`);
}

const stated = Number(/(\d{2,3})\s*(?:hz|hertz)/i.exec(kit.voice.narratorRegister)?.[1] ?? 0);
if (stated) {
  console.log(`\nagainst the stated ${stated} Hz:`);
  for (const row of measured.filter((entry): entry is typeof entry & {hz: number} => entry.hz !== null)
    .sort((a, b) => Math.abs(semitones(stated, a.hz)) - Math.abs(semitones(stated, b.hz)))) {
    const distance = semitones(stated, row.hz);
    console.log(`  seed ${String(row.seed).padStart(3)}  ${row.hz.toFixed(0)} Hz  `
      + `${distance >= 0 ? "+" : ""}${distance.toFixed(2)} st`);
  }
}

console.log(`\nListen: ${path.relative(ROOT, out)}`);
console.log("Then set voice.narratorSeed in data/brand/kit.json. Nothing here writes it —");
console.log("which voice the brand has is not a decision a measurement can make.");
