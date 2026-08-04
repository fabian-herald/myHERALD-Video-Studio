import assert from "node:assert/strict";
import {test} from "node:test";
import {briefSlug, dateStamp, videoIdFor} from "./videoId.ts";

/**
 * Thirty folders all beginning `thought-leadership-` and ending in six hex characters.
 * `ls` was a wall of near-identical names in arbitrary order, and finding "the one from
 * Tuesday about brand drift" meant opening plan.json files one at a time.
 */

test("the date comes first, so the directory sorts itself", () => {
  const names = [
    videoIdFor("Brand voice under deadline", new Date(2026, 7, 4)),
    videoIdFor("Another thing entirely", new Date(2026, 6, 29)),
    videoIdFor("A third", new Date(2026, 11, 1)),
  ];
  assert.deepEqual([...names].sort(), [
    "2026-07-29-another-thing-entirely",
    "2026-08-04-brand-voice-under-deadline",
    "2026-12-01-third",
  ]);
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
  assert.match(videoIdFor("Anything", new Date(2026, 7, 4)), /^[a-z0-9-]+$/);
});

test("a brief with nothing but stopwords still produces a name", () => {
  // Unlikely, and not worth an exception — the date still distinguishes it, and a crash
  // here would happen after the run has been paid for.
  assert.equal(briefSlug("the and of to a"), "video");
  assert.equal(briefSlug(""), "video");
});
