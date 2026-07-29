import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {createReadStream} from "node:fs";
import {loadBrandKit, saveBrandKit, brandKitZ, verifyPairs} from "../core/brand/kit.ts";
import {writeTokensCss} from "../core/brand/tokens.ts";
import {addLogo, removeLogo} from "../core/brand/logos.ts";
import {LOGO_ROLES} from "../core/brand/kit.ts";
import {DEVICE_PRESETS, readMedia} from "../core/media/library.ts";
import {readFacts, writeFacts, factZ} from "../core/knowledge/facts.ts";
import {researchSite, saveResearch} from "../core/knowledge/research.ts";
import {readSettings, writeSettings, settingsZ} from "../core/settings.ts";
import {readLedger} from "../core/ledger.ts";
import {INTENT_PRESETS} from "../core/intents/index.ts";
import {loadPlan, ENERGIES} from "../core/plan/schema.ts";
import {languageName} from "../core/plan/language.ts";
import {OUT_DIR, ROOT, videoDir} from "../core/paths.ts";
import {applyPlanEdits} from "../core/pipeline/apply.ts";
import {createVideoThread, listThreads, loadThread, studioThread} from "../core/threads.ts";
import {runAgentTurn, recordTurn, type AgentEvent} from "./agent.ts";
import {z} from "zod";

const PORT = Number(process.env.STUDIO_API_PORT ?? 5174);
/** An env override still wins, so a one-off run can pin the composer without editing state. */
const COMPOSER_OVERRIDE = process.env.STUDIO_COMPOSER;

/** Files the browser may read. Everything else is off limits. */
const SERVABLE = [OUT_DIR, path.join(ROOT, "data", "brand")];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  try {
    await route(request, response, url);
  } catch (error) {
    if (!response.headersSent) json(response, 500, {error: (error as Error).message});
    else response.end();
  }
});

async function route(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const {pathname} = url;
  const method = request.method ?? "GET";

  if (method === "OPTIONS") return json(response, 204, {});

  // — threads —————————————————————————————————————————————
  if (pathname === "/api/threads" && method === "GET") {
    await studioThread();
    return json(response, 200, await listThreads());
  }

  if (pathname === "/api/threads" && method === "POST") {
    const body = await readJson(request, z.object({
      title: z.string(),
      brief: z.string().default(""),
      videoId: z.string().optional(),
    }));
    return json(response, 200, await createVideoThread(body.title, body.brief, body.videoId));
  }

  const threadMatch = pathname.match(/^\/api\/threads\/([\w-]+)$/);
  if (threadMatch?.[1] && method === "GET") {
    const thread = await loadThread(threadMatch[1]);
    return thread ? json(response, 200, thread) : json(response, 404, {error: "No such thread."});
  }

  const messageMatch = pathname.match(/^\/api\/threads\/([\w-]+)\/message$/);
  if (messageMatch?.[1] && method === "POST") {
    return streamTurn(request, response, messageMatch[1]);
  }

  // — videos ——————————————————————————————————————————————
  if (pathname === "/api/videos" && method === "GET") {
    return json(response, 200, await readLedger());
  }

  const videoMatch = pathname.match(/^\/api\/videos\/([\w-]+)$/);
  if (videoMatch?.[1] && method === "GET") {
    return json(response, 200, await videoDetail(videoMatch[1]));
  }

  const applyMatch = pathname.match(/^\/api\/videos\/([\w-]+)\/apply$/);
  if (applyMatch?.[1] && method === "POST") {
    const body = await readJson(request, z.object({
      edits: z.array(z.object({
        sectionId: z.string(),
        onScreen: z.string().optional(),
        phrases: z.record(z.string(), z.string()).optional(),
        setPhrases: z.array(z.object({
          id: z.string().optional(),
          text: z.string(),
          gapAfterMs: z.number().optional(),
        })).optional(),
        trailingGapMs: z.number().optional(),
        energy: z.enum(ENERGIES).optional(),
        remove: z.boolean().optional(),
      })).min(1),
    }));
    const result = await applyPlanEdits({videoId: applyMatch[1], edits: body.edits});
    return json(response, 200, {
      durationChanged: result.durationChanged,
      needsCompose: result.needsCompose,
      outputs: result.outputs.map((output) => ({format: output.format, qcPassed: output.qc.passed})),
    });
  }

  // — brand and knowledge ——————————————————————————————————
  if (pathname === "/api/brand" && method === "GET") {
    const kit = await loadBrandKit();
    return json(response, 200, {kit, contrastFailures: verifyPairs(kit)});
  }

  if (pathname === "/api/brand" && method === "PUT") {
    const kit = brandKitZ.parse(await readBody(request).then((body) => JSON.parse(body)));

    // A kit whose own declared pairs fail is refused rather than saved and worked
    // around later, because every composition is generated against these numbers.
    const failures = verifyPairs(kit);
    if (failures.length) {
      return json(response, 400, {
        error: failures
          .map((failure) => `${failure.pair.fg} on ${failure.pair.bg} is `
            + `${failure.ratio.toFixed(2)}:1 but declares ${failure.pair.minRatio}:1`)
          .join("; "),
        failures,
      });
    }

    await saveBrandKit(kit);
    await writeTokensCss(kit, path.join(ROOT, "data", "brand", "tokens.css"));
    return json(response, 200, {kit});
  }

  if (pathname === "/api/brand/logos" && method === "POST") {
    const body = await readJson(request, z.object({
      dataUrl: z.string(),
      role: z.enum(LOGO_ROLES),
      theme: z.enum(["light", "dark", "any"]).default("any"),
      label: z.string().default(""),
      safeAreaPct: z.number().min(0).max(1).optional(),
      id: z.string().optional(),
    }));
    try {
      return json(response, 200, {kit: await addLogo(body)});
    } catch (error) {
      return json(response, 400, {error: (error as Error).message});
    }
  }

  const logoMatch = pathname.match(/^\/api\/brand\/logos\/([\w.-]+)$/);
  if (logoMatch?.[1] && method === "DELETE") {
    try {
      return json(response, 200, {kit: await removeLogo(logoMatch[1])});
    } catch (error) {
      return json(response, 404, {error: (error as Error).message});
    }
  }

  if (pathname === "/api/media" && method === "GET") {
    return json(response, 200, {
      items: await readMedia(),
      presets: Object.values(DEVICE_PRESETS),
    });
  }

  if (pathname === "/api/facts" && method === "GET") {
    return json(response, 200, await readFacts());
  }

  if (pathname === "/api/facts" && method === "PUT") {
    const facts = z.array(factZ).parse(await readBody(request).then((body) => JSON.parse(body)));
    await writeFacts(facts);
    return json(response, 200, facts);
  }

  if (pathname === "/api/settings" && method === "GET") {
    return json(response, 200, await readSettings());
  }

  if (pathname === "/api/settings" && method === "PUT") {
    const settings = settingsZ.parse(await readBody(request).then((body) => JSON.parse(body)));
    return json(response, 200, await writeSettings(settings));
  }

  if (pathname === "/api/research" && method === "POST") {
    const body = await readJson(request, z.object({urls: z.array(z.string()).min(1).max(6)}));
    const result = await researchSite(body.urls);
    const saved = await saveResearch(result);
    return json(response, 200, {...result, saved});
  }

  if (pathname === "/api/intents" && method === "GET") {
    return json(response, 200, Object.values(INTENT_PRESETS));
  }

  // — media ———————————————————————————————————————————————
  if (pathname.startsWith("/files/")) {
    return serveFile(response, decodeURIComponent(pathname.slice("/files/".length)), request.headers.range);
  }

  return json(response, 404, {error: `No route for ${method} ${pathname}.`});
}

async function videoDetail(videoId: string) {
  const dir = videoDir(videoId);
  const plan = await loadPlan(path.join(dir, "plan.json")).catch(() => null);
  const outDir = path.join(OUT_DIR, videoId);
  const files = await fs.readdir(outDir).catch(() => [] as string[]);

  const qc = await Promise.all(
    files.filter((name) => name.startsWith("qc-")).map(async (name) => ({
      format: name.replace(/^qc-|\.json$/g, ""),
      report: JSON.parse(await fs.readFile(path.join(outDir, name), "utf8")) as Record<string, unknown>,
    })),
  );
  const provenance = await fs.readFile(path.join(outDir, "provenance.json"), "utf8")
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => null);

  return {
    videoId,
    plan,
    provenance,
    qc,
    files: files.map((name) => ({name, url: `/files/${path.relative(ROOT, path.join(outDir, name))}`})),
  };
}

/**
 * One turn, streamed as server-sent events. The browser sees tool calls land in the
 * order they happened rather than waiting for the whole run.
 */
async function streamTurn(request: http.IncomingMessage, response: http.ServerResponse, threadId: string) {
  const body = await readJson(request, z.object({text: z.string().min(1)}));
  const thread = await loadThread(threadId);
  if (!thread) return json(response, 404, {error: "No such thread."});

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const controller = new AbortController();
  request.on("close", () => controller.abort());

  const collected: AgentEvent[] = [];
  for await (const event of runAgentTurn({
    thread,
    prompt: body.text,
    composerId: COMPOSER_OVERRIDE ?? (await readSettings()).composer,
    signal: controller.signal,
  })) {
    collected.push(event);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const latest = await loadThread(threadId) ?? thread;
  await recordTurn(latest, body.text, collected);
  response.end();
}

/** Range-aware static serving, scoped to two directories and refusing traversal. */
async function serveFile(response: http.ServerResponse, relativePath: string, range?: string) {
  const absolute = path.resolve(ROOT, relativePath);
  if (!SERVABLE.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
    return json(response, 403, {error: "That file is not servable."});
  }

  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) return json(response, 404, {error: "No such file."});

  const type = CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream";
  const bytes = range?.match(/bytes=(\d*)-(\d*)/);

  if (bytes) {
    const start = Number(bytes[1] || 0);
    const end = Math.min(Number(bytes[2] || stat.size - 1), stat.size - 1);
    response.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
    });
    return void createReadStream(absolute, {start, end}).pipe(response);
  }

  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(stat.size),
    "Accept-Ranges": "bytes",
  });
  createReadStream(absolute).pipe(response);
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

function json(response: http.ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {"Content-Type": "application/json; charset=utf-8"});
  response.end(JSON.stringify(payload));
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T extends z.ZodType>(request: http.IncomingMessage, schema: T): Promise<z.infer<T>> {
  return schema.parse(JSON.parse(await readBody(request) || "{}"));
}

server.listen(PORT, "127.0.0.1", async () => {
  const settings = await readSettings();
  console.log(
    `studio api    http://127.0.0.1:${PORT}`
    + `  ·  composer ${COMPOSER_OVERRIDE ?? settings.composer}`
    + `  ·  content ${languageName(settings.contentLanguage)}`,
  );
});
