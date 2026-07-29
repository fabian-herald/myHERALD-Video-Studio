import fs from "node:fs/promises";
import path from "node:path";
import {researchSite, saveResearch} from "../src/core/knowledge/research.ts";
import {ROOT} from "../src/core/paths.ts";

await loadEnv();

const argv = process.argv.slice(2);
const urls = argv.filter((value) => !value.startsWith("--"));
const dryRun = argv.includes("--dry-run");

if (!urls.length) {
  console.error(`Usage: npm run research -- <url> [url…] [--dry-run]

Reads public pages and extracts what the product says about itself, plus the colours
and type it presents itself in. Statements are saved as \`proposed\` facts; colours and
fonts are reported only and never written into the brand kit.

  --dry-run    show the findings without saving anything`);
  process.exit(1);
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const result = await researchSite(urls);

console.log(`pages         ${result.pages.length} of ${urls.length}`);
for (const page of result.pages) {
  console.log(`  ${page.url}`);
  console.log(`    ${page.blocks} statement(s) · ${page.title || "no title"}`);
}

console.log("");
console.log(`statements    ${result.facts.length}`);
for (const fact of result.facts) {
  const flag = fact.needsEvidence ? " [needs evidence]" : "";
  console.log(`  ${fact.kind.padEnd(11)}${fact.statement.slice(0, 96)}${flag}`);
}

console.log("");
console.log(`colours       ${result.colors.length}  (contrast is against your own surface)`);
for (const color of result.colors) {
  console.log(
    `  ${color.hex}  ${String(color.count).padStart(4)}x  ${color.role.padEnd(8)}`
    + `${String(color.onSurface).padStart(6)}:1${color.matchesToken ? `   already yours as ${color.matchesToken}` : ""}`,
  );
}

console.log("");
console.log(`fonts         ${result.fonts.length}`);
for (const font of result.fonts) {
  console.log(
    `  ${String(font.count).padStart(4)}x  ${font.stack.slice(0, 72)}`
    + `${font.matchesStack ? `   matches your ${font.matchesStack} stack` : ""}`,
  );
}

if (result.errors.length) {
  console.log("");
  console.log("skipped");
  for (const line of result.errors) console.log(`  ${line}`);
}

console.log("");
if (dryRun) {
  console.log("dry run       nothing saved");
} else {
  const saved = await saveResearch(result);
  console.log(`saved         ${saved.added} new fact(s) as \`proposed\`${saved.skipped ? `, ${saved.skipped} already known` : ""}`);
  console.log("              Approve them in the Brand screen. Until then they reach no prompt.");
  console.log("              Colours and fonts are reported only; the brand kit is untouched.");
}

function fail(error: unknown) {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
}

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
