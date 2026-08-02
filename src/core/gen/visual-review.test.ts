import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import type {AuthoringDir} from "../compose/workdir.ts";
import {codexComposerEvent, codexExecArgs} from "./codexComposer.ts";
import {actionableRepairFindings, visualReviewRequest} from "./composer.ts";

const authoring: AuthoringDir = {
  dir: "/tmp/video/work/landscape",
  compositionId: "video-landscape",
  family: "landscape",
  width: 1920,
  height: 1080,
  durationSeconds: 42,
};

test("the provider-neutral review uses exact evidence and a concrete visual rubric", () => {
  const images = [
    "/tmp/video/work/landscape/.visual-review/contact-sheet.png",
    "/tmp/video/work/landscape/.visual-review/frames/frame-001.png",
    "/tmp/video/work/landscape/.visual-review/frames/frame-002.png",
  ];
  const request = visualReviewRequest(authoring, images);

  assert.deepEqual(request.imagePaths, images);
  assert.match(request.prompt, /1920x1080/);
  assert.match(request.prompt, /Inspect every image/);
  assert.match(request.prompt, /small island.*empty portrait frame/s);
  assert.match(request.prompt, /early\/late temporal pairs/);
  assert.match(request.prompt, /perpetual drifting/);
  assert.match(request.prompt, /full.*lockup image/s);
  assert.match(request.prompt, /25% is one quarter/);
  assert.match(request.prompt, /prominent line, connector, node or dot/);
  assert.match(request.prompt, /breathing room above captions/);
  assert.match(request.prompt, /website.*before looping/s);
  assert.match(request.prompt, /clipped, cropped, overlapping or off-canvas/);
  assert.match(request.prompt, /distinct scene archetypes/);
  assert.match(request.prompt, /Do not change narration/);
  for (const image of images) assert.match(request.prompt, new RegExp(image.replaceAll(".", "\\.")));
});

test("Codex receives the shared review frames as real image inputs", () => {
  const images = ["/tmp/contact-sheet.png", "/tmp/section-1.png"];
  const args = codexExecArgs({
    dir: authoring.dir,
    model: "gpt-test",
    effort: "high",
    imagePaths: images,
  });

  const imageFlag = args.indexOf("--image");
  assert.notEqual(imageFlag, -1);
  assert.deepEqual(args.slice(imageFlag + 1, imageFlag + 1 + images.length), images);
  assert.equal(args[imageFlag + 1 + images.length], "--ignore-user-config");
  assert.equal(args.at(-1), "-", "the shared prompt is still supplied over stdin");
  assert.ok(args.includes("--json"), "composer output must be structured before it reaches the UI log");
});

test("Codex composer logging collapses file diffs into one useful event", () => {
  const event = codexComposerEvent(JSON.stringify({
    type: "item.completed",
    item: {
      type: "file_change",
      changes: [
        {path: "/tmp/work/index.html", diff: "+ thousands of bytes"},
        {path: "/tmp/work/styles.css", diff: "+ thousands more"},
      ],
    },
  }));
  assert.equal(event.log, "updated index.html, styles.css");
  assert.equal(event.filesChanged, true);
  assert.equal(JSON.stringify(event).includes("thousands"), false);
});

test("repair prompts act only on blocking errors", () => {
  const findings = actionableRepairFindings({
    ok: false,
    errorCount: 1,
    warningCount: 1,
    findings: [
      {severity: "warning", code: "decorative_overflow", message: "decoration clips", source: "hyperframes"},
      {severity: "error", code: "text_overlap", message: "copy overlaps", source: "hyperframes"},
    ],
  });
  assert.deepEqual(findings.map((finding) => finding.code), ["text_overlap"]);
});

test("ordinary Codex authoring does not invent an empty image flag", () => {
  const args = codexExecArgs({dir: authoring.dir, model: "gpt-test", effort: "medium"});
  assert.equal(args.includes("--image"), false);
});

test("Codex authoring allows a full multi-scene file-write interval before idle recovery", () => {
  const source = readFileSync(new URL("./codexComposer.ts", import.meta.url), "utf8");
  assert.match(source, /CODEX_IDLE_TIMEOUT_MS = 300_000/);
  assert.doesNotMatch(source, /120_000/);
});

test("the pipeline renders centrally, then invokes and rechecks the shared review", () => {
  const source = readFileSync(new URL("../pipeline/run.ts", import.meta.url), "utf8");
  const flow = source.slice(source.indexOf("export async function composeWithRepair"));
  const snapshot = flow.indexOf("await renderSnapshots");
  const review = flow.indexOf("await composer.review");
  const recheck = flow.indexOf("report = await check()", review);

  assert.ok(snapshot >= 0 && review > snapshot, "review ran without centrally rendered evidence");
  assert.ok(recheck > review, "review edits were not checked again");
  assert.match(flow, /sectionReviewTimes\(plan\)/);
  assert.match(flow, /visualReviewRequest\(authoring, \[contactSheet, \.\.\.frames\]\)/);
  assert.match(flow, /composer\.repair\(context, report, attempt - 1, report\.evidencePaths\)/);
});

test("technical repairs receive checker snapshots and finding crops", () => {
  const checker = readFileSync(new URL("../render/check.ts", import.meta.url), "utf8");
  assert.match(checker, /"--snapshots"/);
  assert.match(checker, /snapshots\?\.findingFiles/);
  assert.match(checker, /evidencePaths: \[\.\.\.frozen\.frames\]/);
});

test("both adapters implement the same visual-review seam", () => {
  const claude = readFileSync(new URL("./claudeComposer.ts", import.meta.url), "utf8");
  const codex = readFileSync(new URL("./codexComposer.ts", import.meta.url), "utf8");
  assert.match(claude, /async review\(context, request: VisualReviewRequest\)/);
  assert.match(codex, /async review\(context, request: VisualReviewRequest\)/);
  assert.match(claude, /request\.prompt/);
  assert.match(codex, /request\.prompt/);
  assert.match(codex, /request\.imagePaths/);
  assert.match(codex, /evidencePaths/);
  assert.match(claude, /evidencePaths/);
});
