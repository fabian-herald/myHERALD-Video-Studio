import path from "node:path";
import {contrastRatio, loadBrandKit, verifyPairs} from "../src/core/brand/kit.ts";
import {writeTokensCss} from "../src/core/brand/tokens.ts";
import {BRAND_DIR, rel} from "../src/core/paths.ts";

const kit = await loadBrandKit();
const target = path.join(BRAND_DIR, "tokens.css");
await writeTokensCss(kit, target);

console.log(`brand         ${kit.name} · ${Object.keys(kit.color.tokens).length} colour tokens`);
console.log(`tokens        ${rel(target)}`);

const failures = verifyPairs(kit);
for (const pair of kit.color.pairs) {
  const fg = kit.color.tokens[pair.fg];
  const bg = kit.color.tokens[pair.bg];
  const ratio = fg && bg ? contrastRatio(fg, bg) : 0;
  const ok = ratio >= pair.minRatio;
  console.log(
    `${ok ? "  ok  " : "  FAIL"}        ${pair.fg} on ${pair.bg} — `
    + `${ratio.toFixed(2)}:1 (needs ${pair.minRatio}:1)`,
  );
}

if (failures.length) {
  console.error(`\n${failures.length} declared colour pair(s) do not meet their own minimum.`);
  process.exit(1);
}
