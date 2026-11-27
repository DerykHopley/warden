// The parts a detail card's decision forms share (docs/design.md: Detail card's Decisions, Control detail card): the
// secondary button that opens a form, the form's frame (its refusal line, its submit and Cancel, Esc to cancel), and
// where focus goes once the card's next render lands.
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

/**
 * A secondary button that opens its form; Cancel puts focus back on it, found by `data-opener`. It waits (disabled)
 * while any of the card's calls runs.
 */
export function OpenerButton(props: {
  /** Its key: what `focusInCard` finds it by. */
  opener: string;
  label: string;
  waiting: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="secondary"
      data-opener={props.opener}
      disabled={props.waiting}
      onClick={props.onOpen}
    >
      {props.label}
    </button>
  );
}

/**
 * A decision form's frame around its fields: the refusal line, then its submit, disabled until it's ready and busy
 * while its call runs, and Cancel. Esc anywhere in it cancels (focus back on its opener); with `holdWhileBusy`, Cancel
 * waits (disabled) and Esc does nothing while the call runs, so the form, and what was typed, stays for its answer.
 */
export function DecisionForm(props: {
  name: string;
  submitLabel: string;
  ready: boolean;
  busy: boolean;
  holdWhileBusy?: boolean;
  refusal: string | null;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const held = props.busy && props.holdWhileBusy === true;
  // Marked handled, so a floating panel's Esc, which listens on the document, leaves the panel open.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!held) props.onCancel();
  }
  return (
    // noValidate: the form's own refusal line says what's wrong, never the browser's bubble (a Reopens on day under
    // its `min`, say). `min` stays, so the picker greys out the days before it.
    <form
      className="decision-form"
      aria-label={props.name}
      noValidate
      onSubmit={props.onSubmit}
      onKeyDown={onKeyDown}
    >
      {props.children}
      {props.refusal !== null && (
        <p className="card-line refused" role="alert">
          {props.refusal}
        </p>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="primary"
          disabled={!props.ready || props.busy}
          aria-busy={props.busy ? "true" : undefined}
        >
          {props.submitLabel}
        </button>
        <button type="button" className="secondary" disabled={held} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * What takes focus once a card's next render lands: its line ("line"), the open form's first field ("field"), or the
 * opener with that key.
 */
export type FocusTarget = "line" | "field" | (string & {});

/** Focuses `target` in `card`; `line` finds the card's own line. Nothing found, nothing moves. */
export function focusInCard(
  card: HTMLElement,
  target: FocusTarget,
  line: (card: HTMLElement) => HTMLElement | null,
): void {
  const element =
    target === "line"
      ? line(card)
      : target === "field"
        ? card.querySelector<HTMLElement>(".decision-form input, .decision-form textarea")
        : // Matched by value, not an attribute selector, so a key holding any id needs no escaping.
          [...card.querySelectorAll<HTMLElement>("[data-opener]")].find(
            (el) => el.dataset.opener === target,
          );
  element?.focus();
}
