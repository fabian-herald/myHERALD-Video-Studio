import fs from "node:fs/promises";
import path from "node:path";
import {BRAND_DIR} from "../paths.ts";
import {loadBrandKit, saveBrandKit, type BrandKit, type Logo, type LogoRole} from "./kit.ts";

/**
 * Adding and removing marks. Small on purpose: a logo is a file plus four facts about
 * it, and the studio's job is to keep the file, the facts and the kit in step.
 */

const LOGO_DIR = path.join(BRAND_DIR, "logos");
const MAX_BYTES = 4_000_000;

/** What a browser can hand us, and what a composition can then place. */
const ACCEPTED: Record<string, string> = {
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export interface LogoUpload {
  /** `data:image/png;base64,...` straight from a FileReader. */
  dataUrl: string;
  role: LogoRole;
  theme: "light" | "dark" | "any";
  label?: string;
  safeAreaPct?: number;
  /** Set when the uploaded asset already renders the brand tagline. */
  includesTagline?: boolean;
  /** Slug for the file and the id. Derived from the filename when absent. */
  id?: string;
}

const slug = (value: string) =>
  value.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export async function addLogo(upload: LogoUpload): Promise<BrandKit> {
  const match = upload.dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("Expected a base64 data URL.");

  const [, mime = "", encoded = ""] = match;
  const extension = ACCEPTED[mime.toLowerCase()];
  if (!extension) {
    throw new Error(`${mime} is not an image format the studio places. Use PNG, SVG, JPEG or WebP.`);
  }

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new Error("That file is empty.");
  if (bytes.length > MAX_BYTES) throw new Error(`That file is ${Math.round(bytes.length / 1e6)} MB; the ceiling is 4 MB.`);

  const kit = await loadBrandKit();
  const base = slug(upload.id ?? `${upload.role}-${upload.theme}`) || "logo";
  const id = uniqueId(base, kit.logos);
  const file = path.join("logos", `${id}${extension}`);

  await fs.mkdir(LOGO_DIR, {recursive: true});
  await fs.writeFile(path.join(BRAND_DIR, file), bytes);

  const size = measure(bytes, extension);
  const logo: Logo = {
    id,
    role: upload.role,
    theme: upload.theme,
    file,
    safeAreaPct: upload.safeAreaPct ?? 0.25,
    // Conservative for an upload: claiming a tagline that is not in the pixels would let a
    // silent outro ship with no brand context at all. The kit can set it deliberately.
    includesTagline: upload.includesTagline ?? false,
    label: upload.label ?? "",
    ...(size ?? {}),
  };

  const next = {...kit, logos: [...kit.logos, logo]};
  await saveBrandKit(next);
  return next;
}

export async function removeLogo(id: string): Promise<BrandKit> {
  const kit = await loadBrandKit();
  const logo = kit.logos.find((entry) => entry.id === id);
  if (!logo) throw new Error(`No logo called "${id}".`);

  // The kit entry goes first. A file left behind is harmless; a kit pointing at a file
  // that is gone breaks every render until someone notices.
  const next = {...kit, logos: kit.logos.filter((entry) => entry.id !== id)};
  await saveBrandKit(next);
  await fs.rm(path.join(BRAND_DIR, logo.file), {force: true}).catch(() => {});
  return next;
}

function uniqueId(base: string, existing: readonly Logo[]): string {
  if (!existing.some((logo) => logo.id === base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!existing.some((logo) => logo.id === candidate)) return candidate;
  }
}

/**
 * Intrinsic size, read from the file's own header rather than trusted from the client.
 * Returns nothing when the format hides it — an SVG with no viewBox, say — because a
 * missing dimension is honest and a guessed one is not.
 */
export function measure(bytes: Buffer, extension: string): {width: number; height: number} | null {
  if (extension === ".png" && bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  }

  if (extension === ".svg") {
    const head = bytes.subarray(0, 2048).toString("utf8");
    const box = head.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (box) return {width: Math.round(Number(box[1])), height: Math.round(Number(box[2]))};
    const width = head.match(/\bwidth\s*=\s*["'](\d+)/i);
    const height = head.match(/\bheight\s*=\s*["'](\d+)/i);
    if (width && height) return {width: Number(width[1]), height: Number(height[1])};
    return null;
  }

  if (extension === ".jpg") {
    // Walk the segment chain to the frame header; only SOFn carries the dimensions.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1] ?? 0;
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7)};
      }
      offset += 2 + length;
    }
    return null;
  }

  if (extension === ".webp" && bytes.length > 30 && bytes.subarray(8, 12).toString() === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString();
    if (chunk === "VP8X") return {width: read24(bytes, 24) + 1, height: read24(bytes, 27) + 1};
    if (chunk === "VP8 ") return {width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff};
    return null;
  }

  return null;
}

const read24 = (bytes: Buffer, offset: number) =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
