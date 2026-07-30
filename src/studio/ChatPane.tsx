import {useEffect, useRef, useState} from "react";
import {api, sendMessage, type AgentEvent, type Thread, type ThreadMessage} from "./api.ts";
import {CONTENT_LANGUAGES, LANGUAGE_ENDONYMS, type ContentLanguage} from "../core/plan/language.ts";

interface Props {
  thread: Thread;
  onTurnComplete: (videoId?: string) => void;
}

/**
 * Seconds since the turn started, or 0 when nothing is running.
 *
 * A build runs twenty-odd minutes, most of it inside one compose step that emits tool
 * calls at an uneven rate — long silences while the agent renders frames and looks at
 * them. Without a clock the only way to tell "still working" from "wedged" is to sit and
 * wait for the next line.
 */
function useElapsed(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    // Derived from a start stamp rather than counted per tick: browsers throttle timers
    // in a backgrounded tab, and a counter would drift low over twenty minutes exactly
    // when the number matters most.
    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

/** `48s`, then `4m 12s`. Seconds stay visible throughout — they are the sign of life. */
export function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function ChatPane({thread, onTurnComplete}: Props) {
  const [messages, setMessages] = useState<ThreadMessage[]>(thread.messages);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [cost, setCost] = useState<AgentEvent["cost"] | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(running);
  /**
   * The handle on the run in flight.
   *
   * A ref rather than state: stopping must not wait for a render, and nothing about the
   * controller belongs on screen. Aborting it drops the response stream, which the server
   * hears as `response.on("close")` and turns into the run's own cancellation.
   */
  const runRef = useRef<AbortController | null>(null);
  /** Which thread the messages on screen belong to, so a switch can be told from a refetch. */
  const threadIdRef = useRef(thread.id);

  useEffect(() => {
    // A shorter list for the same thread is a stale read, not an edit. Stopping a run
    // refetches the thread the instant the stream drops, which can beat the server writing
    // the turn down by a few milliseconds — and adopting that answer wiped the whole
    // transcript off the screen while all twenty-one messages sat safely on disk. Switching
    // threads is the real change, and that always brings a different id.
    setMessages((current) =>
      thread.id !== threadIdRef.current || thread.messages.length >= current.length
        ? thread.messages
        : current);
    threadIdRef.current = thread.id;
    setCost(null);
  }, [thread.id, thread.messages]);

  useEffect(() => {
    logRef.current?.scrollTo({top: logRef.current.scrollHeight, behavior: "smooth"});
  }, [messages.length, running]);

  async function submit() {
    const text = draft.trim();
    if (!text || running) return;

    setDraft("");
    setRunning(true);
    setCost(null);
    append({role: "user", text});

    const controller = new AbortController();
    runRef.current = controller;

    let videoId: string | undefined;
    try {
      await sendMessage(thread.id, text, (event: AgentEvent) => {
        if (event.type === "message") append({role: "assistant", text: event.text});
        else if (event.type === "event") append({role: "event", text: event.text, tool: event.tool});
        else if (event.type === "error") append({role: "assistant", text: `⚠ ${event.text}`});
        else if (event.type === "done") {
          videoId = event.videoId;
          if (event.cost) setCost(event.cost);
        }
      }, controller.signal);
    } catch (error) {
      // A stop the owner asked for is not an error to apologise for. It is still recorded,
      // because a run that spent twenty minutes and produced nothing should say so in the
      // transcript rather than leave a gap someone has to reconstruct later.
      append(controller.signal.aborted
        ? {role: "event", text: "stopped by you"}
        : {role: "assistant", text: `⚠ ${(error as Error).message}`});
    } finally {
      runRef.current = null;
      setRunning(false);
      onTurnComplete(videoId);
    }
  }

  /** Stop the run in flight. See `core/cancel.ts` for what the server does with it. */
  function stop() {
    runRef.current?.abort();
  }

  function append(message: Omit<ThreadMessage, "id" | "at">) {
    setMessages((current) => [
      ...current,
      {...message, id: `local-${current.length}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString()},
    ]);
  }

  return (
    <section className="chat">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !running ? <Welcome kind={thread.kind} /> : null}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {running ? (
          <div className="msg msg-event running">
            working… <span className="elapsed">{formatElapsed(elapsed)}</span>
            {/* Beside the elapsed time on purpose: the moment you want to stop a run is the
                moment you notice how long it has been going. */}
            <button className="run-stop" onClick={stop}>Stop</button>
          </div>
        ) : null}
      </div>

      {cost ? (
        <div className="chat-note">
          This turn: <b>${cost.chargedUsd.toFixed(2)} charged</b>
          {cost.billingMode === "subscription"
            ? ` · $${cost.apiEquivalentUsd.toFixed(2)} would be the equivalent at API list prices, covered by your CLI subscription`
            : " · metered API billing"}
        </div>
      ) : null}

      <div className="chat-input">
        <textarea
          value={draft}
          placeholder={thread.kind === "studio"
            ? "What should the next video be about?"
            : "Change the wording, try another angle, add a format…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <LanguagePicker />
        <button className="chat-send" disabled={running || !draft.trim()} onClick={() => void submit()}>
          {running ? "…" : "Send"}
        </button>
      </div>
    </section>
  );
}

/**
 * The language videos come out in, not the language of this interface.
 *
 * It sits in the composer rather than on a settings screen because it is a property of
 * the thing you are about to ask for. Anywhere else and a wrong value is first noticed
 * when a finished video speaks the wrong language.
 */
function LanguagePicker() {
  const [language, setLanguage] = useState<ContentLanguage | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.settings().then((settings) => setLanguage(settings.contentLanguage)).catch(() => {});
  }, []);

  async function choose(next: ContentLanguage) {
    const previous = language;
    setLanguage(next);
    setSaving(true);
    try {
      const current = await api.settings();
      await api.saveSettings({...current, contentLanguage: next});
    } catch {
      setLanguage(previous);
    } finally {
      setSaving(false);
    }
  }

  if (!language) return null;

  return (
    <label className="chat-language" title="The language new videos are written, spoken and captioned in. Not the language of this interface.">
      <span>SPOKEN</span>
      <select
        value={language}
        disabled={saving}
        onChange={(event) => void choose(event.target.value as ContentLanguage)}
      >
        {CONTENT_LANGUAGES.map((code) => (
          <option key={code} value={code}>{LANGUAGE_ENDONYMS[code]}</option>
        ))}
      </select>
    </label>
  );
}

function Message({message}: {message: ThreadMessage}) {
  if (message.role === "event") return <div className="msg msg-event">{message.text}</div>;
  if (message.role === "user") return <div className="msg msg-user">{message.text}</div>;
  return <div className="msg msg-assistant">{message.text}</div>;
}

function Welcome({kind}: {kind: Thread["kind"]}) {
  return (
    <div className="chat-empty">
      <h1>
        One thought.
        <br />
        <em>A finished video.</em>
      </h1>
      <p>
        {kind === "studio"
          ? "Say what the video is about. Everything else comes from the brand kit: format, length, tone, and whether it pitches at all."
          : "Ask for a change. Wording and pacing are free. Only a change of shape needs a rebuild."}
      </p>
    </div>
  );
}
