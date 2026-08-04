import fs from "node:fs/promises";
import path from "node:path";
import {addMedia, aspectOf, type MediaItem} from "../core/media/library.ts";
import {labelScreenshot} from "../core/media/label.ts";
import {MEDIA_DIR} from "../core/paths.ts";
import {hash} from "../core/util/exec.ts";
import {gotoAndSettle, type CaptureSession} from "./session.ts";

export interface ShotSpec {
  /** Route inside the app, e.g. "/kanban". */
  route: string;
  /** Short slug used in the media id. */
  name: string;
  /** What this screenshot is evidence of. Shown to the composer. */
  caption: string;
  /** Wait for this selector before shooting, so the shot is never of a spinner. */
  waitFor?: string;
  /** Photograph one element instead of the whole viewport. */
  clipTo?: string;
  tags?: string[];
}

export interface ShotResult {
  item: MediaItem;
  skipped?: string;
}

/**
 * A library recorder, not a beat recorder.
 *
 * Screenshots are captured once into a reusable library and bound to sections later,
 * which is what lets a single capture session serve many videos. Shots are stills by
 * choice: a live screen recording of a real app is fragile in ways a still never is.
 */
export async function captureShots(
  session: CaptureSession,
  shots: readonly ShotSpec[],
  onLog: (line: string) => void = () => {},
  /**
   * Describe each shot with a small model after taking it.
   *
   * Off by default because it costs money and a curated `ShotSpec` list already carries
   * good captions written by hand. It earns its keep on volume — uploads, a long route
   * list, anything where nobody is going to write forty captions — and an unlabelled
   * library is one the planner cannot pick from: `shot-3 — Phone, portrait` says nothing
   * about whether that screenshot proves the point a section is making.
   */
  options: {label?: boolean} = {},
): Promise<ShotResult[]> {
  const screenshotDir = path.join(MEDIA_DIR, "screenshots");
  await fs.mkdir(screenshotDir, {recursive: true});

  const results: ShotResult[] = [];
  for (const shot of shots) {
    const id = `${shot.name}-${session.config.preset.id}`;
    try {
      await gotoAndSettle(session, shot.route);

      if (shot.waitFor) {
        await session.page.waitForSelector(shot.waitFor, {state: "visible", timeout: 15_000});
      }

      const target = shot.clipTo ? session.page.locator(shot.clipTo).first() : session.page;
      const file = path.join("screenshots", `${id}.png`);
      await target.screenshot({path: path.join(MEDIA_DIR, file), scale: "device"});

      const {width, height} = await session.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      const item: MediaItem = {
        id,
        kind: "screenshot",
        variants: [],
        file,
        width: shot.clipTo ? await measure(session, shot.clipTo, "width") : width,
        height: shot.clipTo ? await measure(session, shot.clipTo, "height") : height,
        caption: shot.caption,
        tags: [...(shot.tags ?? []), session.config.preset.id],
        safeToShow: true,
        state: "approved",
        source: {
          type: "playwright",
          url: shot.route,
          preset: session.config.preset.id,
          capturedAt: new Date().toISOString(),
        },
      };

      onLog(`  shot        ${id} · ${item.width}×${item.height} · ${aspectOf(item)}`);

      if (options.label) {
        const labelled = await labelScreenshot(file, onLog).catch(() => null);
        if (labelled) {
          // The hand-written caption wins if there is one: a curated ShotSpec knows what
          // the shot is *for*, which is a judgement about the video, not about the picture.
          item.caption = shot.caption || labelled.label.caption;
          item.tags = [...new Set([...item.tags, ...labelled.label.tags])];
          onLog(`  label       ${id} · ${labelled.label.tags.join(", ")} · $${labelled.costUsd.toFixed(4)}`);
          if (labelled.label.sensitive.length) {
            // Reported, never acted on. Whether this is publishable is the owner's call —
            // a mock name on a marketing page is fine, a real customer's is not, and only
            // they know which this is.
            onLog(`  label       ${id} POSSIBLY SENSITIVE: ${labelled.label.sensitive.join("; ")}`);
          }
        }
      }

      await addMedia(item);
      results.push({item});
    } catch (error) {
      // Fail loudly per shot but keep going: one missing selector should not cost
      // the whole session, and a silently substituted placeholder would be worse.
      const reason = (error as Error).message.split("\n")[0] ?? "unknown";
      onLog(`  shot        ${id} FAILED · ${reason}`);
      results.push({
        skipped: reason,
        item: {
          id,
          kind: "screenshot",
          variants: [],
          file: "",
          width: 0,
          height: 0,
          caption: shot.caption,
          tags: [],
          safeToShow: false,
          state: "stale",
          source: {type: "playwright", url: shot.route, preset: session.config.preset.id, capturedAt: new Date().toISOString()},
        },
      });
    }
  }
  return results;
}

async function measure(session: CaptureSession, selector: string, side: "width" | "height"): Promise<number> {
  const box = await session.page.locator(selector).first().boundingBox();
  return Math.round((box?.[side] ?? 0) * session.config.preset.deviceScaleFactor);
}

/**
 * The myHERALD surfaces worth showing. Deliberately a small, curated list: a video
 * needs three or four pieces of real evidence, not a tour of every screen.
 */
export const MYHERALD_SHOTS: ShotSpec[] = [
  {
    route: "/dashboard",
    name: "dashboard",
    caption: "The dashboard: what is running and what is waiting on a decision.",
    tags: ["overview"],
  },
  {
    route: "/kanban",
    name: "kanban",
    caption: "The content board, from idea to scheduled.",
    tags: ["workflow"],
  },
  {
    route: "/review",
    name: "review",
    caption: "The review queue, where a draft waits for a human yes.",
    tags: ["approval", "proof"],
  },
  {
    route: "/calendar",
    name: "calendar",
    caption: "A connected week rather than seven empty slots.",
    tags: ["planning"],
  },
  {
    route: "/knowledge",
    name: "knowledge",
    caption: "The knowledge base the writing is grounded in.",
    tags: ["context"],
  },
  {
    route: "/chat",
    name: "chat",
    caption: "Handing over one rough thought.",
    tags: ["input"],
  },
];

/** Deterministic id for a capture bundle, so a re-record overwrites the same file. */
export const bundleName = (baseUrl: string, presetId: string) =>
  `${presetId}-${hash({baseUrl}, 6)}`;
