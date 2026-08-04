import assert from "node:assert/strict";
import {test} from "node:test";
import {briefSlug, dateStamp, shortCode, videoIdFor} from "./videoId.ts";

/**
 * Thirty folders all beginning `thought-leadership-` and ending in six hex characters.
 * `ls` was a wall of near-identical names in arbitrary order, and finding "the one from
 * Tuesday about brand drift" meant opening plan.json files one at a time.
 */

test("the date comes first, so the directory sorts itself", () => {
  const names = [
    videoIdFor("Brand voice under deadline", "codex", new Date(2026, 7, 4)),
    videoIdFor("Another thing entirely", "claude", new Date(2026, 6, 29)),
    videoIdFor("A third", "codex", new Date(2026, 11, 1)),
  ];
  assert.deepEqual([...names].sort(), [
    "2026-07-29-another-thing-entirely-claude",
    "2026-08-04-brand-voice-under-deadline-codex",
    "2026-12-01-third-codex",
  ]);
});

test("a code tail keeps same-title videos apart without losing what they were", () => {
  // Three existing videos are called some version of "The Second Draft". Numbering them
  // -2 and -3 throws away the only thing that identified them; the tail does not.
  const at = new Date(2026, 6, 30, 14, 12);
  const a = videoIdFor("The Second Draft", "claude", at, shortCode("The Second Draft", at));
  const later = new Date(2026, 6, 30, 16, 40);
  const b = videoIdFor("The Second Draft", "claude", later, shortCode("The Second Draft", later));
  assert.notEqual(a, b);
  assert.match(a, /^2026-07-30-second-draft-claude-[0-9a-f]{4}$/);
  // Stable for one video: the same title and minute always give the same folder.
  assert.equal(shortCode("The Second Draft", at), shortCode("The Second Draft", at));
});

test("the name says what it is and who made it", () => {
  // The two questions actually asked of a folder list. Comparing one backend against the
  // other is a thing that gets done, and the answer used to live only in provenance.json.
  assert.equal(
    videoIdFor("The Month-Later Test", "codex", new Date(2026, 7, 4)),
    "2026-08-04-month-later-test-codex",
  );
  assert.equal(
    videoIdFor("Consistency Is Not a Point of View", "claude", new Date(2026, 7, 4)),
    "2026-08-04-consistency-point-view-claude",
  );
});

test("the intent is left out on purpose", () => {
  // Nine of ten videos are thought-leadership, so leading with it puts the same nineteen
  // characters in front of almost every name — which is what made the old scheme
  // unreadable in the first place. It is in plan.json and in the ledger.
  assert.doesNotMatch(
    videoIdFor("Some Title", "codex", new Date(2026, 7, 4)),
    /thought|leadership|educational/,
  );
});

test("the stamp is the local day, not a UTC one the maker slept through", () => {
  // 23:30 on the 4th in a positive-offset zone is the 5th in UTC. The folder should say
  // the day the person was working, which is the day they will look for it under.
  assert.equal(dateStamp(new Date(2026, 7, 4, 23, 30)), "2026-08-04");
  assert.equal(dateStamp(new Date(2026, 0, 9)), "2026-01-09", "months and days are padded");
});

test("stopwords are dropped so four words are four useful ones", () => {
  assert.equal(
    briefSlug("Most brands measure AI content by how much they can publish."),
    "brands-measure-ai-content",
  );
  // Without the filter this would be "most-brands-measure-ai" — one word of identity lost
  // to a word that appears in half of all briefs.
});

test("punctuation, accents and casing all flatten", () => {
  assert.equal(briefSlug("Erklär den Unterschied!"), "erklar-den-unterschied");
  assert.equal(briefSlug("Why our onboarding flow drops 40% of users"), "onboarding-flow-drops-40");
  assert.match(videoIdFor("Anything", "codex", new Date(2026, 7, 4)), /^[a-z0-9-]+$/);
});

test("a brief with nothing but stopwords still produces a name", () => {
  // Unlikely, and not worth an exception — the date still distinguishes it, and a crash
  // here would happen after the run has been paid for.
  assert.equal(briefSlug("the and of to a"), "video");
  assert.equal(briefSlug(""), "video");
});
