import assert from "node:assert/strict";
import {test} from "node:test";
import {
  TITLE_MAX_CHARS,
  UNTITLED_THREAD,
  isGeneratedTitle,
  resolveThreadTitle,
  titleFromMessage,
} from "./threadTitle.ts";

test("the placeholder shapes this studio has produced are all recognised", () => {
  // Every one of these was a rail row at some point. `toLocaleDateString` is
  // locale-dependent, so the German and ISO forms have to count as generated too.
  for (const title of ["Video 8/1/2026", "Video 01.08.2026", "Video 2026-08-01", UNTITLED_THREAD, "  "]) {
    assert.equal(isGeneratedTitle(title), true, `${title} should be replaceable`);
  }
});

test("a name that came from a video or a person is never treated as replaceable", () => {
  for (const title of ["Let Authorship Lead", "Video ideas for Q3", "Der Engpass ist nicht die Menge"]) {
    assert.equal(isGeneratedTitle(title), false, `${title} should be left alone`);
  }
});

test("a short message is the title, unchanged", () => {
  assert.equal(titleFromMessage("Make a video about brand drift"), "Make a video about brand drift");
});

test("a long message is cut at a word boundary, not mid-word", () => {
  const title = titleFromMessage(
    "Was habe ich zum Thema Content-Kalender schon gemacht? Nur nachschauen und antworten.",
  );
  assert.ok(title.length <= TITLE_MAX_CHARS + 1, `too long: ${title}`);
  assert.ok(title.endsWith("…"), `no ellipsis: ${title}`);
  assert.ok(!title.includes("  "), "collapsed whitespace expected");
  // The cut landed between words: dropping the ellipsis leaves whole words behind.
  assert.ok("Was habe ich zum Thema Content-Kalender schon gemacht? Nur nachschauen und antworten."
    .startsWith(title.slice(0, -1)), `cut mid-word: ${title}`);
});

test("a single word longer than the limit is cut anyway", () => {
  const title = titleFromMessage("A".repeat(80));
  assert.equal(title.length, TITLE_MAX_CHARS + 1, "a wordless string still has to fit");
});

test("newlines and runs of spaces collapse, so the rail gets one line", () => {
  assert.equal(titleFromMessage("  make   this\n\nabout pricing  "), "make this about pricing");
});

test("a message of nothing at all falls back rather than producing an empty row", () => {
  assert.equal(titleFromMessage("   \n  "), UNTITLED_THREAD);
});

test("the video's title wins over the message that started the thread", () => {
  assert.equal(
    resolveThreadTitle({
      current: "Video 8/1/2026",
      videoTitle: "Let Authorship Lead",
      firstMessage: "something about shipping fast and sounding like everyone else",
    }),
    "Let Authorship Lead",
  );
});

test("with no video yet, the first message names the thread", () => {
  assert.equal(
    resolveThreadTitle({current: UNTITLED_THREAD, firstMessage: "A video on pricing pages"}),
    "A video on pricing pages",
  );
});

test("a title that is already meaningful survives a video being made", () => {
  // The owner opened this thread from the Videos screen, so it was named on creation.
  // A later turn must not renegotiate that.
  assert.equal(
    resolveThreadTitle({
      current: "Der Engpass ist nicht die Menge",
      videoTitle: "Something The Planner Called It Later",
      firstMessage: "…",
    }),
    "Der Engpass ist nicht die Menge",
  );
});

test("nothing known yet leaves the thread with a name rather than a blank row", () => {
  assert.equal(resolveThreadTitle({current: ""}), UNTITLED_THREAD);
  assert.equal(resolveThreadTitle({current: UNTITLED_THREAD}), UNTITLED_THREAD);
});
