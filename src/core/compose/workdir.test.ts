import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {restoreSuppliedFiles, SUPPLIED_FILES} from "./workdir.ts";

async function suppliedDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supplied-"));
  await fs.mkdir(path.join(dir, "blocks"), {recursive: true});
  for (const {file, source} of SUPPLIED_FILES) {
    await fs.copyFile(source, path.join(dir, file));
  }
  return dir;
}

test("restoreSuppliedFiles leaves an untouched directory alone", async () => {
  const dir = await suppliedDir();
  assert.deepEqual(await restoreSuppliedFiles(dir), []);
});

test("an edited block stylesheet is reverted and named", async () => {
  const dir = await suppliedDir();
  const target = path.join(dir, "blocks", "caption-layer.css");
  const pristine = await fs.readFile(target, "utf8");

  // The exact edit the landscape repair made on run 0600: nudge the shared caption band
  // down 5% of frame height, to move two words in one video.
  await fs.writeFile(target, `${pristine}\n#caption-layer { transform: translateY(5%); }\n`);

  assert.deepEqual(await restoreSuppliedFiles(dir), ["blocks/caption-layer.css"]);
  assert.equal(await fs.readFile(target, "utf8"), pristine);
});

test("every supplied file is restored, not just the blocks", async () => {
  const dir = await suppliedDir();
  for (const {file} of SUPPLIED_FILES) {
    await fs.appendFile(path.join(dir, file), "\n/* edited */\n");
  }

  const restored = await restoreSuppliedFiles(dir);
  assert.deepEqual(restored, SUPPLIED_FILES.map((entry) => entry.file));
});

test("a missing supplied file is not resurrected", async () => {
  // Deleting one is a different failure from editing it, and the checker's missing-stylesheet
  // finding is what should speak to it. Silently writing the file back would hide that.
  const dir = await suppliedDir();
  await fs.rm(path.join(dir, "blocks", "base.css"));

  assert.deepEqual(await restoreSuppliedFiles(dir), []);
  await assert.rejects(() => fs.readFile(path.join(dir, "blocks", "base.css"), "utf8"));
});

test("the composition's own files are never touched by the restore", async () => {
  const dir = await suppliedDir();
  await fs.writeFile(path.join(dir, "styles.css"), ".hook { color: red; }");

  await restoreSuppliedFiles(dir);
  assert.equal(await fs.readFile(path.join(dir, "styles.css"), "utf8"), ".hook { color: red; }");
});
