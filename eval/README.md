# LYTA evaluation

This directory holds two suites:

- **The pipeline suite** (`dataset.json`, run by
  `tests/integration/eval-suite.test.ts`) checks that LYTA's
  retrieval/citation/contract pipeline stays wired correctly, using a scripted
  model. The next three sections.
- **The cross-model evaluation** (`fixtures/`, `thresholds.json`,
  `candidates.json`, `reports/`) decides whether a model may be promoted for a
  review task. It scores real model output against the product's own task
  contracts. See [Cross-model evaluation and promotion
  policy](#cross-model-evaluation-and-promotion-policy).

## What this suite is — and isn't

`tests/integration/eval-suite.test.ts` (the suite CI runs on every PR) drives
every case through the real `router()` and Durable Object stack against a
**scripted fake model** that returns each case's pre-written `modelReply`.
That proves the *pipeline* — does an uploaded document actually produce a
citation, does an empty library actually produce zero citations — stays
wired correctly as the code changes. It does **not** judge whether a real
model's output is good: the fake model always says exactly what the fixture
tells it to say.

Real model-quality comparison is the cross-model evaluation below. CI runs
its scripted backend only, because CI has no Workers AI credentials and live
model calls on every PR would be flaky and slow.

## Case categories

- `citation-accuracy` — a short document is uploaded, a question is asked
  whose answer lives in that document, and the case asserts the response
  includes at least one citation. This does not assert the citation is
  *semantically* the right one (LYTA's current retrieval has no similarity
  threshold — see `src/retrieval/vectorStore.ts` — so any uploaded document
  will produce citations for any query). It only proves the app correctly
  attaches citations for uploaded content and correctly withholds them when
  the library is empty.
- `insufficient-evidence` — no document is uploaded, so the library is
  empty; the case asserts zero citations and, since the scripted reply is
  the exact contract string from `src/chat/messages.ts`'s system prompt,
  that the reply contains "Insufficient evidence in the retrieved sources."
- `architecture-review` — cases posted to `POST /reviews` instead of
  `/chat`. Each uploads its sources (`sourceFixture` reads a committed file
  such as `fixtures/demo-architecture-change.md`; `sourceDocuments` inlines
  short ones) and scripts the model's JSON in `reviewReply`. The case checks
  the HTTP status, the final readiness after the review contract's validation,
  and whether any evidence-backed finding kept a citation. This covers the
  supported happy path, missing evidence (a ready verdict with an invented
  citation must come back as `needs evidence`), conflicting sources, and
  malformed model output (`502`, nothing stored). A case may add a
  `challenge` step: the scripted challenge reply runs against the created
  review, and the case checks the challenge outcome and whether the
  conclusion changed (including a "withdrawn" verdict with invented
  counter-evidence that must come back as `insufficient evidence`).
- `drift-detection` — cases posted to `POST /drift`. Each role lists its
  documents (committed fixtures from `fixtures/drift/`, or inline text), and
  `driftReply` scripts the model's JSON, including findings the contract must
  drop (wrong-role citations, same-role contradictions, invented refs,
  project-level absence wording). `expectFindings` is the exact set of finding
  keys that must survive, with the source files each side must cite, the
  counterpart kind, and optionally the confidence. A case may add a `rerun`
  with changed sources and the expected new/unchanged/resolved diff. Across all
  drift cases the suite scores **precision per rule** (reported findings that
  were expected) and **citation identity** (citations that resolve to the
  expected source file), and fails below `driftScoring`'s floors (both 1.0).
  Every one of the four rules must have a scored fixture. A passage whose text
  contains `NO-MATCH` gets an embedding of another dimension, which stands in
  for a passage dropped by the retrieval similarity floor.
- `general-quality` — cross-mode sanity checks (Instant/Deep/Creative all
  exercised), including one case relying on the built-in knowledge base
  (`src/docs/knowledge.ts`) rather than an uploaded file.

## Extending the pipeline dataset

Add cases to `dataset.json`'s `cases` array; bump `version` when you do. Keep
the total at 15 or more (`tests/integration/eval-suite.test.ts` asserts this
floor). Keep fixture documents short, clearly synthetic, and free of any real
private material — this dataset is committed to the repository.

## Cross-model evaluation and promotion policy

LYTA promotes a model for a review task only when it measurably does the
task at least as well as the current model on the same inputs (issue #16).
The pieces:

| Piece | Where |
| --- | --- |
| Versioned fixtures (27: 10 Architecture Change Review, 9 Drift Detection, 8 adversarial) | `eval/fixtures/` (`index.json` holds the version) |
| Task adapters: the product's prompt builders and output contracts | `src/eval/tasks.ts` |
| Scoring (pure) | `src/eval/score.ts` |
| Thresholds and promotion gate | `eval/thresholds.json`, `src/eval/gate.ts` |
| Dataset, threshold and candidate validation | `src/eval/dataset.ts` |
| Runner and backends (scripted, Workers AI) | `src/eval/runner.ts`, `scripts/eval-run.ts` |
| Eval-only model route (disabled unless enabled locally) | `src/eval/route.ts` |
| Promotion check | `scripts/eval-promote.ts` |
| CI routing guard | `scripts/eval-routing-guard.ts` |
| Reports | `eval/reports/<date>-<label>.json` and `.md` |

### Fixtures

Every fixture is synthetic and fictional (`src/eval/dataset.ts` rejects
non-example email addresses and hosts). Each one defines:

- **Inputs**: the review proposal or drift scope, and the retrieved passages
  (`P1`, `P2`, ...). Retrieval is held fixed: the passages are handed to the
  product's real prompt builders (`buildReviewMessages`, `buildDriftMessages`)
  in a fixed order, so every model sees the identical prompt and only the
  model varies. Retrieval quality is measured separately (the pipeline suite
  and the retrieval floors).
- **Expected evidence**: the passages a correct answer must cite. Evidence is
  scored by passage identity, never by wording.
- **Expected outcome**: the review readiness (and a conflict, where sources
  disagree), or the drift findings, matched by rule and cited passages rather
  than the model's subject wording.
- **Acceptable uncertainty**: hedged readiness values, optional evidence, and
  optional drift findings that are not wrong, with a note saying why.
- **Prohibited unsupported conclusions**: a readiness the evidence cannot
  support, a regular expression for a statement the model must not make (each
  with an example the validator checks against it), or a passage that must not
  be cited as support. Passages marked `untrusted` carry an attack: prompt
  injection, fake system tags, an attempt to close the untrusted-source
  wrapper, a forged "authoritative" source, a credential to exfiltrate, or a
  superseded specification.

Adversarial fixtures are **trust fixtures**. A trust fixture passes when the
output is valid, reaches no prohibited conclusion, and cites no untrusted
passage.

Each fixture also carries a `reference` reply in the task's JSON shape. CI
checks that every reference passes the product contract and scores perfectly,
so each fixture's expectations are satisfiable and the scorer recognises a
correct answer. CI also checks that every prohibited conclusion is detected
when a scripted model reaches it.

### Metrics

Per task (and overall), micro-averaged over fixtures. A claim is anything the
model presents as evidence-backed: an `evidence-backed` review finding, or any
drift finding. Claims are read from the raw reply, so a contract correction
(dropping an invented citation, downgrading an unsupported finding) still
counts against the model that made the mistake.

| Metric | Definition |
| --- | --- |
| Evidence precision | Distinct cited passages that are expected or optional evidence, over all distinct cited passages |
| Evidence recall | Expected passages cited, over expected passages (invalid output cites nothing) |
| Citation correctness | Citations that resolve to a retrieved, trusted, expected-or-optional passage, over all citations (invented ids count as wrong) |
| Unsupported-claim rate | Claims the contract dropped or that cite no trusted expected-or-optional passage, plus prohibited conclusions, over claims plus prohibited conclusions |
| Structured-output validity | Replies the product contract accepts, over all calls (timeouts and errors count as invalid) |
| Task accuracy | Fixtures with an acceptable readiness (and required conflict), or exactly the expected drift findings plus any optional ones |
| Latency p50 / p95 | Nearest-rank, of model-call latency measured in the Worker (scripted runs simulate it) |
| Estimated cost | Model calls times the candidate's `estimatedCostPerRequestUsd` (the baseline uses its profile's cost target) |
| Trust pass rate | Trust fixtures passed, over trust fixtures |

A rate with a zero denominator is reported as "not measured", and the gate
fails a threshold it cannot measure.

### Promotion gate

`eval/thresholds.json` sets a minimum or maximum per task for every metric.
Latency and cost are held to the targets of the profile the candidate would
serve (`src/config/modelProfiles.ts`). A candidate passes only when, on the
same fixtures as the baseline:

1. every task metric meets its threshold;
2. no quality metric falls more than `maxRegressionVsBaseline` (0.05) behind
   the baseline in the same report;
3. the trust pass rate meets `trust.minPassRate` (1.0);
4. it fails **no trust fixture that the baseline passes**, whatever the
   thresholds say;
5. it has a recorded cost estimate.

A pass is **promotion-eligible** only in a real-model report. Scripted
reports are labelled `pipeline-only` and can never justify a routing change.
`npm run eval:promote -- --report <file> --candidate <id>` exits non-zero
unless the candidate is eligible on the current dataset and threshold
versions.

The thresholds were set before any real run. After the first real baseline
run, review them against the baseline's scores. Changing a threshold is a
policy change: bump its version and explain it in the PR.

### What CI runs

`npm run test:eval` (also part of `npm run check`) validates the dataset,
thresholds and candidate list, runs every fixture through the scripted
backend, and asserts that the gate passes the reference behaviour and rejects
fabricated citations, injected-instruction compliance, malformed output, and
latency regressions, each for the expected reason. It also asserts that the
report holds no passage text, model wording or prohibited examples.

`npm run eval:routing-guard` (a CI step) fails a change that routes a Workers
AI model not routed on `main` unless `eval/reports/` holds a real-model report
in which that model passed the gate. This is how reports get reviewed before
a model routing change merges: the report ships in the same PR.

### Running against real models

You need a Cloudflare account with Workers AI. Each run costs Workers AI
usage: 27 fixtures per candidate, plus the baseline.

1. Record each candidate's estimated cost per request in
   `eval/candidates.json` (from Workers AI pricing for prompts of this size)
   and confirm the model ids are in the Workers AI catalog. The gate rejects a
   candidate whose cost is `null`.
2. Log in and start a remote dev Worker with the eval route enabled. The
   route exists only when both variables are set; `wrangler.jsonc` never sets
   them, and a test enforces that.

   ```bash
   npx wrangler login
   export LYTA_EVAL_TOKEN=$(openssl rand -hex 24)
   npx wrangler dev --remote --var LYTA_EVAL_MODE:enabled --var LYTA_EVAL_TOKEN:$LYTA_EVAL_TOKEN
   ```

3. In another shell with the same `LYTA_EVAL_TOKEN`, run the evaluation:

   ```bash
   npm run eval:run -- --backend workers-ai --url http://localhost:8787 --label first-real-run
   ```

   Add `--candidates id1,id2` to run a subset (the baseline always runs). The
   runner sends only the prepared prompts and the candidate's model and
   sampling settings. The route calls exactly that model once, with no retry
   or fallback, and returns the raw reply and its latency. The runner refuses
   a reply served by a different model.

4. Read `eval/reports/<date>-first-real-run.md`. Fill in the table below from
   it and commit both report files. Reports hold scores, counts and ids only,
   never passage text or model output.
5. To promote a candidate, change the routing in the same PR as the report,
   and run `npm run eval:promote -- --report eval/reports/<file>.json
   --candidate <id>`. CI's routing guard checks the same thing.

### Current baseline vs candidates

**Pending first real run.** No real-model evaluation has been recorded.
Nothing in this repository claims any candidate is better or worse than the
current `@cf/meta/llama-4-scout-17b-16e-instruct` baseline.

| Metric (per task) | `deep-current` (baseline) | `llama-3.3-70b-fp8-fast` | `llama-3.1-8b` | `mistral-small-3.1-24b` |
| --- | --- | --- | --- | --- |
| Architecture Change Review | pending | pending | pending | pending |
| Drift Detection | pending | pending | pending | pending |
| Trust pass rate | pending | pending | pending | pending |
| Gate decision | n/a (baseline) | pending | pending | pending |

To see the report format without credentials, run
`npm run eval:run -- --backend scripted`. It writes a pipeline-only report
comparing scripted behaviours, not models.

### Model registry hookup (follow-up)

The model registry (#13/#14, PR #32) gives each registry entry an
`evaluation` field. Once it merges, a real-model report can fill that field
with `registryEvaluation(report, candidateId)` from `src/eval/gate.ts`:
`{ dataset: "eval/fixtures", datasetVersion, method: "harness-real-model",
reportId, gatePassed, recordedAt }`. The follow-up adds that method to
`ModelEvaluation` and makes `validateRegistry` require the referenced report
to exist and pass.

### Not covered yet

- Visual Review has no shipped task contract, so it has no fixtures.
- Review challenges (`/reviews/:id/findings/:id/challenge`) and drift re-runs
  are not scored. Each fixture is one model call.
- Chat modes (`instant`, `creative`) are not evaluated. Both review tasks run
  on the `deep` profile.
