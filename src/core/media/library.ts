import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {MEDIA_DIR, ROOT} from "../paths.ts";
import {familyOf, type FormatFamily, type OutputFormat} from "../plan/formats.ts";

export type Aspect = "landscape" | "portrait" | "square";

/**
 * Device presets for screen capture.
 *
 * Real viewport sizes, not idealised ratios: a maximised browser on a 14" MacBook is
 * roughly 1512×860 once the window chrome is gone, which is close to but not exactly
 * 16:9. Capturing at the real size and letting the composition frame it beats
 * pretending the screen matches the video.
 */
export interface DevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  /** The video shapes this preset is a sensible source for. */
  suits: FormatFamily[];
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  "desktop-wide": {
    id: "desktop-wide",
    label: "Desktop, widescreen",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    suits: ["landscape"],
  },
  macbook: {
    id: "macbook",
    label: "MacBook, maximised browser",
    width: 1512,
    height: 860,
    deviceScaleFactor: 2,
    isMobile: false,
    suits: ["landscape"],
  },
  "tablet-portrait": {
    id: "tablet-portrait",
    label: "Tablet, portrait",
    width: 1024,
    height: 1366,
    deviceScaleFactor: 2,
    isMobile: true,
    suits: ["portrait"],
  },
  mobile: {
    id: "mobile",
    label: "Phone, portrait",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    suits: ["portrait"],
  },
  "mobile-short": {
    id: "mobile-short",
    label: "Phone, cropped to a panel",
    width: 390,
    height: 620,
    deviceScaleFactor: 3,
    isMobile: true,
    suits: ["portrait"],
  },
};

/** What to capture for a given delivery format, without having to think about it. */
export function presetsFor(format: OutputFormat): DevicePreset[] {
  const family = familyOf(format);
  return Object.values(DEVICE_PRESETS).filter((preset) => preset.suits.includes(family));
}

export const mediaItemZ = z.object({
  id: z.string(),
  kind: z.enum(["screenshot", "recording", "upload", "logo"]),
  file: z.string(),
  width: z.number(),
  height: z.number(),
  durationMs: z.number().optional(),
  caption: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** False keeps it out of generation entirely, for anything not safe to show. */
  safeToShow: z.boolean().default(true),
  state: z.enum(["proposed", "approved", "stale"]).default("approved"),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("playwright"),
      url: z.string(),
      preset: z.string(),
      capturedAt: z.string(),
    }),
    z.object({type: z.literal("upload"), fileName: z.string(), addedAt: z.string()}),
  ]),
});

export type MediaItem = z.infer<typeof mediaItemZ>;

const INDEX_PATH = path.join(MEDIA_DIR, "index.json");

export function aspectOf(item: {width: number; height: number}): Aspect {
  const ratio = item.width / item.height;
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.87) return "portrait";
  return "square";
}

export async function readMedia(): Promise<MediaItem[]> {
  const raw = await fs.readFile(INDEX_PATH, "utf8").catch(() => "[]");
  const parsed = z.array(mediaItemZ).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

export async function writeMedia(items: readonly MediaItem[]): Promise<void> {
  await fs.mkdir(path.dirname(INDEX_PATH), {recursive: true});
  await fs.writeFile(INDEX_PATH, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

export async function addMedia(item: MediaItem): Promise<MediaItem[]> {
  const items = await readMedia();
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) items[index] = item;
  else items.push(item);
  await writeMedia(items);
  return items;
}

/**
 * The media a video may actually use.
 *
 * A landscape screenshot dropped into a 9:16 piece is a letterboxed strip with dead
 * space above and below, so the shape is filtered here rather than left to the
 * composer's judgement. Square reads acceptably either way.
 */
export async function mediaForFormat(format: OutputFormat): Promise<MediaItem[]> {
  const family = familyOf(format);
  return (await readMedia()).filter((item) => {
    if (!item.safeToShow || item.state !== "approved") return false;
    const aspect = aspectOf(item);
    if (aspect === "square") return true;
    return family === "landscape" ? aspect === "landscape" : aspect === "portrait";
  });
}

/** What the composer is shown: enough to lay it out, never a real path. */
export const mediaBrief = (item: MediaItem) => ({
  id: item.id,
  kind: item.kind,
  width: item.width,
  height: item.height,
  aspect: aspectOf(item),
  durationMs: item.durationMs,
  caption: item.caption,
  tags: item.tags,
});

export const mediaPath = (item: MediaItem) => path.join(ROOT, "data", "media", item.file);

/**
 * The real files a plan's `mediaId` and `screen.mediaId` references point at.
 *
 * Resolution is a lookup by id against the index — never a path taken from the plan. That
 * is the whole reason the plan carries ids: the composer is shown `media/<id>.png` and the
 * file is copied into the workdir under exactly that name, so a model cannot name a file
 * outside the library and cannot invent a screenshot that does not exist. An id with no
 * approved, safe-to-show entry behind it is returned as missing rather than substituted,
 * because a silently dropped `<img>` is how a video ships with an empty panel where the
 * evidence was supposed to be.
 */
export function bindMedia(
  sections: readonly {mediaId?: string; screen?: {mediaId: string}}[],
  items: readonly MediaItem[],
): {files: {id: string; path: string}[]; missing: string[]} {
  const wanted = [...new Set(
    sections.flatMap((section) => [section.screen?.mediaId, section.mediaId].filter(Boolean) as string[]),
  )];
  if (!wanted.length) return {files: [], missing: []};

  const usable = new Map(
    items.filter((item) => item.safeToShow && item.state !== "stale").map((item) => [item.id, item]),
  );

  const files: {id: string; path: string}[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    const item = usable.get(id);
    if (item) files.push({id, path: mediaPath(item)});
    else missing.push(id);
  }
  return {files, missing};
}

/** `bindMedia` against the library on disk. */
export const mediaForPlan = async (sections: Parameters<typeof bindMedia>[0]) =>
  bindMedia(sections, await readMedia());

/**
 * Reject a binding whose shape does not fit the delivery format. This runs in the
 * pre-render gate, so a mismatch never reaches a rendered file.
 */
export function checkMediaFit(
  items: readonly MediaItem[],
  bindings: readonly {sectionId: string; mediaId: string}[],
  format: OutputFormat,
): string[] {
  const family = familyOf(format);
  const problems: string[] = [];

  for (const binding of bindings) {
    const item = items.find((candidate) => candidate.id === binding.mediaId);
    if (!item) {
      problems.push(`Section ${binding.sectionId} references media "${binding.mediaId}", which does not exist.`);
      continue;
    }
    if (!item.safeToShow) {
      problems.push(`Section ${binding.sectionId} uses "${item.id}", which is marked not safe to show.`);
      continue;
    }
    const aspect = aspectOf(item);
    if (aspect === "square") continue;
    const wanted = family === "landscape" ? "landscape" : "portrait";
    if (aspect !== wanted) {
      problems.push(
        `Section ${binding.sectionId} binds a ${aspect} screenshot (${item.width}×${item.height}) `
        + `into a ${family} video. Capture it with a ${wanted} preset instead.`,
      );
    }
  }
  return problems;
}
