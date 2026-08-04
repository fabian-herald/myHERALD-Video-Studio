import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {FORMATS, OUTPUT_FORMATS} from "../plan/formats.ts";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

/**
 * `--u` is the scale unit compositions are told to reach for. It was advertised in the
 * contract and defined nowhere, so seven compositions invented it with four incompatible
 * definitions — the popular `--stage-h / 100` among them, which is 19.2px at 9:16 and
 * 10.8px at 1:1, so a composition built on it collapses the moment it is re-emitted.
 */
test("--u is defined once, on the stage, off the short edge", () => {
  const base = read("./blocks/base.css");
  const declaration = /--u:\s*calc\(min\(var\(--stage-w\), var\(--stage-h\)\)\s*\/\s*100\)/;
  assert.match(base, declaration);

  // On #stage rather than :root, so it inherits the per-format `--stage-w`/`--stage-h`
  // the re-emit writes onto that same element.
  const stageBlock = base.slice(base.indexOf("#stage {"), base.indexOf("}", base.indexOf("#stage {")));
  assert.match(stageBlock, declaration);
  assert.equal((base.match(/--u:/g) ?? []).length, 1);
});

test("--u resolves to the same size in every format we emit", () => {
  // The property that makes it worth having: one authored size, four canvases. Portrait
  // and landscape both have a 1080 short edge, which is also the edge the brand type
  // scale's absolute pixel sizes are calibrated against.
  const sizes = OUTPUT_FORMATS.map((format) => {
    const spec = FORMATS[format];
    return Math.min(spec.width, spec.height) / 100;
  });
  assert.deepEqual(sizes, [10.8, 10.8, 10.8, 10.8]);
});

test("the contract points at --u and warns off container units", () => {
  const contract = read("./CONTRACT.md");
  assert.match(contract, /`base\.css` defines\s+\*\*`--u`\*\*/);
  // It used to offer `cqw` / `cqh` as an equal option. Nothing sets `container-type`, so
  // they fall back to the viewport and appear to work only because the renderer sizes the
  // viewport to the stage — they break under `hyperframes preview`.
  assert.match(contract, /`cqw` \/ `cqh` are \*\*not\*\* available/);
});

test("no block sets container-type", () => {
  // `container-type: size` would make `cqw`/`cqh` real, and would also change layout —
  // size containment means the stage no longer sizes to its content. Defining `--u`
  // removes the reason to want it, so the door stays shut deliberately.
  for (const file of ["base.css", "brand-rail.css", "editorial.css", "cta-lockup.css"]) {
    const declarations = read(`./blocks/${file}`).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(declarations, /container-type/, file);
  }
});
