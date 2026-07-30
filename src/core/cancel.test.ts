import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {Cancelled, isCancellation, throwIfCancelled} from "./cancel.ts";

test("an un-aborted signal passes straight through", () => {
  assert.doesNotThrow(() => throwIfCancelled(new AbortController().signal, "compose"));
  assert.doesNotThrow(() => throwIfCancelled(undefined, "compose"));
});

test("an aborted signal stops the run and names the stage", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfCancelled(controller.signal, "narration"), /Cancelled during narration/);
});

test("our own cancellation is recognised", () => {
  assert.ok(isCancellation(new Cancelled("compose")));
});

test("the SDK's AbortError is recognised too", () => {
  // A cancelled run throws whichever of the two was in flight: our check at a stage
  // boundary, or the abort raised inside a model call. Catching only one means a retry
  // loop that stops most of the time, which is the same as not stopping.
  const aborted = Object.assign(new Error("The operation was aborted"), {name: "AbortError"});
  assert.ok(isCancellation(aborted));
});

test("an ordinary failure is not a cancellation", () => {
  // The distinction has to hold in this direction too: a genuinely bad compose attempt
  // must still be retried, because that retry is what the repair budget is for.
  assert.equal(isCancellation(new Error("Composer stopped: error_max_turns.")), false);
  assert.equal(isCancellation(null), false);
  assert.equal(isCancellation("aborted"), false);
});

test("a cancelled compose attempt is rethrown, never retried", () => {
  // The bug this file exists for, asserted where it lived. The catch around the composer
  // logged the abort as a failed attempt and called `continue`, so cancelling a run opened
  // a fresh model session every few seconds — killing one produced another, and the only
  // way to stop it was killing the server.
  //
  // Structural, because the alternative is standing up a composer, a check and a full
  // authoring directory to observe one `continue`.
  const source = readFileSync(new URL("./pipeline/run.ts", import.meta.url), "utf8");
  const loop = source.slice(source.indexOf("for (let attempt = 1"));
  const catchBlock = loop.slice(loop.indexOf("} catch (error) {"), loop.indexOf("continue;"));
  assert.match(catchBlock, /isCancellation\(error\)/, "the compose catch retries a cancelled attempt");
  assert.ok(
    catchBlock.indexOf("throw error") < catchBlock.indexOf("freezeAttempt"),
    "a cancelled attempt is frozen as a failure before it is rethrown",
  );
});

test("every long stage checks for cancellation before it starts", () => {
  // One check is not enough: each stage runs for minutes, so a cancel that only lands at
  // the end of the current one is not a cancel anybody can feel.
  const source = readFileSync(new URL("./pipeline/run.ts", import.meta.url), "utf8");
  for (const stage of ["planning", "narration", "compose", "render"]) {
    assert.match(source, new RegExp(`throwIfCancelled\\(\\s*(?:options\\.)?signal,\\s*"${stage}"`),
      `nothing stops the run before ${stage}`);
  }
});

test("a cancelled run does not fall back to the baseline composition", () => {
  // The fallback exists for an exhausted repair budget. Reaching it after a cancellation
  // would hand back a composition nobody asked for and let the caller carry on rendering.
  const source = readFileSync(new URL("./pipeline/run.ts", import.meta.url), "utf8");
  const fallback = source.indexOf("repair budget exhausted");
  const guard = source.lastIndexOf("throwIfCancelled", fallback);
  assert.ok(guard > 0 && fallback - guard < 400, "the baseline fallback is reachable after a cancel");
});

test("the run is cancelled by the response closing, not the request", () => {
  // The bug under all the others, and the reason none of the fixes appeared to work: the
  // controller was wired to `request.on("close")`, which never fires for a stream like this
  // — the request body is fully read before the first byte goes out, so as far as the
  // IncomingMessage is concerned it finished long ago. The abort was never raised at all.
  // A printed probe on both events was the only way to see it; this test is that probe,
  // kept.
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const stream = server.slice(server.indexOf("async function streamTurn"));
  const turn = stream.slice(0, stream.indexOf("\n}"));
  assert.match(turn, /response\.on\("close",\s*\(\)\s*=>\s*controller\.abort\(\)\)/,
    "the cancel listener is not on the response");
  // Comments stripped first: the function documents the wrong wiring by name, and an
  // assertion that cannot tell a call from the sentence explaining it would force the
  // explanation out of the file to stay green.
  const code = turn.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  assert.ok(!/request\.on\("close"/.test(code), "the listener is back on the request, where it never fires");
});

test("both model sessions are closed, not just abandoned", () => {
  // Aborting the controller stops messages arriving but leaves the CLI the SDK spawned
  // running. One survived a cancelled run by twenty minutes; another was still holding the
  // studio's port two days after the session that started it.
  for (const file of ["../server/agent.ts", "./gen/claudeComposer.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /session\.close\(\)/, `${file} never closes its session`);
    assert.match(source, /addEventListener\("abort"/, `${file} does not close on abort`);
    assert.match(source, /\}\s*finally\s*\{/, `${file} only closes on the happy path`);
  }
});

test("the browser can stop a run", () => {
  // api.ts has accepted a signal since it was written; nothing ever passed one, so the
  // ellipsis on the send button was the only feedback and there was no way to stop.
  const pane = readFileSync(new URL("../studio/ChatPane.tsx", import.meta.url), "utf8");
  assert.match(pane, /new AbortController\(\)/);
  assert.match(pane, /controller\.signal/, "the controller is created but never handed to the request");
  assert.match(pane, /run-stop/, "there is no stop control on screen");
});
