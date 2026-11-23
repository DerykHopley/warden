# Design

How Warden looks and feels, and why. The tokens live in the frontend's main stylesheet (the walking skeleton names the file) under `:root`; this file names and explains them, and never holds a value the CSS doesn't. `scripts/design-lint.py` fails on a colour written outside a token.

**Design is part of every ticket, not a polish phase.** A ticket that changes the UI isn't done until it matches this file in light and dark, at phone width, and with reduced motion. Copy the checklist of each section it touches into the ticket's `Done when`.

Keep this file short enough to read before each UI ticket: a component gets a row and a checklist line here; its full spec lives in the ticket that builds it.

## Source and approval

- **Identity from:** the owner's own idea (started blank; the walking skeleton fills in identity and tokens)
- **Visual changes approved by:** the owner. A ticket that needs a visual choice this file doesn't settle goes to them: a static choice with a screenshot of each option, side by side; an interactive one (a handle, drag, resize, focus, hover, motion, keyboard) as a "try this" step in the owner preview or the live app.

## Identity

- **For:** {{who uses it, and where: on a phone between meetings, at a desk all day}}
- **Feels:** {{three words, e.g. calm, quick, plain}}
- **Not:** {{what it must not feel like, e.g. playful, corporate, dense}}

## Decisions

What was chosen, usually after a prototype, and why. A prototype's answer lands here, and the prototype is thrown away.

| Area | Decision | Why | Rejected |
|---|---|---|---|
| {{Overall look}} | {{…}} | {{…}} | {{the options not taken, so they aren't proposed again}} |

## Tokens

| Token | Value lives in | Use for | Not for |
|---|---|---|---|
| `--bg` | `:root` | page background | |
| `--fg` | `:root` | body text | |
| `--accent` | `:root` | the one main action per screen, links | decoration |
| {{…}} | | | |

Type, spacing, radius, shadow and motion get rows here once the CSS names them as tokens. Dark mode redefines the same tokens; it never adds new ones.

**Checklist:** every colour is a token (`scripts/design-lint.py` passes); each token used in light is defined in dark.

## Layout

| Width | What changes |
|---|---|
| under {{640}}px | {{one column; the main action stays in reach of a thumb}} |
| {{640–1024}}px | {{…}} |
| over {{1024}}px | {{…}} |

**Checklist:** each changed screen checked at {{the widths above}}; nothing scrolls sideways.

## Motion

| What moves | How | With reduced motion |
|---|---|---|
| {{cards on load}} | {{fade up, 200ms}} | {{appear without moving}} |

**Checklist:** the motion listed for a component ships with it; `prefers-reduced-motion` is honoured.

## Components

One row per component, with the states it must show. A state not listed here doesn't exist yet: adding one is a design choice.

| Component | States |
|---|---|
| {{Button}} | default, hover, focus, disabled, busy |

**Checklist:** every state in the row is reachable and looks as described, in light and dark.

## Accessibility floor

- Text contrast at least 4.5:1 (3:1 for large text and icons), in light and dark.
- A visible focus ring on everything that takes focus.
- Touch targets at least 44 by 44px.
- Colour is never the only cue: a label, icon or shape goes with it.

**Checklist:** contrast checked for each new colour pair, in both themes; keyboard reaches and leaves every new control.

## Approved screens

Screenshots of screens the approver signed off, one line each: what it shows and the date. Added only after approval.
