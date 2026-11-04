# LYTA evaluation suite

`dataset.json` is a versioned set of technical-review cases used to catch
regressions in LYTA's retrieval/citation/insufficient-evidence pipeline, and
as the fixture set for comparing candidate models before a routing change.

## What this suite is — and isn't

`tests/integration/eval-suite.test.ts` (the suite CI runs on every PR) drives
every case through the real `router()` and Durable Object stack against a
**scripted fake model** that returns each case's pre-written `modelReply`.
That proves the *pipeline* — does an uploaded document actually produce a
citation, does an empty library actually produce zero citations — stays
wired correctly as the code changes. It does **not** judge whether a real
model's output is good: the fake model always says exactly what the fixture
tells it to say.

Real model-quality comparison is a manual step (see below), because CI has
no Workers AI credentials and making live model calls part of every PR would
be both flaky and slow.

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

## Promotion policy

**No model or prompt change is described as "stronger" until it meets the
documented baseline pass rate (`dataset.json`'s `baselinePassRate`) against
this suite, run against a real model.** The automated CI run enforces the
pipeline-correctness floor on every PR; it is a necessary but not sufficient
condition for promoting a model. Before changing `src/config/modelProfiles.ts`
in a way that swaps models or changes prompts:

1. Run this dataset's questions manually against the current production
   model and the candidate (see "Running against a real model" below).
2. Compare citation accuracy, insufficient-evidence compliance, latency, and
   estimated cost per `MODEL_PROFILES`' `targets`.
3. Record the comparison as part of the PR description's AI-evaluation
   comparison step (see `RELEASE_CHECKLIST.md`).
4. Only promote if the candidate meets or exceeds baseline on every
   dimension above — a model is not "stronger" because it looks fluent in a
   single chat.

## Running against a real model

This suite's harness (`tests/integration/eval-suite.test.ts`'s `runCase()`)
is intentionally structured to accept any `env` shape with an `AI` binding.
To evaluate against a real model:

1. Get a real `env.AI` binding (e.g. via `wrangler dev --remote`, or a small
   local script that calls the Cloudflare Workers AI REST API with an
   account token).
2. Replace the scripted fake in `createEvalEnv()` with that real binding, or
   adapt `runCase()` into a standalone script that posts each case's
   question through a running local Worker.
3. Score each case's actual (not scripted) reply and citations by hand
   against `dataset.json`'s `expectCitation`/`mustContainPhrase` fields, and
   record latency/estimated cost.

This is deliberately a manual step — see "What this suite is — and isn't"
above for why it isn't automated in CI.

## Extending the dataset

Add cases to `dataset.json`'s `cases` array; bump `version` when you do. Keep
the total at 15 or more (`tests/integration/eval-suite.test.ts` asserts this
floor). Keep fixture documents short, clearly synthetic, and free of any real
private material — this dataset is committed to the repository.
