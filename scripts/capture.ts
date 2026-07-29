import fs from "node:fs/promises";
import path from "node:path";
import {readMedia} from "../src/core/media/library.ts";
import {ROOT, rel} from "../src/core/paths.ts";
import {
  AUTH_STATE,
  gotoAndSettle,
  openCaptureSession,
  presetOrThrow,
  saveAuthState,
  type CaptureMode,
} from "../src/capture/session.ts";
import {bundleName, captureShots, MYHERALD_SHOTS} from "../src/capture/shots.ts";

await loadEnv();

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string, fallback = "") => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};

const BASE_URL = flag("url", process.env.CAPTURE_BASE_URL ?? "http://localhost:3000");
const WORKSPACE = flag("workspace", process.env.CAPTURE_WORKSPACE_ID ?? "");
const PRESET = flag("preset", "macbook");

if (command === "help") {
  console.log(`Usage: npm run capture -- <command> [options]

  login     Open a browser, sign in by hand, and save the session.
  record    Drive the live app once and freeze every response into a HAR bundle.
  shots     Take the screenshots. Uses the recording when one exists.
  list      Show what is already in the media library.

  --url         app base URL            (default ${BASE_URL})
  --workspace   workspace id to pin     (required for login and record)
  --preset      ${"desktop-wide | macbook | tablet-portrait | mobile | mobile-short"}
  --live        for \`shots\`: hit the running app instead of the recording

The workspace is pinned on every navigation and capture refuses to run live without
one, so a screenshot can never accidentally show real customer data.`);
  process.exit(0);
}

// Capture fails for ordinary, expected reasons — no recording yet, app not running,
// session expired. Those deserve a sentence, not a stack trace.
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function fail(error: unknown) {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
}

const preset = presetOrThrow(PRESET);
const bundle = bundleName(BASE_URL, preset.id);

if (command === "login") {
  requireWorkspace();
  console.log(`login         opening ${BASE_URL} · sign in, then close the window`);
  const {chromium} = await import("playwright");
  const browser = await chromium.launch({headless: false});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  await page.goto(BASE_URL);
  await page.waitForEvent("close", {timeout: 0});
  const saved = await saveAuthState(context);
  await browser.close();
  console.log(`session       saved to ${rel(saved)}`);
  process.exit(0);
}

if (command === "record") {
  requireWorkspace();
  const session = await openCaptureSession({
    baseUrl: BASE_URL,
    workspaceId: WORKSPACE,
    preset,
    mode: "record",
    bundle,
  });
  console.log(`record        ${BASE_URL} · workspace ${WORKSPACE} · ${preset.label}`);

  for (const shot of MYHERALD_SHOTS) {
    try {
      await gotoAndSettle(session, shot.route);
      console.log(`  visited     ${shot.route}`);
    } catch (error) {
      console.log(`  visited     ${shot.route} FAILED · ${(error as Error).message.split("\n")[0]}`);
    }
  }
  await session.close();
  console.log(`bundle        data/capture/har/${bundle}.har`);
  console.log("");
  console.log("The app's state is now frozen. `npm run capture -- shots` replays this");
  console.log("bundle, so the screenshots stay identical no matter what the app does next.");
  process.exit(0);
}

if (command === "shots") {
  const live = argv.includes("--live");
  if (live) requireWorkspace();

  const mode: CaptureMode = live ? "live" : "replay";
  const session = await openCaptureSession({
    baseUrl: BASE_URL,
    ...(live ? {workspaceId: WORKSPACE} : {}),
    preset,
    mode,
    bundle,
  });
  console.log(`shots         ${mode} · ${preset.label} (${preset.width}×${preset.height})`);

  const results = await captureShots(session, MYHERALD_SHOTS, (line) => console.log(line));
  await session.close();

  const failed = results.filter((result) => result.skipped);
  console.log("");
  console.log(`captured      ${results.length - failed.length} of ${results.length}`);
  if (failed.length) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

if (command === "list") {
  const items = await readMedia();
  console.log(`media         ${items.length} item(s)`);
  for (const item of items) {
    console.log(
      `  ${item.id.padEnd(28)}${String(item.width).padStart(5)}×${String(item.height).padEnd(6)}`
      + `${item.state.padEnd(10)}${item.caption}`,
    );
  }
  process.exit(0);
}

console.error(`Unknown command "${command}". Run without arguments for help.`);
process.exit(1);

function requireWorkspace() {
  if (WORKSPACE) return;
  console.error(
    "This command needs --workspace <id> (or CAPTURE_WORKSPACE_ID).\n"
    + "Capture is fail-closed on purpose: without a pinned workspace it would\n"
    + "photograph whatever account happens to be signed in.",
  );
  process.exit(1);
}

async function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const raw = await fs.readFile(path.join(ROOT, file), "utf8").catch(() => null);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match?.[1]) continue;
      const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value && !process.env[match[1]]) process.env[match[1]] = value;
    }
  }
  void AUTH_STATE;
}
