import assert from "node:assert/strict"
import { test } from "node:test"
import { MODEL_PROFILES } from "../../src/config/modelProfiles"
import { checkRoutingChange, evaluateGate, registryEvaluation, type EvalThresholds, type ReportSummary } from "../../src/eval/gate"
import { resolveCandidates, validateDataset, validateThresholds, type CandidateConfig } from "../../src/eval/dataset"
import { EVAL_METRICS, type CandidateResult, type FixtureScore, type TaskMetrics } from "../../src/eval/types"
import { loadCandidateConfig, loadDataset, loadThresholds } from "../../scripts/eval-files"

const thresholds = loadThresholds()
const targets = { p50Ms: 5000, p95Ms: 15000, costUsd: 0.004 }

function metrics(overrides: Partial<TaskMetrics> = {}): TaskMetrics {
  return {
    fixtures: 10,
    evidencePrecision: 0.95,
    evidenceRecall: 0.9,
    citationCorrectness: 0.97,
    unsupportedClaimRate: 0.02,
    structuredOutputValidity: 1,
    taskAccuracy: 0.9,
    latencyP50Ms: 2000,
    latencyP95Ms: 6000,
    estimatedCostPerRequestUsd: 0.003,
    estimatedCostTotalUsd: 0.03,
    prohibitedConclusions: 0,
    ...overrides
  }
}

function fixture(id: string, trust: boolean, trustPassed = true): FixtureScore {
  return {
    fixtureId: id,
    task: "architecture-review",
    suite: trust ? "adversarial" : "core",
    trust,
    valid: true,
    error: null,
    latencyMs: 1000,
    modelCalls: 1,
    citedPassages: [],
    expectedEvidence: 0,
    relevantCited: 0,
    expectedCited: 0,
    citations: 0,
    correctCitations: 0,
    assertedClaims: 0,
    unsupportedClaims: 0,
    prohibitedHits: [],
    untrustedCitations: 0,
    taskCorrect: true,
    trustPassed,
    readiness: null
  }
}

function result(
  id: string,
  overrides: { review?: Partial<TaskMetrics>; failTrust?: string[]; cost?: number | null; fixtures?: string[] } = {}
): CandidateResult {
  const fixtures = (overrides.fixtures || ["core-1", "trust-1", "trust-2"]).map((name) =>
    fixture(name, name.startsWith("trust"), !overrides.failTrust?.includes(name))
  )
  const trust = fixtures.filter((item) => item.trust)
  return {
    candidate: {
      id,
      profile: "deep",
      model: `@cf/test/${id}`,
      temperature: 0.35,
      top_p: 0.85,
      max_tokens: 1800,
      timeoutMs: 25000,
      estimatedCostPerRequestUsd: overrides.cost === undefined ? 0.003 : overrides.cost
    },
    byTask: { "architecture-review": metrics(overrides.review), "drift-detection": metrics() },
    overall: metrics(),
    trust: {
      fixtures: trust.length,
      passRate: trust.filter((item) => item.trustPassed).length / trust.length,
      failedFixtureIds: trust.filter((item) => !item.trustPassed).map((item) => item.fixtureId)
    },
    fixtures
  }
}

const gate = (
  candidate: CandidateResult,
  options: { baseline?: CandidateResult; thresholds?: EvalThresholds; grade?: "pipeline-only" | "real-model" } = {}
) =>
  evaluateGate({
    baseline: options.baseline || result("baseline"),
    candidate,
    thresholds: options.thresholds || thresholds,
    targets,
    evidenceGrade: options.grade || "real-model"
  })

test("eval gate: a candidate that meets every threshold on the same fixtures passes and is eligible on a real run", () => {
  const outcome = gate(result("candidate"))
  assert.equal(outcome.decision, "pass", outcome.reasons.join("\n"))
  assert.equal(outcome.promotionEligible, true)
  assert.equal(gate(result("candidate"), { grade: "pipeline-only" }).promotionEligible, false, "a scripted run is never promotion evidence")
})

test("eval gate: each metric threshold is enforced, and an unmeasured metric fails", () => {
  for (const [metric, value] of [
    ["evidencePrecision", 0.5],
    ["evidenceRecall", 0.2],
    ["citationCorrectness", 0.8],
    ["unsupportedClaimRate", 0.3],
    ["structuredOutputValidity", 0.9],
    ["taskAccuracy", 0.5],
    ["latencyP50Ms", 6000],
    ["latencyP95Ms", 20000],
    ["estimatedCostPerRequestUsd", 0.01],
    ["evidencePrecision", null]
  ] as const) {
    const outcome = gate(result("candidate", { review: { [metric]: value } }))
    assert.equal(outcome.decision, "fail", `${metric}=${value} should fail`)
    assert.ok(
      outcome.checks.some((check) => check.scope === "architecture-review" && check.metric === metric && !check.passed),
      `${metric} check should be the failing one`
    )
  }
})

test("eval gate: a quality regression beyond the margin fails even above the absolute floor", () => {
  const baseline = result("baseline", { review: { evidencePrecision: 0.99 } })
  const outcome = gate(result("candidate", { review: { evidencePrecision: 0.9 } }), { baseline })
  assert.equal(outcome.decision, "fail")
  assert.ok(outcome.reasons.some((reason) => reason.includes("evidencePrecision regressed")))
  assert.equal(gate(result("candidate", { review: { evidencePrecision: 0.96 } }), { baseline }).decision, "pass")
})

test("eval gate: any trust regression fails, even with the trust floor lowered to zero", () => {
  const lenient = { ...thresholds, trust: { minPassRate: 0 } }
  const outcome = gate(result("candidate", { failTrust: ["trust-2"] }), { thresholds: lenient })
  assert.equal(outcome.decision, "fail")
  assert.deepEqual(outcome.trustRegressions, ["trust-2"])

  // Failing a trust fixture the baseline also fails is not a regression, but still fails the floor.
  const weakBaseline = result("baseline", { failTrust: ["trust-2"] })
  const same = gate(result("candidate", { failTrust: ["trust-2"] }), { baseline: weakBaseline })
  assert.deepEqual(same.trustRegressions, [])
  assert.equal(same.decision, "fail")
  assert.equal(gate(result("candidate", { failTrust: ["trust-2"] }), { baseline: weakBaseline, thresholds: lenient }).decision, "pass")
})

test("eval gate: a different input set or an unknown cost fails", () => {
  assert.equal(gate(result("candidate", { fixtures: ["core-1", "trust-1"] })).decision, "fail")
  const unknownCost = gate(result("candidate", { cost: null }))
  assert.equal(unknownCost.decision, "fail")
  assert.ok(unknownCost.reasons.some((reason) => reason.includes("no cost estimate")))
})

test("eval gate: routing a new model needs a committed, passing real-model report", () => {
  const report = (grade: ReportSummary["evidenceGrade"], eligible: boolean): ReportSummary => ({
    reportId: "2026-12-01-run",
    evidenceGrade: grade,
    datasetVersion: "v",
    createdAt: "2026-12-01T00:00:00.000Z",
    gate: [{ candidateId: "c", model: "@cf/new/model", decision: eligible ? "pass" : "fail", promotionEligible: eligible }]
  })
  const before = ["@cf/meta/llama-4-scout-17b-16e-instruct"]

  assert.deepEqual(checkRoutingChange(before, before, []).problems, [])
  assert.deepEqual(checkRoutingChange(before, [], []).problems, [], "removing a model needs no report")
  assert.equal(checkRoutingChange(before, ["@cf/new/model"], []).problems.length, 1)
  assert.equal(checkRoutingChange(before, ["@cf/new/model"], [report("pipeline-only", false)]).problems.length, 1)
  assert.equal(checkRoutingChange(before, ["@cf/new/model"], [report("real-model", false)]).problems.length, 1)
  assert.deepEqual(checkRoutingChange(before, ["@cf/new/model"], [report("real-model", true)]).problems, [])
})

test("eval gate: a registry entry can reference a report by id and pass/fail", () => {
  const summary: ReportSummary = {
    reportId: "2026-12-01-first-real-run",
    evidenceGrade: "real-model",
    datasetVersion: "2026-11-04.1",
    createdAt: "2026-12-01T10:00:00.000Z",
    gate: [{ candidateId: "c", model: "@cf/x/y", decision: "pass", promotionEligible: true }]
  }
  assert.deepEqual(registryEvaluation(summary, "c"), {
    dataset: "eval/fixtures",
    datasetVersion: "2026-11-04.1",
    method: "harness-real-model",
    reportId: "2026-12-01-first-real-run",
    gatePassed: true,
    recordedAt: "2026-12-01"
  })
  assert.throws(() => registryEvaluation(summary, "missing"))
})

test("eval thresholds: the committed file covers every task and metric, and gaps are reported", () => {
  assert.deepEqual(validateThresholds(thresholds), [])
  const broken = structuredClone(thresholds) as unknown as { tasks: Record<string, Record<string, unknown>> }
  delete broken.tasks["drift-detection"].taskAccuracy
  broken.tasks["architecture-review"].evidenceRecall = { min: 0.5, max: 0.9 }
  const problems = validateThresholds(broken as unknown as EvalThresholds)
  assert.ok(problems.some((problem) => problem.includes("drift-detection.taskAccuracy is missing")))
  assert.ok(problems.some((problem) => problem.includes("architecture-review.evidenceRecall needs exactly one")))
  assert.equal(EVAL_METRICS.length, Object.keys(thresholds.tasks["architecture-review"]).length)
})

test("eval dataset: validation catches broken fixtures", () => {
  const dataset = loadDataset()
  const mutate = (change: (copy: ReturnType<typeof loadDataset>) => void) => {
    const copy = structuredClone(dataset)
    change(copy)
    return validateDataset(copy)
  }

  assert.ok(mutate((copy) => copy.fixtures.push(copy.fixtures[0])).some((problem) => problem.includes("duplicate fixture id")))
  assert.ok(mutate((copy) => (copy.fixtures = copy.fixtures.slice(0, 20))).some((problem) => problem.includes("need at least 25")))
  assert.ok(
    mutate((copy) => {
      const rule = copy.fixtures[0].prohibited.find((item) => item.kind === "statement")!
      if (rule.kind === "statement") rule.example = "something unrelated"
    }).some((problem) => problem.includes("example does not match"))
  )
  assert.ok(
    mutate((copy) => {
      const adversarial = copy.fixtures.find((item) => item.passages.some((passage) => passage.untrusted))!
      adversarial.expected.evidence.push(adversarial.passages.find((passage) => passage.untrusted)!.id)
    }).some((problem) => problem.includes("is not a trusted passage"))
  )
  assert.ok(
    mutate((copy) => (copy.fixtures[0].passages[0].text += " Contact pat@acme-corp.com")).some((problem) =>
      problem.includes("non-example email")
    )
  )
  assert.ok(mutate((copy) => (copy.fixtures[0].acceptableUncertainty.note = "")).some((problem) => problem.includes("needs a note")))
  assert.ok(mutate((copy) => (copy.fixtures[0].prohibited = [])).some((problem) => problem.includes("prohibited conclusion is required")))
})

test("eval candidates: the baseline is the live profile and candidates only swap the model", () => {
  const config = loadCandidateConfig()
  const resolved = resolveCandidates(config, MODEL_PROFILES)
  assert.deepEqual(resolved.problems, [])
  assert.equal(resolved.baseline!.model, MODEL_PROFILES.deep.model)
  assert.equal(resolved.baseline!.estimatedCostPerRequestUsd, MODEL_PROFILES.deep.targets.estimatedCostPerRequestUsd)
  for (const candidate of resolved.candidates) {
    assert.equal(candidate.temperature, MODEL_PROFILES.deep.temperature)
    assert.equal(candidate.max_tokens, MODEL_PROFILES.deep.max_tokens)
    assert.equal(candidate.timeoutMs, MODEL_PROFILES.deep.timeoutMs)
  }

  const bad: CandidateConfig = {
    ...config,
    candidates: [
      { id: "external", profile: "deep", model: "openai/gpt-4o-mini", estimatedCostPerRequestUsd: 0.001 },
      { id: "other-profile", profile: "instant", model: "@cf/meta/llama-3.1-8b-instruct", estimatedCostPerRequestUsd: null }
    ]
  }
  const problems = resolveCandidates(bad, MODEL_PROFILES).problems
  assert.ok(problems.some((problem) => problem.includes("external model must be a Workers AI")))
  assert.ok(problems.some((problem) => problem.includes("other-profile must use the baseline's profile")))
})
