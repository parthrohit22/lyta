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
  *semantically* the right one: the scripted fake embedding returns the same
  vector for every input, so every chunk clears the similarity floor
  (`MIN_LIBRARY_SCORE` in `src/retrieval/vectorStore.ts`). The floor itself
  is covered by `tests/unit/retrieval-boundary.test.ts`. This suite only
  proves the app correctly attaches citations for uploaded content and
  correctly withholds them when the library is empty.
- `insufficient-evidence` — no document is uploaded, so the library is
  empty; the case asserts zero citations and, since the scripted reply is
  the exact contract string from `src/chat/messages.ts`'s system prompt,
  that the reply contains "Insufficient evidence in the retrieved sources."
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

## Retrieval threshold calibration

`MIN_LIBRARY_SCORE` and `MIN_KNOWLEDGE_SCORE` in
`src/retrieval/vectorStore.ts` were set from measured cosine scores, not
guessed. The 2026-11-03 run embedded 57 queries with the open-weights
`BAAI/bge-base-en-v1.5` (fp32, mean pooling — the Workers AI default) against
this dataset's documents, chunked `fixtures/demo-architecture-change.md`, and
the built-in knowledge base, using LYTA's own chunking and retrieval-query
code. Best-chunk scores:

| Query group | Score range |
| --- | --- |
| Related question, typed (own document) | 0.612 – 0.850 |
| Related question, file attached (own document) | 0.820 – 0.940 |
| Vague request with file attached ("Summarize this document") | 0.805 – 0.950 |
| Best *other* document for a related question | 0.554 – 0.691 |
| Unrelated question (insufficient-evidence cases, general questions) | 0.459 – 0.686 |
| Vague request, no file ("Find risks") | 0.514 – 0.589 |
| Question about LYTA vs built-in knowledge | 0.705 – 0.860 |
| Question naming LYTA the knowledge base can't answer | 0.655 – 0.719 |
| General question vs built-in knowledge ("What is a Durable Object?") | up to 0.778 |

What the numbers mean:

- **Library floor = 0.7.** It is the lowest value that rejects every unrelated
  question and every wrong-document match. Every attached-file query still
  clears it. The cost: 4 of 13 typed questions about the demo fixture
  (0.61–0.68) now get no citation and fall back to "insufficient evidence."
  For an evidence-first product, a missing citation is the safer error.
- **The built-in knowledge base needs a topic gate, not just a floor.** A
  general Durable Object question scored 0.778 against LYTA's
  self-description — higher than some genuine LYTA questions — so it is only
  consulted when the query names LYTA. Its 0.7 floor then keeps genuine LYTA
  questions; the two off-topic ones that pass (0.715, 0.719) only receive
  accurate facts about LYTA.
- **Caveats:** this is a 57-query set, and Cloudflare's hosted model may score
  slightly differently from the local fp32 copy. The library floor sits only
  0.014 above the highest unrelated score. Switching to `pooling: "cls"`
  lowers every score by about 0.06–0.09, so the floors would need
  re-calibrating along with re-embedding every stored chunk.

## Extending the dataset

Add cases to `dataset.json`'s `cases` array; bump `version` when you do. Keep
the total at 15 or more (`tests/integration/eval-suite.test.ts` asserts this
floor). Keep fixture documents short, clearly synthetic, and free of any real
private material — this dataset is committed to the repository.
