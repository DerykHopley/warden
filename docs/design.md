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
| App header | Team name and Role (a word in a pill) shown; waiting ("…" for both, until the server answers for the active Team); no Team (Warden and Sign out only, the switcher moves into the page). On a phone it wraps: the page links wrap onto a second line when they don't fit (at 390px the fourth does), each still a 44px target, so nothing scrolls sideways whatever the fallback font |
| Page links | default, hover, focus, current (accent, bold, underlined) |
| People table row | default; under 640px name and Role only; a message under the Role after a refused change (words, `role="alert"`) |
| Role picker | default, hover, focus, disabled, busy; an Admin's only: everyone else sees the Role as a word |
| Clerk-load notice | "Loading…" while Clerk loads; after 10 s, or at once when Clerk reports it failed to load, "Sign-in couldn't load. An ad blocker or a lost connection can stop it." with a Try again button that reloads the page |
| Summary line (Findings) | one line in the heading font: "7 open Findings, 2 Critical" ("1 open Finding"; no Critical part when none is); "Nothing open." with none open; "No Findings yet: they appear after the first Scan." with none at all |
| Findings page waiting and empty states | waiting ("Loading Findings…"); not answering (with Retry), too many attempts, no Team, Team not opened, as on People; none open (no "Start here"); no Findings at all (summary line only); an empty view (one row, "Nothing matches this view."); a decision on a Finding the Team no longer has ("This Finding is no longer in your Team.", a notice above the summary, until another Finding is selected) |
| Severity pill | Critical, High, Medium, Low (word always shown) |
| Finding card (top 5) | default, hover, focus, selected (accent border) |
| Findings table row | default, hover, focus, selected; Unconfirmed fix flag |
| Filter tabs (status, severity, module) | default, selected, focus; the view path shown at the right |
| Level header line | one line in `--muted` above the Findings summary: "Level: Quick · see the journey", "see the journey" a link to Overview (accent, a 44px-high target, the focus ring). The Level comes with `/api/me`'s answer, so the line shows with the page, and the page makes no call of its own for it |
| Journey card (Overview) | Quick, Standard, Audit-ready in order, each with its word, what it adds ("Repo scan and top fixes", "Agent hook and the Judge", "Evidence for an audit"), a progress bar (`role="progressbar"`, its value in `aria-valuenow`) and its state in words: done (a full bar, "Done"), current (accent border, "Current"), not started (an empty bar, "Not started"). Quick's next step: before the first Scan an empty bar and "Next: the first Scan"; after it a full bar, "Last Scan: <date>" and "Next: Standard adds the agent hook and the Judge". Three in a row from a 640px column, stacked below it |
| Trend line (Overview) | one line in the heading font: "Open Findings went from 0 to 7 in 30 days; fix rate 9%." when the count changed; "Open Findings stayed at 7 over 30 days; fix rate 9%." when it didn't; "Open Findings stayed at 0 over 30 days." with nothing to fix (no rate); "No Findings yet: the trend starts after the first Scan." when the Team has no Finding at all and no Scan. The rate is fixed of counted, rounded down to a whole percent (never 100% before everything is fixed) and at least 1% once anything is |
| Overview waiting and empty states | the heading "Overview" always; waiting ("Loading Overview…"); not answering (with Retry), too many attempts, no Team, Team not opened, as on Findings; "Are we ready for the audit?" (h2) with one line, "Warden can answer this at Audit-ready, once Vouch checks your Controls.", and no rows until Vouch |
| Audit Control row (Overview) | default, hover, selected |
| Product entry (Products) | a card on `--surface`: the Product's name (h2, heading font), then its Repo URLs and its dependencies side by side from a 640px column, stacked below it. Repo URL: a link (accent, a 44px target, the focus ring) that opens in a new tab, or "No Repo URLs." (muted). Dependency row: the framework's name (its id while the names can't load, or for a framework Warden doesn't know), the version in mono or "version unknown" (muted), how it's used in words ("Self-hosted", "Library", "Through another package", "Hosted"), and "internet-facing" in a pill when it is; or "No Dependencies." (muted). Under 640px a row's parts stack. Read-only: no controls on the page |
| Products page waiting and empty states | the heading "Products" always; waiting ("Loading Products…", until the Products answer, and with a list, until the framework names answer or 3 seconds pass, whichever is first); not answering (with Retry), too many attempts, no Team, Team not opened, as on People, each shown as soon as it answers; no Products ("No Products yet.", and for a Member "A Lead or an Admin adds them.") |
| Ask Warden panel | closed (a button, "Ask Warden", then "· 2 messages" once the person has sent any), floating (slides in from the right; Esc closes it and focus returns to the button), pinned (beside the page, the window's full height); under 640px open means full screen; Pin is offered from 1100px; a ✕ closes it. Divider (pinned only, a focusable separator): default (a short grip on the edge), hover (the handle fills with `--chip`), focus (the ring), dragging (an `--accent` bar down the edge) |
| Detail card | Finding (short id, module and Rule id in mono; title; Severity pill, Status, Unconfirmed fix with its candidate count; Asset, Location, evidence summary, a secret's type, path, line and mask, Control, an acceptance's reason as "Accepted because" and its until as "Reopens on"), then its pending Proposals (decision, reason, "reopens on" with the date on an accept, as "Accept, reopens on Jan 15, 2027", who asked and when, "Asked by you" on the signed-in person's own; a stale one adds "The Finding has changed since this was asked."), or "Couldn't load Proposals" with Retry; Control (Overview, later); cleared (✕: the focus leaves the URL, the panel stays). **Decisions** (story 4), under the fields, one row of secondary Buttons by Status: a Lead's or Admin's (Open: Accept, Mark False positive; Accepted: Renew acceptance, Mark False positive, Reopen; False positive: Reopen; Fixed with an Unconfirmed fix: Confirm fix, Mark moved; Fixed without one, or merged: none), or a Member's (Open or Accepted: Propose accepting, Propose False positive; else none); none until the Role loads. A Finding takes one pending Proposal at a time: while it has one, a Member's Propose buttons give way to "Waiting for a Lead or Admin to decide." (in the Done line's box, not bold, no role, takes no focus); neither shows while the Proposals load, and the buttons show if they couldn't load (the server still refuses a second). A Lead's or Admin's buttons don't change. A button opens its form in place of the row, one form at a time: Reason (a text area, at most 2,000 characters); on an accept (Accept, Renew acceptance, Propose accepting) the text area reads "Why accept this risk?" instead (Renew acceptance opens with the current acceptance reason in it, to edit; every other form opens empty), and a date follows it, "Reopens on" (earliest tomorrow), with the hint "Warden reopens it on this date so the Team looks again." under it (muted, at `.form-note`'s size, the date's `aria-describedby`); the candidates (radios, each its short id, title and Location, a 44px-high row) on Mark moved, or "The candidate isn't in this view's list. Reload to see it."; a primary submit named for the decision ("Propose" for a Member), disabled until ready and busy while it runs, and Cancel (focus back on the opener). Done line: one line on `--surface` with a `--focus-line` border (`role="status"`, takes focus), such as "Accepted. Reopens on Jan 15, 2099." or "Proposal sent. A Lead or an Admin decides.". Refusal line: the same box in bold (`role="alert"`), in the form, kept with the typed reason; a 409 in the server's words when it gives them; in the card when the form has closed (focus moves to it, or to the first button left). While a call runs, every other button that opens a form, and Approve, waits (disabled); a finished call closes only its own form. On each pending Proposal, a Lead's Approve (primary) and Reject (secondary; Reject only on a stale one); Reject opens a Reason form in place of the buttons. Mark moved offers only the candidates the server would merge: Open, not merged, with the Finding's module, Rule and Asset |
| Context line | with focus ("Talking about: 3f9a1c2e · view: Findings, Open, High", the short id in mono), without focus ("Talking about: view: Findings, Open"; on People "Talking about: view: People"; on Overview "Talking about: view: Overview"; on Products "Talking about: view: Products") |
| Chat message | user (on `--chip`, at the right), Warden (on `--bg`, at the left; until the agent spec, its one reply is the placeholder "Warden's chat isn't connected yet."), Proposal (approve or reject), streaming. The chat keeps its newest message in view: a sent message and Warden's reply each jump the panel's body to the newest message's bottom edge (no smooth scroll, so reduced motion needs nothing of its own), with or without a detail card; opening the card or deciding in it doesn't scroll the chat |

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
