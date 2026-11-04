# Release checklist

Run through this before dispatching the **Deploy production** workflow (see
[README.md#cicd](README.md#cicd)). CI already re-runs `npm run check` at
deploy time; this checklist covers what CI cannot verify automatically.

## 1. Deployed-header verification

CI validates the security header policy against source
(`tests/unit/security-render-and-headers.test.ts`), not against the live
deployment. After a deploy, confirm the headers actually reached
production:

```bash
curl -sI https://lyta.parthrohit-dev.workers.dev | grep -i \
  -e content-security-policy \
  -e x-content-type-options \
  -e referrer-policy \
  -e permissions-policy
```

Compare against `CONTENT_SECURITY_POLICY` and the rest of the policy in
`src/utils/browserSecurity.ts`.

## 2. Migration review

If this release adds a new Durable Object SQLite migration tag in
`wrangler.jsonc`:

- Confirm the migration is additive (new tag, new class) rather than a
  rename/delete of an existing class — those require the corresponding
  `deleted_classes`/`renamed_classes` entry and cannot be reverted.
- Confirm any storage-shape change in the affected DO (`src/durable/*.ts`)
  has a migration/backfill path for records written under the old shape
  (see the legacy-record migration pattern in `Workspace.loadLibrary()`
  and `Conversation.loadCanonicalHistory()`).
- Confirm rollback means reverting the Worker script, not the migration
  tag — Durable Object migrations are forward-only.

## 3. AI-evaluation comparison

Before promoting a model or prompt change (`src/config/modelProfiles.ts`,
`src/chat/messages.ts`'s system prompts, the review or drift prompts and
contracts), follow
[`eval/README.md`](eval/README.md#cross-model-evaluation-and-promotion-policy):

- CI's `npm run test:eval` only proves the harness and gate work against a
  scripted model. It is not evidence about any model.
- Run the cross-model evaluation against real models (`wrangler dev --remote`
  with the eval route enabled, then
  `npm run eval:run -- --backend workers-ai --label <label>`; full steps in
  [`eval/README.md`](eval/README.md#running-against-real-models)). The
  baseline and every candidate run the same task contracts on the same
  fixtures.
- Review the generated `eval/reports/<date>-<label>.md`: per-task evidence
  precision and recall, citation correctness, unsupported-claim rate,
  structured-output validity, task accuracy, latency p50/p95, estimated cost,
  and the trust fixtures.
- Promote only a candidate that `npm run eval:promote -- --report <file>
  --candidate <id>` accepts: it meets every threshold in
  `eval/thresholds.json`, does not regress beyond the allowed margin, and
  fails no trust fixture the baseline passes.
- Commit the report in the same PR as the routing change. CI's routing guard
  (`npm run eval:routing-guard`) fails a PR that routes a new model without a
  passing real-model report.
- Update the "Current baseline vs candidates" table in `eval/README.md` from
  the report. Until the first real run it stays marked "pending first real
  run".
- Prompt or contract changes that keep the same model are not caught by the
  routing guard. Re-run the evaluation for them by hand and attach the report.

## 4. Manual accessibility smoke test

Automated checks don't cover interaction or assistive-technology
behavior. Against a local `wrangler dev` run or the deployed preview:

- Tab through the workspace rail, chat input, mode selector, and output
  board using only the keyboard — every interactive element must be
  reachable and show a visible focus state.
- Confirm form inputs (`pages/index.html`) have associated labels and
  that streamed chat responses are announced (or at least don't trap
  focus) by a screen reader.
- Spot-check color contrast on the chat surface and output board against
  WCAG AA (4.5:1 for body text) in both light and dark modes if
  supported.
