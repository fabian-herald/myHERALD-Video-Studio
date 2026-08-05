import {readSettings} from "../settings.ts";

/**
 * Which model the Claude Agent SDK runs, as an options fragment.
 *
 * A fragment rather than a string because "no opinion" has to stay expressible: passing
 * `model: ""` pins the session to an empty model id, whereas leaving the key off lets the
 * SDK choose, which is what the studio wants until the owner says otherwise. Spreading the
 * result keeps that distinction at the one place it is decided instead of at every caller.
 *
 * Environment ahead of settings, matching `codexModel` — a one-off `CLAUDE_MODEL=… npm run
 * make` is how a model gets tried without committing the studio to it.
 */
export async function claudeModelOption(): Promise<{model?: string}> {
  const model = process.env.CLAUDE_MODEL || (await readSettings()).claudeModel;
  return model ? {model} : {};
}
