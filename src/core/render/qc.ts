import fs from "node:fs/promises";
import path from "node:path";
import {NARRATION_TARGET_LUFS, NARRATION_TRUE_PEAK_DB} from "../audio/master.ts";
import {FORMATS, type OutputFormat} from "../plan/formats.ts";
import {captionTranscript, type CaptionData} from "../tts/captions.ts";
import {fileHash, run} from "../util/exec.ts";

export const CAPTION_MAX_WORDS = 8;
export const CAPTION_MAX_CHARS = 52;

export interface QcReport {
  passed: boolean;
  format: OutputFormat;
  media: Record<string, unknown>;
  captions: Record<string, unknown>;
  checks: Record<string, boolean>;
  diagnostics: Record<string, unknown>;
  hashes: Record<string, string>;
}

/**
 * Post-render verification against the actual file. `hyperframes check` validates the
 * composition; this validates the artefact — the two catch different things.
 */
export async function runQc(options: {
  videoPath: string;
  format: OutputFormat;
  expectedDurationMs: number;
  fps: number;
  captions: CaptionData;
  coverPath?: string;
  extraHashPaths?: readonly string[];
}): Promise<QcReport> {
  const {videoPath, format, expectedDurationMs, fps, captions, coverPath, extraHashPaths = []} = options;
  const spec = FORMATS[format];

  const probe = JSON.parse((await run("ffprobe", [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", videoPath,
  ])).stdout) as {streams: Record<string, string | number>[]; format: Record<string, string>};

  const video = probe.streams.find((stream) => stream.codec_type === "video") ?? {};
  const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(probe.format.duration);

  const freeze = await filterLog(videoPath, "freezedetect=n=0.001:d=2.5");
  const black = await filterLog(videoPath, "blackdetect=d=0.15:pix_th=0.05");
  const loudness = await filterLog(videoPath, null, ["-af", "ebur128=peak=true"]);

  const summary = loudness.match(
    /Integrated loudness:[\s\S]*?I:\s+(-?\d+\.\d+) LUFS[\s\S]*?True peak:[\s\S]*?Peak:\s+(-?\d+\.\d+) dBFS/,
  );
  const integratedLufs = summary?.[1] ? Number(summary[1]) : null;
  const truePeakDbfs = summary?.[2] ? Number(summary[2]) : null;

  const pageWords = captions.pages.map((page) => page.text.trim().split(/\s+/).length);
  const pageChars = captions.pages.map((page) => page.text.length);
  const maxWords = Math.max(0, ...pageWords);
  const maxChars = Math.max(0, ...pageChars);
  const lastCaptionEndMs = Math.max(0, ...captions.tokens.map((token) => token.toMs));

  const tokenTranscript = captions.tokens.map((token) => token.text).join(" ").replace(/\s+/g, " ").trim();

  const checks: Record<string, boolean> = {
    resolution: video.width === spec.width && video.height === spec.height,
    frameRate: String(video.r_frame_rate) === `${fps}/1`,
    durationWithinOneFrame: Math.abs(durationSeconds * 1000 - expectedDurationMs) <= (1000 / fps) + 60,
    videoCodec: video.codec_name === "h264",
    pixelFormat: video.pix_fmt === "yuv420p",
    oneAudioTrack: audio.length === 1,
    audioCodec: audio[0]?.codec_name === "aac",
    loudnessNearTarget: integratedLufs !== null && Math.abs(integratedLufs - NARRATION_TARGET_LUFS) <= 3,
    truePeakInRange: truePeakDbfs !== null && truePeakDbfs <= NARRATION_TRUE_PEAK_DB + 0.5,
    noLongFreeze: !/freeze_start/.test(freeze),
    noBlackSection: !/black_start/.test(black),
    captionTranscriptExact: tokenTranscript === captionTranscript(captions),
    captionPagesReadable: maxWords <= CAPTION_MAX_WORDS && maxChars <= CAPTION_MAX_CHARS,
    captionsClearBeforeFinalFrame: lastCaptionEndMs <= durationSeconds * 1000,
    coverPresent: coverPath ? await fs.access(coverPath).then(() => true).catch(() => false) : true,
  };

  const hashes: Record<string, string> = {[path.basename(videoPath)]: await fileHash(videoPath)};
  for (const extra of [coverPath, ...extraHashPaths].filter(Boolean) as string[]) {
    hashes[path.basename(extra)] = await fileHash(extra).catch(() => "");
  }

  return {
    passed: Object.values(checks).every(Boolean),
    format,
    media: {
      width: video.width,
      height: video.height,
      frameRate: video.r_frame_rate,
      durationSeconds,
      videoCodec: video.codec_name,
      pixelFormat: video.pix_fmt,
      audioTracks: audio.length,
      audioCodec: audio[0]?.codec_name ?? null,
      integratedLufs,
      truePeakDbfs,
    },
    captions: {
      pageCount: captions.pages.length,
      tokenCount: captions.tokens.length,
      maxWordsPerPage: maxWords,
      maxCharsPerPage: maxChars,
      lastCaptionEndMs,
      alignment: captions.alignment,
    },
    checks,
    diagnostics: {
      freezeEvents: freeze.match(/lavfi\.freezedetect\.[^\n]+/g) ?? [],
      blackEvents: black.match(/black_(?:start|end|duration):\S+/g) ?? [],
      failed: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
    },
    hashes,
  };
}

async function filterLog(videoPath: string, videoFilter: string | null, extra: string[] = []) {
  const args = [
    "-hide_banner", "-nostats", "-v", "info",
    "-i", videoPath,
    ...(videoFilter ? ["-vf", videoFilter, "-an"] : []),
    ...extra,
    "-f", "null", "-",
  ];
  // ffmpeg writes analysis output to stderr and exits 0; a failure means no data.
  const result = await run("ffmpeg", args).catch((error: unknown) => error as {stderr?: string});
  return result.stderr ?? "";
}

export async function writeQc(report: QcReport, target: string) {
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/**
 * QC failures the composer can actually act on, phrased as something it can fix.
 *
 * Codec, resolution and loudness failures are pipeline problems and are deliberately
 * absent — handing those to the composer would just burn a repair pass on something
 * it has no control over.
 */
const COMPOSER_FIXABLE: Record<string, string> = {
  noLongFreeze:
    "The rendered video holds a completely static frame for over 2.5 seconds. Add a "
    + "meaningful visual beat inside that span, then hold the resolved state. Do not add "
    + "perpetual drift solely to satisfy the check.",
  noBlackSection:
    "The rendered video goes fully black for a stretch. A scene is leaving before the next "
    + "one arrives — overlap the transition instead of cutting to nothing.",
  captionsClearBeforeFinalFrame:
    "A caption is still on screen after the video ends. The caption layer must clear before "
    + "the final frame.",
};

export function composerFixableFailures(report: QcReport): {check: string; message: string}[] {
  return (report.diagnostics.failed as string[])
    .filter((check) => check in COMPOSER_FIXABLE)
    .map((check) => ({check, message: COMPOSER_FIXABLE[check] as string}));
}
