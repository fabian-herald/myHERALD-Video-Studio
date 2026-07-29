import {useMemo, useState} from "react";

export interface Kit {
  name: string;
  tagline: string;
  website: string;
  color: {
    tokens: Record<string, string>;
    pairs: {fg: string; bg: string; minRatio: number; usage: string}[];
  };
  type: {stacks: Record<string, string>; scale: Record<string, number>};
  motion: Record<string, unknown>;
  voice: {
    toneRules: string[]; bannedWords: string[]; addressAs: string;
    narrationStyle: string; narratorRegister: string;
  };
  doDont: {do: string[]; dont: string[]};
  logos: KitLogo[];
}

export interface KitLogo {
  id: string;
  role: "wordmark" | "seal" | "lockup";
  theme: "light" | "dark" | "any";
  file: string;
  safeAreaPct: number;
  width?: number;
  height?: number;
  label: string;
}

/** WCAG 2.1 relative luminance, mirrored from core/brand/kit.ts so it reads live. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  if (value.length !== 6) return 0;
  const channels = [0, 2, 4].map((offset) => {
    const part = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

const isHex = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

/**
 * The brand kit, editable.
 *
 * Every pair is measured as you type, and the server refuses a kit whose own declared
 * minimums are not met. That is deliberate: these numbers are what every composition
 * is generated against, so a kit that lies about itself would quietly poison output.
 */
export function IdentityTab({kit, onSave}: {kit: Kit; onSave: (kit: Kit) => Promise<void>}) {
  const [draft, setDraft] = useState<Kit>(kit);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Logos are files, so adding or removing one writes to disk immediately rather than
  // waiting on Save. The reply carries the whole kit back, which is then merged into
  // the draft so an unsaved colour edit alongside it is not thrown away.
  const onLogosChanged = (next: Kit) =>
    setDraft((current) => ({...current, logos: next.logos}));

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(kit), [draft, kit]);
  const measured = useMemo(() => draft.color.pairs.map((pair) => {
    const fg = draft.color.tokens[pair.fg];
    const bg = draft.color.tokens[pair.bg];
    const ratio = fg && bg && isHex(fg) && isHex(bg) ? contrast(fg, bg) : 0;
    return {pair, fg, bg, ratio, ok: ratio >= pair.minRatio};
  }), [draft]);

  const failing = measured.filter((entry) => !entry.ok);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onSave(draft);
      setNotice("Saved. tokens.css is regenerated; the next video uses these values.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setToken = (name: string, value: string) =>
    setDraft((current) => ({
      ...current,
      color: {...current.color, tokens: {...current.color.tokens, [name]: value}},
    }));

  const setList = (key: "toneRules" | "bannedWords", value: string[]) =>
    setDraft((current) => ({...current, voice: {...current.voice, [key]: value}}));

  return (
    <>
      <h2 className="pane-title">{draft.name}</h2>
      <p className="pane-sub">{draft.tagline} · {draft.website}</p>

      {notice ? <div className="banner">{notice}</div> : null}
      {error ? <div className="banner error">{error}</div> : null}

      <Logos logos={draft.logos} onChanged={onLogosChanged} />

      <span className="field-label">Colour tokens: the only colours a composition may use</span>
      <div className="swatch-grid">
        {Object.entries(draft.color.tokens).map(([name, value]) => (
          <div className="swatch" key={name}>
            <label className="swatch-chip" style={{background: isHex(value) ? value : "transparent"}}>
              <input
                type="color"
                value={isHex(value) ? value : "#000000"}
                onChange={(event) => setToken(name, event.target.value)}
              />
            </label>
            <div className="swatch-name">{name}</div>
            <input
              className={`swatch-hex${isHex(value) ? "" : " invalid"}`}
              value={value}
              spellCheck={false}
              onChange={(event) => setToken(name, event.target.value.trim())}
            />
          </div>
        ))}
      </div>

      <span className="field-label">Approved contrast pairs · measured live</span>
      <p className="pane-sub" style={{marginBottom: 10}}>
        These are the only combinations the composer is shown. It is why the WCAG pass succeeds on
        the first attempt rather than the third.
      </p>
      {measured.map((entry) => (
        <div className={`check-row${entry.ok ? "" : " fail"}`} key={`${entry.pair.fg}-${entry.pair.bg}`}>
          <span className="dot" />
          <span
            className="pair-sample"
            style={{color: entry.fg, background: entry.bg}}
          >
            {entry.pair.fg} on {entry.pair.bg}
          </span>
          <span className="pair-ratio">{entry.ratio.toFixed(2)}:1</span>
          <span style={{color: "var(--muted)"}}>target {entry.pair.minRatio}:1 · {entry.pair.usage}</span>
        </div>
      ))}

      <span className="field-label">Type stacks</span>
      <p className="pane-sub" style={{marginBottom: 10}}>
        Videos render offline, so only the six vendored faces are guaranteed. Naming a font
        that is not in <code>data/brand/fonts</code> falls back silently at render time.
      </p>
      {(["display", "body", "mono"] as const).map((role) => (
        <div className="stack-row" key={role}>
          <span className="stack-role">{role}</span>
          <input
            value={draft.type.stacks[role] ?? ""}
            spellCheck={false}
            onChange={(event) => setDraft((current) => ({
              ...current,
              type: {...current.type, stacks: {...current.type.stacks, [role]: event.target.value}},
            }))}
          />
          <span className="stack-sample" style={{fontFamily: draft.type.stacks[role]}}>myHERALD 123</span>
        </div>
      ))}

      <span className="field-label">Type scale · pixels against a 1080-wide canvas</span>
      <p className="pane-sub" style={{marginBottom: 10}}>
        Reference sizes, scaled per format at render. The composer sees each as
        <code> --brand-size-*</code>.
      </p>
      <div className="scale-grid">
        {Object.entries(draft.type.scale).map(([name, size]) => (
          <label className="scale-cell" key={name}>
            <span>{name}</span>
            <input
              type="number"
              min={4}
              max={400}
              value={size}
              onChange={(event) => setDraft((current) => ({
                ...current,
                type: {...current.type, scale: {...current.type.scale, [name]: Number(event.target.value)}},
              }))}
            />
          </label>
        ))}
      </div>

      <span className="field-label">Tone · one rule per line</span>
      <textarea
        className="list-field"
        rows={Math.max(4, draft.voice.toneRules.length + 1)}
        value={draft.voice.toneRules.join("\n")}
        onChange={(event) => setList("toneRules", splitLines(event.target.value))}
      />

      <span className="field-label">Banned words · comma separated</span>
      <textarea
        className="list-field"
        rows={2}
        value={draft.voice.bannedWords.join(", ")}
        onChange={(event) => setList("bannedWords", event.target.value.split(",").map((word) => word.trim()).filter(Boolean))}
      />

      <span className="field-label">Delivery for the narration</span>
      <textarea
        className="list-field"
        rows={3}
        value={draft.voice.narrationStyle}
        onChange={(event) => setDraft((current) => ({
          ...current,
          voice: {...current.voice, narrationStyle: event.target.value},
        }))}
      />

      <span className="field-label">Who the narrator is</span>
      <p className="field-hint">
        Physical description, not mood. Held identical across every clip in a video,
        while the delivery above varies by section. Generative voices decide the speaker
        fresh on every line, and leaving this blank is how one line ends up sounding
        like somebody else.
      </p>
      <input
        className="text-field"
        value={draft.voice.narratorRegister}
        placeholder="one man, low-to-mid register, speaking pitch around 140 hertz"
        onChange={(event) => setDraft((current) => ({
          ...current,
          voice: {...current.voice, narratorRegister: event.target.value},
        }))}
      />

      <span className="field-label">Do</span>
      <textarea
        className="list-field"
        rows={Math.max(3, draft.doDont.do.length + 1)}
        value={draft.doDont.do.join("\n")}
        onChange={(event) => setDraft((current) => ({
          ...current,
          doDont: {...current.doDont, do: splitLines(event.target.value)},
        }))}
      />

      <span className="field-label">Don't</span>
      <textarea
        className="list-field"
        rows={Math.max(3, draft.doDont.dont.length + 1)}
        value={draft.doDont.dont.join("\n")}
        onChange={(event) => setDraft((current) => ({
          ...current,
          doDont: {...current.doDont, dont: splitLines(event.target.value)},
        }))}
      />

      <div className="apply-bar pinned">
        <button disabled={busy || !dirty || failing.length > 0} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <span>
          {failing.length
            ? `${failing.length} pair(s) miss their own minimum.`
            : dirty ? "Unsaved changes." : "No changes."}
        </span>
        {dirty ? (
          <button className="ghost-button" onClick={() => setDraft(kit)}>Discard</button>
        ) : null}
      </div>
    </>
  );
}

const splitLines = (value: string) =>
  value.split("\n").map((line) => line.trim()).filter(Boolean);

const ROLES = ["seal", "wordmark", "lockup"] as const;
const THEMES = ["light", "dark", "any"] as const;

const ROLE_HELP: Record<string, string> = {
  seal: "The mark on its own.",
  wordmark: "The name on its own.",
  lockup: "Mark and name together.",
};

/**
 * The marks a composition may place.
 *
 * This exists because the composer was hand-setting the wordmark: two typefaces at two
 * sizes on one baseline, which nothing reproduces correctly by eye. Now the files are
 * named in the compose brief and a check rejects a typeset brand name outright.
 *
 * A `dark` file is the one drawn *for* dark fields, so it carries light ink. The preview
 * below shows each on the field it belongs to, which is the only way to tell at a glance.
 */
function Logos({logos, onChanged}: {logos: KitLogo[]; onChanged: (kit: Kit) => void}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<typeof ROLES[number]>("lockup");
  const [theme, setTheme] = useState<typeof THEMES[number]>("light");

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("That file could not be read."));
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/brand/logos", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({dataUrl, role, theme, id: file.name}),
      });
      const body = await response.json() as {kit?: Kit; error?: string};
      if (!response.ok) throw new Error(body.error ?? "Upload failed.");
      if (body.kit) onChanged(body.kit);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/brand/logos/${id}`, {method: "DELETE"});
      const body = await response.json() as {kit?: Kit; error?: string};
      if (!response.ok) throw new Error(body.error ?? "Could not remove it.");
      if (body.kit) onChanged(body.kit);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="field-label">Logos</span>
      <p className="pane-sub" style={{marginBottom: 10}}>
        Compositions place these files. They never set the brand name as type, because the
        wordmark is two faces at two sizes and hand-setting it is always slightly wrong.
      </p>

      {error ? <div className="banner error" style={{marginBottom: 10}}>{error}</div> : null}

      <div className="logo-grid">
        {logos.map((logo) => (
          <figure className={`logo-card on-${logo.theme}`} key={logo.id}>
            <img src={`/files/data/brand/${logo.file}`} alt={logo.id} />
            <figcaption>
              <b>{logo.id}</b>
              <span>
                {logo.role} · {logo.theme === "any" ? "any field" : `${logo.theme} fields`}
                {logo.width && logo.height ? ` · ${logo.width}×${logo.height}` : ""}
              </span>
              <button className="ghost-button" disabled={busy} onClick={() => void remove(logo.id)}>
                Remove
              </button>
            </figcaption>
          </figure>
        ))}
        {logos.length === 0 ? (
          <div className="banner">
            No marks yet. Without one the composer is told to stay typographic rather than
            invent something.
          </div>
        ) : null}
      </div>

      <div className="apply-bar" style={{marginBottom: 22}}>
        <label className="upload-button">
          {busy ? "Adding…" : "Add a logo"}
          <input
            type="file"
            accept="image/png,image/svg+xml,image/jpeg,image/webp"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        <select value={role} onChange={(event) => setRole(event.target.value as typeof ROLES[number])}>
          {ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select value={theme} onChange={(event) => setTheme(event.target.value as typeof THEMES[number])}>
          {THEMES.map((value) => (
            <option key={value} value={value}>{value === "any" ? "any field" : `${value} fields`}</option>
          ))}
        </select>
        <span>{ROLE_HELP[role]} PNG, SVG, JPEG or WebP.</span>
      </div>
    </>
  );
}
