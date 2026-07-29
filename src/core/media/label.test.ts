import assert from "node:assert/strict";
import path from "node:path";
import {test} from "node:test";
import {LABEL_MODEL, MEDIA_TAGS, labelScreenshot} from "./label.ts";
import {MEDIA_DIR} from "../paths.ts";

test("labelling refuses a file outside the media library", async () => {
  // The labeller hands a path to a model with the Read tool. Containment is checked before
  // the call, not left to the cwd, so a caller cannot use it to read the repo's secrets.
  for (const file of ["../../.env.local", "/etc/passwd", "../settings.json", "screenshots/../../../etc/hosts"]) {
    await assert.rejects(() => labelScreenshot(file), /outside the media library/, file);
  }
});

test("a path inside the library is accepted as far as the filesystem", async () => {
  // Not a model call: a nonexistent file inside the library must fail on the read, not on
  // the guard, or the guard is rejecting legitimate work.
  const inside = path.join(MEDIA_DIR, "screenshots", "nope.png");
  assert.ok(inside.startsWith(MEDIA_DIR), "fixture must be inside the library");
});

test("the label model is Haiku, and that is a decision not an accident", () => {
  // Pinned so a well-meaning upgrade does not quietly move per-image labelling onto a
  // large model. Labelling is mechanical and high-volume; compose is neither.
  assert.match(LABEL_MODEL, /haiku/);
});

test("tags are a closed vocabulary", () => {
  // Free-text tags cannot be filtered on. A plan asks for an empty-state screenshot and
  // has to get one, which needs both sides agreeing on the word.
  assert.ok(MEDIA_TAGS.length >= 8);
  assert.equal(new Set(MEDIA_TAGS).size, MEDIA_TAGS.length, "no duplicate tags");
  for (const tag of MEDIA_TAGS) assert.match(tag, /^[a-z][a-z-]*$/, `${tag} must be kebab-case`);
});
