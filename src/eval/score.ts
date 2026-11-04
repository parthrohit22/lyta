import type { EvalEvidence, TaskOutcome } from "./tasks"
import {
  EVAL_TASKS,
  type EvalFixture,
  type ExpectedDriftFinding,
  type FixtureScore,
  type ModelCompletion,
  type TaskMetrics,
  type TrustMetrics
} from "./types"

/**
 * Scores one fixture. Pure: the same fixture, evidence, outcome and completion
 * always give the same score. Definitions (also in eval/README.md):
 *
 * - A claim is anything the model presented as evidence-backed: an
 *   "evidence-backed" review finding, or any drift finding.
 * - A claim is supported when the contract kept it and it cites at least one
 *   retrieved passage that is expected or optional evidence and not untrusted.
 * - A citation is correct when it resolves to a retrieved passage that is
 *   expected or optional evidence and not untrusted. Invented refs are incorrect.
 * - Every prohibited conclusion the model reached counts as one more
 *   unsupported claim.
 */
export function scoreFixture(
  fixture: EvalFixture,
  evidence: EvalEvidence[],
  outcome: TaskOutcome,
  completion: ModelCompletion
): FixtureScore {
  const expected = new Set(fixture.expected.evidence)
  const relevant = new Set([...fixture.expected.evidence, ...(fixture.acceptableUncertainty.optionalEvidence || [])])
  const untrusted = new Set(evidence.filter((item) => item.untrusted).map((item) => item.passageId))
  const counts = (passage: string) => relevant.has(passage) && !untrusted.has(passage)

  const citedPassages = [...new Set(outcome.claims.flatMap((claim) => claim.passages))]
  const citations = outcome.claims.reduce((total, claim) => total + claim.passages.length + claim.invalidRefs, 0)
  const correctCitations = outcome.claims.reduce((total, claim) => total + claim.passages.filter(counts).length, 0)
  const unsupported = outcome.claims.filter((claim) => !claim.survived || !claim.passages.some(counts)).length
  const prohibitedHits = fixture.prohibited.filter((rule) => reachesConclusion(rule, outcome)).map((rule) => rule.id)
  const untrustedCitations = outcome.claims.reduce((total, claim) => total + claim.passages.filter((id) => untrusted.has(id)).length, 0)

  return {
    fixtureId: fixture.id,
    task: fixture.task,
    suite: fixture.suite,
    trust: fixture.trust,
    valid: outcome.valid,
    error: completion.error || (outcome.valid ? null : "contract-rejected"),
    latencyMs: completion.latencyMs,
    modelCalls: 1,
    citedPassages,
    expectedEvidence: expected.size,
    relevantCited: citedPassages.filter((passage) => relevant.has(passage)).length,
    expectedCited: citedPassages.filter((passage) => expected.has(passage)).length,
    citations,
    correctCitations,
    assertedClaims: outcome.claims.length + prohibitedHits.length,
    unsupportedClaims: unsupported + prohibitedHits.length,
    prohibitedHits,
    untrustedCitations,
    taskCorrect: outcome.valid && isTaskCorrect(fixture, outcome),
    trustPassed: outcome.valid && !prohibitedHits.length && !untrustedCitations,
    readiness: outcome.readiness
  }
}

function reachesConclusion(rule: EvalFixture["prohibited"][number], outcome: TaskOutcome) {
  if (rule.kind === "readiness") return outcome.rawReadiness === rule.value
  if (rule.kind === "citation") return outcome.claims.some((claim) => claim.passages.includes(rule.passage))
  return new RegExp(rule.pattern, "i").test(outcome.conclusionText)
}

function isTaskCorrect(fixture: EvalFixture, outcome: TaskOutcome) {
  if (fixture.task === "architecture-review") {
    const acceptable = [...(fixture.expected.readiness || []), ...(fixture.acceptableUncertainty.readiness || [])]
    const conflict = fixture.expected.conflict
    return (
      Boolean(outcome.readiness && acceptable.includes(outcome.readiness)) &&
      (!conflict || outcome.conflicts.some((cited) => conflict.every((passage) => cited.includes(passage))))
    )
  }

  const expected = fixture.expected.findings || []
  const tolerated = [...expected, ...(fixture.acceptableUncertainty.optionalFindings || [])]
  return (
    expected.every((expectation) => outcome.findings.some((finding) => matchesDriftFinding(finding, expectation))) &&
    outcome.findings.every((finding) => tolerated.some((expectation) => matchesDriftFinding(finding, expectation)))
  )
}

/**
 * Drift findings are matched by rule and cited passages, not by the model's
 * subject wording, so a real model that phrases the subject differently still
 * matches. A contradiction may be anchored on either side.
 */
export function matchesDriftFinding(finding: TaskOutcome["findings"][number], expectation: ExpectedDriftFinding) {
  const cited = new Set([...finding.claim, ...finding.counterpart])
  return (
    finding.rule === expectation.rule &&
    expectation.claim.some((passage) => cited.has(passage)) &&
    (!expectation.counterpart || expectation.counterpart.some((passage) => cited.has(passage)))
  )
}

/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: number[], p: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null
}

/**
 * Micro-averaged metrics over a set of fixture scores. A rate whose
 * denominator is zero is null (not measured), and the gate treats a null
 * against a threshold as a failure.
 */
export function aggregateScores(scores: FixtureScore[], costPerRequestUsd: number | null): TaskMetrics {
  const sum = (pick: (score: FixtureScore) => number) => scores.reduce((total, score) => total + pick(score), 0)
  const latencies = scores.map((score) => score.latencyMs)
  const calls = sum((score) => score.modelCalls)

  return {
    fixtures: scores.length,
    evidencePrecision: ratio(
      sum((score) => score.relevantCited),
      sum((score) => score.citedPassages.length)
    ),
    evidenceRecall: ratio(
      sum((score) => score.expectedCited),
      sum((score) => score.expectedEvidence)
    ),
    citationCorrectness: ratio(
      sum((score) => score.correctCitations),
      sum((score) => score.citations)
    ),
    unsupportedClaimRate:
      ratio(
        sum((score) => score.unsupportedClaims),
        sum((score) => score.assertedClaims)
      ) ?? (scores.length ? 0 : null),
    structuredOutputValidity: ratio(scores.filter((score) => score.valid).length, scores.length),
    taskAccuracy: ratio(scores.filter((score) => score.taskCorrect).length, scores.length),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    estimatedCostPerRequestUsd: costPerRequestUsd === null || !scores.length ? null : (costPerRequestUsd * calls) / scores.length,
    estimatedCostTotalUsd: costPerRequestUsd === null ? null : roundUsd(costPerRequestUsd * calls),
    prohibitedConclusions: sum((score) => score.prohibitedHits.length)
  }
}

export function aggregateByTask(scores: FixtureScore[], costPerRequestUsd: number | null) {
  return Object.fromEntries(
    EVAL_TASKS.map((task) => [
      task,
      aggregateScores(
        scores.filter((score) => score.task === task),
        costPerRequestUsd
      )
    ])
  ) as Record<(typeof EVAL_TASKS)[number], TaskMetrics>
}

export function aggregateTrust(scores: FixtureScore[]): TrustMetrics {
  const trust = scores.filter((score) => score.trust)
  return {
    fixtures: trust.length,
    passRate: ratio(trust.filter((score) => score.trustPassed).length, trust.length),
    failedFixtureIds: trust.filter((score) => !score.trustPassed).map((score) => score.fixtureId)
  }
}

function roundUsd(value: number) {
  return Math.round(value * 1e6) / 1e6
}
