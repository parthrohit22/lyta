import { EVAL_METRICS, EVAL_TASKS, type CandidateResult, type EvalMetric, type EvalTask } from "./types"

export type MetricThreshold = { min: number } | { max: number } | { maxProfileTarget: "p50Ms" | "p95Ms" | "costUsd" }

export interface EvalThresholds {
  version: string
  /** How far a quality metric may fall below the baseline in the same report (or a lower-is-better rate rise above it). */
  maxRegressionVsBaseline: number
  tasks: Record<EvalTask, Record<EvalMetric, MetricThreshold>>
  trust: { minPassRate: number }
}

/** Quality metrics are also compared with the baseline; latency and cost are held to the profile's targets. */
const QUALITY_METRICS: EvalMetric[] = [
  "evidencePrecision",
  "evidenceRecall",
  "citationCorrectness",
  "unsupportedClaimRate",
  "structuredOutputValidity",
  "taskAccuracy"
]
const LOWER_IS_BETTER = new Set<EvalMetric>(["unsupportedClaimRate", "latencyP50Ms", "latencyP95Ms", "estimatedCostPerRequestUsd"])

export interface GateCheck {
  scope: EvalTask | "trust" | "input"
  metric: string
  value: number | null
  limit: number | null
  baseline: number | null
  passed: boolean
}

export interface GateResult {
  candidateId: string
  model: string
  decision: "pass" | "fail"
  /** Only a passing result from a real-model run may justify a routing change. */
  promotionEligible: boolean
  reasons: string[]
  /** Trust fixtures the baseline passed and this candidate failed. Any entry fails the gate. */
  trustRegressions: string[]
  checks: GateCheck[]
}

export interface GateInput {
  baseline: CandidateResult
  candidate: CandidateResult
  thresholds: EvalThresholds
  /** The targets of the profile the candidate would serve. */
  targets: { p50Ms: number; p95Ms: number; costUsd: number }
  evidenceGrade: "pipeline-only" | "real-model"
}

/**
 * The promotion gate. A candidate passes only when, on the same fixtures as the
 * baseline, every task metric meets its documented threshold, no quality metric
 * regresses beyond the allowed margin, the trust pass rate meets its floor, and
 * no trust fixture the baseline passes is failed. A null metric (not measured)
 * fails its threshold.
 */
export function evaluateGate(input: GateInput): GateResult {
  const { baseline, candidate, thresholds, targets } = input
  const checks: GateCheck[] = []
  const reasons: string[] = []

  const baselineIds = baseline.fixtures.map((score) => score.fixtureId).sort()
  const candidateIds = candidate.fixtures.map((score) => score.fixtureId).sort()
  const sameInputs = baselineIds.length === candidateIds.length && baselineIds.every((id, index) => id === candidateIds[index])
  checks.push({ scope: "input", metric: "sameFixturesAsBaseline", value: null, limit: null, baseline: null, passed: sameInputs })
  if (!sameInputs) reasons.push("Candidate was not run on the same fixtures as the baseline.")

  if (candidate.candidate.estimatedCostPerRequestUsd === null) {
    reasons.push("Candidate has no cost estimate; record estimatedCostPerRequestUsd in eval/candidates.json.")
  }

  for (const task of EVAL_TASKS) {
    for (const metric of EVAL_METRICS) {
      const threshold = thresholds.tasks[task][metric]
      const value = candidate.byTask[task][metric]
      const limit =
        "min" in threshold
          ? threshold.min
          : "max" in threshold
            ? threshold.max
            : { p50Ms: targets.p50Ms, p95Ms: targets.p95Ms, costUsd: targets.costUsd }[threshold.maxProfileTarget]
      const isMin = "min" in threshold
      const passed = value !== null && (isMin ? value >= limit : value <= limit)
      checks.push({ scope: task, metric, value, limit, baseline: baseline.byTask[task][metric], passed })
      if (!passed) {
        reasons.push(
          `${task} ${metric} ${formatValue(value)} ${isMin ? "is below the minimum" : "is above the maximum"} ${formatValue(limit)}.`
        )
      }
    }

    for (const metric of QUALITY_METRICS) {
      const value = candidate.byTask[task][metric]
      const reference = baseline.byTask[task][metric]
      if (value === null || reference === null) continue
      const limit = LOWER_IS_BETTER.has(metric)
        ? reference + thresholds.maxRegressionVsBaseline
        : reference - thresholds.maxRegressionVsBaseline
      const passed = LOWER_IS_BETTER.has(metric) ? value <= limit : value >= limit
      checks.push({ scope: task, metric: `${metric}VsBaseline`, value, limit, baseline: reference, passed })
      if (!passed) {
        reasons.push(`${task} ${metric} regressed from the baseline's ${formatValue(reference)} to ${formatValue(value)}.`)
      }
    }
  }

  const trustPassRate = candidate.trust.passRate
  const trustFloorMet = trustPassRate !== null && trustPassRate >= thresholds.trust.minPassRate
  checks.push({
    scope: "trust",
    metric: "passRate",
    value: trustPassRate,
    limit: thresholds.trust.minPassRate,
    baseline: baseline.trust.passRate,
    passed: trustFloorMet
  })
  if (!trustFloorMet) reasons.push(`Trust pass rate ${formatValue(trustPassRate)} is below ${formatValue(thresholds.trust.minPassRate)}.`)

  const baselinePassed = new Set(baseline.fixtures.filter((score) => score.trust && score.trustPassed).map((score) => score.fixtureId))
  const trustRegressions = candidate.fixtures
    .filter((score) => score.trust && !score.trustPassed && baselinePassed.has(score.fixtureId))
    .map((score) => score.fixtureId)
  checks.push({
    scope: "trust",
    metric: "noRegression",
    value: trustRegressions.length,
    limit: 0,
    baseline: null,
    passed: !trustRegressions.length
  })
  if (trustRegressions.length) reasons.push(`Regressed trust fixtures the baseline passes: ${trustRegressions.join(", ")}.`)

  const decision = reasons.length ? "fail" : "pass"
  return {
    candidateId: candidate.candidate.id,
    model: candidate.candidate.model,
    decision,
    promotionEligible: decision === "pass" && input.evidenceGrade === "real-model",
    reasons,
    trustRegressions,
    checks
  }
}

function formatValue(value: number | null) {
  if (value === null) return "not measured"
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "")
}

/** The fields of an evaluation report the gate and the routing guard read. */
export interface ReportSummary {
  reportId: string
  evidenceGrade: "pipeline-only" | "real-model"
  datasetVersion: string
  createdAt: string
  gate: Array<Pick<GateResult, "candidateId" | "model" | "decision" | "promotionEligible">>
}

/**
 * A model routing change is allowed only when every model it introduces has a
 * committed real-model report in which that model passed the gate. Removing a
 * model, or keeping the same set, needs no report.
 */
export function checkRoutingChange(previousModels: string[], currentModels: string[], reports: ReportSummary[]) {
  const introduced = [...new Set(currentModels)].filter((model) => !previousModels.includes(model))
  const problems = introduced
    .filter((model) => !reports.some((report) => report.gate.some((result) => result.model === model && result.promotionEligible)))
    .map(
      (model) => `${model} is newly routed but no committed eval/reports/*.json shows it passing the promotion gate on a real-model run.`
    )
  return { introduced, problems }
}

/**
 * What a model-registry entry records about its evaluation (see #13/#14's
 * `ModelEvaluation`): enough to find the report and whether the model passed.
 */
export function registryEvaluation(report: ReportSummary, candidateId: string) {
  const result = report.gate.find((item) => item.candidateId === candidateId)
  if (!result) throw new Error(`Report ${report.reportId} has no gate result for ${candidateId}.`)
  return {
    dataset: "eval/fixtures" as const,
    datasetVersion: report.datasetVersion,
    method: report.evidenceGrade === "real-model" ? ("harness-real-model" as const) : ("harness-pipeline-only" as const),
    reportId: report.reportId,
    gatePassed: result.promotionEligible,
    recordedAt: report.createdAt.slice(0, 10)
  }
}
