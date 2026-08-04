import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {loadBrandKit} from "../brand/kit.ts";
import {INTENT_PRESETS} from "../intents/index.ts";
import {ENERGY_MOTION} from "../tts/energy.ts";
import type {Intent} from "../plan/schema.ts";
import {motionBrief} from "./workdir.ts";

const kit = await loadBrandKit();

/** The entrance in ms the brief prints for one energy of one intent. */
function entranceMs(intent: Intent, energy: string): number {
  const row = motionBrief(kit, intent)
    .split("\n")
    .find((line) => line.startsWith(`| \`${energy}\``));
  assert.ok(row, `no ${energy} row for ${intent}`);
  const match = /\|\s*(\d+)ms\s*\|/.exec(row);
  assert.ok(match, `no entrance figure in: ${row}`);
  return Number(match[1]);
}

test("an ad moves harder than an explainer", () => {
  // The reason this field exists at all. One global dial cannot serve a cold feed and a
  // video someone chose to watch; the ad has three seconds to earn attention it never had.
  assert.ok(entranceMs("promotional", "settled") < entranceMs("thought-leadership", "settled"));
  assert.ok(entranceMs("thought-leadership", "settled") < entranceMs("educational", "settled"));
});

test("educational holds the brand's own baseline exactly", () => {
  // scale 1 must mean untouched, so the kit stays a number you can reason about.
  assert.equal(entranceMs("educational", "settled"), kit.motion.sceneEnterMs);
});

test("the intent scale shifts the curve without flattening it", () => {
  // A faster piece is not a piece where every section is the same speed. Contrast is the
  // point: a lift only reads as a lift because the section before it did not.
  for (const intent of Object.keys(INTENT_PRESETS) as Intent[]) {
    const quiet = entranceMs(intent, "quiet");
    const edge = entranceMs(intent, "edge");
    assert.ok(quiet > edge * 1.5, `${intent}: quiet ${quiet}ms vs edge ${edge}ms is not a curve`);
  }
});

test("every energy in the table reaches the brief", () => {
  // The table used to be hand-copied prose. If an energy is added to ENERGY_MOTION and
  // the composer never hears about it, sections carrying it get no timing at all.
  const brief = motionBrief(kit, "thought-leadership");
  for (const [energy, {note}] of Object.entries(ENERGY_MOTION)) {
    assert.ok(brief.includes(`\`${energy}\``), `${energy} missing from the brief`);
    assert.ok(brief.includes(note), `${energy} description drifted from ENERGY_MOTION`);
  }
});

test("quiet uses readable holds without asking for perpetual motion", () => {
  for (const intent of Object.keys(INTENT_PRESETS) as Intent[]) {
    const brief = motionBrief(kit, intent);
    assert.match(brief, /hold still long enough to read/i);
    assert.doesNotMatch(brief, /continuous drift|never still|keep moving/i);
  }
});

test("the simultaneous cap is a delta on the kit, not a second source of truth", () => {
  for (const [intent, preset] of Object.entries(INTENT_PRESETS)) {
    const expected = kit.motion.maxSimultaneous + preset.motion.simultaneousDelta;
    assert.ok(
      motionBrief(kit, intent as Intent).includes(`At most ${expected} things moving at once`),
      `${intent} should cap at ${expected}`,
    );
    assert.ok(expected >= 3, `${intent}: a cap under 3 makes staggered entrances impossible`);
  }
});



test("the brief asks for staged visual development rather than perpetual drift", () => {
  for (const intent of Object.keys(INTENT_PRESETS) as Intent[]) {
    const brief = motionBrief(kit, intent);
    assert.match(brief, /meaningful staged beats/);
    assert.match(brief, /No element is required to remain in motion/);
    assert.match(brief, /After the beat resolves, the scene may hold/);
    assert.doesNotMatch(brief, /sustained motion|card that drifts/i);
  }
});

test("thought leadership ends with context, not a promotional call to action", () => {
  const guidance = INTENT_PRESETS["thought-leadership"].guidance;
  assert.match(guidance, /No spoken or promotional call to action/);
  assert.match(guidance, /canonical brand lockup/);
  assert.match(guidance, /brand tagline/);
  assert.match(guidance, /website/);
  assert.match(guidance, /buy, try, follow, subscribe, or click/);
});

test("the area rule never appears without the rule that bounds it", () => {
  // These two sentences are one rule. Given only the first, the composer read "move
  // something large" as licence to sweep an opaque card over a headline and produced
  // twenty `layout: Text is hidden beneath an opaque element` errors in a single pass —
  // against two in the run before the area wording existed. Whoever edits one half has to
  // see the other.
  const contract = readFileSync(new URL("./CONTRACT.md", import.meta.url), "utf8");
  const areaAt = contract.indexOf("A meaningful visual beat has to have area");
  assert.ok(areaAt > 0, "the area rule is gone from the contract");
  const boundedAt = contract.indexOf("behind the type", areaAt);
  assert.ok(boundedAt > areaAt && boundedAt - areaAt < 1200,
    "the area rule is stated without the rule that stops it burying the type");
});

test("the contract names the check that catches an opaque overlap", () => {
  // Naming the finding is what lets the composer connect the rule to the error it is
  // about to read in a repair prompt.
  const contract = readFileSync(new URL("./CONTRACT.md", import.meta.url), "utf8");
  assert.match(contract, /Text is hidden beneath an opaque element/);
  assert.match(contract, /rgba\(0,0,0,α\)|translucent/, "no way out is offered, only a prohibition");
});

test("the only full-runtime tween the contract recommends is the spine, unaccelerated", () => {
  // This guard used to forbid `duration: TOTAL` in the contract outright, and that was
  // right until the spine turned out to need it. A progress readout is not drift, and
  // stepping it scene by scene — the only shape that passed while the ban was absolute —
  // reads as several unrelated animations instead of one clock.
  //
  // So the guard now defends the narrower invariant: every example of a full-runtime tween
  // in the contract is a spine, and every one of them is linear.
  const contract = readFileSync(new URL("./CONTRACT.md", import.meta.url), "utf8");
  const examples = [...contract.matchAll(/^.*duration:\s*TOTAL.*$/gm)].map((match) => match[0]);
  assert.ok(examples.length > 0, "the contract stopped showing the one it does allow");
  for (const example of examples) {
    assert.match(example, /spine-line|spine-node/, example);
    assert.match(example, /ease:\s*"none"/, example);
  }
});

test("the brief lists the directory instead of making the composer find it", () => {
  // An attempt died at error_max_turns having spent its budget on `ls -la`, `ls -R`,
  // `find exemplar` and a `cat` — all refused by the sandbox, so it learned nothing and
  // paid a turn each time. This module wrote those files and knows what is there.
  const source = readFileSync(new URL("./workdir.ts", import.meta.url), "utf8");
  const manifest = source.slice(source.indexOf("function directoryManifest"));
  const body = manifest.slice(0, manifest.indexOf("\n}"));
  assert.match(body, /BLOCK_FILES\.map/, "the block list is hand-copied and will drift");
  assert.match(body, /NARRATION_FILE/);
  assert.match(body, /caption-data\.js/);
  assert.match(body, /kit\.logos\.map/, "logos are not listed, so the composer has to go looking");
  assert.match(body, /ls.*cat.*find|refused/, "nothing says why the shell will not help");
});

test("the composer is told to read rather than shell out", () => {
  const source = readFileSync(new URL("../gen/claudeComposer.ts", import.meta.url), "utf8");
  const prompt = source.slice(source.indexOf("const SYSTEM_PROMPT"), source.indexOf("BASH_REFUSAL"));
  assert.match(prompt, /\\`Read\\` and \\`Glob\\`/, "no alternative to the shell is named");
  assert.match(prompt, /manifest/, "the composer is not pointed at the file list");
});

// ── CRAFT.md, and the things it must not become ─────────────────────────────────

const craft = () => readFileSync(new URL("./CRAFT.md", import.meta.url), "utf8");

test("CRAFT.md does not restate what the contract already binds", () => {
  // A third document competing with CONTRACT.md for a finite prompt budget is the risk
  // this file was written against. Anything duplicated here drifts from the binding copy
  // the first time one of them is edited, and then two documents disagree.
  const source = craft();
  assert.doesNotMatch(source, /paper artefact at an angle|concentric rings/,
    "the archetype list belongs to CONTRACT section 6");
  assert.doesNotMatch(source, /var\(--brand-\*\)|rogue colour/i,
    "the token rule belongs to CONTRACT section 2");
  assert.doesNotMatch(source, /at most two things move/i,
    "stated in CONTRACT section 6a; restating it here is where the two copies drift apart");
  assert.doesNotMatch(source, /data-value|data-max|--fill/,
    "the figure contract belongs to CONTRACT section 5b");
});

test("CRAFT.md defers to the contract on motion rather than licensing more of it", () => {
  // Its source material says every decorative element should breathe, drift or pulse.
  // CONTRACT section 6a says at most two things move and type never moves while it is
  // read, and the freeze gate exists to catch what that rule permits. The contract wins,
  // so the ambient-decorative rule is not imported at all — and the file says so, because
  // a reader arriving from the same source material will otherwise assume it was an
  // oversight.
  const source = craft();
  assert.match(source, /not about how much moves/i);
  assert.match(source, /CONTRACT §6a wins/);
  assert.doesNotMatch(source, /ambient motion|should breathe|feel dead/i);
});

test("CRAFT.md stays short enough to be read", () => {
  // 150 lines was the budget. Past that it competes with the contract for attention
  // instead of supplementing it, and the contract is the one that is binding.
  assert.ok(craft().split("\n").length <= 150, `${craft().split("\n").length} lines`);
});

test("CRAFT.md reaches every composer, and no rendered format", () => {
  const workdir = readFileSync(new URL("./workdir.ts", import.meta.url), "utf8");
  assert.match(workdir, /copyFile\(path\.join\(COMPOSE_SRC, "CRAFT\.md"\)/);
  assert.match(workdir, /`CRAFT\.md` — /, "written to the directory but never mentioned in the manifest");

  for (const file of ["../gen/claudeComposer.ts", "../gen/codexComposer.ts"]) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), /CRAFT\.md/, file);
  }

  // The exclusion that is easy to forget: without it every emitted format directory ships
  // a stray design document beside the composition.
  const emit = readFileSync(new URL("../render/hyperframes.ts", import.meta.url), "utf8");
  const from = emit.indexOf("export async function emitFormat");
  assert.match(emit.slice(from, emit.indexOf("const indexPath", from)), /CRAFT\\\.md/);
});

test("CRAFT.md names the difference the owner actually saw", () => {
  // "Codex visuals are more distracting, Claude's more meaningful." Three measurements
  // failed to explain it — decorative-element ratio, invented-text count and label length
  // all put the approved composition at or above the rejected ones. The fourth found it:
  // the approved one puts 25 elements into repeated sets and the rejected ones 0 and 6.
  const source = craft();
  assert.match(source, /Draw sets, not shapes/);
  assert.match(source, /25 elements into repeated/);
  // And the caveat, because half the approved composition's scenes have no set in them.
  assert.match(source, /Not every scene has a set in it/);
});
