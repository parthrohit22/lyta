# Architecture Change Review — demo and usability script

A 10-minute walkthrough of LYTA's flagship workflow: **upload → review →
inspect evidence → challenge → record → export**. Use it to demo the product,
or run it with a participant as a usability session (the "Observe" notes say
what to watch for). Sessions 7–10 at the end are the review-flow usability
passes for the workspace layout: at-a-glance comprehension, keyboard only,
mobile, and screen reader. The tokens and components they exercise are
documented in [`docs/design/design-system.md`](../design/design-system.md).
The [Drift check](#drift-check) section scripts the second workflow, drift
detection across a specification, a design, and code.

The workspace opens on **Review**. The brief is in the centre, **Source
evidence** is on the right, and reviews, records and files are in the sidebar.
**Chat** is one click away in the topbar's Review/Chat switch.

Source material: [`fixtures/demo-architecture-change.md`](../../fixtures/demo-architecture-change.md),
a short, fictional change proposal ("move API gateway sessions from an
in-process cache to single-AZ Redis"). It is safe public sample data.

Optional second source for the challenge step: save this as
`adr-014-session-storage.md` and upload it too.

```text
ADR-014 (accepted): auth-critical session state must live in a multi-AZ
datastore. Single-AZ stores are not permitted for session or token data.
```

## Before you start

- Open the [live demo](https://lyta.parthrohit-dev.workers.dev), or run it locally with `npm run dev`.
- Guest mode is fine. Sign in only if you want the review to survive the session.
- Model output varies run to run. The script describes what the product
  guarantees (classifications, citations, corrections), not exact wording.

## 1. Upload the sources (1 min)

1. In the sidebar, click **+** next to **Library** and add
   `demo-architecture-change.md` (and the ADR, if you made it).
2. Confirm both files appear under **Library**.

**Observe:** does the participant find the library without help? Do they
understand files are reusable across chats and reviews?

## 2. Run a review (2 min)

1. Click **Review a change** in the sidebar. The start form opens in the centre panel.
2. Fill in:
   - **Proposed change:** `Replace the API gateway's in-process LRU session cache with a single-AZ ElastiCache Redis instance behind the SessionStore interface.`
   - **Intended outcome:** `Sessions survive gateway restarts and are valid on every gateway instance.`
   - **Constraints:** `p99 gateway latency must stay within budget.`
3. Under **Evidence sources**, tick `demo-architecture-change.md` only. Leave the ADR unticked for now.
4. Click **Run review**. The centre panel shows "Reviewing…" with a progress
   line until the brief is ready.

**Expect:** a brief with a readiness verdict (`Ready`, `Needs evidence`, or
`Blocked`) and a rationale. Each finding has a classification chip. Below the
findings are required tests, observability, rollback, missing evidence,
assumptions, open questions, and next actions. If the server corrected the
model (for example, by downgrading a claim with no real citation to
`Inference`), the correction is listed under **Server-side corrections**.

**Observe:** can the participant say, in their own words, what the verdict
is and why? Do they notice the difference between `Evidence-backed` and
`Inference`?

## 3. Inspect the evidence (1 min)

1. Select an **Evidence-backed** finding in the brief. The **Source evidence**
   panel shows the claim, its evidence state, and each cited passage. For each
   passage it shows the excerpt, file name, file id, version, passage id, and
   retrieval context ("Retrieved for this review, rank 3 of 6 · policy …").
2. Select an **Inference** or **Recommendation** finding. The evidence state
   explains what that means, and a callout says no retrieved passage supports
   it, with "Add files" and "Challenge it" actions.

**Observe:** does the participant trust a finding more once they've seen the
excerpt? Do they try to click a finding without being prompted?

## 4. Challenge a conclusion (2 min)

1. Re-run the review with **both** sources ticked, or use the existing review
   if the ADR was already selected.
2. Select the finding about single-AZ Redis or the failure blast radius.
3. In the evidence panel under **Challenge this conclusion**, type
   `Does ADR-014 allow a single-AZ store?` in **Why do you doubt it?** and click
   **Search for counter-evidence**.

**Expect:** a status line saying the outcome (`Upheld`, `Revised`,
`Withdrawn`, or `Insufficient evidence`) and whether the conclusion changed.
The finding's **Challenge history** keeps the earlier version, and any new
passage shows "Retrieved by challenge F2-C1". A conclusion
only changes when the challenge cites retrieved counter-evidence. A challenge
that finds nothing is recorded as `Insufficient evidence`, and the finding
stays as it was.

**Observe:** does the participant understand that the earlier version is
kept, not overwritten? Does "insufficient evidence" read as a useful answer
or as a failure?

## 5. Record decisions (1 min)

1. With a finding selected, go to **Decide** in the evidence panel, choose
   **Save as → Decision**, and click **Accept**.
2. On another finding, choose **Save as → Risk** and click **Accept**. Mark a
   third finding **Reject**.
3. The sidebar's **Records** section now shows counts by kind. Click
   **Decisions**, or **Project records**.
4. In **New record**, add an assumption directly (for example, "Traffic stays
   at today's volume until multi-AZ ships") without going through a review.

**Expect:** records are grouped under **Decisions**, **Risks** and
**Assumptions**, with a filter by kind. Each shows its sources and, if it came
from a review, an **Open review** button that reopens the brief with that
finding selected. Rejected
findings are not saved. If you challenge an accepted finding and the
conclusion changes, its record is removed, because the decision applied to
the old conclusion.

**Observe:** can the participant find a saved decision again without
scrolling chat?

## 6. Export the brief (1 min)

1. Open the review from the sidebar's **Reviews** list and click **Export brief**.
2. Open the downloaded `lyta-review-<id>.md`.

**Expect:** the readiness verdict comes first. Each finding keeps its
classification, its disposition (with "saved as" kind), and links such as
`[E1](#evidence-e1)` to quoted source excerpts. Challenged findings include
their **Challenge history** with outcome, rationale, counter-evidence, and
before/after.

**Observe:** would the participant paste this into a PR or design doc as is?
What would they edit first?

## 7. At-a-glance comprehension (2 min)

Show the participant a completed review for **five seconds**, then hide the
screen.

Ask:
1. Is this change ready to ship?
2. How many claims are backed by evidence?
3. Where would you look to check one of them?

**Pass:** they recall the readiness verdict, roughly how many findings were
evidence-backed, and that evidence is "on the right" or "click a finding". If
they describe it as a chat, the layout has failed its main goal (#8).

## 8. Keyboard-only pass (3 min)

Unplug the mouse, or don't touch it.

1. Press **Tab** from page load. The first stop is **Skip to main content**.
   Activating it moves focus into the workspace.
2. Tab to **Review a change**, fill in the form, tick a source with **Space**,
   and submit with **Enter**.
3. When the brief loads, focus is on the "Review brief" heading. Tab to a
   finding and press **Enter**. Its passages appear in the evidence panel.
4. Tab into the evidence panel and run a challenge. When it finishes, focus
   moves to the evidence heading, so the updated passages are read next. Then
   accept the finding; focus stays on the **Accept** button.
5. Use the topbar **Review / Chat** switch to go to chat and back.

**Pass:** every step works without a mouse, and the focus ring is always
visible. Focus never disappears to the top of the page after an action.

## 9. Mobile pass (2 min)

Use a phone or a 375px-wide window.

1. Open the sidebar with the menu button and pick a review.
2. Select a finding. **Source evidence** opens as a bottom sheet over the
   brief.
3. Challenge or accept from the sheet, then close it with ✕ or **Escape**.
   Focus returns to the finding you selected.
4. Switch to **Chat**, send a message, and open the board from a response.
   The board opens as a sheet and does not cover the composer while closed.

**Pass:** every review and evidence action (select, inspect, challenge,
accept, export) works at phone width. No panel covers content it shouldn't.

## 10. Screen-reader pass (3 min)

Use VoiceOver (macOS/iOS) or NVDA (Windows).

1. Navigate by landmarks: sidebar, main, the review panel, and the source
   evidence panel are all announced with names.
2. Run a review. You should hear "Review ready: Needs evidence. 6 findings,
   4 evidence-backed…" (counts vary).
3. Select a finding. You should hear "Showing evidence for F2: 1 source
   passage."
4. Run a challenge. You should hear "F2 challenge: Revised. The conclusion
   changed."
5. In Chat, send a message. You should hear "LYTA is responding.", the
   response, and then "Response complete…".
6. Force a failure, for example by deleting a selected source in another tab
   and running the review. The alert "Review failed…" is read immediately, and
   focus lands on **Retry**.

**Pass:** every result above is announced without moving the cursor to find
it. Buttons, toggles and fields are read with meaningful names and states
("pressed", "busy").

## Drift check

A 6-minute script for the second workflow: **assign roles → run → inspect →
change a source → re-run → decide**. It uses the fictional **Lanternfish
Bookmarks** set in [`fixtures/drift/`](../../fixtures/drift/). Lanternfish is
invented and describes no real system:

| File | Role | What it says |
| --- | --- | --- |
| `lanternfish-prd.md` | Specification / PRD | REQ-1 CSV export, REQ-2 30-minute idle sessions, REQ-3 120 requests/minute, REQ-4 7-day trash |
| `lanternfish-architecture.md` | Architecture / design | Gateway (30 min TTL), SyncService, SearchIndexer, TrashService |
| `v1/lanternfish-code-export.md` | Implementation evidence | `SESSION_TTL_SECONDS = 86400`, `RATE_LIMIT_PER_MIN = 120`, no indexer, no export |
| `v2/lanternfish-code-export.md` | Implementation evidence (changed) | TTL fixed to 1800, indexer added, rate limit now 60 |

The files are deliberately compact: the model sees the first 260 characters of
each retrieved passage, so each file keeps its facts at the top.

### D1. Assign roles and run (2 min)

1. Upload the PRD, the architecture note, and the **v1** code export.
2. Click **Check drift** (under **Review a change**). Enter a scope such as
   "Lanternfish sessions, API limits, search, export, and trash."
3. Under **Sources and roles**, set each file's role. The summary line counts
   files per role. Leave all four rules checked and click **Run drift check**.

**Expect:** a run view with the summary, **Run 1**, three **New** badges, the
**Sources compared** table (role, file, short version id, import time), and
**Evidence coverage** per role. Typical findings: D1 CSV export, D2
SearchIndexer, D3 session TTL.

**Observe:** does the participant understand that a file can only have one
role? Do they read the coverage note before judging a "not found" finding?

### D2. Inspect a finding (1 min)

1. Select the D1 **CSV export** finding.
2. In **Source evidence**, read the claim and its PRD passage, then the
   **Counterpart**. It reads **Not found in the supplied evidence** and names the
   architecture and code files that were searched. Confidence is at most medium.
3. Select the D3 **session TTL** finding. Its counterpart is **Conflicting
   evidence**, with the code passage cited beside the PRD passage.

**Pass:** the participant can say that LYTA did not find CSV export in the
files it was given, not that the product lacks it.

### D3. Change a source and re-run (2 min)

1. Upload `v2/lanternfish-code-export.md`. It has the same name as v1.
2. Click **Re-run with changed sources**. The scope and rules are locked, so
   findings stay comparable. Both code exports are listed with their import
   times; set the **newest** to Implementation evidence and the older one to
   **Not compared**, then re-run.
3. Read **Changes since run 1**: 1 new (API rate limit), 1 unchanged (CSV
   export), 2 resolved (SearchIndexer, session TTL). **Resolved since the
   previous run** says that is not proof the drift was fixed.
4. Click **Run 1** under **Run history**. It reads back exactly as before.

**Variant (stale source):** re-run while keeping the **older** export selected.
A D4 finding reports that `lanternfish-code-export.md` has a newer version in
the library.

### D4. Decide and export (1 min)

1. On the API rate limit finding, type a note and choose **Accepted
   deviation**. The status line and screen reader announce that it is kept for
   later runs.
2. Re-run again with the same sources. The finding is **Unchanged** and still
   shows **Accepted deviation**.
3. Click **Export report**. The Markdown has the sources and versions, the
   coverage, the diff, every finding's claim, counterpart, evidence links,
   confidence, and disposition.

**Keyboard and screen reader:** each role picker is announced as "Role for
<file name>", finding rows are pressed toggles that control the evidence panel,
the disposition buttons are a named group, and a finished run is announced as
"Drift run N ready: … new, … unchanged, … resolved".

## Usability metrics to record

| Measure | Target |
| --- | --- |
| Time from upload to first brief | < 2 minutes |
| Participant can name the readiness verdict after 5 seconds (step 7) | Yes |
| Participant inspects at least one passage without prompting | Yes |
| Errors needing facilitator help | 0 |
| Keyboard-only and screen-reader passes complete without a workaround | Yes |

## Debrief questions (2 min)

1. What did LYTA decide about this change, and how confident are you in it?
2. Which finding would you challenge in a real review, and why?
3. What was missing from the brief that you would need before approving?
4. Where did you expect to find saved decisions?

## Facilitator checklist

- [ ] Review produced a verdict with a rationale
- [ ] At least one finding showed a source excerpt
- [ ] A challenge recorded an outcome and kept history
- [ ] A finding was saved as a decision or risk and appeared in Project records
- [ ] Export contained classifications, sources, challenge history, and the final verdict
- [ ] Keyboard-only, mobile, and screen-reader passes (8–10) completed
- [ ] Drift run 1 listed every source with its version and import time
- [ ] A "not found in the supplied evidence" finding named the files it searched
- [ ] The re-run showed new, unchanged, and resolved findings, and run 1 was unchanged
- [ ] A disposition set on one run was shown on the next
