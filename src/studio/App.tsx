import {useCallback, useEffect, useState} from "react";
import {api, type LedgerEntry, type Thread} from "./api.ts";
import {UNTITLED_THREAD} from "../core/threadTitle.ts";
import {BrandPage} from "./BrandPage.tsx";
import {Canvas} from "./Canvas.tsx";
import {ChatPane} from "./ChatPane.tsx";
import {SettingsPage} from "./SettingsPage.tsx";

type View = {kind: "thread"; id: string} | {kind: "brand"} | {kind: "videos"} | {kind: "settings"};

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

  /*
   * Named `Untitled video` rather than `Video 8/1/2026`, because the date is not what
   * anybody is scanning the rail for and every thread made that afternoon carried the same
   * one. The server replaces this with the first message, and then with the video's own
   * title once there is a video — see `core/threadTitle.ts`.
   */
  async function newThread() {
    const created = await api.createThread(UNTITLED_THREAD);
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

  const studioEntry = threads.find((entry) => entry.kind === "studio");
  const openThreads = threads.filter((entry) => entry.kind !== "studio" && !entry.archivedAt);
  const activeVideos = videos.filter((entry) => !entry.archivedAt);

  /*
   * Archiving from the rail goes through the video when there is one, because the two are
   * one piece of work: hiding the thread and leaving its video counted as covered would put
   * the row away without putting the video away.
   */
  async function archiveThread(entry: Thread) {
    if (entry.videoId) await api.archiveVideo(entry.videoId, true);
    else await api.archiveThread(entry.id, true);
    if (view.kind === "thread" && view.id === entry.id) setView({kind: "thread", id: "studio"});
    await reload();
  }

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

      {/*
        Three fixed regions and one scrolling one. The whole rail used to scroll, so twenty
        threads deep the studio conversation went off the top and Settings off the bottom —
        the three destinations that are never "one of many" were paged like the ones that are.
      */}
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

        {studioEntry ? (
          <button
            className={`rail-item${view.kind === "thread" && view.id === studioEntry.id ? " active" : ""}`}
            onClick={() => setView({kind: "thread", id: studioEntry.id})}
          >
            Studio<small>global</small>
          </button>
        ) : null}

        <div className="rail-label">VIDEO THREADS</div>
        <div className="rail-threads">
          {openThreads.length === 0 ? <p className="rail-empty">Nothing open.</p> : null}
          {openThreads.map((entry) => (
            <div className="rail-row" key={entry.id}>
              <button
                className={`rail-item${view.kind === "thread" && view.id === entry.id ? " active" : ""}`}
                onClick={() => setView({kind: "thread", id: entry.id})}
              >
                {entry.title}
                <small>{entry.videoId ?? "no video yet"}</small>
              </button>
              <button
                className="rail-archive"
                title="Archive — it stays in the ledger and can be brought back"
                aria-label={`Archive ${entry.title}`}
                onClick={() => void archiveThread(entry)}
              >
                ↓
              </button>
            </div>
          ))}
        </div>

        <div className="rail-bottom">
          <button
            className={`rail-item${view.kind === "videos" ? " active" : ""}`}
            onClick={() => setView({kind: "videos"})}
          >
            Videos<small>{activeVideos.length} in the ledger</small>
          </button>
          <button
            className={`rail-item${view.kind === "brand" ? " active" : ""}`}
            onClick={() => setView({kind: "brand"})}
          >
            Brand &amp; product<small>Context</small>
          </button>
          <button
            className={`rail-item${view.kind === "settings" ? " active" : ""}`}
            onClick={() => setView({kind: "settings"})}
          >
            Settings<small>AI &amp; guidance</small>
          </button>
        </div>
      </nav>

      {view.kind === "settings" ? (
        <SettingsPage />
      ) : view.kind === "brand" ? (
        <BrandPage />
      ) : view.kind === "videos" ? (
        <VideoList
          videos={videos}
          onOpen={(id) => openVideoThread(id)}
          onArchive={async (id, archived) => {
            await api.archiveVideo(id, archived);
            await reload();
          }}
          onDelete={async (id) => {
            await api.deleteVideo(id);
            await reload();
          }}
        />
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
function VideoList({videos, onOpen, onArchive, onDelete}: {
  videos: LedgerEntry[];
  onOpen: (id: string) => void;
  onArchive: (id: string, archived: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  /* Which row is asking to be confirmed. Delete is two clicks and never the same click
     twice, because it takes the rendered files and the thread with it. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const active = videos.filter((entry) => !entry.archivedAt);
  const archived = videos.filter((entry) => entry.archivedAt);
  const shown = showArchived ? archived : active;

  return (
    <section className="chat">
      <div className="chat-log">
        <h2 className="pane-title">Videos</h2>
        <p className="pane-sub">
          The studio's memory. The agent queries it before every plan, so the same thesis is not made twice.
          Archiving takes a video out of that memory — a test then neither blocks the real video on its
          thesis nor counts as having spent the figures it charted.
        </p>

        <div className="videos-tabs">
          <button
            className={showArchived ? "" : "active"}
            onClick={() => setShowArchived(false)}
          >
            Active ({active.length})
          </button>
          <button
            className={showArchived ? "active" : ""}
            onClick={() => setShowArchived(true)}
          >
            Archived ({archived.length})
          </button>
        </div>

        {shown.length === 0 ? (
          <p className="pane-sub">{showArchived ? "Nothing archived." : "Nothing produced yet."}</p>
        ) : null}

        {shown.map((entry) => (
          <div className="section-card" key={entry.id}>
            <div className="section-head">
              <span>{entry.intent} · {entry.formats.join(", ")} · {new Date(entry.createdAt).toLocaleDateString()}</span>
              <b>{entry.status}</b>
            </div>
            <div className="onscreen">{entry.thesis}</div>
            {confirming === entry.id ? (
              <div className="apply-bar danger" style={{marginTop: 12}}>
                <span>Delete for good? The plan, the rendered files and the thread all go.</span>
                <button
                  className="destructive"
                  onClick={() => {
                    setConfirming(null);
                    void onDelete(entry.id);
                  }}
                >
                  Delete
                </button>
                <button onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            ) : (
              <div className="apply-bar" style={{marginTop: 12}}>
                <button onClick={() => onOpen(entry.id)}>Open</button>
                <button onClick={() => void onArchive(entry.id, !entry.archivedAt)}>
                  {entry.archivedAt ? "Restore" : "Archive"}
                </button>
                <button className="quiet" onClick={() => setConfirming(entry.id)}>Delete</button>
                <span>{entry.id}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
