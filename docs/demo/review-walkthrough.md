# Architecture Change Review — demo and usability script

A 10-minute walkthrough of LYTA's flagship workflow: **upload → review →
inspect evidence → challenge → record → export**. Use it to demo the product,
or run it with a participant as a usability session (the "Observe" notes say
what to watch for).

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

1. Click **Review a change** in the sidebar.
2. Fill in:
   - **Proposed change:** `Replace the API gateway's in-process LRU session cache with a single-AZ ElastiCache Redis instance behind the SessionStore interface.`
   - **Intended outcome:** `Sessions survive gateway restarts and are valid on every gateway instance.`
   - **Constraints:** `p99 gateway latency must stay within budget.`
3. Under **Evidence sources**, tick `demo-architecture-change.md` only. Leave the ADR unticked for now.
4. Click **Run review**.

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

1. Click an **Evidence-backed** finding's title.
2. Read the quoted excerpt and its caption (`E1 · demo-architecture-change.md`).
3. Click an **Inference** or **Recommendation** finding and note that it either
   has no excerpt or says no retrieved source supports it.

**Observe:** does the participant trust a finding more once they've seen the
excerpt? Do they try to click a finding without being prompted?

## 4. Challenge a conclusion (2 min)

1. Re-run the review with **both** sources ticked, or use the existing review
   if the ADR was already selected.
2. Open the finding about single-AZ Redis or the failure blast radius.
3. In **Why do you doubt this?**, type `Does ADR-014 allow a single-AZ store?`
   and click **Challenge this conclusion**.

**Expect:** a status line saying the outcome (`Upheld`, `Revised`,
`Withdrawn`, or `Insufficient evidence`) and whether the conclusion changed.
The finding's **Challenge history** keeps the earlier version. A conclusion
only changes when the challenge cites retrieved counter-evidence. A challenge
that finds nothing is recorded as `Insufficient evidence`, and the finding
stays as it was.

**Observe:** does the participant understand that the earlier version is
kept, not overwritten? Does "insufficient evidence" read as a useful answer
or as a failure?

## 5. Record decisions (1 min)

1. On one finding, choose **Save as → Decision** and click **Accept**.
2. On another, choose **Save as → Risk** and click **Accept**. Mark a third
   finding **Reject**.
3. Click **Review a change → View project records**, or **Project records** in
   the sidebar.

**Expect:** the accepted findings are grouped under **Decisions** and
**Risks**. Each shows its sources and an **Open review** button. Rejected
findings are not saved. If you challenge an accepted finding and the
conclusion changes, its record is removed, because the decision applied to
the old conclusion.

**Observe:** can the participant find a saved decision again without
scrolling chat?

## 6. Export the brief (1 min)

1. Open the review again and click **Export brief**.
2. Open the downloaded `lyta-review-<id>.md`.

**Expect:** the readiness verdict comes first. Each finding keeps its
classification, its disposition (with "saved as" kind), and links such as
`[E1](#evidence-e1)` to quoted source excerpts. Challenged findings include
their **Challenge history** with outcome, rationale, counter-evidence, and
before/after.

**Observe:** would the participant paste this into a PR or design doc as is?
What would they edit first?

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
