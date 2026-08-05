import {useEffect, useState} from "react";
import {api, type ProviderAvailability, type Settings} from "./api.ts";

const ROLES: {key: "agent" | "planner" | "composer"; title: string; description: string}[] = [
  {key: "agent", title: "Studio assistant", description: "Conversation, research and coordination."},
  {key: "planner", title: "Strategy & script", description: "The brief, spoken script and structured video plan."},
  {key: "composer", title: "Visual composer", description: "The HyperFrames scenes, motion and visual treatment."},
];

/** Shown, not defaulted — an empty field means "whatever the studio ships with". */
const CODEX_MODEL_PLACEHOLDER = "gpt-5.6-terra";

/**
 * The ids worth one click, per provider. Neither list is exhaustive and neither is a
 * schema: `Other…` keeps any id typeable, because a new model ships long before this
 * file is edited, and the whole point of the field is trying the new one.
 */
const CLAUDE_MODELS: {value: string; label: string}[] = [
  {value: "", label: "Studio default"},
  {value: "opus", label: "Opus — most capable"},
  {value: "sonnet", label: "Sonnet — faster"},
  {value: "haiku", label: "Haiku — cheapest"},
];

const CODEX_MODELS: {value: string; label: string}[] = [
  {value: "", label: `Studio default (${CODEX_MODEL_PLACEHOLDER})`},
  {value: "gpt-5.6-terra", label: "gpt-5.6-terra"},
  {value: "gpt-5.6-luna", label: "gpt-5.6-luna"},
];

const OTHER_MODEL = "__other__";

/**
 * A short list plus an escape hatch.
 *
 * The dropdown is the answer to "which models are there" — a bare text field answered
 * that with nothing, so the field only worked for someone who already knew an id. The
 * text input stays for the id that is not on the list yet.
 */
function ModelPicker({choices, value, placeholder, onChange}: {
  choices: {value: string; label: string}[];
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}) {
  const listed = choices.some((choice) => choice.value === value);
  /*
   * What is in the text box, or null while the dropdown is doing the choosing. A saved id
   * that is not on the list opens the box already holding it, so `Other…` shows what is
   * actually set rather than an empty field next to a live setting.
   */
  const [draft, setDraft] = useState<string | null>(listed ? null : value);
  const showCustom = draft !== null;

  return (
    <div className="model-picker">
      <select
        value={showCustom ? OTHER_MODEL : value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === OTHER_MODEL) return setDraft(listed ? "" : value);
          setDraft(null);
          onChange(next);
        }}
      >
        {choices.map((choice) => (
          <option value={choice.value} key={choice.value || "default"}>{choice.label}</option>
        ))}
        <option value={OTHER_MODEL}>Other…</option>
      </select>
      {showCustom ? (
        <input
          type="text"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          /*
           * An empty box saves nothing. It reads as "I have not typed the id yet", and the
           * alternative is worse than it sounds: opening `Other…` and clicking away would
           * clear whichever model was set, silently, from a control the owner only looked at.
           * Choosing the studio default is what the first entry in the list is for.
           */
          onBlur={() => {
            const next = draft.trim();
            if (next && next !== value) onChange(next);
          }}
        />
      ) : null}
    </div>
  );
}

const GUIDANCE: {
  key: keyof Settings["marketingSkills"];
  title: string;
  description: string;
  scope: string;
}[] = [
  {
    key: "adCreative",
    title: "Ad creative",
    description: "Sharper problem, promise, proof and CTA guidance.",
    scope: "Performance ads only",
  },
  {
    key: "social",
    title: "Social",
    description: "Clear openings and easy-to-follow social storytelling.",
    scope: "Organic and editorial videos; never performance ads",
  },
  {
    key: "marketingPsychology",
    title: "Marketing psychology",
    description: "Clear framing and lower cognitive load, without invented proof or urgency.",
    scope: "All video styles",
  },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<ProviderAvailability | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api.settings(), api.providers()])
      .then(([nextSettings, nextProviders]) => {
        setSettings(nextSettings);
        setProviders(nextProviders);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  async function save(next: Settings) {
    setSettings(next);
    setState("saving");
    setError(null);
    try {
      setSettings(await api.saveSettings(next));
      setState("saved");
      window.setTimeout(() => setState("idle"), 1400);
    } catch (cause) {
      setError((cause as Error).message);
      setState("idle");
    }
  }

  return (
    <section className="chat settings-page">
      <div className="chat-log">
        <h2 className="pane-title">Settings</h2>
        <p className="pane-sub">
          Choose the subscription used for each part of the work. Changes apply to the next message or video.
        </p>
        {error ? <div className="banner error">{error}</div> : null}
        {!settings || !providers ? <p className="pane-sub">Loading…</p> : (
          <>
            <div className="settings-heading">
              <span className="field-label">AI roles</span>
              <small>{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : ""}</small>
            </div>
            <div className="settings-grid">
              {ROLES.map((role) => (
                <label className="settings-card" key={role.key}>
                  <span><b>{role.title}</b><small>{role.description}</small></span>
                  <select
                    value={settings[role.key]}
                    onChange={(event) => void save({...settings, [role.key]: event.target.value as "claude" | "codex"})}
                  >
                    <option value="claude">Claude subscription</option>
                    <option value="codex" disabled={!providers.codex.available}>Codex subscription</option>
                  </select>
                </label>
              ))}
            </div>
            {!providers.codex.available ? (
              <div className="banner">Codex is unavailable: {providers.codex.reason}</div>
            ) : (
              <p className="settings-note">Codex is signed in through your ChatGPT subscription. No OpenAI API billing is used.</p>
            )}

            <div className="settings-heading">
              <span className="field-label">Models</span>
            </div>
            <div className="settings-grid">
              <div className="settings-card">
                <span>
                  <b>Claude model</b>
                  <small>Runs every role set to Claude. The default is whatever your Claude subscription serves.</small>
                </span>
                <ModelPicker
                  choices={CLAUDE_MODELS}
                  value={settings.claudeModel}
                  placeholder="claude-opus-5"
                  onChange={(claudeModel) => void save({...settings, claudeModel})}
                />
              </div>
              {providers.codex.available ? (
                <>
                  <div className="settings-card">
                    <span>
                      <b>Codex model</b>
                      <small>Runs every role set to Codex.</small>
                    </span>
                    <ModelPicker
                      choices={CODEX_MODELS}
                      value={settings.codexModel}
                      placeholder={CODEX_MODEL_PLACEHOLDER}
                      onChange={(codexModel) => void save({...settings, codexModel})}
                    />
                  </div>
                  <label className="settings-card">
                    <span>
                      <b>Composing effort</b>
                      <small>
                        How hard Codex thinks when it authors the scenes. Lower this if a model
                        rejects xhigh — Codex accepts an unknown value silently, so the run just fails.
                      </small>
                    </span>
                    <select
                      value={settings.codexComposeEffort}
                      onChange={(event) => void save({
                        ...settings,
                        codexComposeEffort: event.target.value as Settings["codexComposeEffort"],
                      })}
                    >
                      <option value="xhigh">xhigh — the visual default</option>
                      <option value="high">high</option>
                      <option value="medium">medium — fastest</option>
                    </select>
                  </label>
                </>
              ) : null}
            </div>

            <div className="settings-heading guidance-heading">
              <span className="field-label">Creative guidance</span>
            </div>
            <p className="pane-sub">
              These aids only influence new strategy and scripts. Turn any one off if it pulls the result in the wrong direction.
            </p>
            <div className="settings-grid">
              {GUIDANCE.map((item) => {
                const enabled = settings.marketingSkills[item.key];
                return (
                  <button
                    type="button"
                    className={`settings-card guidance-card${enabled ? " enabled" : ""}`}
                    aria-pressed={enabled}
                    key={item.key}
                    onClick={() => void save({
                      ...settings,
                      marketingSkills: {...settings.marketingSkills, [item.key]: !enabled},
                    })}
                  >
                    <span><b>{item.title}</b><small>{item.description}</small><em>{item.scope}</em></span>
                    <i>{enabled ? "On" : "Off"}</i>
                  </button>
                );
              })}
            </div>
            <p className="settings-note">
              Video intent, brand rules, approved facts and narration profile always override this guidance. Analytics,
              campaign budgets and A/B-test metrics are deliberately not part of the studio.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
