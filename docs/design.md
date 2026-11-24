# Design

How Warden looks and feels, and why. The tokens live in the frontend's main stylesheet (the walking skeleton names the file) under `:root`; this file names and explains them, and never holds a value the CSS doesn't. `scripts/design-lint.py` fails on a colour written outside a token.

**Design is part of every ticket, not a polish phase.** A ticket that changes the UI isn't done until it matches this file in light and dark, at phone width, and with reduced motion. Copy the checklist of each section it touches into the ticket's `Done when`.

Keep this file short enough to read before each UI ticket: a component gets a row and a checklist line here; its full spec lives in the ticket that builds it.

## Source and approval

- **Identity from:** the owner's own idea, chosen by prototype on 2026-11-24 (direction E below). The prototype, all five directions, is on the branch `prototype/dashboard-directions` (`prototypes/dashboard/index.html`, open it in a browser).
- **Visual changes approved by:** the owner. A ticket that needs a visual choice this file doesn't settle goes to them: a static choice with a screenshot of each option, side by side; an interactive one (a handle, drag, resize, focus, hover, motion, keyboard) as a "try this" step in the owner preview or the live app.

## Identity

- **For:** the person responsible for a small software business's security, often its founder or a lead developer, at a desk in short visits between building: weekly, or when something is flagged. Later, an assessor reading the evidence.
- **Feels:** calm, exact, trustworthy.
- **Not:** alarmist, cluttered, surveillance-like. No red-everywhere threat dashboard; no enterprise density at Quick; nothing that makes a developer feel watched (a flag means "not covered", not "you did wrong").

## Decisions

| Area | Decision | Why | Rejected |
|---|---|---|---|
| Overall look | **E, "combined, friendlier"**: A's quiet document look (paper background, serif headings, one ink-blue accent), made about 15% friendlier (rounded corners, soft shadows, tinted severity pills, plain-language lines) | Calm and formal enough for an audit, warm enough for a founder at Quick | **A Quiet ledger** (clean, but too bare); **B Calm console** (dense dark developer tool; kept its detail panel); **C Friendly guide** (too playful; kept its cards); **D Combined** (right structure, a little cold) |
| Main screen | **Findings**: a one-line summary, the top 5 as cards, then the full table with filters | A developer's question is "what do I fix?"; cards make the first five obvious in a short visit | Dashboard of charts; cards for everything |
| The journey | Quick → Standard → Audit-ready lives on **Overview**, with the trend and "Are we ready for the audit?". Findings shows the Level as one header line linking to it | The journey means a lot to a manager or security officer and nothing to a developer | A journey strip on every page (C) |
| Side panel | **One panel, "Ask Warden"**: closed (a button), floating, or pinned beside the page with a draggable divider. The chat fills its height; a **detail card** for the focused item (a Finding, or a Control on Overview) slots in above the chat, in its own tint, with its own ✕ | Deep-dive and conversation share one context; pinning suits a developer digging in, closed suits a glance. Follows Patch's bubble-to-pinned chat | Always-open panel (B, D: empty space on Overview); separate detail drawer and chat bubble |
| Chat context | The chat gets the page's view (page, filters) and its focus (the item in the detail card) with every message. A **context line** above the input says what "this" means: "Talking about: F-103 · view: Findings, Open" | No guessing what the chat refers to; view changes act at once, data changes come back as a Proposal | Chat with no page context |
| Roles | **Everyone in a Team sees every page.** A person's role only picks the page that opens first: Member → Findings; Lead and Admin → Overview | In a small business, hiding Findings gets in the way; tailored pages can come later | Role-tailored dashboards (for now) |
| Width | Content grows to about 1480px, centred; with the panel pinned, the page uses everything left of it | Widescreen screens shouldn't waste half the width | Fixed 1040px column |

## Tokens

Each token is defined in light and dark. Starting values are in the prototype's `[data-variant="E"]` blocks; the walking skeleton copies them into the stylesheet.

**The stylesheet:** `dashboard/src/styles.css` (light under `:root`, dark under `@media (prefers-color-scheme: dark)`).

| Token | Value lives in | Use for | Not for |
|---|---|---|---|
| `--bg` | `:root` | page background (paper) | |
| `--surface` | `:root` | cards, panel, table background | |
| `--fg` | `:root` | body text | |
| `--muted` | `:root` | secondary text, metadata, labels | body text |
| `--line` | `:root` | borders, dividers, table rules | |
| `--chip` | `:root` | selected row, user chat message, quiet fills | |
| `--accent` | `:root` | the one main action per screen, links, selected card border, pinned state | decoration, severity |
| `--accent-fg` | `:root` | text on `--accent` | |
| `--sev-crit`, `--sev-high`, `--sev-med`, `--sev-low` | `:root` | severity text, always with its word | backgrounds, anything not a severity |
| `--tint-crit`, `--tint-high`, `--tint-med`, `--tint-low` | `:root` | severity pill backgrounds, behind the matching `--sev-*` | rows, cards |
| `--focus-bg`, `--focus-line` | `:root` | the detail card: the item the chat is talking about | anything else |
| `--ok` | `:root` | Fixed, confirmed | |
| `--font-head` | `:root` | page and section headings (serif) | body, tables |
| `--font-body` | `:root` | everything else (sans) | |
| `--font-mono` | `:root` | Rule ids, Finding ids, evidence, the view path | prose |
| `--radius` | `:root` | cards, panel, buttons, inputs (10px; pills are fully round) | |
| `--shadow` | `:root` | cards and the panel only | text, tables |

Dark mode redefines the same tokens; it never adds new ones.

**Checklist:** every colour is a token (`scripts/design-lint.py` passes); each token used in light is defined in dark.

## Layout

| Width | What changes |
|---|---|
| under 640px | One column. The top 5 stack. The table shows severity, title and status only. The panel opens full screen; "pinned" means full screen |
| 640–1100px | Cards wrap to two or three per row. The panel opens floating over the page; pinning is offered from 1100px |
| 1100–1600px | Five cards in a row. The panel starts closed and can be pinned beside the page (320–680px wide, default 400px) |
| over 1600px (widescreen) | The panel starts **pinned**, so the spare width holds the detail card and chat instead of empty margin. Content never grows past about 1480px: longer table rows and lines read badly |

Warden runs both in a small desktop-app window and on a wide browser screen, so the panel's starting state follows the window width. A person's own choice (pinned, unpinned, closed) is remembered and wins over the default.

**Checklist:** each changed screen checked at 390px, 1024px and 1600px; nothing scrolls sideways.

## Motion

| What moves | How | With reduced motion |
|---|---|---|
| Panel opening (floating) | slides in from the right, 150ms | appears without moving |
| Detail card appearing | fades in, 120ms | appears |
| Filter or view change | none: the table swaps at once | none |

**Checklist:** the motion listed for a component ships with it; `prefers-reduced-motion` is honoured.

## Components

| Component | States |
|---|---|
| Button | default, hover, focus, disabled, busy |
| App header | Team name and Role (a word in a pill) shown; waiting ("…" for both, until the server answers for the active Team); no Team (Warden and Sign out only, the switcher moves into the page) |
| Page links | default, hover, focus, current (accent, bold, underlined) |
| People table row | default; under 640px name and Role only; a message under the Role after a refused change (words, `role="alert"`) |
| Role picker | default, hover, focus, disabled, busy; an Admin's only: everyone else sees the Role as a word |
| Severity pill | Critical, High, Medium, Low (word always shown) |
| Finding card (top 5) | default, hover, focus, selected (accent border) |
| Findings table row | default, hover, focus, selected; Unconfirmed fix flag |
| Filter tabs (status, severity, module) | default, selected, focus; the view path shown at the right |
| Level header line | current Level, link to Overview |
| Journey card (Overview) | done, current (accent border), not started; progress bar and next step |
| Audit Control row (Overview) | default, hover, selected |
| Ask Warden panel | closed (button with message count), floating, pinned; divider: default, hover, focus, dragging |
| Detail card | Finding, Control, cleared (✕) |
| Context line | with focus ("F-103 · view …"), without focus ("view …") |
| Chat message | user, Warden, Proposal (approve or reject), streaming |

**Checklist:** every state in the row is reachable and looks as described, in light and dark.

## Accessibility floor

- Text contrast at least 4.5:1 (3:1 for large text and icons), in light and dark. Checked for E on 2026-11-24: every text pair passes; the two severity colours that failed in the prototype (light High on its tint, Low in both themes) were darkened before recording.
- A visible focus ring on everything that takes focus.
- Touch targets at least 44 by 44px.
- Colour is never the only cue: a label, icon or shape goes with it. Severity always shows its word.
- The divider is a focusable separator: ← and → resize it in 24px steps. Esc closes a floating panel.

**Checklist:** contrast checked for each new colour pair, in both themes; keyboard reaches and leaves every new control.

## Approved screens

Screenshots of screens the approver signed off, one line each: what it shows and the date. Added only after approval.
