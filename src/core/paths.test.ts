import assert from "node:assert/strict";
import path from "node:path";
import {test} from "node:test";
import {OUT_DIR, safeVideoOutDir} from "./paths.ts";

test("an ordinary video id resolves inside out/", () => {
  assert.equal(safeVideoOutDir("thought-leadership-63ea13"), path.join(OUT_DIR, "thought-leadership-63ea13"));
});

test("a traversal is refused rather than clamped", () => {
  // This function exists because the resolved path is handed to a file manager. Clamping
  // a hostile id to something plausible would open the wrong folder silently; null makes
  // the caller decide, and every caller answers with an error.
  for (const id of ["..", "../..", "../../etc", "../../../Users", "foo/../..", "./.."]) {
    assert.equal(safeVideoOutDir(id), null, `"${id}" escaped out/`);
  }
});

test("out/ itself is not a video directory", () => {
  // Revealing out/ would work and look harmless, which is exactly why it should not be
  // reachable by passing an empty or dot id — it is not the folder anyone asked for.
  for (const id of ["", ".", "./"]) assert.equal(safeVideoOutDir(id), null, `"${id}" resolved to out/`);
});

test("an absolute path cannot smuggle itself in as an id", () => {
  // path.resolve treats an absolute second argument as the whole answer, discarding
  // OUT_DIR entirely. Without the containment check this would return "/etc" unchanged.
  assert.equal(safeVideoOutDir("/etc"), null);
  assert.equal(safeVideoOutDir(path.join(OUT_DIR, "..", "data")), null);
});

test("a nested path inside out/ is allowed", () => {
  // Not a traversal: a render subdirectory is a legitimate thing to reveal.
  assert.equal(
    safeVideoOutDir(path.join("video-1", "snapshots")),
    path.join(OUT_DIR, "video-1", "snapshots"),
  );
});
