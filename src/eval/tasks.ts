import type { LibraryCitation } from "../library/chunks"
import type { AiChatMessage } from "../services/ai"
import { buildReviewMessages } from "../review/prompt"
import { parseReviewOutput, toReviewEvidence, type ReviewReadiness } from "../review/contract"
import { buildDriftMessages } from "../drift/prompt"
import {
  DRIFT_COMPARISONS,
  DRIFT_ROLES,
  DRIFT_RULES,
  buildDriftCoverage,
  driftFindingKey,
  finalizeDriftFindings,
  parseDriftOutput,
  toDriftEvidence,
  type DriftRuleId,
  type DriftSource
} from "../drift/contract"
import type { EvalFixture } from "./types"

/** A retrieved passage as the model saw it: `ref` is the id in the prompt, `passageId` the fixture's identity for it. */
export interface EvalEvidence {
  ref: string
  chunkId: string
  passageId: string
  untrusted: boolean
}

export interface PreparedTask {
  messages: AiChatMessage[]
  evidence: EvalEvidence[]
  /** Runs the product's own output contract over a raw model reply. */
  interpret(raw: string | null): TaskOutcome
}

/**
 * What the model asserted, and what the product's contract kept. Raw claims are
 * scored so a contract correction (dropping an invented citation, downgrading an
 * unsupported finding) still counts against the model that made the mistake.
 */
export interface TaskOutcome {
  valid: boolean
  /** Claims the model presented as evidence-backed (review) or as drift (every drift finding). */
  claims: Array<{ passages: string[]; invalidRefs: number; survived: boolean }>
  /** The model's conclusion wording, for prohibited-statement matching. Never stored. */
  conclusionText: string
  /** Readiness as the model wrote it, before the contract's guards. */
  rawReadiness: string | null
  readiness: ReviewReadiness | null
  conflicts: string[][]
  findings: Array<{ rule: DriftRuleId; claim: string[]; counterpart: string[] }>
}

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z"

export function chunkIdFor(fixture: EvalFixture, passageId: string) {
  return `${fixture.id}#${passageId}`
}

function toCitation(fixture: EvalFixture, passage: EvalFixture["passages"][number]): LibraryCitation {
  return {
    id: chunkIdFor(fixture, passage.id),
    label: passage.file,
    fileId: `${fixture.id}:${passage.file}`,
    fileName: passage.file,
    snippet: passage.text
  }
}

/**
 * Builds the exact messages the product would send for this fixture, using the
 * real prompt builders, with the fixture's passages standing in for retrieval.
 * Retrieval is held fixed so every model sees the same evidence in the same order.
 */
export function prepareTask(fixture: EvalFixture): PreparedTask {
  return fixture.task === "architecture-review" ? prepareReview(fixture) : prepareDrift(fixture)
}

function distinctFiles(fixture: EvalFixture) {
  return [...new Map(fixture.passages.map((passage) => [passage.file, passage])).values()]
}

function prepareReview(fixture: EvalFixture): PreparedTask {
  if (!("proposedChange" in fixture.input)) throw new Error(`${fixture.id}: an architecture-review fixture needs a proposedChange input`)

  const reviewEvidence = toReviewEvidence(fixture.passages.map((passage) => toCitation(fixture, passage)))
  const sources = distinctFiles(fixture).map((passage) => ({
    fileId: `${fixture.id}:${passage.file}`,
    fileName: passage.file,
    sourceVersionId: "eval-fixture"
  }))
  const input = {
    proposedChange: fixture.input.proposedChange,
    intendedOutcome: fixture.input.intendedOutcome,
    constraints: fixture.input.constraints || "",
    sourceFileIds: sources.map((source) => source.fileId)
  }
  const evidence = toEvalEvidence(fixture, reviewEvidence)

  return {
    messages: buildReviewMessages(input, sources, reviewEvidence),
    evidence,
    interpret(raw) {
      const parsed = raw === null ? null : parseReviewOutput(raw, reviewEvidence)
      if (!parsed?.ok) return invalidOutcome(raw)

      const data = parseJsonObject(raw!) as Record<string, unknown>
      const rawFindings = Array.isArray(data.findings) ? data.findings.slice(0, parsed.value.findings.length) : []
      const claims = rawFindings.flatMap((candidate, index) => {
        const record = candidate as Record<string, unknown>
        if (normalizeEnum(record.classification) !== "evidence-backed") return []
        return [
          { ...resolveRefs(record.citations, evidence), survived: parsed.value.findings[index]?.classification === "evidence-backed" }
        ]
      })
      const conclusionText = [
        data.rationale,
        ...rawFindings
          .filter((candidate) => normalizeEnum((candidate as Record<string, unknown>).classification) !== "insufficient evidence")
          .flatMap((candidate) => {
            const record = candidate as Record<string, unknown>
            return [record.title, record.detail, record.area]
          }),
        ...(Array.isArray(data.conflicts) ? data.conflicts.map((conflict) => (conflict as Record<string, unknown>)?.description) : [])
      ]
        .filter((value): value is string => typeof value === "string")
        .join("\n")

      return {
        valid: true,
        claims,
        conclusionText,
        rawReadiness: normalizeEnum(data.readiness) || null,
        readiness: parsed.value.readiness,
        conflicts: parsed.value.conflicts.map((conflict) => conflict.citationIds.map((id) => passageOf(evidence, id))),
        findings: []
      }
    }
  }
}

function prepareDrift(fixture: EvalFixture): PreparedTask {
  if (!("scope" in fixture.input)) throw new Error(`${fixture.id}: a drift-detection fixture needs a scope input`)

  const { roles, rules } = DRIFT_COMPARISONS["spec-architecture-implementation"]
  const driftEvidence = toDriftEvidence(
    DRIFT_ROLES.map((role) => ({
      role,
      citations: fixture.passages.filter((passage) => passage.role === role).map((passage) => toCitation(fixture, passage))
    }))
  )
  const sources: DriftSource[] = distinctFiles(fixture).map((passage) => ({
    role: passage.role!,
    fileId: `${fixture.id}:${passage.file}`,
    fileName: passage.file,
    sourceVersionId: "eval-fixture",
    importedAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    supersededBy: null
  }))
  const coverage = buildDriftCoverage(roles, sources, driftEvidence)
  const evidence = toEvalEvidence(fixture, driftEvidence)
  const scope = fixture.input.scope

  return {
    messages: buildDriftMessages({ scope, rules, sources, evidence: driftEvidence, priorFindings: [] }),
    evidence,
    interpret(raw) {
      const parsed = raw === null ? null : parseDriftOutput(raw, { evidence: driftEvidence, sources, coverage, rules })
      if (!parsed?.ok) return invalidOutcome(raw)

      const served = finalizeDriftFindings(parsed.value.findings, [...parsed.value.adjustments])
      const servedKeys = new Set(served.map((finding) => finding.key))
      const data = parseJsonObject(raw!) as Record<string, unknown>
      const rawFindings = (Array.isArray(data.findings) ? data.findings : []).slice(0, 12) as Array<Record<string, unknown>>
      const claims = rawFindings.map((record) => {
        const rule = DRIFT_RULES.find((value) => value === normalizeEnum(record.rule).replace(/\s+/g, "-"))
        const subject = normalizeLine(record.subject) || normalizeLine(record.claim).split(" ").slice(0, 8).join(" ")
        const refs = [
          ...(Array.isArray(record.claimCitations) ? record.claimCitations : []),
          ...(Array.isArray(record.counterpartCitations) ? record.counterpartCitations : [])
        ]
        return { ...resolveRefs(refs, evidence), survived: Boolean(rule && servedKeys.has(driftFindingKey(rule, subject))) }
      })
      const conclusionText = [
        data.summary,
        ...rawFindings.flatMap((record) => [record.subject, record.claim, record.counterpart, record.detail])
      ]
        .filter((value): value is string => typeof value === "string")
        .join("\n")

      return {
        valid: true,
        claims,
        conclusionText,
        rawReadiness: null,
        readiness: null,
        conflicts: [],
        findings: served
          .filter((finding) => finding.rule !== "stale-or-missing-source")
          .map((finding) => ({
            rule: finding.rule,
            claim: finding.claimCitationIds.map((id) => passageOf(evidence, id)),
            counterpart: finding.counterpart.citationIds.map((id) => passageOf(evidence, id))
          }))
      }
    }
  }
}

function toEvalEvidence(fixture: EvalFixture, evidence: Array<{ ref: string; chunkId: string }>): EvalEvidence[] {
  return evidence.map((item) => {
    const passageId = item.chunkId.slice(fixture.id.length + 1)
    return {
      ref: item.ref,
      chunkId: item.chunkId,
      passageId,
      untrusted: Boolean(fixture.passages.find((passage) => passage.id === passageId)?.untrusted)
    }
  })
}

function passageOf(evidence: EvalEvidence[], chunkId: string) {
  return evidence.find((item) => item.chunkId === chunkId)?.passageId || chunkId
}

/** Resolves refs the way the contracts do (E1 or a chunk id, case-insensitive, optional brackets). */
function resolveRefs(value: unknown, evidence: EvalEvidence[]) {
  const passages: string[] = []
  let invalidRefs = 0

  for (const ref of Array.isArray(value) ? value : []) {
    if (typeof ref !== "string" || !ref.trim()) continue
    const key = ref
      .trim()
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
    const item = evidence.find((candidate) => candidate.ref.toLowerCase() === key || candidate.chunkId.toLowerCase() === key)
    if (!item) invalidRefs += 1
    else if (!passages.includes(item.passageId)) passages.push(item.passageId)
  }

  return { passages, invalidRefs }
}

function invalidOutcome(raw: string | null): TaskOutcome {
  // Prose instead of JSON is all conclusion, so it is still checked for prohibited statements.
  return { valid: false, claims: [], conclusionText: raw || "", rawReadiness: null, readiness: null, conflicts: [], findings: [] }
}

/** Mirrors the contracts' parser: bare JSON, or JSON in a Markdown code fence. */
function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i)
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed)
  } catch {
    return null
  }
}

function normalizeEnum(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ") : ""
}

function normalizeLine(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) : ""
}
