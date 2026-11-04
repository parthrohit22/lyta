import { DRIFT_ROLES, DRIFT_RULE_DEFINITIONS } from "../drift/contract"
import { REVIEW_READINESS } from "../review/contract"
import type { ModelProfile } from "../config/modelProfiles"
import type { ChatMode } from "../chat/messages"
import { EVAL_METRICS, EVAL_TASKS, type EvalCandidate, type EvalDataset, type EvalFixture } from "./types"
import type { EvalThresholds } from "./gate"

/** Floors from issue #16: at least 25 fixtures across both tasks plus adversarial cases. */
export const DATASET_FLOORS = { total: 25, "architecture-review": 8, "drift-detection": 8, adversarial: 6 } as const

const PASSAGE_ID = /^P\d+$/
// Fixtures are committed, so they may only name reserved example domains and obviously fake tokens.
const EMAIL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi
const URL_HOST = /https?:\/\/([^/\s"')]+)/gi
const ALLOWED_HOST = /(^|\.)example\.(com|org|net)$|\.test$|\.invalid$/i

/** Every problem with the dataset, or an empty list. The CI gate fails on any entry. */
export function validateDataset(dataset: EvalDataset): string[] {
  const problems: string[] = []
  if (!dataset || typeof dataset.version !== "string" || !dataset.version) problems.push("dataset: missing version")
  const fixtures = Array.isArray(dataset?.fixtures) ? dataset.fixtures : []
  const ids = new Set<string>()

  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) problems.push(`${fixture.id}: duplicate fixture id`)
    ids.add(fixture.id)
    problems.push(...validateFixture(fixture).map((problem) => `${fixture.id}: ${problem}`))
  }

  if (fixtures.length < DATASET_FLOORS.total) problems.push(`dataset: ${fixtures.length} fixtures, need at least ${DATASET_FLOORS.total}`)
  for (const task of EVAL_TASKS) {
    const count = fixtures.filter((fixture) => fixture.task === task && fixture.suite === "core").length
    if (count < DATASET_FLOORS[task]) problems.push(`dataset: ${count} core ${task} fixtures, need at least ${DATASET_FLOORS[task]}`)
  }
  const adversarial = fixtures.filter((fixture) => fixture.suite === "adversarial")
  if (adversarial.length < DATASET_FLOORS.adversarial) {
    problems.push(`dataset: ${adversarial.length} adversarial fixtures, need at least ${DATASET_FLOORS.adversarial}`)
  }
  for (const task of EVAL_TASKS) {
    if (!adversarial.some((fixture) => fixture.task === task)) problems.push(`dataset: no adversarial ${task} fixture`)
  }

  return problems
}

function validateFixture(fixture: EvalFixture): string[] {
  const problems: string[] = []
  if (!/^[a-z0-9-]+$/.test(fixture.id || "")) problems.push("id must be lowercase kebab-case")
  if (!EVAL_TASKS.includes(fixture.task)) problems.push(`unknown task "${fixture.task}"`)
  if (fixture.suite !== "core" && fixture.suite !== "adversarial") problems.push(`unknown suite "${fixture.suite}"`)
  if (fixture.suite === "adversarial" && !fixture.trust) problems.push("adversarial fixtures are trust fixtures")
  if (!fixture.title) problems.push("missing title")

  const passages = new Map((fixture.passages || []).map((passage) => [passage.id, passage]))
  if (passages.size !== (fixture.passages || []).length) problems.push("duplicate passage id")
  for (const passage of fixture.passages || []) {
    if (!PASSAGE_ID.test(passage.id)) problems.push(`passage id "${passage.id}" must look like P1`)
    if (!passage.file || !passage.text?.trim()) problems.push(`${passage.id} needs a file and text`)
    if (passage.text.length > 780) problems.push(`${passage.id} is longer than one library chunk (780 characters)`)
    if (fixture.task === "drift-detection" && !DRIFT_ROLES.includes(passage.role!)) problems.push(`${passage.id} needs a drift role`)
    if (fixture.task === "architecture-review" && passage.role) problems.push(`${passage.id}: review passages have no role`)
    problems.push(...privacyProblems(`${passage.id}`, `${passage.file}\n${passage.text}`))
  }

  const known = (id: string) => passages.has(id)
  const trusted = (id: string) => known(id) && !passages.get(id)!.untrusted
  for (const id of fixture.expected?.evidence || []) {
    if (!trusted(id)) problems.push(`expected evidence ${id} is not a trusted passage`)
  }
  for (const id of fixture.acceptableUncertainty?.optionalEvidence || []) {
    if (!trusted(id)) problems.push(`optional evidence ${id} is not a trusted passage`)
  }
  if (!fixture.acceptableUncertainty?.note) problems.push("acceptableUncertainty needs a note")

  if (fixture.task === "architecture-review") {
    if (!("proposedChange" in (fixture.input || {}))) problems.push("review input needs proposedChange and intendedOutcome")
    const readiness = [...(fixture.expected?.readiness || []), ...(fixture.acceptableUncertainty?.readiness || [])]
    if (!fixture.expected?.readiness?.length) problems.push("expected.readiness is required")
    for (const value of readiness) if (!REVIEW_READINESS.includes(value)) problems.push(`unknown readiness "${value}"`)
    for (const id of fixture.expected?.conflict || []) if (!known(id)) problems.push(`conflict cites unknown passage ${id}`)
    if (fixture.expected?.findings) problems.push("review fixtures do not expect drift findings")
  } else if (fixture.task === "drift-detection") {
    if (!("scope" in (fixture.input || {}))) problems.push("drift input needs a scope")
    if (!Array.isArray(fixture.expected?.findings)) problems.push("expected.findings is required (empty means no drift)")
    for (const finding of [...(fixture.expected?.findings || []), ...(fixture.acceptableUncertainty?.optionalFindings || [])]) {
      const definition = DRIFT_RULE_DEFINITIONS[finding.rule]
      if (!definition || definition.owner !== "model") {
        problems.push(`unknown model drift rule "${finding.rule}"`)
        continue
      }
      for (const id of [...finding.claim, ...(finding.counterpart || [])])
        if (!trusted(id)) problems.push(`finding cites ${id}, not a trusted passage`)
      if (definition.counterpartKind !== "cited" && !finding.claim.some((id) => definition.claimRoles.includes(passages.get(id)?.role!))) {
        problems.push(`${finding.rule} claim must cite a ${definition.claimRoles.join(" or ")} passage`)
      }
      if (definition.counterpartKind === "cited" && !finding.counterpart?.length)
        problems.push(`${finding.rule} needs counterpart passages`)
    }
  }

  const prohibitedIds = new Set<string>()
  if (!fixture.prohibited?.length) problems.push("at least one prohibited conclusion is required")
  if ((fixture.prohibited || []).filter((rule) => rule.kind === "readiness").length > 1) problems.push("at most one prohibited readiness")
  for (const rule of fixture.prohibited || []) {
    if (prohibitedIds.has(rule.id)) problems.push(`duplicate prohibited id ${rule.id}`)
    prohibitedIds.add(rule.id)
    if (!rule.reason) problems.push(`prohibited ${rule.id} needs a reason`)
    if (rule.kind === "readiness" && (fixture.task !== "architecture-review" || !REVIEW_READINESS.includes(rule.value))) {
      problems.push(`prohibited ${rule.id}: readiness rules apply to architecture reviews with a known readiness`)
    } else if (rule.kind === "citation" && !known(rule.passage)) {
      problems.push(`prohibited ${rule.id} names unknown passage ${rule.passage}`)
    } else if (rule.kind === "statement") {
      try {
        if (!new RegExp(rule.pattern, "i").test(rule.example))
          problems.push(`prohibited ${rule.id}: its example does not match its pattern`)
      } catch {
        problems.push(`prohibited ${rule.id}: pattern is not a valid regular expression`)
      }
    } else if (!["readiness", "citation", "statement"].includes((rule as { kind: string }).kind)) {
      problems.push(`prohibited ${rule.id}: unknown kind`)
    }
  }

  if (!fixture.reference || typeof fixture.reference !== "object") problems.push("a reference reply is required")
  return problems
}

function privacyProblems(label: string, text: string) {
  const problems: string[] = []
  for (const match of text.matchAll(EMAIL)) {
    if (!ALLOWED_HOST.test(match[0].split("@")[1])) problems.push(`${label} contains a non-example email address`)
  }
  for (const match of text.matchAll(URL_HOST)) {
    if (!ALLOWED_HOST.test(match[1])) problems.push(`${label} links to a non-example host ${match[1]}`)
  }
  return problems
}

export function validateThresholds(thresholds: EvalThresholds): string[] {
  const problems: string[] = []
  if (!thresholds?.version) problems.push("thresholds: missing version")
  if (!(thresholds?.maxRegressionVsBaseline >= 0 && thresholds.maxRegressionVsBaseline <= 1)) {
    problems.push("thresholds: maxRegressionVsBaseline must be between 0 and 1")
  }
  for (const task of EVAL_TASKS) {
    for (const metric of EVAL_METRICS) {
      const threshold = thresholds?.tasks?.[task]?.[metric]
      if (!threshold) {
        problems.push(`thresholds: ${task}.${metric} is missing`)
        continue
      }
      const keys = Object.keys(threshold)
      if (keys.length !== 1 || !["min", "max", "maxProfileTarget"].includes(keys[0])) {
        problems.push(`thresholds: ${task}.${metric} needs exactly one of min, max, maxProfileTarget`)
      } else if ("maxProfileTarget" in threshold && !["p50Ms", "p95Ms", "costUsd"].includes(threshold.maxProfileTarget)) {
        problems.push(`thresholds: ${task}.${metric} names an unknown profile target`)
      }
    }
  }
  if (!(thresholds?.trust?.minPassRate >= 0 && thresholds.trust.minPassRate <= 1))
    problems.push("thresholds: trust.minPassRate must be 0..1")
  return problems
}

export interface CandidateConfig {
  version: string
  baseline: { id: string; profile: ChatMode }
  candidates: Array<{ id: string; profile: ChatMode; model: string; estimatedCostPerRequestUsd: number | null; costNote?: string }>
}

/** Workers AI text models only: the eval route refuses anything else. */
export const EVAL_MODEL_PATTERN = /^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i

/**
 * Resolves candidates against the live model profiles. The baseline is always
 * the profile's current model, so it can never drift from production. A
 * candidate changes only the model; sampling, timeout and targets stay the
 * profile's, so both run the same task contract.
 */
export function resolveCandidates(config: CandidateConfig, profiles: Record<ChatMode, ModelProfile>) {
  const problems: string[] = []
  const toCandidate = (id: string, mode: ChatMode, model: string, cost: number | null): EvalCandidate => {
    const profile = profiles[mode]
    return {
      id,
      profile: mode,
      model,
      temperature: profile.temperature,
      top_p: profile.top_p,
      max_tokens: profile.max_tokens,
      timeoutMs: profile.timeoutMs,
      estimatedCostPerRequestUsd: cost,
      latencyTargets: { p50Ms: profile.targets.latencyMsP50, p95Ms: profile.targets.latencyMsP95 },
      costTargetUsd: profile.targets.estimatedCostPerRequestUsd
    }
  }

  const baselineProfile = profiles[config?.baseline?.profile]
  if (!baselineProfile) problems.push(`candidates: unknown baseline profile "${config?.baseline?.profile}"`)
  const ids = new Set([config?.baseline?.id])
  for (const entry of config?.candidates || []) {
    if (ids.has(entry.id)) problems.push(`candidates: duplicate id ${entry.id}`)
    ids.add(entry.id)
    if (entry.profile !== config.baseline.profile) problems.push(`candidates: ${entry.id} must use the baseline's profile`)
    if (!EVAL_MODEL_PATTERN.test(entry.model)) problems.push(`candidates: ${entry.id} model must be a Workers AI @cf/ id`)
    if (entry.estimatedCostPerRequestUsd !== null && !(entry.estimatedCostPerRequestUsd > 0)) {
      problems.push(`candidates: ${entry.id} cost must be a positive number or null`)
    }
  }
  if (problems.length) return { problems, baseline: null, candidates: [] }

  return {
    problems,
    baseline: toCandidate(
      config.baseline.id,
      config.baseline.profile,
      baselineProfile.model,
      baselineProfile.targets.estimatedCostPerRequestUsd
    ),
    candidates: config.candidates.map((entry) => toCandidate(entry.id, entry.profile, entry.model, entry.estimatedCostPerRequestUsd))
  }
}
