import {useEffect, useMemo, useState} from "react";
import {api, type Energy, type PlanEditPayload, type PlanSection, type VideoDetail} from "./api.ts";

/** A section as the owner is editing it, before anything is sent. */
interface Draft {
  onScreen: string;
  energy: Energy;
  lines: {id?: string; text: string}[];
  trailingGapMs: number;
  removed: boolean;
}

/**
 * The video's dynamic range. Held at one setting throughout, a calm piece reads as flat
 * rather than composed, so a lift only works because the section before it did not.
 */
const ENERGIES: {value: Energy; label: string; hint: string}[] = [
  {value: "quiet", label: "Quiet", hint: "Pulled back, so the line lands on its own."},
  {value: "settled", label: "Settled", hint: "The baseline. Even and certain."},
  {value: "lift", label: "Lift", hint: "Leaning in. Conviction, never enthusiasm."},
  {value: "edge", label: "Edge", hint: "Sharp and flat, for naming what is wrong."},
];

const toDraft = (section: PlanSection): Draft => ({
  onScreen: section.onScreen,
  energy: section.energy ?? "settled",
  lines: section.phrases.map((phrase) => ({id: phrase.id, text: phrase.text})),
  trailingGapMs: section.phrases.at(-1)?.gapAfterMs ?? 120,
  removed: false,
});

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * The cheap edit path made visible.
 *
 * Copy and pacing live in the plan and the composition is keyed to it by section id,
 * so changes here re-narrate only what was touched and re-render without a model call.
 * Anything that would change the *shape* of a scene is reported back rather than
 * attempted.
 */
export function ScriptTab({detail, onApplied}: {detail: VideoDetail; onApplied: () => void}) {
  const plan = detail.plan;
  const sections = useMemo(() => plan?.sections ?? [], [plan]);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    setDrafts(Object.fromEntries(sections.map((section) => [section.id, toDraft(section)])));
    setNotice(null);
    setProblems([]);
  }, [plan?.id, sections]);

  const edits = useMemo(() => buildEdits(sections, drafts), [sections, drafts]);
  const remaining = sections.filter((section) => !drafts[section.id]?.removed).length;

  if (!plan) return <p className="pane-sub">No plan for this video.</p>;

  async function apply() {
    if (!plan || !edits.length) return;
    setBusy(true);
    setNotice(null);
    setProblems([]);
    try {
      const result = await api.applyEdits(plan.id, edits);
      setProblems(result.needsCompose);
      setNotice(
        `${result.outputs.map((output) => output.format).join(", ")} re-rendered`
        + `${result.durationChanged ? " · length changed" : " · same length"}`
        + `${result.outputs.every((output) => output.qcPassed) ? " · QC passed" : " · QC failed"}`,
      );
      onApplied();
    } catch (error) {
      setProblems([(error as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  function patch(sectionId: string, next: Partial<Draft>) {
    setDrafts((current) => {
      const base = current[sectionId];
      return base ? {...current, [sectionId]: {...base, ...next}} : current;
    });
  }

  return (
    <>
      <h2 className="pane-title">Script</h2>
      <p className="pane-sub">
        Copy, lines and pauses are edited here directly. Only what you touch is re-narrated;
        the rest comes from the cache.
      </p>

      {notice ? <div className="banner">{notice}</div> : null}
      {problems.map((problem) => (
        <div className="banner error" key={problem}>{problem}</div>
      ))}

      {sections.map((section, index) => {
        const draft = drafts[section.id] ?? toDraft(section);
        return (
          <div className={`section-card${draft.removed ? " struck" : ""}`} key={section.id}>
            <div className="section-head">
              <span>{String(index + 1).padStart(2, "0")} · {section.kind}</span>
              <span className="timing">
                {seconds(section.startMs)} → {seconds(section.startMs + section.durationMs)}
              </span>
            </div>

            <span className="field-label">On screen</span>
            <input
              className="onscreen"
              value={draft.onScreen}
              disabled={draft.removed}
              onChange={(event) => patch(section.id, {onScreen: event.target.value})}
            />

            <span className="field-label">Energy</span>
            <div className="energy-row">
              {ENERGIES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  disabled={draft.removed}
                  className={`energy-chip${draft.energy === option.value ? " active" : ""}`}
                  onClick={() => patch(section.id, {energy: option.value})}
                >
                  {option.label}
                </button>
              ))}
              <span className="pane-sub">
                {ENERGIES.find((option) => option.value === draft.energy)?.hint}
              </span>
            </div>

            <span className="field-label">Spoken · one line per caption page</span>
            {draft.lines.map((line, lineIndex) => (
              <div className="line-row" key={line.id ?? `new-${lineIndex}`}>
                <textarea
                  value={line.text}
                  rows={1}
                  disabled={draft.removed}
                  onChange={(event) => {
                    const lines = [...draft.lines];
                    lines[lineIndex] = {...line, text: event.target.value};
                    patch(section.id, {lines});
                  }}
                />
                <button
                  className="icon-button"
                  title="Remove this line"
                  disabled={draft.removed || draft.lines.length < 2}
                  onClick={() => patch(section.id, {lines: draft.lines.filter((_, i) => i !== lineIndex)})}
                >
                  −
                </button>
                <button
                  className="icon-button"
                  title="Insert a line below"
                  disabled={draft.removed}
                  onClick={() => {
                    const lines = [...draft.lines];
                    lines.splice(lineIndex + 1, 0, {text: ""});
                    patch(section.id, {lines});
                  }}
                >
                  +
                </button>
              </div>
            ))}

            <div className="row-split">
              <div>
                <span className="field-label">Pause after</span>
                <input
                  type="number"
                  min={0}
                  max={4000}
                  step={20}
                  disabled={draft.removed}
                  value={draft.trailingGapMs}
                  onChange={(event) => patch(section.id, {trailingGapMs: Number(event.target.value)})}
                />
              </div>
              <button
                className="ghost-button"
                disabled={!draft.removed && remaining < 3}
                onClick={() => patch(section.id, {removed: !draft.removed})}
              >
                {draft.removed ? "Keep it after all" : "Remove scene"}
              </button>
            </div>
          </div>
        );
      })}

      <div className="apply-bar pinned">
        <button disabled={busy || !edits.length} onClick={() => void apply()}>
          {busy ? "Rendering…" : `Apply${edits.length ? ` (${edits.length})` : ""}`}
        </button>
        <span>{edits.length ? "No agent, no model cost. Changing energy re-narrates that section." : "No changes."}</span>
      </div>
    </>
  );
}

function buildEdits(sections: PlanSection[], drafts: Record<string, Draft>): PlanEditPayload[] {
  const edits: PlanEditPayload[] = [];

  for (const section of sections) {
    const draft = drafts[section.id];
    if (!draft) continue;

    if (draft.removed) {
      edits.push({sectionId: section.id, remove: true});
      continue;
    }

    const edit: PlanEditPayload = {sectionId: section.id};
    let changed = false;

    if (draft.onScreen !== section.onScreen) {
      edit.onScreen = draft.onScreen;
      changed = true;
    }

    if (draft.energy !== (section.energy ?? "settled")) {
      edit.energy = draft.energy;
      changed = true;
    }

    const before = section.phrases.map((phrase) => `${phrase.id}::${phrase.text}`).join("|");
    const after = draft.lines.map((line) => `${line.id ?? ""}::${line.text}`).join("|");
    if (before !== after) {
      edit.setPhrases = draft.lines
        .filter((line) => line.text.trim())
        .map((line) => (line.id ? {id: line.id, text: line.text} : {text: line.text}));
      changed = true;
    }

    if (draft.trailingGapMs !== (section.phrases.at(-1)?.gapAfterMs ?? 120)) {
      edit.trailingGapMs = draft.trailingGapMs;
      changed = true;
    }

    if (changed) edits.push(edit);
  }

  return edits;
}
