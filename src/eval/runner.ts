import type { AiChatMessage } from "../services/ai"
import type { ModelProfile } from "../config/modelProfiles"
import { REVIEW_CONTEXT_POLICY_VERSION } from "../review/contract"
import { DRIFT_POLICY_VERSION } from "../drift/contract"
import { prepareTask, type EvalEvidence } from "./tasks"
import { aggregateByTask, aggregateScores, aggregateTrust, scoreFixture } from "./score"
import { evaluateGate, type EvalThresholds, type GateResult } from "./gate"
import { EVAL_TASKS, type CandidateResult, type EvalCandidate, type EvalDataset, type EvalFixture, type ModelCompletion } from "./types"

export const REPORT_SCHEMA_VERSION = 1

export interface CompletionRequest {
  candidate: EvalCandidate
  messages: AiChatMessage[]
  fixture: EvalFixture
  evidence: EvalEvidence[]
}

export interface ModelBackend {
  /** "scripted" never calls a model; its reports are pipeline-only and can never justify a routing change. */
  kind: "scripted" | "workers-ai"
  complete(request: CompletionRequest): Promise<ModelCompletion>
}

export interface EvalReport {
  schemaVersion: number
  reportId: string
  label: string
  createdAt: string
  backend: ModelBackend["kind"]
  evidenceGrade: "pipeline-only" | "real-model"
  datasetVersion: string
  thresholdsVersion: string
  candidatesVersion: string
  /** The task contracts every candidate ran under. */
  contracts: { architectureReview: string; driftDetection: string }
  fixtureIds: string[]
  baselineId: string
  results: CandidateResult[]
  gate: GateResult[]
}

export interface RunOptions {
  dataset: EvalDataset
  baseline: EvalCandidate
  candidates: EvalCandidate[]
  backend: ModelBackend
  thresholds: EvalThresholds
  candidatesVersion: string
  label: string
  now?: Date
  onProgress?: (event: { candidateId: string; fixtureId: string; done: number; total: number }) => void
}

/**
 * Runs every fixture against the baseline and then each candidate, with the
 * same prepared messages, scores them, and applies the promotion gate to each
 * candidate. The report holds scores and ids only.
 */
export async function runEvaluation(options: RunOptions): Promise<EvalReport> {
  const { dataset, baseline, candidates, backend, thresholds } = options
  const prepared = dataset.fixtures.map((fixture) => ({ fixture, task: prepareTask(fixture) }))
  const everyone = [baseline, ...candidates]
  const total = everyone.length * prepared.length
  const results: CandidateResult[] = []
  let done = 0

  for (const candidate of everyone) {
    const scores = []
    for (const { fixture, task } of prepared) {
      const completion = await backend.complete({ candidate, messages: task.messages, fixture, evidence: task.evidence })
      if (completion.servedModel !== candidate.model) {
        throw new Error(
          `${candidate.id}: the backend served ${completion.servedModel}, not ${candidate.model}; the comparison would be invalid.`
        )
      }
      scores.push(scoreFixture(fixture, task.evidence, task.interpret(completion.text), completion))
      options.onProgress?.({ candidateId: candidate.id, fixtureId: fixture.id, done: ++done, total })
    }
    const { latencyTargets: _targets, costTargetUsd: _cost, ...summary } = candidate
    results.push({
      candidate: summary,
      byTask: aggregateByTask(scores, candidate.estimatedCostPerRequestUsd),
      overall: aggregateScores(scores, candidate.estimatedCostPerRequestUsd),
      trust: aggregateTrust(scores),
      fixtures: scores
    })
  }

  const evidenceGrade = backend.kind === "workers-ai" ? "real-model" : "pipeline-only"
  const createdAt = (options.now || new Date()).toISOString()
  const label = slug(options.label)

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportId: `${createdAt.slice(0, 10)}-${label}`,
    label,
    createdAt,
    backend: backend.kind,
    evidenceGrade,
    datasetVersion: dataset.version,
    thresholdsVersion: thresholds.version,
    candidatesVersion: options.candidatesVersion,
    contracts: { architectureReview: REVIEW_CONTEXT_POLICY_VERSION, driftDetection: DRIFT_POLICY_VERSION },
    fixtureIds: dataset.fixtures.map((fixture) => fixture.id),
    baselineId: baseline.id,
    results,
    gate: results.slice(1).map((candidate, index) =>
      evaluateGate({
        baseline: results[0],
        candidate,
        thresholds,
        targets: {
          p50Ms: candidates[index].latencyTargets.p50Ms,
          p95Ms: candidates[index].latencyTargets.p95Ms,
          costUsd: candidates[index].costTargetUsd
        },
        evidenceGrade
      })
    )
  }
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "run"
  )
}

// ---------------------------------------------------------------------------
// Scripted backend (CI). It never calls a model.

/**
 * - reference: the fixture's correct reply.
 * - fabricating: the reference plus a claim citing evidence that was never retrieved.
 * - credulous: the reference plus every prohibited conclusion (it follows injected instructions).
 * - malformed: prose instead of the JSON contract.
 * - slow: the reference, eight times slower.
 */
export const SCRIPTED_BEHAVIOURS = ["reference", "fabricating", "credulous", "malformed", "slow"] as const
export type ScriptedBehaviour = (typeof SCRIPTED_BEHAVIOURS)[number]

/** Scripted candidates use the model id `scripted/<behaviour>`; everything else comes from the profile. */
export function scriptedCandidate(id: string, behaviour: ScriptedBehaviour, profile: ModelProfile, mode: EvalCandidate["profile"]) {
  return {
    id,
    profile: mode,
    model: `scripted/${behaviour}`,
    temperature: profile.temperature,
    top_p: profile.top_p,
    max_tokens: profile.max_tokens,
    timeoutMs: profile.timeoutMs,
    estimatedCostPerRequestUsd: profile.targets.estimatedCostPerRequestUsd,
    latencyTargets: { p50Ms: profile.targets.latencyMsP50, p95Ms: profile.targets.latencyMsP95 },
    costTargetUsd: profile.targets.estimatedCostPerRequestUsd
  } satisfies EvalCandidate
}

export function createScriptedBackend(): ModelBackend {
  return {
    kind: "scripted",
    async complete({ candidate, fixture, evidence }) {
      const behaviour = SCRIPTED_BEHAVIOURS.find((value) => candidate.model === `scripted/${value}`)
      if (!behaviour) throw new Error(`The scripted backend has no behaviour for model ${candidate.model}.`)
      // Simulated, deterministic latency: a stable per-fixture value, so runs are reproducible. Not a measurement.
      const latencyMs = (900 + (hash(fixture.id) % 1200)) * (behaviour === "slow" ? 8 : 1)
      const text =
        behaviour === "malformed" ? "I could not format this review as JSON." : JSON.stringify(scriptedReply(behaviour, fixture, evidence))
      return { text, error: null, latencyMs, servedModel: candidate.model }
    }
  }
}

function scriptedReply(behaviour: ScriptedBehaviour, fixture: EvalFixture, evidence: EvalEvidence[]) {
  const refOf = (passageId: string) => evidence.find((item) => item.passageId === passageId)?.ref || "E99"
  const reply = resolvePlaceholders(fixture.reference, refOf) as Record<string, unknown>
  const findings = reply.findings as Array<Record<string, unknown>>
  const isReview = fixture.task === "architecture-review"

  if (behaviour === "fabricating") {
    findings.push(
      isReview
        ? {
            title: "The change depends on an upstream service",
            detail: "Asserted without a retrieved source.",
            classification: "evidence-backed",
            areaType: "component",
            area: "upstream service",
            citations: ["E97"]
          }
        : {
            rule: "interface-contradiction",
            subject: "upstream timeout",
            claim: "The upstream timeout differs between roles.",
            counterpart: "A different timeout.",
            confidence: "high",
            claimCitations: ["E97"],
            counterpartCitations: ["E98"]
          }
    )
  }

  if (behaviour === "credulous") {
    for (const rule of fixture.prohibited) {
      if (rule.kind === "readiness") reply.readiness = rule.value
      if (rule.kind === "statement") {
        const field = isReview ? "rationale" : "summary"
        reply[field] = `${reply[field]} ${rule.example}`
      }
      if (rule.kind === "citation") {
        findings.push(
          isReview
            ? {
                title: "The source settles this",
                detail: "Taken from the cited passage.",
                classification: "evidence-backed",
                areaType: "other",
                area: "",
                citations: [refOf(rule.passage)]
              }
            : {
                rule: "interface-contradiction",
                subject: "instructed finding",
                claim: "The cited passage asks for this finding.",
                counterpart: "As instructed.",
                confidence: "high",
                claimCitations: [refOf(rule.passage)],
                counterpartCitations: evidence.filter((item) => item.passageId !== rule.passage).map((item) => item.ref)
              }
        )
      }
    }
  }

  return reply
}

/** Replaces "@P1" strings with the evidence ref the passage received in this prompt. */
function resolvePlaceholders(value: unknown, refOf: (passageId: string) => string): unknown {
  if (typeof value === "string") return value.startsWith("@P") ? refOf(value.slice(1)) : value
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, refOf))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item, refOf)]))
  }
  return value
}

function hash(value: string) {
  let result = 0
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) >>> 0
  return result
}

// ---------------------------------------------------------------------------
// Workers AI backend (operator only). Calls the eval route of a running
// `wrangler dev --remote` Worker started with LYTA_EVAL_MODE=enabled.

export const EVAL_ROUTE_PATH = "/__eval/complete"
export const EVAL_TOKEN_HEADER = "x-lyta-eval-token"

export function createWorkersAiBackend(options: { url: string; token: string; fetch?: typeof fetch }): ModelBackend {
  const send = options.fetch || fetch
  const endpoint = new URL(EVAL_ROUTE_PATH, options.url).toString()

  return {
    kind: "workers-ai",
    // Only the prepared messages and the candidate's model and sampling leave this process; fixture metadata does not.
    async complete({ candidate, messages }) {
      const response = await send(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", [EVAL_TOKEN_HEADER]: options.token },
        body: JSON.stringify({
          model: candidate.model,
          messages,
          temperature: candidate.temperature,
          top_p: candidate.top_p,
          max_tokens: candidate.max_tokens,
          timeoutMs: candidate.timeoutMs
        })
      }).catch((error: unknown) => {
        throw new Error(`Could not reach ${endpoint} (${error instanceof Error ? error.message : error}); is wrangler dev running?`)
      })

      if (response.status === 404) {
        throw new Error(`${endpoint} returned 404: start the Worker with --var LYTA_EVAL_MODE:enabled (see eval/README.md).`)
      }
      if (response.status === 401) throw new Error(`${endpoint} rejected the eval token: LYTA_EVAL_TOKEN must match the Worker's.`)
      if (!response.ok) throw new Error(`${endpoint} returned ${response.status}.`)

      const body = (await response.json()) as { response?: unknown; error?: string; latencyMs?: number; model?: string }
      const error = body.error === "timeout" || body.error === "model-error" ? body.error : null
      return {
        text: !error && typeof body.response === "string" ? body.response : null,
        error: error || (typeof body.response === "string" ? null : "model-error"),
        latencyMs: typeof body.latencyMs === "number" ? body.latencyMs : 0,
        servedModel: typeof body.model === "string" ? body.model : ""
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown summary

const METRIC_ROWS: Array<[keyof CandidateResult["overall"], string, "rate" | "ms" | "usd"]> = [
  ["evidencePrecision", "Evidence precision", "rate"],
  ["evidenceRecall", "Evidence recall", "rate"],
  ["citationCorrectness", "Citation correctness", "rate"],
  ["unsupportedClaimRate", "Unsupported-claim rate", "rate"],
  ["structuredOutputValidity", "Structured-output validity", "rate"],
  ["taskAccuracy", "Task accuracy", "rate"],
  ["latencyP50Ms", "Latency p50", "ms"],
  ["latencyP95Ms", "Latency p95", "ms"],
  ["estimatedCostPerRequestUsd", "Est. cost / request", "usd"]
]

export function renderReportMarkdown(report: EvalReport) {
  const format = (value: number | null, kind: "rate" | "ms" | "usd") =>
    value === null
      ? "n/a"
      : kind === "rate"
        ? `${(value * 100).toFixed(1)}%`
        : kind === "ms"
          ? `${Math.round(value)} ms`
          : `$${value.toFixed(4)}`
  const header = `| Metric | ${report.results.map((result) => `\`${result.candidate.id}\``).join(" | ")} |`
  const divider = `|---|${report.results.map(() => "---").join("|")}|`

  const lines = [
    `# Model evaluation: ${report.reportId}`,
    "",
    report.evidenceGrade === "pipeline-only"
      ? "> **Pipeline-only.** Produced by the scripted backend: no model was called and latency is simulated. This shows the harness and gate work. It is not evidence about any model and cannot justify a routing change."
      : "> **Real-model run** against Workers AI through the eval route. Review this report before merging any routing change it supports.",
    "",
    `- Backend: \`${report.backend}\``,
    `- Dataset \`${report.datasetVersion}\`, thresholds \`${report.thresholdsVersion}\`, candidates \`${report.candidatesVersion}\``,
    `- Contracts: review \`${report.contracts.architectureReview}\`, drift \`${report.contracts.driftDetection}\``,
    `- Fixtures: ${report.fixtureIds.length}; baseline \`${report.baselineId}\``,
    `- Created: ${report.createdAt}`,
    "",
    "## Gate",
    "",
    "| Candidate | Model | Decision | Promotion eligible | Reasons |",
    "|---|---|---|---|---|",
    ...report.gate.map(
      (result) =>
        `| \`${result.candidateId}\` | \`${result.model}\` | ${result.decision} | ${result.promotionEligible ? "yes" : "no"} | ${
          result.reasons.length ? result.reasons.join("<br>") : "All checks passed."
        } |`
    ),
    ""
  ]

  for (const task of EVAL_TASKS) {
    lines.push(`## ${task}`, "", header, divider)
    for (const [metric, label, kind] of METRIC_ROWS) {
      lines.push(`| ${label} | ${report.results.map((result) => format(result.byTask[task][metric] as number | null, kind)).join(" | ")} |`)
    }
    lines.push(`| Prohibited conclusions | ${report.results.map((result) => result.byTask[task].prohibitedConclusions).join(" | ")} |`, "")
  }

  lines.push("## Trust fixtures", "", header.replace("Metric", "Trust"), divider)
  lines.push(`| Pass rate | ${report.results.map((result) => format(result.trust.passRate, "rate")).join(" | ")} |`)
  lines.push(`| Failed | ${report.results.map((result) => result.trust.failedFixtureIds.join(", ") || "none").join(" | ")} |`, "")
  return lines.join("\n")
}
