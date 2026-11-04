import assert from "node:assert/strict"
import { test } from "node:test"
import { MODEL_PROFILES } from "../../src/config/modelProfiles"
import { DATASET_FLOORS, resolveCandidates, validateDataset, validateThresholds } from "../../src/eval/dataset"
import { prepareTask } from "../../src/eval/tasks"
import { scoreFixture } from "../../src/eval/score"
import {
  SCRIPTED_BEHAVIOURS,
  createScriptedBackend,
  renderReportMarkdown,
  runEvaluation,
  scriptedCandidate,
  type ScriptedBehaviour
} from "../../src/eval/runner"
import { loadCandidateConfig, loadDataset, loadThresholds } from "../../scripts/eval-files"

// The CI promotion gate (issue #16), run against the scripted backend. No model
// is called here: these tests prove the dataset is well-formed, that the scorer
// recognises a correct answer for every fixture, and that the gate rejects each
// kind of bad model behaviour. They say nothing about any real model's quality.

const dataset = loadDataset()
const thresholds = loadThresholds()
const deep = MODEL_PROFILES.deep

test(`model eval dataset (version ${dataset.version}) is valid and meets the issue #16 floors`, () => {
  assert.deepEqual(validateDataset(dataset), [])
  assert.deepEqual(validateThresholds(thresholds), [])
  assert.deepEqual(resolveCandidates(loadCandidateConfig(), MODEL_PROFILES).problems, [])
  assert.ok(dataset.fixtures.length >= DATASET_FLOORS.total)
  console.log(
    `[lyta-model-eval] ${dataset.fixtures.length} fixtures: ${["architecture-review", "drift-detection"]
      .map((task) => `${dataset.fixtures.filter((fixture) => fixture.task === task && fixture.suite === "core").length} ${task}`)
      .join(", ")}, ${dataset.fixtures.filter((fixture) => fixture.suite === "adversarial").length} adversarial`
  )
})

test("model eval: every fixture's reference reply passes the product contract and scores perfectly", async () => {
  const backend = createScriptedBackend()
  const candidate = scriptedCandidate("reference", "reference", deep, "deep")

  for (const fixture of dataset.fixtures) {
    const task = prepareTask(fixture)
    const completion = await backend.complete({ candidate, messages: task.messages, fixture, evidence: task.evidence })
    const score = scoreFixture(fixture, task.evidence, task.interpret(completion.text), completion)
    const label = `${fixture.id}: ${JSON.stringify(score)}`

    assert.equal(score.valid, true, label)
    assert.equal(score.taskCorrect, true, label)
    assert.equal(score.trustPassed, true, label)
    assert.deepEqual(score.prohibitedHits, [], label)
    assert.equal(score.unsupportedClaims, 0, label)
    assert.equal(score.correctCitations, score.citations, label)
    assert.equal(score.expectedCited, score.expectedEvidence, label)
  }
})

test("model eval: the credulous behaviour reaches every prohibited conclusion, so each one is detectable", async () => {
  const backend = createScriptedBackend()
  const candidate = scriptedCandidate("credulous", "credulous", deep, "deep")

  for (const fixture of dataset.fixtures) {
    const task = prepareTask(fixture)
    const completion = await backend.complete({ candidate, messages: task.messages, fixture, evidence: task.evidence })
    const score = scoreFixture(fixture, task.evidence, task.interpret(completion.text), completion)
    assert.deepEqual(score.prohibitedHits.sort(), fixture.prohibited.map((rule) => rule.id).sort(), fixture.id)
    if (fixture.trust) assert.equal(score.trustPassed, false, fixture.id)
  }
})

test("model eval: the promotion gate passes the reference and rejects each degraded behaviour", async () => {
  const report = await runEvaluation({
    dataset,
    thresholds,
    backend: createScriptedBackend(),
    baseline: scriptedCandidate("scripted-baseline", "reference", deep, "deep"),
    candidates: SCRIPTED_BEHAVIOURS.map((behaviour) => scriptedCandidate(`scripted-${behaviour}`, behaviour, deep, "deep")),
    candidatesVersion: "scripted",
    label: "ci",
    now: new Date("2026-11-04T00:00:00.000Z")
  })
  const byBehaviour = Object.fromEntries(report.gate.map((result) => [result.candidateId.replace("scripted-", ""), result])) as Record<
    ScriptedBehaviour,
    (typeof report.gate)[number]
  >
  const failed = (behaviour: ScriptedBehaviour, metric: string) =>
    byBehaviour[behaviour].checks.some((check) => check.metric === metric && !check.passed)

  for (const result of report.gate) console.log(`[lyta-model-eval] gate ${result.candidateId}: ${result.decision}`)

  assert.equal(report.reportId, "2026-11-04-ci")
  assert.equal(report.evidenceGrade, "pipeline-only")
  assert.equal(byBehaviour.reference.decision, "pass", byBehaviour.reference.reasons.join("\n"))
  assert.equal(byBehaviour.reference.promotionEligible, false, "a scripted run can never make a model promotion-eligible")

  assert.equal(byBehaviour.fabricating.decision, "fail")
  assert.ok(failed("fabricating", "citationCorrectness") && failed("fabricating", "unsupportedClaimRate"))

  assert.equal(byBehaviour.credulous.decision, "fail")
  assert.ok(failed("credulous", "noRegression") && failed("credulous", "passRate"))
  assert.equal(byBehaviour.credulous.trustRegressions.length, dataset.fixtures.filter((fixture) => fixture.trust).length)

  assert.equal(byBehaviour.malformed.decision, "fail")
  assert.ok(failed("malformed", "structuredOutputValidity"))

  assert.equal(byBehaviour.slow.decision, "fail")
  assert.ok(failed("slow", "latencyP50Ms"))
  assert.ok(
    byBehaviour.slow.checks.filter((check) => !check.passed).every((check) => check.metric.startsWith("latency")),
    "slow only fails on latency"
  )

  // Reports hold scores and ids only: no passage text, reference wording or prohibited examples.
  const serialized = JSON.stringify(report)
  const markdown = renderReportMarkdown(report)
  for (const fixture of dataset.fixtures) {
    for (const passage of fixture.passages) {
      for (const output of [serialized, markdown])
        assert.ok(!output.includes(passage.text.slice(0, 32)), `${fixture.id} ${passage.id} leaked`)
    }
    for (const rule of fixture.prohibited) {
      if (rule.kind === "statement") assert.ok(!serialized.includes(rule.example), `${fixture.id} ${rule.id} example leaked`)
    }
    const rationale = (fixture.reference.rationale || fixture.reference.summary) as string
    assert.ok(!serialized.includes(rationale.slice(0, 32)), `${fixture.id} reference wording leaked`)
  }
  assert.doesNotMatch(serialized, /"(text|messages|content|snippet|response)":/)
  assert.match(markdown, /Pipeline-only/)
})
