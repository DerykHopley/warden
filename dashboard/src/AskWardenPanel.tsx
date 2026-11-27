// The Ask Warden panel (docs/design.md direction E: Side panel, Chat context, Layout, Motion): closed (a button),
// floating over the page, or pinned beside it with a divider that resizes it. The detail card for the page's focus sits
// above the chat, and the context line above the input. The chat is a placeholder: nothing is sent to the server, and
// nothing is kept past the page. The real chat comes with the agent spec.
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { Role } from "@warden/contracts";
import { askAboutTeam, type GetToken } from "./api.ts";
import { ControlCard } from "./ControlCard.tsx";
import { DetailCard } from "./DetailCard.tsx";
import { shortId } from "./findings.ts";
import {
  askWardenLabel,
  PANEL_STORAGE_KEY,
  PANEL_WIDTH,
  panelReducer,
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
  /** What shows. */
  state: PanelState;
  /** The person's choice of mode: it shows, and it's stored. */
  choose: (mode: PanelMode) => void;
  /** A mode that shows without being stored. */
  show: (mode: PanelMode) => void;
  /** A width that shows (clamped) without being stored: the divider while it's dragged. */
  resize: (width: number) => void;
  /** Stores what shows: a drag's end, or a keyboard step. */
  commit: () => void;
  /** Opens the panel floating when it's closed, without storing it; an open or pinned panel stays as it is. */
  openFloating: () => void;
};

/**
 * The panel's state, for the shell: the width default or the person's stored choice on load. Each choice the person
 * makes is stored, so it wins over the width default next time; an automatic open and a drag in progress aren't.
 * Every function keeps its identity across renders.
 */
export function usePanelState(): PanelControls {
  const [{ shown, chosen }, dispatch] = useReducer(panelReducer, undefined, () => ({
    shown: startingPanel(window.innerWidth, readStored()),
    chosen: null,
  }));
  useEffect(() => {
    if (chosen !== null) store(chosen);
  }, [chosen]);

  const choose = useCallback((mode: PanelMode) => dispatch({ type: "choose", mode }), []);
  const show = useCallback((mode: PanelMode) => dispatch({ type: "show", mode }), []);
  const resize = useCallback((width: number) => dispatch({ type: "resize", width }), []);
  const commit = useCallback(() => dispatch({ type: "commit" }), []);
  const openFloating = useCallback(() => dispatch({ type: "open" }), []);
  return { state: shown, choose, show, resize, commit, openFloating };
}

/** Not asked: the Proposals load while the detail card shows. */
const NOT_ASKED = { kind: "not-asked" } as const;

export function AskWardenPanel(props: {
  panel: PanelControls;
  context: PanelContext;
  getToken: GetToken;
  /** The active Team: an answer about another is asked again, never shown. */
  team: string | null;
  /** The person's Role in the Team (null until /api/me answers): it picks the detail card's buttons. */
  role: Role | null;
  /** The signed-in person's user id: their own Proposals read "Asked by you". */
  userId: string | null;
  /** Ask /api/me again: the server said the person's Role is too low for a decision. */
  refreshMe: () => void;
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

  // The Proposals load whenever the detail card shows a newly focused Finding, so a Proposal asked since shows too.
  const cardFocus = shownAs === "closed" ? null : (context.focus?.id ?? null);
  const askProposals = useCallback(
    async (signal: AbortSignal) =>
      cardFocus === null
        ? NOT_ASKED
        : askAboutTeam(
            () => fetchProposals(getToken),
            (result) => (result.kind === "proposals" ? result.team : undefined),
            team,
            signal,
          ),
    [cardFocus, getToken, team],
  );
  const proposals = useWardenCall<ProposalsResult | typeof NOT_ASKED>(askProposals, onSessionEnded);

  // A sent message and Warden's reply each jump the chat to its newest message's bottom edge, with no smooth scroll,
  // so reduced motion needs nothing of its own. Opening the card or deciding in it doesn't scroll the chat.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (body !== null && messages.length > 0) body.scrollTop = body.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (focusNext.current === "button") buttonRef.current?.focus();
    if (focusNext.current === "input") inputRef.current?.focus();
    focusNext.current = null;
  });

  const { choose, show } = panel;
  const mode = panel.state.mode;
  // Closing where pinning isn't offered keeps a pinned choice: the person chose pinned for a wider window.
  const close = useCallback(() => {
    focusNext.current = "button";
    if (mode === "pinned" && windowWidth < PIN_FROM) show("closed");
    else choose("closed");
  }, [mode, windowWidth, choose, show]);

  // Esc closes a floating (or full-screen) panel, wherever focus is, unless something else took it first or an input
  // method is composing.
  const overPage = shownAs === "floating" || shownAs === "full-screen";
  useEffect(() => {
    if (!overPage) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      close();
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
          choose("floating");
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
      {shownAs === "pinned" && (
        <Divider width={panel.state.width} onResize={panel.resize} onCommit={panel.commit} />
      )}
      <div className="panel-header">
        <h2 id="ask-warden-title">Ask Warden</h2>
        {windowWidth >= PIN_FROM && (
          <button
            type="button"
            className="secondary"
            onClick={() => choose(shownAs === "pinned" ? "floating" : "pinned")}
          >
            {shownAs === "pinned" ? "Unpin" : "Pin"}
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Close Ask Warden" onClick={close}>
          ✕
        </button>
      </div>
      <div className="panel-body" ref={bodyRef}>
        {context.focus !== null && (
          <DetailCard
            key={context.focus.id}
            finding={context.focus}
            proposals={proposalsShown}
            clerkUsers={clerkUsers}
            role={props.role}
            userId={props.userId}
            getToken={getToken}
            candidates={context.candidates}
            productName={context.productName}
            onRetryProposals={proposals.retry}
            onClear={() => {
              focusNext.current = "input";
              context.clearFocus();
            }}
            onFindingChanged={context.onFindingChanged}
            onFindingGone={context.onFindingGone}
            onProposalsChanged={proposals.refresh}
            refreshMe={props.refreshMe}
            onSessionEnded={onSessionEnded}
          />
        )}
        {context.control !== null && (
          <ControlCard
            key={`${context.control.catalogue.id} ${context.control.control.ref}`}
            focus={context.control}
            team={team}
            getToken={getToken}
            userId={props.userId}
            role={props.role}
            refreshMe={props.refreshMe}
            clerkUsers={clerkUsers}
            onClear={() => {
              focusNext.current = "input";
              context.control?.clear();
            }}
            onSessionEnded={onSessionEnded}
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

/**
 * What "this" means to the chat: "Talking about: 3f9a1c2e · view: Findings, Open, High", the focused Finding's short
 * id in mono, or a focused Control's ref ("Talking about: 1.3.3 · view: Overview"); without a focus "Talking about:
 * view: Findings, Open".
 */
export function ContextLine({ context }: { context: PanelContext }) {
  return (
    <p className="context-line">
      Talking about:{" "}
      {context.focus !== null && (
        <>
          <code>{shortId(context.focus.id)}</code> ·{" "}
        </>
      )}
      {context.control !== null && (
        <>
          <code>{context.control.control.ref}</code> ·{" "}
        </>
      )}
      view: {context.view.join(", ")}
    </p>
  );
}

/**
 * The pinned panel's divider: a focusable separator. Dragging it resizes the panel, stored when the drag ends; ← widens
 * and → narrows it by 24px, each step stored. The width stays within 320 to 680px either way.
 */
function Divider({
  width,
  onResize,
  onCommit,
}: {
  width: number;
  onResize: (width: number) => void;
  onCommit: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  function onKeyDown(event: KeyboardEvent) {
    const step = { ArrowLeft: PANEL_WIDTH.step, ArrowRight: -PANEL_WIDTH.step }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    onResize(width + step);
    onCommit();
  }

  function endDrag() {
    if (!dragging) return;
    setDragging(false);
    onCommit();
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
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
