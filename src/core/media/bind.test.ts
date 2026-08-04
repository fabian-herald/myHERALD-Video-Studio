import assert from "node:assert/strict";
import path from "node:path";
import {test} from "node:test";
import {bindMedia, checkMediaFit, type MediaItem} from "./library.ts";

const item = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: "shot",
  kind: "screenshot",
  file: "screenshots/shot.png",
  width: 1080,
  height: 1920,
  caption: "",
  variants: [],
  tags: [],
  safeToShow: true,
  state: "approved",
  source: {type: "playwright", url: "https://example.test", preset: "mobile", capturedAt: ""},
  ...over,
});

test("a bound screenshot resolves to a real file path", () => {
  // The path is derived from the library entry, never from the plan. That indirection is
  // why a plan carries ids: a model cannot name a file the library does not have.
  const {files, missing} = bindMedia([{mediaId: "shot"}], [item()]);
  assert.equal(missing.length, 0);
  assert.equal(files.length, 1);
  assert.ok(files[0]?.path.endsWith(path.join("data", "media", "screenshots", "shot.png")));
});

test("a screen block's mediaId is bound as well as a bare mediaId", () => {
  // Two places can reference an image and only one used to be read. A screen section whose
  // file never arrives renders as an empty panel and passes every check we have.
  const {files} = bindMedia([{screen: {mediaId: "shot"}}], [item()]);
  assert.deepEqual(files.map((file) => file.id), ["shot"]);
});

test("an id with nothing behind it is reported, never silently dropped", () => {
  const {files, missing} = bindMedia([{mediaId: "ghost"}], [item()]);
  assert.deepEqual(files, []);
  assert.deepEqual(missing, ["ghost"]);
});

test("unsafe and stale items do not bind", () => {
  // safeToShow is the flag for anything that must not appear in generated output at all,
  // and a stale item is one whose source has moved on. Both fail closed.
  assert.deepEqual(bindMedia([{mediaId: "shot"}], [item({safeToShow: false})]).missing, ["shot"]);
  assert.deepEqual(bindMedia([{mediaId: "shot"}], [item({state: "stale"})]).missing, ["shot"]);
});

test("a proposed item still binds", () => {
  // Deliberately laxer than facts: an unapproved screenshot is a picture you took, while
  // an unapproved fact is a claim about the world. Only the second can mislead.
  assert.equal(bindMedia([{mediaId: "shot"}], [item({state: "proposed"})]).files.length, 1);
});

test("the same id referenced twice is copied once", () => {
  const {files} = bindMedia([{mediaId: "shot"}, {screen: {mediaId: "shot"}}], [item()]);
  assert.equal(files.length, 1);
});

test("a plan with no media asks for nothing", () => {
  assert.deepEqual(bindMedia([{}, {}], [item()]), {files: [], missing: []});
});

test("a second capture of the same subject serves the other shape under one id", () => {
  // A 1920×1080 product shot is a letterboxed strip in a 9:16 frame however the scene is
  // arranged around it. The composition still says `media/shot.png`; only the file behind
  // that name changes, so neither authoring pass has to know the other exists.
  const wide = item({
    id: "dashboard",
    file: "screenshots/dashboard-wide.png",
    width: 1920,
    height: 1080,
    variants: [{file: "screenshots/dashboard-tall.png", width: 1080, height: 1920}],
  });
  const sections = [{screen: {mediaId: "dashboard"}}];

  assert.match(bindMedia(sections, [wide], "landscape").files[0]!.path, /dashboard-wide\.png$/);
  assert.match(bindMedia(sections, [wide], "portrait").files[0]!.path, /dashboard-tall\.png$/);
  // No family asked for means no substitution — the item's own file, as before.
  assert.match(bindMedia(sections, [wide]).files[0]!.path, /dashboard-wide\.png$/);
});

test("a shape check accepts an item that carries the capture it needs", () => {
  const wide = item({
    id: "dashboard", file: "screenshots/dashboard-wide.png", width: 1920, height: 1080,
    variants: [{file: "screenshots/dashboard-tall.png", width: 1080, height: 1920}],
  });
  const bindings = [{sectionId: "proof", mediaId: "dashboard"}];

  assert.deepEqual(checkMediaFit([wide], bindings, "9x16"), []);
  // Without the second capture it is the same defect it always was.
  assert.equal(checkMediaFit([{...wide, variants: []}], bindings, "9x16").length, 1);
  assert.match(
    checkMediaFit([{...wide, variants: []}], bindings, "9x16")[0]!,
    /variants/,
    "the message has to name the way out, or it reads as \"recapture and throw one away\"",
  );
});
