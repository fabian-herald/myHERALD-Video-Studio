import fs from "node:fs/promises";
import path from "node:path";
import {chromium, type Browser, type BrowserContext, type Page} from "playwright";
import {DEVICE_PRESETS, type DevicePreset} from "../core/media/library.ts";
import {DATA_DIR, ROOT} from "../core/paths.ts";
import {FREEZE_CSS, HIDE_DEV_OVERLAYS_CSS, REMOVE_DEV_OVERLAYS_JS} from "./freeze.ts";

export const AUTH_DIR = path.join(ROOT, ".auth");
export const AUTH_STATE = path.join(AUTH_DIR, "capture.json");
export const HAR_DIR = path.join(DATA_DIR, "capture", "har");

/** Time is frozen so a clock, a relative timestamp or a countdown never drifts. */
export const FROZEN_TIME = "2026-04-17T09:24:00.000Z";

export type CaptureMode = "live" | "record" | "replay";

export interface CaptureConfig {
  /** Where the app runs, e.g. http://localhost:3000 */
  baseUrl: string;
  /**
   * The one workspace captures may touch. Required in live and record mode: a
   * screenshot of the wrong workspace is a data leak that ships in a video.
   */
  workspaceId?: string;
  preset: DevicePreset;
  mode: CaptureMode;
  /** Bundle name under data/capture/har. One bundle per capture session. */
  bundle: string;
}

export interface CaptureSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  config: CaptureConfig;
  close(): Promise<void>;
}

export function presetOrThrow(id: string): DevicePreset {
  const preset = DEVICE_PRESETS[id];
  if (!preset) {
    throw new Error(`Unknown device preset "${id}". Known: ${Object.keys(DEVICE_PRESETS).join(", ")}.`);
  }
  return preset;
}

/**
 * Open a browser prepared for deterministic capture.
 *
 * `record` drives the real app once and writes a HAR bundle; `replay` serves every
 * request from that bundle, so later captures need no running app, no database and
 * no seeded workspace. That is the answer to "how do I fill these workspaces": you
 * fill them once by using the product, we freeze the result, and the screenshots
 * stop changing underneath the videos that use them.
 */
export async function openCaptureSession(config: CaptureConfig): Promise<CaptureSession> {
  if (config.mode !== "replay" && !config.workspaceId) {
    throw new Error(
      "Live capture needs an explicit workspace id. Refusing to photograph whatever "
      + "workspace happens to be signed in.",
    );
  }

  const harPath = path.join(HAR_DIR, `${config.bundle}.har`);
  if (config.mode === "replay" && !await exists(harPath)) {
    throw new Error(
      `No recording at ${path.relative(ROOT, harPath)}. Run \`npm run capture -- record\` once `
      + "against the live app first.",
    );
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: {width: config.preset.width, height: config.preset.height},
    deviceScaleFactor: config.preset.deviceScaleFactor,
    isMobile: config.preset.isMobile,
    hasTouch: config.preset.isMobile,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    storageState: await exists(AUTH_STATE) ? AUTH_STATE : undefined,
    ...(config.mode === "record"
      ? {recordHar: {path: harPath, mode: "full" as const, content: "embed" as const}}
      : {}),
  });

  if (config.mode === "replay") {
    // Serve every request, including the top-level document, from the bundle.
    // Next.js renders most of this on the server, so intercepting only /api would
    // leave the page blank.
    await context.routeFromHAR(harPath, {notFound: "abort", update: false});
  }

  await context.addInitScript(`
    Date.now = () => new Date(${JSON.stringify(FROZEN_TIME)}).getTime();
    const FixedDate = Date;
    globalThis.Date = class extends FixedDate {
      constructor(...args) {
        super(...(args.length ? args : [${JSON.stringify(FROZEN_TIME)}]));
      }
      static now() { return new FixedDate(${JSON.stringify(FROZEN_TIME)}).getTime(); }
    };
    Math.random = () => 0.42;
  `);

  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    config,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

/** Navigate, settle, then strip everything that only exists because this is a dev build. */
export async function gotoAndSettle(session: CaptureSession, route: string): Promise<void> {
  const url = new URL(route, session.config.baseUrl);
  if (session.config.workspaceId) url.searchParams.set("workspace", session.config.workspaceId);

  await session.page.goto(url.toString(), {waitUntil: "networkidle", timeout: 45_000});
  await dismissConsent(session.page);
  await session.page.addStyleTag({content: `${FREEZE_CSS}\n${HIDE_DEV_OVERLAYS_CSS}`});
  await session.page.evaluate(REMOVE_DEV_OVERLAYS_JS);
  await session.page.evaluate(() => document.fonts.ready);
  // One frame for the injected styles to take effect before the shutter.
  await session.page.waitForTimeout(120);
}

/**
 * Buttons that decline non-essential cookies, in the order we would rather click them.
 *
 * Reject only. "Accept all" is never in this list and must never be added: the capture
 * browser is acting on the owner's behalf, and consenting to tracking on their behalf is
 * not a decision a screenshot tool gets to make. If only an accept button exists, the
 * banner stays in the shot and that is the correct outcome — a visible banner is a problem
 * you can see, where a silent opt-in is not.
 */
const CONSENT_REJECT = [
  "button:has-text('Reject All')",
  "button:has-text('Reject all')",
  "button:has-text('Decline')",
  "button:has-text('Only essential')",
  "button:has-text('Necessary only')",
  "button:has-text('Alle ablehnen')",
  "button:has-text('Ablehnen')",
  "[aria-label*='reject' i]",
];

/**
 * Dismiss a cookie banner before the shutter, declining non-essential cookies.
 *
 * Worth the trouble because a consent modal does not merely sit in the corner: it dims the
 * page behind it. The first capture of the marketing site came back as a full-height
 * overlay over a greyed hero, and the labeller dutifully described the cookie dialogue —
 * a screenshot that proves nothing about the product.
 */
export async function dismissConsent(page: Page): Promise<string | null> {
  // The banner is usually injected after load rather than served with the document.
  await page.waitForTimeout(1200);

  for (const selector of CONSENT_REJECT) {
    const matches = page.locator(selector);
    const count = await matches.count().catch(() => 0);
    // Every match, not just the first. These widgets ship the same button twice — once in
    // the visible banner and once inside a collapsed preferences panel — and taking
    // `.first()` lands on the hidden copy, reads it as absent, and skips a selector that
    // would have worked. That is exactly how the first version of this silently did nothing.
    for (let index = 0; index < count; index++) {
      const button = matches.nth(index);
      if (!await button.isVisible({timeout: 300}).catch(() => false)) continue;
      await button.click({timeout: 2000}).catch(() => {});
      // The overlay animates out; shooting mid-fade is its own defect.
      await page.waitForTimeout(700);
      return selector;
    }
  }
  return null;
}

export async function saveAuthState(context: BrowserContext): Promise<string> {
  await fs.mkdir(AUTH_DIR, {recursive: true});
  await context.storageState({path: AUTH_STATE});
  return AUTH_STATE;
}

const exists = (target: string) => fs.access(target).then(() => true).catch(() => false);
