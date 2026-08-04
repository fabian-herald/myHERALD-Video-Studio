import {spawn} from "node:child_process";
import {constants as fsConstants} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {readSettings} from "../settings.ts";

export interface CodexSubscriptionStatus {
  available: boolean;
  executable?: string;
  reason?: string;
}

export async function resolveCodexExecutable(): Promise<string | null> {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  for (const candidate of candidates.filter(Boolean) as string[]) {
    if (await fs.access(candidate, fsConstants.X_OK).then(() => true).catch(() => false)) return candidate;
  }

  return new Promise<string | null>((resolve) => {
    const child = spawn("which", ["codex"], {stdio: ["ignore", "pipe", "ignore"]});
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", () => resolve(output.trim() || null));
    child.on("error", () => resolve(null));
  });
}

export async function codexSubscriptionStatus(): Promise<CodexSubscriptionStatus> {
  const executable = await resolveCodexExecutable();
  if (!executable) {
    return {available: false, reason: "Codex is not installed on this Mac."};
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const auth = await fs.readFile(path.join(codexHome, "auth.json"), "utf8")
    .then((raw) => JSON.parse(raw) as {auth_mode?: string; tokens?: unknown})
    .catch(() => null);
  if (auth?.auth_mode !== "chatgpt" || !auth.tokens) {
    return {
      available: false,
      executable,
      reason: "Codex is installed, but it is not signed in with a ChatGPT subscription.",
    };
  }
  return {available: true, executable};
}

export async function requireCodexSubscription(): Promise<string> {
  const status = await codexSubscriptionStatus();
  if (!status.available || !status.executable) {
    throw new Error(status.reason ?? "Codex is unavailable.");
  }
  return status.executable;
}

/**
 * Codex must run against the local ChatGPT subscription. Do not inherit arbitrary env
 * variables: an OPENAI_API_KEY in .env.local would silently turn a subscription feature
 * into metered API usage, exactly the billing ambiguity this boundary exists to prevent.
 */
export function codexChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const keep = [
    "PATH", "HOME", "CODEX_HOME", "TMPDIR", "TEMP", "TMP", "SHELL", "USER", "LOGNAME", "LANG", "TZ",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  Object.assign(env, extra);
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

/**
 * Which model, and how hard it thinks. Environment first, then settings, then the default.
 *
 * Both are async because settings live on disk. `settings.ts` imports only node builtins,
 * zod, `paths.ts` and `plan/language.ts`, so there is no cycle back to here.
 *
 * The environment stays ahead of settings deliberately: a one-off `CODEX_MODEL=… npm run
 * make` is how a new model gets tried without committing the studio to it.
 */
export const codexModel = async () =>
  process.env.CODEX_MODEL || (await readSettings()).codexModel || "gpt-5.6-terra";

/**
 * Reasoning effort for the pass that decides the composition.
 *
 * `xhigh` is verified accepted by codex-cli 0.146.0 against gpt-5.6-terra. It is the
 * default because the work this studio asks of the model is a composition, not a lookup:
 * on the same brief Codex authored 65 lines of CSS to Claude's 570, and thinking budget is
 * the one input we control without changing models.
 *
 * Worth lowering when a model that does not accept `xhigh` is selected — `codex` takes an
 * unknown effort value silently rather than erroring, so the symptom is a failed run with
 * nothing in it that names the cause.
 */
export const codexEffort = async () =>
  process.env.CODEX_REASONING_EFFORT || (await readSettings()).codexComposeEffort;
