import {useCallback, useEffect, useState} from "react";
import {api, type LedgerEntry, type Thread} from "./api.ts";
import {BrandPage} from "./BrandPage.tsx";
import {Canvas} from "./Canvas.tsx";
import {ChatPane} from "./ChatPane.tsx";

type View = {kind: "thread"; id: string} | {kind: "brand"} | {kind: "videos"};

export function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [videos, setVideos] = useState<LedgerEntry[]>([]);
  const [view, setView] = useState<View>({kind: "thread", id: "studio"});
  const [thread, setThread] = useState<Thread | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Which pane is showing when the window is too narrow to hold both. */
  const [pane, setPane] = useState<"chat" | "canvas">("chat");

  const reload = useCallback(async () => {
    try {
      const [nextThreads, nextVideos] = await Promise.all([api.threads(), api.videos()]);
      setThreads(nextThreads);
      setVideos(nextVideos);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (view.kind !== "thread") return;
    let cancelled = false;
    api.thread(view.id)
      .then((next) => !cancelled && setThread(next))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [view, refreshKey]);

  const onTurnComplete = useCallback(
    (videoId?: string) => {
      setRefreshKey((key) => key + 1);
      void reload();
      if (videoId) setThread((current) => (current ? {...current, videoId} : current));
    },
    [reload],
  );

  async function newThread() {
    const created = await api.createThread(`Video ${new Date().toLocaleDateString()}`);
    await reload();
    setView({kind: "thread", id: created.id});
  }

  /*
   * Any video thread, whether or not it has produced a video yet — the canvas opens on Sources
   * until there is something rendered. Gated on `videoId` this panel appeared only after the
   * work was finished, which is the wrong half of the job to be looking at the research in.
   * The studio thread is still canvas-less: it has no video and no research of its own.
   */
  const showCanvas = view.kind === "thread" && thread?.kind === "video";

  return (
    <div className={`shell${showCanvas ? "" : " no-canvas"} pane-${pane}`}>
      {/*
        Below the two-column breakpoint the panes stack behind this switch. The canvas
        used to be `display: none` there, which did not shrink it — it removed the video,
        the script, the scenes and the checks with nothing to bring them back, so a
        narrow window silently lost half the application.
      */}
      {showCanvas ? (
        <div className="pane-switch">
          <button className={pane === "chat" ? "active" : ""} onClick={() => setPane("chat")}>Chat</button>
          <button className={pane === "canvas" ? "active" : ""} onClick={() => setPane("canvas")}>Video</button>
        </div>
      ) : null}

      <nav className="rail">
        {/* The real marks, for the same reason a composition has to use them: the
            wordmark is two faces at two sizes, and setting it in CSS is a near miss. */}
        <div className="rail-brand">
          <img className="rail-seal" src="/files/data/brand/logos/seal.png" alt="" />
          <div>
            <img className="rail-wordmark" src="/files/data/brand/logos/wordmark-light.png" alt="myHERALD" />
            <span>VIDEO STUDIO</span>
          </div>
        </div>

        <button className="rail-new" onClick={() => void newThread()}>New video</button>

        <div className="rail-label">THREADS</div>
        {threads.map((entry) => (
          <button
            key={entry.id}
            className={`rail-item${view.kind === "thread" && view.id === entry.id ? " active" : ""}`}
            onClick={() => setView({kind: "thread", id: entry.id})}
          >
            {entry.kind === "studio" ? "Studio" : entry.title}
            <small>{entry.videoId ?? (entry.kind === "studio" ? "global" : "no video yet")}</small>
          </button>
        ))}

        <div className="rail-spacer" />

        <button
          className={`rail-item${view.kind === "videos" ? " active" : ""}`}
          onClick={() => setView({kind: "videos"})}
        >
          Videos<small>{videos.length} in the ledger</small>
        </button>
        <button
          className={`rail-item${view.kind === "brand" ? " active" : ""}`}
          onClick={() => setView({kind: "brand"})}
        >
          Brand &amp; product<small>Context</small>
        </button>
      </nav>

      {view.kind === "brand" ? (
        <BrandPage />
      ) : view.kind === "videos" ? (
        <VideoList videos={videos} onOpen={(id) => openVideoThread(id)} />
      ) : thread ? (
        <>
          <ChatPane thread={thread} onTurnComplete={onTurnComplete} />
          {showCanvas ? (
            <Canvas
              threadId={thread.id}
              videoId={thread.videoId}
              refreshKey={refreshKey}
              onRefresh={() => setRefreshKey((key) => key + 1)}
              onOpenBrand={() => setView({kind: "brand"})}
            />
          ) : null}
        </>
      ) : (
        <section className="chat">
          <div className="canvas-empty">{error ?? "Loading…"}</div>
        </section>
      )}
    </div>
  );

  async function openVideoThread(videoId: string) {
    const existing = threads.find((entry) => entry.videoId === videoId);
    if (existing) return setView({kind: "thread", id: existing.id});

    const entry = videos.find((candidate) => candidate.id === videoId);
    const created = await api.createThread(entry?.title ?? videoId, entry?.thesis ?? "", videoId);
    await reload();
    setView({kind: "thread", id: created.id});
  }
}

/** The ledger as a list — what is already covered, at a glance. */
function VideoList({videos, onOpen}: {videos: LedgerEntry[]; onOpen: (id: string) => void}) {
  return (
    <section className="chat">
      <div className="chat-log">
        <h2 className="pane-title">Videos</h2>
        <p className="pane-sub">
          The studio's memory. The agent queries it before every plan, so the same thesis is not made twice.
        </p>
        {videos.length === 0 ? <p className="pane-sub">Nothing produced yet.</p> : null}
        {videos.map((entry) => (
          <div className="section-card" key={entry.id}>
            <div className="section-head">
              <span>{entry.intent} · {entry.formats.join(", ")} · {new Date(entry.createdAt).toLocaleDateString()}</span>
              <b>{entry.status}</b>
            </div>
            <div className="onscreen">{entry.thesis}</div>
            <div className="apply-bar" style={{marginTop: 12}}>
              <button onClick={() => onOpen(entry.id)}>Open</button>
              <span>{entry.id}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
