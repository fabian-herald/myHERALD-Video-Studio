import {constants as fsConstants} from "node:fs";
import fs from "node:fs/promises";
import {run} from "../util/exec.ts";

/**
 * HyperFrames requires Node 22+. The process running this pipeline is often older
 * (nvm defaults commonly are), so probe the usual locations for a compatible binary.
 */
export async function compatibleNode(): Promise<string> {
  const candidates = [
    process.env.HYPERFRAMES_NODE_PATH,
    process.execPath,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const tried: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    if (!await fs.access(candidate, fsConstants.X_OK).then(() => true).catch(() => false)) continue;
    const major = await run(candidate, ["--version"])
      .then(({stdout}) => Number.parseInt(stdout.trim().replace(/^v/, ""), 10))
      .catch(() => 0);
    tried.push(`${candidate} (v${major || "?"})`);
    if (major >= 22) return candidate;
  }

  throw new Error(
    "HyperFrames requires Node 22 or newer. None of the probed runtimes qualify: "
    + `${tried.join(", ") || "none found"}. Set HYPERFRAMES_NODE_PATH in .env.local.`,
  );
}
