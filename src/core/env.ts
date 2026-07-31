import fs from "node:fs/promises";
import path from "node:path";
import {ROOT} from "./paths.ts";

/** Load local development secrets without adding a dotenv runtime dependency. */
export async function loadLocalEnv() {
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
  // Accept the short name already used by an existing local setup. Keep the rest of
  // the application on the documented variable name without rewriting the secret file.
  if (!process.env.CARTESIA_API_KEY && process.env.CARTESIA) {
    process.env.CARTESIA_API_KEY = process.env.CARTESIA;
  }
}
