// The Ask Warden panel's rules (docs/design.md: Side panel, Chat context, Layout): its starting state by window width
// and a person's stored choice, how each state shows at a width, and what the context line says.
import type { Finding, FindingsView } from "@warden/contracts";
import { MODULE_WORDS, SEVERITY_WORDS, STATUS_WORDS } from "./finding-words.ts";
import { shortId } from "./findings.ts";

/** A person's choice: closed (a button), floating over the page, or pinned beside it. */
export type PanelMode = "closed" | "floating" | "pinned";
const MODES: readonly PanelMode[] = ["closed", "floating", "pinned"];

/** The panel's state: its mode, and its width when pinned or floating. */
export type PanelState = { mode: PanelMode; width: number };

/** The pinned panel's width limits and default, and the divider's keyboard step, in pixels. */
export const PANEL_WIDTH = { min: 320, max: 680, default: 400, step: 24 } as const;

/** Under this window width an open panel fills the screen. */
const FULL_SCREEN_UNDER = 640;
/** From this window width the panel can be pinned. */
export const PIN_FROM = 1100;
/** Over this window width the panel starts pinned. */
const PINNED_OVER = 1600;

/** Where the person's choice is kept in `localStorage`. */
export const PANEL_STORAGE_KEY = "warden.askWardenPanel";

export const clampWidth = (width: number) =>
  Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, Math.round(width)));

/** Whether `value` is a choice `startingPanel` takes: a known mode, and a whole width within the limits. */
function isPanelState(value: unknown): value is PanelState {
  if (typeof value !== "object" || value === null) return false;
  const { mode, width } = value as Record<string, unknown>;
  return (
    MODES.includes(mode as PanelMode) &&
    typeof width === "number" &&
    Number.isInteger(width) &&
    width >= PANEL_WIDTH.min &&
    width <= PANEL_WIDTH.max
  );
}

/**
 * The panel's state on load: the person's stored choice when it parses, else the width default (pinned over 1600px,
 * closed otherwise, at the default width). A stored value that doesn't parse, or a width outside the limits, is ignored.
 */
export function startingPanel(windowWidth: number, stored: string | null): PanelState {
  if (stored !== null) {
    try {
      const value: unknown = JSON.parse(stored);
      if (isPanelState(value)) return { mode: value.mode, width: value.width };
    } catch {
      // Not JSON: the width default.
    }
  }
  return {
    mode: windowWidth > PINNED_OVER ? "pinned" : "closed",
    width: PANEL_WIDTH.default,
  };
}

/** How a mode shows at a window width: an open panel fills a phone's screen, and floats where pinning isn't offered. */
export function panelShownAs(
  mode: PanelMode,
  windowWidth: number,
): "closed" | "floating" | "pinned" | "full-screen" {
  if (mode === "closed") return "closed";
  if (windowWidth < FULL_SCREEN_UNDER) return "full-screen";
  if (mode === "pinned" && windowWidth < PIN_FROM) return "floating";
  return mode;
}

/** What a page is talking about: the panel's context line and detail card read it. */
export type PanelContext = {
  /** The view's words: the page, then each filter that isn't "all". */
  view: string[];
  /** The Finding the page has focused, or null. */
  focus: Finding | null;
  /** Clears the page's focus: the detail card's ✕. */
  clearFocus: () => void;
};

/** What the shell gives a page to talk to the panel. Both functions keep their identity across renders. */
export type PagePanel = {
  /** Tells the panel what the page is talking about. */
  setContext: (context: PanelContext) => void;
  /** Opens the panel floating when it's closed; an open or pinned panel stays as it is. */
  open: () => void;
};

/** The Findings page's view words: "Findings", then each filter that isn't "all", as status, severity, module. */
export function findingsViewWords(view: Pick<FindingsView, "status" | "severity" | "module">) {
  return [
    "Findings",
    ...(view.status === "all" ? [] : [STATUS_WORDS[view.status]]),
    ...(view.severity === "all" ? [] : [SEVERITY_WORDS[view.severity]]),
    ...(view.module === "all" ? [] : [MODULE_WORDS[view.module]]),
  ];
}

/** "Talking about: 3f9a1c2e · view: Findings, Open, High", or without a focus "Talking about: view: Findings, Open". */
export function contextLine(context: PanelContext): string {
  const focus = context.focus === null ? "" : `${shortId(context.focus.id)} · `;
  return `Talking about: ${focus}view: ${context.view.join(", ")}`;
}

/** The closed panel's button: "Ask Warden", then "· 2 messages" once the person has sent any. */
export function askWardenLabel(sent: number): string {
  if (sent === 0) return "Ask Warden";
  return `Ask Warden · ${sent} ${sent === 1 ? "message" : "messages"}`;
}
