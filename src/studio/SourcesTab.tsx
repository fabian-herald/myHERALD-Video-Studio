import {useEffect, useState} from "react";
import {api, type ThreadResearch} from "./api.ts";

/**
 * What the research came to, and everything it was built from.
 *
 * Two kinds of content on one screen, and the distinction is the whole point of the tab. The
 * **brief** is the agent's account of the work — a claim, which can be wrong. The **sources**
 * are the record: pages actually read, figures actually found, queries actually run, written by
 * the tools as they went. So when the brief says something the sources do not support, this
 * screen is where that shows, and it only shows if the record is not the agent's to edit.
 *
 * Read-only, deliberately. A figure here is a number a page printed; it becomes usable by a
 * video when the owner approves it as a fact in the Brand screen, which is the one place that
 * can set `approved`. Putting a second approve button here would mean two paths to the same
 * state, and the state is the thing keeping unverified numbers out of videos.
 *
 * Every string except the state chip was written by a web page. React escapes it; nothing here
 * may render it as HTML.
 */
export function SourcesTab({threadId, refreshKey, onOpenBrand}: {
  threadId: string;
  refreshKey: number;
  onOpenBrand: () => void;
}) {
  const [research, setResearch] = useState<ThreadResearch | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.threadResearch(threadId)
      .then((next) => !cancelled && setResearch(next))
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, [threadId, refreshKey]);

  if (error) return <div className="banner error">{error}</div>;
  if (!research) return <p className="pane-sub">Loading…</p>;

  const figures = research.sources.flatMap((source) => source.figures);
  const proposed = figures.filter((figure) => figure.factState === "proposed").length;
  const approved = figures.filter((figure) => figure.factState === "approved").length;
  const nothing = !research.brief && !research.sources.length && !research.queries.length;

  return (
    <>
      <h2 className="pane-title">Sources</h2>
      <p className="pane-sub">
        {nothing
          ? "Nothing researched in this thread yet. Ask for a figure and the searches, the pages read and the numbers found are recorded here."
          : `${research.sources.length} page(s) read · ${figures.length} figure(s) · ${research.queries.length} search(es)`}
      </p>

      {research.brief ? (
        <div className="section-card">
          <div className="section-head">
            <span>BRIEF</span>
            <b>{new Date(research.brief.writtenAt).toLocaleString()}</b>
          </div>
          <div className="onscreen">{research.brief.question}</div>

          {research.brief.findings.length ? (
            <>
              <span className="field-label">What the sources support</span>
              {research.brief.findings.map((finding) => (
                <div className="check-row" key={finding}>
                  <span className="dot" />
                  <span>{finding}</span>
                </div>
              ))}
            </>
          ) : null}

          {research.brief.gaps.length ? (
            <>
              {/* Styled as failures on purpose. A gap is the sentence that stops a number
                  being invented three weeks later, so it has to be as loud as a finding. */}
              <span className="field-label">Could not be sourced</span>
              {research.brief.gaps.map((gap) => (
                <div className="check-row fail" key={gap}>
                  <span className="dot" />
                  <span>{gap}</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : research.sources.length ? (
        <div className="section-card">
          <div className="section-head"><span>BRIEF</span><b>not written</b></div>
          <p className="pane-sub" style={{margin: 0}}>
            Pages were read but the agent has not written up what it found. Ask it to save a brief.
          </p>
        </div>
      ) : null}

      {/*
        The button appears only once something is actually there to act on. A figure nobody has
        proposed as a fact is not in the Brand screen at all, so offering to "review" it would
        send you to a page that does not contain it — and the count line beside the button would
        have told you so while the button implied otherwise.
      */}
      {approved + proposed > 0 ? (
        <div className="apply-bar" style={{marginBottom: 16}}>
          <button onClick={onOpenBrand}>Review in Brand &amp; product</button>
          <span>
            {approved} approved · {proposed} awaiting you · {figures.length - approved - proposed} not proposed
          </span>
        </div>
      ) : figures.length ? (
        <p className="pane-sub">
          None of these {figures.length} figures has been proposed as a fact yet, so none is in the
          Brand screen. Ask the agent to propose the ones worth keeping.
        </p>
      ) : null}

      {research.sources.map((source) => (
        <div className="section-card" key={source.url}>
          <div className="section-head">
            <span>{hostOf(source.url)} · {source.via || "unknown"}</span>
            <b>{source.error ? "not read" : figureCount(source)}</b>
          </div>

          <div className="onscreen">{source.title || source.url}</div>
          <div className="file-row">
            {/* Opened in a new tab with the referrer withheld: the destination is a URL a
                search engine handed us, and it has no business knowing what studio sent the
                visit. `noopener` because a tab we open can otherwise reach back into ours. */}
            <a href={source.url} target="_blank" rel="noreferrer noopener">{source.url}</a>
            <span>{new Date(source.readAt).toLocaleDateString()}</span>
          </div>

          {source.error ? <p className="pane-sub">{source.error}</p> : null}

          {source.figures.map((figure) => (
            <div key={`${figure.statement}-${figure.value}`} style={{marginTop: 14}}>
              <span className="field-label">
                {formatValue(figure.value)}{figure.unit === "%" ? "%" : figure.unit ? ` ${figure.unit}` : ""}
                {" · "}
                {figure.factState === "approved"
                  ? "approved fact"
                  : figure.factState === "proposed" ? "proposed, awaiting you" : "not proposed"}
              </span>
              <div className="kv">
                <dt>claim</dt>
                <dd>{figure.statement}</dd>
                {figure.attribution ? (
                  <>
                    <dt>credited to</dt>
                    <dd>{figure.attribution}</dd>
                  </>
                ) : null}
                <dt>on the page</dt>
                {/* The verbatim sentence, which is the reason this tab is worth opening: it is
                    what an evidence note is made of, and what tells you whether the number
                    means what the claim says it means. */}
                <dd style={{fontStyle: "italic"}}>“{figure.context}”</dd>
              </div>
            </div>
          ))}

          {source.dropped ? (
            <p className="pane-sub" style={{marginTop: 12}}>
              {source.dropped} figure(s) dropped — the number was not in the sentence quoted for it.
            </p>
          ) : null}
        </div>
      ))}

      {research.queries.length ? (
        <div className="section-card">
          <div className="section-head">
            <span>SEARCHES</span>
            <b>{research.queries.length}</b>
          </div>
          {/* Including the ones that found nothing. A search with no hits is the part of the
              trail nobody writes down voluntarily and the part that says most about how hard
              a number was to find — or that the agent never went looking. */}
          {research.queries.slice().reverse().map((entry, index) => (
            <div className={`check-row${entry.hits ? "" : " fail"}`} key={`${entry.at}-${index}`}>
              <span className="dot" />
              <span>{entry.query}</span>
              <span style={{marginLeft: "auto", opacity: 0.7}}>{entry.provider} · {entry.hits}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
};

const figureCount = (source: {figures: unknown[]; statements: number}) =>
  source.figures.length
    ? `${source.figures.length} figure(s)`
    : source.statements ? `${source.statements} statement(s)` : "nothing found";

/** Grouped, because 2400000 and "2,400,000" are the same number and only one of them reads. */
const formatValue = (value: number) => value.toLocaleString(undefined, {maximumFractionDigits: 2});
