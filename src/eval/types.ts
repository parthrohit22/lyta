import type { DriftRole, DriftRuleId } from "../drift/contract"
import type { ReviewReadiness } from "../review/contract"
import type { ChatMode } from "../chat/messages"

/** The task contracts the model evaluation covers. Each runs the product's own prompt builder and output validator. */
export const EVAL_TASKS = ["architecture-review", "drift-detection"] as const
export type EvalTask = (typeof EVAL_TASKS)[number]

/** One retrieved passage, addressed by a fixture-local id (P1, P2, ...). Passage identity is what evidence is scored on. */
export interface EvalPassage {
  id: string
  file: string
  /** Drift fixtures only: the role the passage was selected under. */
  role?: DriftRole
  text: string
  /** The passage carries an injection, fake system text, or a forged authority claim. Citing it as support fails the fixture's trust check. */
  untrusted?: boolean
}

/** A drift finding a fixture expects (or tolerates), matched by rule and cited passages rather than model-written wording. */
export interface ExpectedDriftFinding {
  rule: Exclude<DriftRuleId, "stale-or-missing-source">
  claim: string[]
  counterpart?: string[]
}

export type ProhibitedConclusion =
  | { id: string; kind: "readiness"; value: ReviewReadiness; reason: string }
  | { id: string; kind: "statement"; pattern: string; example: string; reason: string }
  | { id: string; kind: "citation"; passage: string; reason: string }

export interface EvalFixture {
  id: string
  task: EvalTask
  suite: "core" | "adversarial"
  /** Security/trust fixtures. A candidate may not fail one the baseline passes. */
  trust: boolean
  title: string
  input: { proposedChange: string; intendedOutcome: string; constraints?: string } | { scope: string }
  passages: EvalPassage[]
  expected: {
    /** Passages a correct answer must cite. */
    evidence: string[]
    /** Architecture review: the readiness a correct review reaches. */
    readiness?: ReviewReadiness[]
    /** Architecture review: a conflict a correct review must raise, citing both passages. */
    conflict?: [string, string]
    /** Drift: findings a correct run must report. An empty list means "no drift". */
    findings?: ExpectedDriftFinding[]
  }
  acceptableUncertainty: {
    note: string
    /** Hedged readiness values that still count as a correct outcome. */
    readiness?: ReviewReadiness[]
    /** Passages that may be cited without being required. */
    optionalEvidence?: string[]
    /** Drift findings that may be reported without being required. */
    optionalFindings?: ExpectedDriftFinding[]
  }
  prohibited: ProhibitedConclusion[]
  /** A correct model reply in the task's JSON shape. Citations are written "@P1" and resolved to evidence refs by the scripted backend. */
  reference: Record<string, unknown>
}

export interface EvalDataset {
  version: string
  fixtures: EvalFixture[]
}

/** A model/profile combination under evaluation. Sampling and timeout come from the profile; only the model may differ. */
export interface EvalCandidate {
  id: string
  profile: ChatMode
  model: string
  temperature: number
  top_p: number
  max_tokens: number
  timeoutMs: number
  /** Null when no estimate has been recorded; the gate rejects a candidate whose cost is unknown. */
  estimatedCostPerRequestUsd: number | null
  latencyTargets: { p50Ms: number; p95Ms: number }
  costTargetUsd: number
}

/** What one model call produced. `text` is held in memory only and never written to a report. */
export interface ModelCompletion {
  text: string | null
  error: "timeout" | "model-error" | null
  latencyMs: number
  /** The model that actually served the call, as reported by the backend. */
  servedModel: string
}

export const EVAL_METRICS = [
  "evidencePrecision",
  "evidenceRecall",
  "citationCorrectness",
  "unsupportedClaimRate",
  "structuredOutputValidity",
  "taskAccuracy",
  "latencyP50Ms",
  "latencyP95Ms",
  "estimatedCostPerRequestUsd"
] as const
export type EvalMetric = (typeof EVAL_METRICS)[number]

/** Per-fixture score. Ids, counts and enum values only: no passage text and no model wording. */
export interface FixtureScore {
  fixtureId: string
  task: EvalTask
  suite: "core" | "adversarial"
  trust: boolean
  valid: boolean
  error: "timeout" | "model-error" | "contract-rejected" | null
  latencyMs: number
  modelCalls: number
  /** Distinct retrieved passages cited by claims that assert evidence support. */
  citedPassages: string[]
  expectedEvidence: number
  relevantCited: number
  expectedCited: number
  citations: number
  correctCitations: number
  assertedClaims: number
  unsupportedClaims: number
  prohibitedHits: string[]
  untrustedCitations: number
  taskCorrect: boolean
  trustPassed: boolean
  /** Architecture review: the readiness after the contract's guards. */
  readiness: ReviewReadiness | null
}

export type MetricValues = Record<EvalMetric, number | null>

export interface TaskMetrics extends MetricValues {
  fixtures: number
  estimatedCostTotalUsd: number | null
  prohibitedConclusions: number
}

export interface TrustMetrics {
  fixtures: number
  passRate: number | null
  failedFixtureIds: string[]
}

export interface CandidateResult {
  candidate: Omit<EvalCandidate, "latencyTargets" | "costTargetUsd">
  byTask: Record<EvalTask, TaskMetrics>
  overall: TaskMetrics
  trust: TrustMetrics
  fixtures: FixtureScore[]
}
