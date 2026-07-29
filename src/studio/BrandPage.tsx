import {useEffect, useState} from "react";
import {api, type ResearchResult} from "./api.ts";
import {IdentityTab, type Kit} from "./IdentityTab.tsx";

type Tab = "identity" | "product" | "research";

interface Fact {
  id: string;
  kind: string;
  statement: string;
  evidence: string;
  state: "proposed" | "approved" | "rejected";
  source: string;
  updatedAt: string;
}

export function BrandPage() {
  const [tab, setTab] = useState<Tab>("identity");
  const [kit, setKit] = useState<Kit | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.brand().then((data) => setKit(data.kit as unknown as Kit)).catch((cause: Error) => setError(cause.message));
    void api.facts().then((data) => setFacts(data as unknown as Fact[])).catch(() => {});
  }, []);

  async function saveKit(next: Kit) {
    const saved = await api.saveBrand(next);
    setKit(saved.kit as unknown as Kit);
  }

  async function setState(id: string, state: Fact["state"]) {
    const next = facts.map((fact) => (fact.id === id ? {...fact, state, updatedAt: new Date().toISOString()} : fact));
    setFacts(next);
    await api.saveFacts(next).catch((cause: Error) => setError(cause.message));
  }

  const pending = facts.filter((fact) => fact.state === "proposed").length;

  return (
    <section className="chat">
      <div className="canvas-tabs">
        <button className={`canvas-tab${tab === "identity" ? " active" : ""}`} onClick={() => setTab("identity")}>IDENTITY</button>
        <button className={`canvas-tab${tab === "product" ? " active" : ""}`} onClick={() => setTab("product")}>
          PRODUCT{pending ? ` (${pending})` : ""}
        </button>
        <button className={`canvas-tab${tab === "research" ? " active" : ""}`} onClick={() => setTab("research")}>RESEARCH</button>
      </div>

      <div className="chat-log">
        {error ? <div className="banner error">{error}</div> : null}
        {!kit ? <p className="pane-sub">Loading…</p>
          : tab === "identity" ? <IdentityTab kit={kit} onSave={saveKit} />
            : tab === "product" ? <Product facts={facts} onSetState={setState} />
              : (
                <Research onImported={() => void api.facts().then((data) => setFacts(data as unknown as Fact[]))} />
              )}
      </div>
    </section>
  );
}

function Product({facts, onSetState}: {facts: Fact[]; onSetState: (id: string, state: Fact["state"]) => void}) {
  const groups: {state: Fact["state"]; label: string; hint: string}[] = [
    {state: "proposed", label: "Proposed", hint: "Not used in generation until you approve them."},
    {state: "approved", label: "Approved", hint: "The only product claims that reach a prompt."},
    {state: "rejected", label: "Rejected", hint: ""},
  ];

  return (
    <>
      <h2 className="pane-title">Product knowledge</h2>
      <p className="pane-sub">
        Only approved facts reach a prompt. An approved fact that states a number without an evidence
        note is withheld anyway.
      </p>

      {facts.length === 0 ? (
        <div className="banner">
          No facts yet. Use the Research tab to read your website, or ask the agent in chat. Either way
          they arrive as proposals; approving them is yours alone.
        </div>
      ) : null}

      {groups.map((group) => {
        const entries = facts.filter((fact) => fact.state === group.state);
        if (!entries.length) return null;
        return (
          <div key={group.state}>
            <span className="field-label">{group.label} ({entries.length})</span>
            {group.hint ? <p className="pane-sub" style={{margin: "0 0 8px"}}>{group.hint}</p> : null}
            {entries.map((fact) => {
              const numeric = /\d/.test(fact.statement);
              const withheld = fact.state === "approved" && numeric && !fact.evidence.trim();
              return (
                <div className="section-card" key={fact.id}>
                  <div className="section-head">
                    <span>{fact.kind}</span>
                    {withheld ? <b style={{color: "var(--danger)"}}>withheld, no evidence</b> : null}
                  </div>
                  <div style={{fontSize: 15}}>{fact.statement}</div>
                  {fact.evidence ? <p className="pane-sub" style={{margin: "8px 0 0"}}>Evidence: {fact.evidence}</p> : null}
                  <div className="apply-bar" style={{marginTop: 12}}>
                    {fact.state !== "approved" ? (
                      <button onClick={() => onSetState(fact.id, "approved")}>Approve</button>
                    ) : null}
                    {fact.state !== "rejected" ? (
                      <button
                        onClick={() => onSetState(fact.id, "rejected")}
                        style={{background: "transparent", color: "var(--purple)", border: "1px solid var(--border-strong)"}}
                      >
                        Reject
                      </button>
                    ) : null}
                    <span>{fact.source || "manual"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/**
 * Reading the website is one button, but the result is deliberately not applied.
 * Statements land as proposals in the Product tab; colours and fonts are reported here
 * and copied across by hand if they are worth having. A web page is text a stranger
 * wrote, so nothing it says may take effect without a person in between.
 */
function Research({onImported}: {onImported: () => void}) {
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const list = urls.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean).slice(0, 6);
    if (!list.length) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.research(list));
      onImported();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="pane-title">Research your website</h2>
      <p className="pane-sub">
        Reads public pages and pulls out what the product says about itself, plus the colours and type
        it presents itself in. Local and private addresses are refused, and nothing is applied
        automatically.
      </p>

      <span className="field-label">Page URLs, one per line</span>
      <textarea
        value={urls}
        rows={3}
        placeholder={"https://myherald.io\nhttps://myherald.io/product"}
        onChange={(event) => setUrls(event.target.value)}
        style={{width: "100%", fontFamily: "var(--mono)", fontSize: 13}}
      />
      <div className="apply-bar" style={{marginTop: 12}}>
        <button onClick={() => void run()} disabled={busy || !urls.trim()}>
          {busy ? "Reading…" : "Read these pages"}
        </button>
        <span>Up to six pages.</span>
      </div>

      {error ? <div className="banner error" style={{marginTop: 16}}>{error}</div> : null}

      {result ? (
        <>
          <div className="banner" style={{marginTop: 16}}>
            {result.saved.added} statement(s) added as proposals in the Product tab
            {result.saved.skipped ? `, ${result.saved.skipped} already known` : ""}.
          </div>

          {result.errors.map((line) => (
            <div className="banner error" key={line} style={{marginTop: 8}}>{line}</div>
          ))}

          {result.pages.map((page) => (
            <div className="section-card" key={page.url}>
              <div className="section-head">
                <span>{page.title || page.url}</span>
                <span className="timing">{page.blocks} statements</span>
              </div>
              {page.summary ? <p className="pane-sub" style={{margin: 0}}>{page.summary}</p> : null}
            </div>
          ))}

          {result.colors.length ? (
            <>
              <span className="field-label">Colours found</span>
              <p className="pane-sub" style={{margin: "0 0 8px"}}>
                Contrast is measured against your own page surface. Copy anything worth keeping into
                Identity yourself.
              </p>
              {result.colors.map((color) => (
                <div className="swatch-row" key={color.hex}>
                  <span className="finding-swatch" style={{background: color.hex}} />
                  <code>{color.hex}</code>
                  <span className="pane-sub">
                    {color.role} · {color.count}×
                    {color.matchesToken ? ` · already yours as ${color.matchesToken}` : ""}
                  </span>
                  <span className="timing">{color.onSurface}:1</span>
                </div>
              ))}
            </>
          ) : null}

          {result.fonts.length ? (
            <>
              <span className="field-label">Font stacks found</span>
              {result.fonts.map((font) => (
                <div className="swatch-row" key={font.stack}>
                  <code style={{fontSize: 12}}>{font.stack}</code>
                  <span className="pane-sub">
                    {font.count}×{font.matchesStack ? ` · matches your ${font.matchesStack} stack` : ""}
                  </span>
                </div>
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
