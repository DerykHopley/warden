// The Ask Warden panel (docs/design.md direction E: Side panel, Chat context, Layout, Motion): closed (a button),
// floating over the page, or pinned beside it with a divider that resizes it. The detail card for the page's focus sits
// above the chat, and the context line above the input. The chat is a placeholder: nothing is sent to the server, and
// nothing is kept past the page. The real chat comes with the agent spec.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { askAboutTeam, type GetToken } from "./api.ts";
import { DetailCard } from "./DetailCard.tsx";
import {
  askWardenLabel,
  clampWidth,
  contextLine,
  PANEL_STORAGE_KEY,
  PANEL_WIDTH,
  panelShownAs,
  PIN_FROM,
  startingPanel,
  type PanelContext,
  type PanelMode,
  type PanelState,
} from "./panel.ts";
import { useClerkUsers } from "./person-name.ts";
import { fetchProposals, type ProposalsResult } from "./proposals.ts";
import { useWardenCall } from "./warden-call.tsx";

/** The placeholder's one reply. */
export const NOT_CONNECTED = "Warden's chat isn't connected yet.";

type ChatMessage = { from: "person" | "warden"; text: string };

function readStored(): string | null {
  try {
    return window.localStorage.getItem(PANEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(state: PanelState) {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** The window's width, kept current as it resizes. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export type PanelControls = {
  state: PanelState;
  setMode: (mode: PanelMode) => void;
  setWidth: (width: number) => void;
  /** Opens the panel floating when it's closed; an open or pinned panel stays as it is. */
  openFloating: () => void;
};

/**
 * The panel's state, for the shell: the width default or the person's stored choice on load. Each change the person
 * makes is stored, so it wins over the width default next time. Every function keeps its identity across renders.
 */
export function usePanelState(): PanelControls {
  const [state, setState] = useState(() => startingPanel(window.innerWidth, readStored()));
  const chosen = useRef(false);
  useEffect(() => {
    if (chosen.current) store(state);
  }, [state]);

  const change = useCallback((update: (old: PanelState) => PanelState) => {
    chosen.current = true;
    setState(update);
  }, []);
  const setMode = useCallback((mode: PanelMode) => change((old) => ({ ...old, mode })), [change]);
  const setWidth = useCallback(
    (width: number) => change((old) => ({ ...old, width: clampWidth(width) })),
    [change],
  );
  const openFloating = useCallback(
    () => change((old) => (old.mode === "closed" ? { ...old, mode: "floating" } : old)),
    [change],
  );
  return { state, setMode, setWidth, openFloating };
}

/** Not asked yet: the Proposals load when the detail card first shows. */
const NOT_ASKED = { kind: "not-asked" } as const;

export function AskWardenPanel(props: {
  panel: PanelControls;
  context: PanelContext;
  getToken: GetToken;
  /** The active Team: an answer about another is asked again, never shown. */
  team: string | null;
  onSessionEnded: () => void;
}) {
  const { panel, context, getToken, team, onSessionEnded } = props;
  const windowWidth = useWindowWidth();
  const shownAs = panelShownAs(panel.state.mode, windowWidth);
  const clerkUsers = useClerkUsers();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Where focus goes once the next render lands: back to the closed button, or into the input. */
  const focusNext = useRef<"button" | "input" | null>(null);

  // The Proposals load once the detail card first shows, then once per Team.
  const cardShown = shownAs !== "closed" && context.focus !== null;
  const [proposalsWanted, setProposalsWanted] = useState(false);
  if (cardShown && !proposalsWanted) setProposalsWanted(true);
  const askProposals = useCallback(
    async (signal: AbortSignal) =>
      proposalsWanted
        ? askAboutTeam(
            () => fetchProposals(getToken),
            (result) => (result.kind === "proposals" ? result.team : undefined),
            team,
            signal,
          )
        : NOT_ASKED,
    [proposalsWanted, getToken, team],
  );
  const proposals = useWardenCall<ProposalsResult | typeof NOT_ASKED>(askProposals, onSessionEnded);

  useEffect(() => {
    if (focusNext.current === "button") buttonRef.current?.focus();
    if (focusNext.current === "input") inputRef.current?.focus();
    focusNext.current = null;
  });

  const { setMode } = panel;
  const close = useCallback(() => {
    focusNext.current = "button";
    setMode("closed");
  }, [setMode]);

  // Esc closes a floating (or full-screen) panel, wherever focus is.
  const overPage = shownAs === "floating" || shownAs === "full-screen";
  useEffect(() => {
    if (!overPage) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [overPage, close]);

  const sent = messages.filter((m) => m.from === "person").length;

  if (shownAs === "closed") {
    return (
      <button
        ref={buttonRef}
        type="button"
        className="secondary ask-warden-button"
        onClick={() => {
          focusNext.current = "input";
          setMode("floating");
        }}
      >
        {askWardenLabel(sent)}
      </button>
    );
  }

  function onSend(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    setMessages((all) => [
      ...all,
      { from: "person", text },
      { from: "warden", text: NOT_CONNECTED },
    ]);
    setDraft("");
  }

  const proposalsShown =
    proposals.result === "loading" || proposals.result.kind === "not-asked"
      ? "loading"
      : proposals.result;
  const style = { "--panel-width": `${panel.state.width}px` } as CSSProperties;

  return (
    <aside
      className={`ask-warden ${shownAs}`}
      data-shown={shownAs}
      aria-labelledby="ask-warden-title"
      style={style}
    >
      {shownAs === "pinned" && <Divider width={panel.state.width} onResize={panel.setWidth} />}
      <div className="panel-header">
        <h2 id="ask-warden-title">Ask Warden</h2>
        {windowWidth >= PIN_FROM && (
          <button
            type="button"
            className="secondary"
            onClick={() => setMode(shownAs === "pinned" ? "floating" : "pinned")}
          >
            {shownAs === "pinned" ? "Unpin" : "Pin"}
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Close Ask Warden" onClick={close}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {context.focus !== null && (
          <DetailCard
            key={context.focus.id}
            finding={context.focus}
            proposals={proposalsShown}
            clerkUsers={clerkUsers}
            onClear={() => {
              focusNext.current = "input";
              context.clearFocus();
            }}
          />
        )}
        <ol className="chat-messages" aria-label="Messages">
          {messages.map((message, i) => (
            <li key={i} className={`chat-message from-${message.from}`} data-from={message.from}>
              {message.text}
            </li>
          ))}
        </ol>
      </div>
      <div className="panel-foot">
        <ContextLine context={context} />
        <form className="chat-form" onSubmit={onSend}>
          <input
            ref={inputRef}
            className="chat-input"
            aria-label="Message"
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="primary">
            Send
          </button>
        </form>
      </div>
    </aside>
  );
}

/** What "this" means to the chat: the focused item's short id, then the page's view. */
export function ContextLine({ context }: { context: PanelContext }) {
  return <p className="context-line">{contextLine(context)}</p>;
}

/**
 * The pinned panel's divider: a focusable separator. Dragging it resizes the panel; ← widens and → narrows it by 24px.
 * The width stays within 320 to 680px either way.
 */
function Divider({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const [dragging, setDragging] = useState(false);

  function onKeyDown(event: KeyboardEvent) {
    const step = { ArrowLeft: PANEL_WIDTH.step, ArrowRight: -PANEL_WIDTH.step }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    onResize(width + step);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Ask Warden"
      aria-valuenow={width}
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      tabIndex={0}
      className="panel-divider"
      data-dragging={dragging ? "true" : undefined}
      onKeyDown={onKeyDown}
      // A drag selects no text on the page.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        // The panel's right edge is the viewport's: its width is what lies right of the pointer.
        if (dragging) onResize(document.documentElement.clientWidth - event.clientX);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    />
  );
}
