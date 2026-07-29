import {useEffect, useMemo, useState} from "react";
import {api, type VideoDetail} from "./api.ts";
import {ScriptTab} from "./ScriptTab.tsx";

type Tab = "video" | "script" | "scenes" | "assets" | "checks" | "files";

const TABS: {id: Tab; label: string}[] = [
  {id: "video", label: "VIDEO"},
  {id: "script", label: "SCRIPT"},
  {id: "scenes", label: "SCENES"},
  {id: "assets", label: "ASSETS"},
  {id: "checks", label: "CHECKS"},
  {id: "files", label: "FILES"},
];

export function Canvas({videoId, refreshKey, onRefresh}: {videoId?: string; refreshKey: number; onRefresh: () => void}) {
  const [tab, setTab] = useState<Tab>("video");
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoId) return setDetail(null);
    let cancelled = false;
    api.video(videoId)
      .then((next) => !cancelled && setDetail(next))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [videoId, refreshKey]);

  if (!videoId) {
    return (
      <aside className="canvas">
        <div className="canvas-empty">
          <p>No video in this thread yet.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="canvas">
      <div className="canvas-tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={`canvas-tab${tab === entry.id ? " active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="canvas-body">
        {error ? <div className="banner error">{error}</div> : null}
        {!detail ? <p className="pane-sub">Loading…</p> : <TabBody tab={tab} detail={detail} onApplied={onRefresh} />}
      </div>
    </aside>
  );
}

function TabBody({tab, detail, onApplied}: {tab: Tab; detail: VideoDetail; onApplied: () => void}) {
  switch (tab) {
    case "video": return <VideoTab detail={detail} />;
    case "script": return <ScriptTab detail={detail} onApplied={onApplied} />;
    case "scenes": return <ScenesTab detail={detail} />;
    case "assets": return <AssetsTab detail={detail} />;
    case "checks": return <ChecksTab detail={detail} />;
    case "files": return <FilesTab detail={detail} />;
  }
}

function VideoTab({detail}: {detail: VideoDetail}) {
  const masters = detail.files.filter((file) => file.name.startsWith("master-"));
  const [selected, setSelected] = useState(masters[0]?.name ?? "");
  const sheet = detail.files.find((file) => file.name === "contact-sheet.png");
  const active = masters.find((file) => file.name === selected) ?? masters[0];

  const qcFor = (name: string) =>
    detail.qc.find((entry) => name.includes(entry.format))?.report.passed ?? true;

  return (
    <>
      <h2 className="pane-title">{detail.plan?.title ?? detail.videoId}</h2>
      <p className="pane-sub">{detail.plan?.thesis}</p>

      {masters.length > 1 ? (
        <div className="format-row">
          {masters.map((file) => (
            <button
              key={file.name}
              className={`chip${file.name === active?.name ? " active" : ""}${qcFor(file.name) ? "" : " fail"}`}
              onClick={() => setSelected(file.name)}
            >
              {file.name.replace(/^master-|\.mp4$/g, "")}
            </button>
          ))}
        </div>
      ) : null}

      {active ? <video key={active.url} src={active.url} controls preload="metadata" /> : <p>No render yet.</p>}

      {sheet ? (
        <>
          <span className="field-label">Contact sheet: are these frames structurally different?</span>
          <img className="sheet" src={sheet.url} alt="contact sheet" />
        </>
      ) : null}
    </>
  );
}

function ScenesTab({detail}: {detail: VideoDetail}) {
  const sections = detail.plan?.sections ?? [];
  return (
    <>
      <h2 className="pane-title">Scenes</h2>
      <p className="pane-sub">One look per section. Copy, lines and length are edited in Script; the shape of a scene is a conversation with the agent.</p>
      {sections.map((section, index) => (
        <div className="section-card" key={section.id}>
          <div className="section-head">
            <span>{String(index + 1).padStart(2, "0")} · {section.kind} · {section.id}</span>
            <span className="timing">{(section.durationMs / 1000).toFixed(1)}s long</span>
          </div>
          <div className="onscreen">{section.onScreen || <em style={{opacity: 0.5}}>no on-screen copy</em>}</div>
          {section.intentNote ? <p className="pane-sub" style={{margin: "8px 0 0"}}>{section.intentNote}</p> : null}
          {section.slot ? <span className="chip active">Presenter · {section.slot.style}</span> : null}
        </div>
      ))}
    </>
  );
}

function AssetsTab({detail}: {detail: VideoDetail}) {
  const plan = detail.plan;
  const provenance = detail.provenance as {narration?: Record<string, unknown>; composer?: Record<string, unknown>} | null;
  return (
    <>
      <h2 className="pane-title">Assets</h2>
      <p className="pane-sub">What this video is made of.</p>
      <dl className="kv">
        <dt>Voice</dt>
        <dd>{plan?.narration.voice} · {String(provenance?.narration?.provider ?? "—")} · {String(provenance?.narration?.model ?? "")}</dd>
        <dt>Cloned</dt>
        <dd>{provenance?.narration?.cloned ? "yes" : "no"}</dd>
        <dt>Phrases</dt>
        <dd>{String(provenance?.narration?.phrases ?? plan?.sections.reduce((sum, section) => sum + section.phrases.length, 0) ?? 0)}</dd>
        <dt>Composition</dt>
        <dd>{String(provenance?.composer?.provider ?? "—")} · {String(provenance?.composer?.model ?? "")}</dd>
        <dt>Attempts</dt>
        <dd>{String(provenance?.composer?.attempts ?? "—")}</dd>
        <dt>Formats</dt>
        <dd>{plan?.formats.join(", ")}</dd>
      </dl>

      <span className="field-label">Cost</span>
      <CostBreakdown provenance={detail.provenance} />

      <span className="field-label">Angles not taken</span>
      {(plan?.alternates ?? []).map((alternate) => (
        <div className="section-card" key={alternate.thesis}>
          <div className="onscreen" style={{fontSize: 15}}>{alternate.thesis}</div>
          <p className="pane-sub" style={{margin: "8px 0 0"}}>{alternate.why}</p>
        </div>
      ))}
    </>
  );
}

interface CostShape {
  billingMode: string;
  chargedUsd: number;
  apiEquivalentUsd: number;
  entries: {provider: string; step: string; chargedUsd: number; apiEquivalentUsd: number; note: string}[];
}

/**
 * Two columns, never one. What actually left an account, and what the same work would
 * have cost metered. Collapsing them is how a subscription-covered run reads as a bill.
 */
function CostBreakdown({provenance}: {provenance: Record<string, unknown> | null}) {
  const cost = provenance?.cost as CostShape | undefined;
  if (!cost) return <p className="pane-sub">No cost breakdown was written for this video.</p>;

  return (
    <>
      <div className="cost-total">
        <div>
          <span className="cost-figure">${cost.chargedUsd.toFixed(2)}</span>
          <span className="cost-caption">actually charged</span>
        </div>
        <div>
          <span className="cost-figure muted">${cost.apiEquivalentUsd.toFixed(2)}</span>
          <span className="cost-caption">
            at API list prices
            {cost.billingMode === "subscription" ? " · covered by the CLI subscription" : ""}
          </span>
        </div>
      </div>
      {cost.entries.map((entry) => (
        <div className="cost-row" key={`${entry.provider}-${entry.step}`}>
          <span className="cost-who">{entry.provider} · {entry.step}</span>
          <span className="cost-pair">
            ${entry.chargedUsd.toFixed(2)} / ${entry.apiEquivalentUsd.toFixed(2)}
          </span>
          <span className="cost-note">{entry.note}</span>
        </div>
      ))}
    </>
  );
}

function ChecksTab({detail}: {detail: VideoDetail}) {
  return (
    <>
      <h2 className="pane-title">Checks</h2>
      <p className="pane-sub">What was measured on the finished file.</p>
      {detail.qc.map((entry) => (
        <div className="section-card" key={entry.format}>
          <div className="section-head">
            <span>{entry.format}</span>
            <b>{entry.report.passed ? "passed" : "failed"}</b>
          </div>
          {Object.entries(entry.report.checks).map(([name, passed]) => (
            <div className={`check-row${passed ? "" : " fail"}`} key={name}>
              <span className="dot" />
              <span>{name}</span>
            </div>
          ))}
          {entry.report.diagnostics.freezeEvents.length ? (
            <>
              <span className="field-label">Held frames</span>
              <div className="kv">
                {entry.report.diagnostics.freezeEvents.map((event) => (
                  <dd key={event}>{event}</dd>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ))}
    </>
  );
}

function FilesTab({detail}: {detail: VideoDetail}) {
  return (
    <>
      <h2 className="pane-title">Files</h2>
      <p className="pane-sub">{detail.videoId}</p>
      {detail.files.map((file) => (
        <div className="file-row" key={file.name}>
          <span>{file.name}</span>
          <a href={file.url} download>download</a>
        </div>
      ))}
    </>
  );
}
