import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {ROOT} from "../src/core/paths.ts";

// The server and the composer both need the keys; load them before anything spawns.
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

const children = [
  spawn("npx", ["tsx", "watch", "src/server/index.ts"], {cwd: ROOT, stdio: "inherit", env: process.env}),
  spawn("npx", ["vite", "--host", "127.0.0.1"], {cwd: ROOT, stdio: "inherit", env: process.env}),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
