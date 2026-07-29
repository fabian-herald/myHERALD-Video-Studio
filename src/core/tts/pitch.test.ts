import assert from "node:assert/strict";
import {test} from "node:test";
import {
  centreHz, closestToCentre, MAX_ABOVE_ST, MAX_BELOW_ST, pitchOutlier, semitones,
} from "./pitch.ts";

/** Median F0 of the sixteen clips that shipped in thought-leadership-5741a2. */
const SHIPPED = [108, 119, 116, 200, 143, 133, 140, 145, 138, 151, 104, 118, 148, 133, 129, 138];

test("the clip that read as a woman is caught", () => {
  const centre = centreHz(SHIPPED);
  assert.equal(centre, 138);
  const outlier = pitchOutlier(200, centre);
  assert.ok(outlier, "200 Hz against a 138 Hz track is a different speaker");
  assert.ok(outlier.st > MAX_ABOVE_ST);
});

test("the band is lopsided, because only sharp reads as a stranger", () => {
  const centre = 138;
  // Symmetric would flag six of sixteen. Going flat reads as weight, so it does not.
  assert.equal(pitchOutlier(119, centre), null, "119 Hz is low but still him");
  assert.ok(pitchOutlier(200, centre), "200 Hz is not");
  assert.ok(MAX_BELOW_ST > MAX_ABOVE_ST, "the band must be wider below than above");
});

test("only the phrases a listener would notice are re-rolled", () => {
  const centre = centreHz(SHIPPED);
  const flagged = SHIPPED.filter((hz) => pitchOutlier(hz, centre));
  // Three of sixteen: cheap enough to retry, and it includes the one that was reported.
  // A symmetric ±2 band would have flagged six, most of them for being warm.
  assert.deepEqual(flagged, [108, 200, 104]);
  assert.equal(SHIPPED.filter((hz) => Math.abs(semitones(centre!, hz)) > 2).length, 6);
});

test("a track with too few measurable clips has no centre to hold to", () => {
  assert.equal(centreHz([null, null]), null);
  assert.equal(centreHz([140, null]), null);
  // With no centre nothing can be an outlier, so nothing is re-rolled for no reason.
  assert.equal(pitchOutlier(200, null), null);
  assert.equal(pitchOutlier(null, 138), null);
});

test("the best attempt is the closest one, not the last one", () => {
  const attempts = [{pitch: 200}, {pitch: 175}, {pitch: 141}];
  assert.equal(closestToCentre(attempts, 138), 2);
  // A later attempt that overshoots does not displace an earlier good one.
  assert.equal(closestToCentre([{pitch: 141}, {pitch: 90}], 138), 0);
});

test("an unmeasurable attempt never wins", () => {
  assert.equal(closestToCentre([{pitch: null}, {pitch: 190}], 138), 1);
  // Nor does it win by being the only one left; index 0 is the original take.
  assert.equal(closestToCentre([{pitch: null}, {pitch: null}], 138), 0);
});

test("semitones are signed the way the log messages read them", () => {
  assert.ok(semitones(138, 200) > 0, "sharp is positive");
  assert.ok(semitones(138, 104) < 0, "flat is negative");
  assert.equal(Math.round(semitones(100, 200)), 12, "an octave is twelve");
});
