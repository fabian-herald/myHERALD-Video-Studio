import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {createReadStream} from "node:fs";
import {loadBrandKit, saveBrandKit, brandKitZ, verifyPairs} from "../core/brand/kit.ts";
import {writeTokensCss} from "../core/brand/tokens.ts";
import {addLogo, removeLogo} from "../core/brand/logos.ts";
import {LOGO_ROLES} from "../core/brand/kit.ts";
import {DEVICE_PRESETS, readMedia} from "../core/media/library.ts";
import {loadResearch} from "../core/knowledge/brief.ts";
import {figureFactState} from "../core/knowledge/trail.ts";
import {readFacts, writeFacts, factZ} from "../core/knowledge/facts.ts";
import {researchSite, saveResearch} from "../core/knowledge/research.ts";
import {readSettings, writeSettings, settingsZ} from "../core/settings.ts";
import {readLedger} from "../core/ledger.ts";
import {INTENT_PRESETS} from "../core/intents/index.ts";
import {loadPlan, ENERGIES} from "../core/plan/schema.ts";
import {languageName} from "../core/plan/language.ts";
import {OUT_DIR, ROOT, safeVideoOutDir, videoDir} from "../core/paths.ts";
import {applyPlanEdits} from "../core/pipeline/apply.ts";
import {
  createVideoThread,
  deleteThread,
  listThreads,
  loadThread,
  setThreadArchived,
  studioThread,
} from "../core/threads.ts";
import {deleteVideo, setVideoArchived} from "../core/archive.ts";
import {run} from "../core/util/exec.ts";
import {runAgentTurn, recordTurn, type AgentEvent} from "./agent.ts";
import {handleCodexMcp} from "./codexMcp.ts";
import {codexSubscriptionStatus} from "../core/gen/codexCli.ts";
import {z} from "zod";

const PORT = Number(process.env.STUDIO_API_PORT ?? 5174);
/** An env override still wins, so a one-off run can pin the composer without editing state. */
const COMPOSER_OVERRIDE = process.env.STUDIO_COMPOSER;
const AGENT_OVERRIDE = process.env.STUDIO_AGENT;
const PLANNER_OVERRIDE = process.env.STUDIO_PLANNER;

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

  // The Codex CLI receives a short-lived bearer token for exactly this turn. This route
  // must run before any generic body parser because the MCP transport owns the stream.
  if (pathname === "/api/internal/codex-mcp") {
    return handleCodexMcp(request, response);
  }

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

  const researchMatch = pathname.match(/^\/api\/threads\/([\w-]+)\/research$/);
  if (researchMatch?.[1] && method === "GET") {
    return json(response, 200, await threadResearch(researchMatch[1]));
  }

  const threadArchiveMatch = pathname.match(/^\/api\/threads\/([\w-]+)\/archive$/);
  if (threadArchiveMatch?.[1] && method === "POST") {
    const body = await readJson(request, z.object({archived: z.boolean()}));
    const thread = await setThreadArchived(threadArchiveMatch[1], body.archived);
    return thread
      ? json(response, 200, thread)
      : json(response, 400, {error: "No such thread, or the studio thread, which stays."});
  }

  if (threadMatch?.[1] && method === "DELETE") {
    return (await deleteThread(threadMatch[1]))
      ? json(response, 200, {deleted: true})
      : json(response, 400, {error: "No such thread, or the studio thread, which stays."});
  }

  // — videos ——————————————————————————————————————————————
  if (pathname === "/api/videos" && method === "GET") {
    return json(response, 200, await readLedger());
  }

  const videoMatch = pathname.match(/^\/api\/videos\/([\w-]+)$/);
  if (videoMatch?.[1] && method === "GET") {
    return json(response, 200, await videoDetail(videoMatch[1]));
  }

  const videoArchiveMatch = pathname.match(/^\/api\/videos\/([\w-]+)\/archive$/);
  if (videoArchiveMatch?.[1] && method === "POST") {
    const body = await readJson(request, z.object({archived: z.boolean()}));
    const entry = await setVideoArchived(videoArchiveMatch[1], body.archived);
    return entry ? json(response, 200, entry) : json(response, 404, {error: "No such video."});
  }

  // Removes the ledger entry, the working directory, the rendered files and the thread.
  // The browser asks twice before it gets here; nothing on this side can undo it.
  if (videoMatch?.[1] && method === "DELETE") {
    const result = await deleteVideo(videoMatch[1]);
    return result.removed
      ? json(response, 200, result)
      : json(response, 404, {error: "No such video."});
  }

  const revealMatch = pathname.match(/^\/api\/videos\/([\w-]+)\/reveal$/);
  if (revealMatch?.[1] && method === "POST") {
    return json(response, 200, await revealOutputDir(revealMatch[1]));
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

  if (pathname === "/api/providers" && method === "GET") {
    const codex = await codexSubscriptionStatus();
    return json(response, 200, {
      claude: {available: true, label: "Claude subscription"},
      codex: {
        available: codex.available,
        label: "Codex subscription",
        ...(codex.reason ? {reason: codex.reason} : {}),
      },
    });
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

/**
 * Show a finished video's folder in the desktop file manager.
 *
 * Two deliberate choices. The path is built here from `OUT_DIR` and checked for
 * containment rather than accepted from the caller — the route's `[\w-]+` already
 * excludes a traversal, and this makes that a property of the code instead of a property
 * of one regex. And the file manager is spawned through `execFile` with an argument
 * array, never a shell string, so a directory name is data and cannot become a command.
 */
async function revealOutputDir(videoId: string) {
  const dir = safeVideoOutDir(videoId);
  if (!dir) return {ok: false, error: "That is not an output directory."};

  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) {
    return {ok: false, error: "Nothing rendered yet — there is no folder to open."};
  }

  // `open -R` selects the folder in Finder rather than opening it as a window.
  const [command, args] = process.platform === "darwin"
    ? ["open", ["-R", dir]]
    : process.platform === "win32"
      ? ["explorer", [dir]]
      : ["xdg-open", [dir]];

  return run(command as string, args as string[])
    .then(() => ({ok: true, path: dir}))
    .catch((cause: unknown) => ({ok: false, error: (cause as Error).message, path: dir}));
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
 * The research trail for a thread, with each figure told what became of it.
 *
 * The state annotation is the point of doing this server-side. A figure in the trail is a
 * number some page printed; the same number may since have been proposed as a fact, or
 * approved, or neither — and only the facts file knows.
 *
 * The matching itself is `figureFactState`, kept pure in `knowledge/trail.ts` so it can be
 * tested — this function reads two files and serves a route, and the interesting part is
 * neither of those. See there for why a reworded statement still counts.
 *
 * Read-only. Nothing here can change a fact's state; that is `PUT /api/facts` and a click.
 */
async function threadResearch(threadId: string) {
  const record = await loadResearch(threadId);
  if (!record) return {threadId, queries: [], sources: [], brief: null};

  const facts = await readFacts();

  return {
    threadId,
    updatedAt: record.updatedAt,
    brief: record.brief ?? null,
    queries: record.queries,
    sources: record.sources.map((source) => ({
      ...source,
      figures: source.figures.map((figure) => ({
        ...figure,
        factState: figureFactState(figure, source.url, facts),
      })),
    })),
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

  /**
   * The client going away, which is what "stop" is on the wire.
   *
   * On the **response**, not the request. This was wired to `request.on("close")` and that
   * event never fires for a stream like this one: the request body was fully read before
   * the first byte went out, so as far as the IncomingMessage is concerned it finished long
   * ago. The abort was therefore never raised — not late, never — and a cancelled run kept
   * composing until the server was killed. It took a printed probe on both events to see
   * it, because every symptom pointed at the pipeline rather than at the listener.
   *
   * `close` on the response fires when the socket goes, whether the run finished or the
   * owner pressed stop, so `aborted` distinguishes them: a finished run has already left
   * this loop and its abort is a no-op on nothing.
   */
  const controller = new AbortController();
  response.on("close", () => controller.abort());

  const collected: AgentEvent[] = [];
  const settings = await readSettings();
  for await (const event of runAgentTurn({
    thread,
    prompt: body.text,
    agentId: (AGENT_OVERRIDE ?? settings.agent) as "claude" | "codex",
    plannerId: (PLANNER_OVERRIDE ?? settings.planner) as "claude" | "codex",
    composerId: COMPOSER_OVERRIDE ?? settings.composer,
    codexMcpUrl: `http://127.0.0.1:${PORT}/api/internal/codex-mcp`,
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
    + `  ·  agent ${AGENT_OVERRIDE ?? settings.agent}`
    + `  ·  planner ${PLANNER_OVERRIDE ?? settings.planner}`
    + `  ·  composer ${COMPOSER_OVERRIDE ?? settings.composer}`
    + `  ·  content ${languageName(settings.contentLanguage)}`,
  );
});
