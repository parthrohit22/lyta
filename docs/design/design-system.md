# LYTA design system

LYTA's interface is a review workspace, not a chat screen. The review brief
owns the centre, source evidence sits right beside it, and chat is one switch
away. This document records the tokens, components, states and accessibility
rules the UI is built from, so new surfaces stay consistent.

Everything here is implemented in [`pages/styles.css`](../../pages/styles.css),
with no CSS framework. Tokens are CSS custom properties. Components are plain
class names styled from those tokens. When this document and the stylesheet
disagree, the stylesheet wins and this document is out of date.

## Principles

1. **Evidence before prose.** A claim is never shown without its evidence state
   (evidence-backed, inference, recommendation, insufficient evidence, or
   withdrawn), and selecting it shows the exact retrieved passage.
2. **The brief is the artifact.** Review output is a document to read, decide
   on, and export. Chat is a secondary tool.
3. **Quiet chrome, loud state.** Surfaces are neutral. Colour is reserved for
   meaning: readiness, classification, failure, focus.
4. **Every state is actionable.** Empty, loading, insufficient-evidence and
   failure states always say what to do next and offer the button to do it.
5. **Accessible by construction.** Contrast, focus and labels are checked by
   [`tests/unit/frontend-accessibility.test.ts`](../../tests/unit/frontend-accessibility.test.ts),
   so a token change that breaks them fails CI.

## Tokens

### Colour

Light values live on `:root, [data-theme="light"]`, and dark values on
`[data-theme="dark"]`. The theme follows the system unless the user picks one
in Settings.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f7f7f8` | `#0b0c0e` | Page and panel background |
| `--bg-subtle` | `#eef0f2` | `#111214` | Skeleton shimmer, quiet fills |
| `--surface` | `#ffffff` | `#141619` | Cards, inputs, finding rows |
| `--surface-subtle` | `#f0f1f3` | `#1a1d21` | Excerpts, hover, history entries |
| `--surface-raised` | `#ffffff` | `#1a1d21` | Modals, menus |
| `--border` | `#e5e7eb` | `#24272c` | Dividers and card outlines (decorative) |
| `--border-strong` | `#848995` | `#63686f` | Form-control boundaries and neutral chips (≥3:1) |
| `--text` | `#111827` | `#edeef0` | Body text, headings |
| `--text-muted` | `#5b6169` | `#9a9ea5` | Secondary text, labels, metadata |
| `--text-subtle` | `#686d7a` | `#7d818a` | Notes and helper text |
| `--accent` | `#2563eb` | `#5b9bff` | Primary actions, selection, focus ring, excerpt rule |
| `--accent-hover` | `#1d4ed8` | `#7dabff` | Primary hover |
| `--accent-subtle` | `#eff6ff` | `rgba(91,155,255,.14)` | Pressed toggle fill |
| `--accent-on` | `#ffffff` | `#0b0c0e` | Text on accent |
| `--success` | `#027a48` | `#34d399` | `ready`, evidence-backed |
| `--warning` | `#b54708` | `#fbbf24` | `needs evidence`, insufficient evidence, unsupported |
| `--danger` | `#b42318` | `#ff6a5c` | `blocked`, withdrawn, failures |
| `--danger-subtle` | `#fef2f1` | `rgba(255,106,92,.12)` | Failure callout fill |

**Meaning map** (keep it consistent across every surface):

| Meaning | Token | Where |
| --- | --- | --- |
| Ready / evidence-backed | `--success` | Verdict rule, classification chip, evidence-state rule |
| Needs evidence / insufficient / unsupported | `--warning` | Verdict rule, callouts, chip, evidence-state rule |
| Blocked / withdrawn / failed | `--danger` | Verdict rule, callouts, evidence-state rule |
| Selected / focused / primary | `--accent` | Selected finding, focus ring, pressed toggles, primary button |
| Inference / recommendation | `--border-strong` | Neutral chip; never green |
| Drift: new finding | `--warning` | Diff badge |
| Drift: resolved finding | `--success` | Diff badge (with "not proof of a fix" copy) |
| Drift: unchanged finding, source check | `--border-strong` | Diff badge, evidence-state rule |
| Drift: cited contradiction | `--danger` | Counterpart evidence-state rule |
| Drift: not found in the supplied evidence | `--warning` | Counterpart evidence-state rule; never presented as absent from the project |

### Contrast (WCAG 2.1 AA)

These pairs are enforced by the accessibility test. Text needs 4.5:1, and
component boundaries and focus indicators need 3:1.

| Pair | Minimum | Light | Dark |
| --- | --- | --- | --- |
| `text` on `bg` | 4.5:1 | 16.57:1 | 16.86:1 |
| `text` on `surface` | 4.5:1 | 17.74:1 | 15.61:1 |
| `text-muted` on `surface` | 4.5:1 | 6.25:1 | 6.74:1 |
| `text-muted` on `surface-subtle` | 4.5:1 | 5.53:1 | 6.29:1 |
| `text-subtle` on `bg` | 4.5:1 | 4.83:1 | 5.01:1 |
| `text-subtle` on `surface` | 4.5:1 | 5.18:1 | 4.64:1 |
| `accent-on` on `accent` | 4.5:1 | 5.17:1 | 7.06:1 |
| `accent` on `accent-subtle` | 4.5:1 | 4.75:1 | 5.9:1 |
| `success` on `surface` | 4.5:1 | 5.41:1 | 9.43:1 |
| `warning` on `surface` | 4.5:1 | 5.43:1 | 10.86:1 |
| `danger` on `surface` | 4.5:1 | 6.57:1 | 6.45:1 |
| `danger` on `danger-subtle` | 4.5:1 | 6.01:1 | 6.1:1 |
| `accent` on `bg` (focus ring) | 3:1 | 4.83:1 | 7.06:1 |
| `border-strong` on `surface` | 3:1 | 3.5:1 | 3.23:1 |
| `border-strong` on `bg` | 3:1 | 3.27:1 | 3.49:1 |

`--border` is decorative only and intentionally below 3:1. Anything a user
must find to operate, such as a text field, the composer or the chat search,
uses `--border-strong`.

### Typography

| Token | Value | Use |
| --- | --- | --- |
| `--font-sans` | Inter, then system UI | All UI text (self-hosted, `font-display: swap`) |
| `--font-mono` | `ui-monospace`, SF Mono, Menlo | File, version, and passage ids |
| `--text-xs` | 12px | Metadata, notes, chips |
| `--text-sm` | 13px | Panel body, findings, evidence |
| `--text-base` | 14px | Default body |
| `--text-md` | 15px | Claim titles, mobile topbar |
| `--text-lg` | 18px | Topbar and panel titles |
| `--text-xl` | 24px | Reserved for empty-state headlines |
| `--weight-normal` / `--weight-medium` / `--weight-semibold` | 400 / 500 / 600 | Body / labels / headings |

### Spacing, radius, elevation, motion

- **Spacing** follows a 4px scale: `--space-1` (4px) to `--space-10` (40px).
  Panels pad with `--space-5` to `--space-7`, cards with `--space-3`, and
  stacks gap at `--space-4`.
- **Radius:** `--radius-sm` 6px (controls, cards), `--radius-md` 10px (record
  form), `--radius-lg` 14px (modals, bottom sheets), `--radius-full`
  (pills).
- **Elevation:** `--shadow-sm`, `--shadow-md` (composer), `--shadow-lg` (sheets,
  drawers, modals). Shadows derive from `--shadow-rgb` so they work in both
  themes.
- **Motion:** `--ease-standard` with `--duration-micro` 120ms (hover, border),
  `--duration-panel` 200ms (sheets, sidebar), `--duration-modal` 280ms. All
  motion collapses under `prefers-reduced-motion: reduce`.

### Layout metrics and breakpoints

| Token | Value | Notes |
| --- | --- | --- |
| `--sidebar-width` / `--sidebar-rail-width` | 264px / 56px | Rail mode is ⌘B |
| `--topbar-height` | 56px | |
| `--evidence-width` | 380px (320px ≤1180px) | Evidence inspector beside the brief |
| `--board-width` | 360px (300px ≤1180px) | Output board beside chat |

| Width | Layout |
| --- | --- |
| > 1180px | Sidebar · centre · side panel (evidence or board), all in-flow |
| 981–1180px | Same three columns with narrower side panels. Nothing overlays the centre. (This used to be a floating board that covered chat.) |
| ≤ 980px | Sidebar becomes a drawer. Evidence and board become bottom sheets opened on demand, with a backdrop, a close button, Escape to close, a focus trap, and focus returned to the trigger. Closed sheets are `visibility:hidden`, so they leave the tab order and the accessibility tree. |
| ≤ 720px | Tighter padding. Evidence metadata stacks to one column. |

## Layout

```
┌──────────┬───────────────────────────────┬──────────────────────┐
│ Sidebar  │ Topbar: title · Review|Chat   │                      │
│          ├───────────────────────────────┤  Source evidence     │
│ Review a │ Review brief (centre)         │  (adjacent panel)    │
│ change   │  verdict · callouts           │  claim · state       │
│ Check    │  — or — Drift run             │  claim · counterpart │
│ drift    │   diff badges · sources       │  confidence · decide │
│ Records  │  findings (selectable claims) │  passages + ids      │
│ New chat │  tests · rollback · gaps …    │  retrieval context   │
│ Reviews  │                               │  challenge history   │
│ Records  │  — or — Start form            │  challenge · decide  │
│ Library  │  — or — Project records       │                      │
│ Chats    │                               │                      │
└──────────┴───────────────────────────────┴──────────────────────┘
```

`body.view-review` and `body.view-chat` select the view. Elements carry
`.review-only` or `.chat-only`. Review is the default view, and the choice
persists for the browser session.

## Components

| Component | Class / id | Notes |
| --- | --- | --- |
| Primary button | `.primary-button` | One per area. "Review a change", "Run review", "Save record", "Retry". |
| Secondary button | `.secondary-button` | All other actions. |
| Icon button | `.icon-button` | Always has `aria-label`; the SVG is `aria-hidden="true"`. |
| Segmented toggle | `.mode-selector` + `.mode-button[aria-pressed]` | View switch, response mode, record filter. |
| Status pill | `.status-pill` | Workspace badge. |
| Panel header | `.panel-header`, `.review-panel-header` | Eyebrow (`.meta-label`) + `h2` with `tabindex="-1"` so view changes can move focus to it. |
| Readiness verdict | `.review-verdict[data-readiness]` | Coloured left rule; label + rationale + sources. |
| Callout | `.review-callout[data-tone="warning" \| "danger"]` | Heading, explanation, and action buttons. Used for insufficient evidence, blocked, failure, unsupported claims. |
| Classification chip | `.review-chip` | Text label, never colour alone. |
| Finding row | `.review-finding-select[aria-pressed][data-classification][data-withdrawn]` | A button that selects the claim; `aria-controls="evidencePanel"`. |
| Evidence state | `.evidence-state[data-state]` | Label + plain-language description from `describeEvidenceState()`. |
| Evidence card | `.evidence-card` + `.evidence-meta` (`dl`) + `.evidence-excerpt` | Ref and file name, then file id, version, passage id, retrieval context, "also cited by". Ids use `--font-mono`. |
| Challenge history entry | `.review-history-entry[data-changed]` | Warning rule when the conclusion changed. |
| Record card | `.review-record` | Title, details, sources, time; "Open review" and two-step "Delete". |
| Sidebar list | `.sidebar-list-button[aria-current]` + `.sidebar-list-meta` | Reviews (readiness) and record counts by kind. |
| Form field | `.settings-field` (label wraps `span` + control) | Controls use `--border-strong` and switch to `--accent` on focus. |
| Loading | `.review-loading` + `.skeleton-lines` | Says what is happening; shimmer is decorative (`aria-hidden`). |
| Drift role picker | `.drift-role-row` (label wraps file name + `select[aria-label="Role for …"]`) | One role per file; the select uses `--border-strong`. A live summary counts files per role. |
| Drift summary | `.drift-summary` | Neutral left rule; summary, run number, model, policy. |
| Diff badge | `.drift-badge[data-diff="new" \| "unchanged" \| "resolved"]` | Text label on `--surface`, coloured by the meaning map. |
| Sources table | `.drift-table-wrap` + `.drift-sources-table` | `th[scope="col"]`; role, file, short version id (full id in the tooltip and on evidence cards), import time. Scrolls horizontally on narrow screens. |
| Counterpart state | `.evidence-state[data-state="cited" \| "not-found" \| "source-check"]` | Server-written description of what was searched. |

## States

| State | Review centre | Evidence panel | Records |
| --- | --- | --- | --- |
| Empty | Start form. With no documents, the source list explains why and offers "Add files to the library". | "Open a review from the sidebar, or run one…" | "No records yet…" and the create form |
| Loading | Title "Reviewing…", `aria-busy` on the panel, a skeleton, and a status line naming the source count | "Evidence appears here once the review is ready." | n/a (fast) |
| Insufficient evidence | `needs evidence` callout listing the missing evidence, with "Add files to the library" and "Edit and re-run" | Warning state, plus a "No retrieved passage supports this claim" callout with "Add files" and "Challenge it" | n/a |
| Blocked | Danger callout above the findings | n/a | n/a |
| Failure | Danger callout with the server message, "Nothing was saved", and **Retry** and **Edit the change** (inputs kept). Focus moves to Retry and an assertive announcement is made. | Status line plus an assertive announcement; the challenge button re-enables | Danger callout with Retry |
| Streaming (chat) | `#conversationSurface` is `role="log"` with `aria-busy` while streaming. `#liveAnnouncer` says "LYTA is responding." and "Response complete…"; failures go to `#liveAlert`. | | |

## Accessibility rules

- **Landmarks:** one `<main>`, a labelled sidebar `<aside>`, the review
  `<section>` and evidence `<aside>` labelled by their headings, and a skip
  link to `#workspaceGrid` (`tabindex="-1"`).
- **Names and labels:** every button has text or `aria-label`. Every input,
  textarea and select is wrapped in or tied to a `<label>`. Groups of toggles
  are `role="group"` with `aria-label`.
- **Focus:** the global `:focus-visible` ring is `2px solid var(--accent)`.
  Controls that drop their outline restyle on `:focus`, or in a wrapper on
  `:focus-within`. View changes move focus to the panel heading. Opening a sheet
  moves focus into it and closing returns it. Disabling the focused button never
  strands focus on `<body>`.
- **Announcements:** `LytaCore.announce()` writes to `#liveAnnouncer` (polite)
  or `#liveAlert` (assertive). Review completion, challenge outcomes, saved
  dispositions and records, evidence selection, and streaming start, finish and
  failure are all announced.
- **No colour-only meaning:** chips, verdicts and states always carry a text
  label.
- **No raw HTML:** review and drift UI build DOM with `textContent`. The test
  fails on `innerHTML`, `outerHTML` or `insertAdjacentHTML` in
  `pages/app-review.js` or `pages/app-drift.js`.

## Adding a component

1. Use existing tokens. Add a token only when a value repeats and has a
   meaning, and add it to both theme blocks.
2. If it carries text or a boundary, add the pair to `CONTRAST_PAIRS` in the
   accessibility test.
3. Give it every state in the table above that applies.
4. Update this document and, if it changes the review flow, the usability
   script in [`docs/demo/review-walkthrough.md`](../demo/review-walkthrough.md).
