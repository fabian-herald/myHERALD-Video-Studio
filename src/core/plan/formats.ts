export const OUTPUT_FORMATS = ["9x16", "4x5", "1x1", "16x9"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Compositions differ in shape per family, not per format. */
export type FormatFamily = "portrait" | "landscape";

export interface FormatSpec {
  format: OutputFormat;
  family: FormatFamily;
  width: number;
  height: number;
  /** Layout scale relative to the 1080-wide reference the brand type scale assumes. */
  unit: number;
  label: string;
}

export const FORMATS: Record<OutputFormat, FormatSpec> = {
  "9x16": {format: "9x16", family: "portrait", width: 1080, height: 1920, unit: 1, label: "Vertical"},
  "4x5": {format: "4x5", family: "portrait", width: 1080, height: 1350, unit: 1, label: "Feed portrait"},
  "1x1": {format: "1x1", family: "portrait", width: 1080, height: 1080, unit: 1, label: "Square"},
  "16x9": {format: "16x9", family: "landscape", width: 1920, height: 1080, unit: 1.32, label: "Widescreen"},
};

export const familyOf = (format: OutputFormat): FormatFamily => FORMATS[format].family;

/** Group requested formats by family — one compose pass per family. */
export function byFamily(formats: readonly OutputFormat[]): Map<FormatFamily, OutputFormat[]> {
  const grouped = new Map<FormatFamily, OutputFormat[]>();
  for (const format of formats) {
    const family = familyOf(format);
    grouped.set(family, [...(grouped.get(family) ?? []), format]);
  }
  return grouped;
}

/**
 * The reference canvas a family is authored against. Other formats in the same
 * family reuse the composition with a different root width/height.
 */
export function referenceFormat(family: FormatFamily): OutputFormat {
  return family === "landscape" ? "16x9" : "9x16";
}

/**
 * Caption safe band as canvas fractions. Vertical formats keep captions clear of
 * platform UI; landscape sits them lower because nothing overlaps there.
 */
export function captionZone(family: FormatFamily) {
  return family === "landscape"
    ? {x0: 0.08, y0: 0.78, x1: 0.92, y1: 0.94}
    : {x0: 0.06, y0: 0.73, x1: 0.94, y1: 0.88};
}
