import {useEffect, useState} from "react";
import {api, type ProviderAvailability, type Settings} from "./api.ts";

const ROLES: {key: "agent" | "planner" | "composer"; title: string; description: string}[] = [
  {key: "agent", title: "Studio assistant", description: "Conversation, research and coordination."},
  {key: "planner", title: "Strategy & script", description: "The brief, spoken script and structured video plan."},
  {key: "composer", title: "Visual composer", description: "The HyperFrames scenes, motion and visual treatment."},
];

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
