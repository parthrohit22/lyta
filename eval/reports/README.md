# Evaluation reports

`npm run eval:run` writes `<date>-<label>.json` and `<date>-<label>.md` here.
Commit a report with any PR whose routing change it supports. CI's routing
guard reads every `*.json` file in this directory.

A report holds scores, counts and ids only: no passage text, no prompts, no
model output. Its fields:

- `reportId`, `label`, `createdAt`
- `backend` is `scripted` or `workers-ai`. `evidenceGrade` is `pipeline-only`
  or `real-model`; only `real-model` can make a candidate promotion-eligible.
- `datasetVersion`, `thresholdsVersion`, `candidatesVersion`, and `contracts`
  (the review and drift contract versions every candidate ran under).
- `fixtureIds` and `baselineId`.
- `results[]`, one per candidate, baseline first. Each holds the candidate's
  model, sampling and cost estimate; metrics per task and overall; trust pass
  rate and failed trust fixtures; and per-fixture scores (passage ids cited,
  counts, prohibited-conclusion ids, latency, validity).
- `gate[]`, one per candidate: `decision`, `promotionEligible`, `reasons`,
  `trustRegressions`, and every individual check.

No real-model report has been recorded yet. See
[`../README.md`](../README.md#running-against-real-models).
