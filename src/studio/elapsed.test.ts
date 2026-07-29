import assert from "node:assert/strict";
import {test} from "node:test";
import {formatElapsed} from "./ChatPane.tsx";

test("seconds stay visible at every scale", () => {
  // The seconds digit is the sign of life during a twenty-minute compose step, where
  // tool calls can be a minute apart. A bare "4m" cannot be told from a frozen one.
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(48), "48s");
  assert.equal(formatElapsed(60), "1m 00s");
  assert.equal(formatElapsed(252), "4m 12s");
  assert.equal(formatElapsed(1_805), "30m 05s");
});

test("seconds are zero-padded, so the line never changes width", () => {
  for (const seconds of [61, 65, 69, 119]) {
    assert.match(formatElapsed(seconds), /^\d+m \d{2}s$/, String(seconds));
  }
});
