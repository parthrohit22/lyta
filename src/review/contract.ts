import type { LibraryCitation } from "../library/chunks"

/** Recorded on the context-selection manifest of every review retrieval. */
export const REVIEW_CONTEXT_POLICY_VERSION = "2026-11-03.architecture-review"
/** Recorded on the context-selection manifest of every challenge retrieval. */
export const REVIEW_CHALLENGE_POLICY_VERSION = "2026-11-03.architecture-review.challenge"

export const REVIEW_READINESS = ["ready", "needs evidence", "blocked"] as const
export const FINDING_CLASSIFICATIONS = ["evidence-backed", "inference", "recommendation", "insufficient evidence"] as const
export const FINDING_AREA_TYPES = ["component", "interface", "data-path", "prior-decision", "operations", "other"] as const
export const FINDING_DISPOSITIONS = ["accepted", "rejected", "unresolved"] as const
/** What an accepted finding is saved as in the canonical project context. */
export const FINDING_RECORD_KINDS = ["finding", "decision", "risk", "assumption", "follow-up"] as const
export const CHALLENGE_OUTCOMES = ["upheld", "revised", "withdrawn", "insufficient evidence"] as const

export type ReviewReadiness = (typeof REVIEW_READINESS)[number]
export type FindingClassification = (typeof FINDING_CLASSIFICATIONS)[number]
export type FindingAreaType = (typeof FINDING_AREA_TYPES)[number]
export type FindingDisposition = (typeof FINDING_DISPOSITIONS)[number]
export type FindingRecordKind = (typeof FINDING_RECORD_KINDS)[number]
export type ChallengeOutcome = (typeof CHALLENGE_OUTCOMES)[number]

const MAX_CHANGE_LENGTH = 4000
const MAX_OUTCOME_LENGTH = 1200
const MAX_CONSTRAINTS_LENGTH = 1200
const MAX_SELECTED_SOURCES = 8
const MAX_FINDINGS = 12
const MAX_CONFLICTS = 6
const MAX_LIST_ITEMS = 8
const MAX_LINE_LENGTH = 400
const MAX_DETAIL_LENGTH = 1200
const MAX_DISPOSITION_NOTE_LENGTH = 500
const MAX_CHALLENGES_PER_FINDING = 10

export interface ReviewInput {
  proposedChange: string
  intendedOutcome: string
  sourceFileIds: string[]
  constraints: string
}

/** A retrieved chunk the model was shown, addressed in the prompt by `ref` (E1, E2, ...). */
export interface ReviewEvidence {
  ref: string
  chunkId: string
  fileId: string
  fileName: string
  snippet: string
  /** Set when the source file is deleted after the review was created; the snippet is then cleared. */
  sourceDeleted?: boolean
}

export interface ReviewSource {
  fileId: string
  fileName: string
  sourceVersionId: string
}

export interface ReviewFinding {
  id: string
  title: string
  detail: string
  classification: FindingClassification
  areaType: FindingAreaType
  area: string
  /** Canonical chunk ids from the retrieved evidence set; never ids the model invented. */
  citationIds: string[]
  /** Server-side corrections applied to this finding, e.g. a downgrade from evidence-backed. */
  adjustments: string[]
  disposition: FindingDisposition
  dispositionNote: string
  dispositionUpdatedAt: string | null
  /** The canonical context record created when the finding is accepted. */
  contextRecordId: string | null
  /** The context record kind the accepted finding was saved as. */
  recordKind: FindingRecordKind | null
  /** Set when a challenge found counter-evidence that retracts the finding. */
  withdrawn: boolean
  /** Oldest first. Each entry keeps the finding as it was before that challenge. */
  challenges: FindingChallenge[]
}

/** The parts of a finding a challenge can change. */
export interface FindingSnapshot {
  title: string
  detail: string
  classification: FindingClassification
  areaType: FindingAreaType
  area: string
  citationIds: string[]
}

export interface FindingChallenge {
  id: string
  requestId: string
  createdAt: string
  /** The reviewer's reason for doubting the finding, if they gave one. */
  reason: string
  outcome: ChallengeOutcome
  conclusionChanged: boolean
  rationale: string
  /** Chunk ids of the retrieved passages the challenge relied on. */
  counterEvidenceIds: string[]
  before: FindingSnapshot
  after: FindingSnapshot | null
  adjustments: string[]
}

export interface ReviewConflict {
  description: string
  citationIds: string[]
}

export interface ReviewOutput {
  readiness: ReviewReadiness
  rationale: string
  findings: ReviewFinding[]
  conflicts: ReviewConflict[]
  requiredTests: string[]
  observability: string[]
  rollback: string[]
  missingEvidence: string[]
  assumptions: string[]
  openQuestions: string[]
  nextActions: string[]
  /** Review-level server corrections, e.g. readiness lowered because nothing was evidence-backed. */
  adjustments: string[]
}

export interface ArchitectureReview extends ReviewOutput {
  id: string
  type: "architecture-change"
  requestId: string
  input: ReviewInput
  sources: ReviewSource[]
  evidence: ReviewEvidence[]
  modelVersion: string
  policyVersion: string
  createdAt: string
  updatedAt: string
}

export type ReviewInputResult = { ok: true; value: ReviewInput } | { ok: false; error: string }
export type ReviewOutputResult = { ok: true; value: ReviewOutput } | { ok: false; error: string }

export function validateReviewInput(body: unknown): ReviewInputResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Body missing" }
  }

  const payload = body as Record<string, unknown>

  for (const field of ["proposedChange", "intendedOutcome", "constraints"]) {
    if (payload[field] != null && typeof payload[field] !== "string") {
      return { ok: false, error: `${field} must be a string` }
    }
  }

  if (!Array.isArray(payload.sourceFileIds) || payload.sourceFileIds.some((id) => typeof id !== "string")) {
    return { ok: false, error: "sourceFileIds must be an array of library file ids" }
  }

  const proposedChange = normalizeBlock(payload.proposedChange, MAX_CHANGE_LENGTH)
  const intendedOutcome = normalizeBlock(payload.intendedOutcome, MAX_OUTCOME_LENGTH)
  const sourceFileIds = [...new Set(payload.sourceFileIds.map((id) => normalizeLine(id, 120)).filter(Boolean))]

  if (!proposedChange) {
    return { ok: false, error: "Describe the proposed change" }
  }

  if (!intendedOutcome) {
    return { ok: false, error: "Describe the intended outcome" }
  }

  if (!sourceFileIds.length) {
    return { ok: false, error: "Select at least one library source" }
  }

  if (sourceFileIds.length > MAX_SELECTED_SOURCES) {
    return { ok: false, error: `Select at most ${MAX_SELECTED_SOURCES} sources` }
  }

  return {
    ok: true,
    value: {
      proposedChange,
      intendedOutcome,
      sourceFileIds,
      constraints: normalizeBlock(payload.constraints, MAX_CONSTRAINTS_LENGTH)
    }
  }
}

export function normalizeDisposition(value: unknown): FindingDisposition | null {
  return FINDING_DISPOSITIONS.includes(value as FindingDisposition) ? (value as FindingDisposition) : null
}

export function normalizeDispositionNote(value: unknown) {
  return normalizeBlock(value, MAX_DISPOSITION_NOTE_LENGTH)
}

export function normalizeRecordKind(value: unknown): FindingRecordKind {
  return FINDING_RECORD_KINDS.find((kind) => kind === normalizeEnumValue(value)) || "finding"
}

export function normalizeChallengeReason(value: unknown) {
  return normalizeBlock(value, MAX_DISPOSITION_NOTE_LENGTH)
}

export function toReviewEvidence(citations: LibraryCitation[]): ReviewEvidence[] {
  return citations.map((citation, index) => ({
    ref: `E${index + 1}`,
    chunkId: citation.id,
    fileId: citation.fileId,
    fileName: citation.fileName,
    snippet: citation.snippet
  }))
}

/**
 * Parses and strictly validates the model's JSON review. Structural problems
 * (not JSON, missing readiness/rationale/findings, unknown enum values) are
 * rejected outright so a malformed reply can never be shown as a review.
 * Grounding problems are corrected rather than rejected, and every correction
 * is recorded in `adjustments` so the brief shows what the server changed:
 *
 * - citations that are not in the retrieved evidence set are dropped;
 * - an `evidence-backed` finding left with no valid citation becomes `inference`;
 * - a conflict needs two valid citations from different chunks, or it is dropped;
 * - `ready` requires at least one evidence-backed finding and no open conflicts.
 */
export function parseReviewOutput(raw: unknown, evidence: ReviewEvidence[]): ReviewOutputResult {
  const parsed = typeof raw === "string" ? parseJsonObject(raw) : raw

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "The review model did not return a JSON object." }
  }

  const data = parsed as Record<string, unknown>
  const readiness = REVIEW_READINESS.find((value) => value === normalizeEnumValue(data.readiness))

  if (!readiness) {
    return { ok: false, error: "The review model returned an unknown readiness state." }
  }

  const rationale = normalizeBlock(data.rationale, MAX_DETAIL_LENGTH)

  if (!rationale) {
    return { ok: false, error: "The review model did not explain its readiness state." }
  }

  if (!Array.isArray(data.findings)) {
    return { ok: false, error: "The review model did not return a findings list." }
  }

  const lists: Record<ReviewListKey, string[]> = {
    requiredTests: [],
    observability: [],
    rollback: [],
    missingEvidence: [],
    assumptions: [],
    openQuestions: [],
    nextActions: []
  }

  for (const key of Object.keys(lists) as Array<keyof typeof lists>) {
    const value = data[key]
    if (value == null) continue
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return { ok: false, error: `The review model returned an invalid ${key} list.` }
    }
    lists[key] = value
      .map((item) => normalizeLine(item, MAX_LINE_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_LIST_ITEMS)
  }

  const resolveRef = createCitationResolver(evidence)
  const findings: ReviewFinding[] = []

  for (const [index, candidate] of data.findings.slice(0, MAX_FINDINGS).entries()) {
    const finding = parseFinding(candidate, `F${index + 1}`, resolveRef)
    if (!finding) {
      return { ok: false, error: `The review model returned a malformed finding (#${index + 1}).` }
    }
    findings.push(finding)
  }

  const adjustments: string[] = []
  const conflicts: ReviewConflict[] = []

  if (data.conflicts != null && !Array.isArray(data.conflicts)) {
    return { ok: false, error: "The review model returned an invalid conflicts list." }
  }

  for (const candidate of (Array.isArray(data.conflicts) ? data.conflicts : []).slice(0, MAX_CONFLICTS)) {
    const record = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {}
    const description = normalizeLine(record.description, MAX_LINE_LENGTH)
    const citationIds = resolveCitations(record.citations, resolveRef).citationIds

    if (!description) {
      return { ok: false, error: "The review model returned a conflict without a description." }
    }

    if (citationIds.length < 2) {
      adjustments.push(`Dropped a conflict without two retrieved sources to compare: "${description}"`)
      continue
    }

    conflicts.push({ description, citationIds })
  }

  const guarded = applyReadinessGuards(readiness, { evidenceCount: evidence.length, findings, conflicts })
  adjustments.push(...guarded.adjustments)

  const missingEvidence = [...lists.missingEvidence]

  if (!evidence.length && !missingEvidence.length) {
    missingEvidence.push(
      "No passages from the selected sources matched this change. Add design, runbook, or decision documents that cover it."
    )
  }

  return {
    ok: true,
    value: {
      readiness: guarded.readiness,
      rationale,
      findings,
      conflicts,
      ...lists,
      missingEvidence,
      adjustments
    }
  }
}

type ReviewListKey = "requiredTests" | "observability" | "rollback" | "missingEvidence" | "assumptions" | "openQuestions" | "nextActions"

/**
 * `ready` is only allowed when something retrieved backs it: at least one
 * active evidence-backed finding and no open conflict. These guards only ever
 * lower readiness, and they run both on a new review and after a challenge.
 */
export function applyReadinessGuards(
  readiness: ReviewReadiness,
  state: { evidenceCount: number; findings: ReviewFinding[]; conflicts: ReviewConflict[] }
) {
  if (readiness !== "ready") {
    return { readiness, adjustments: [] as string[] }
  }

  const reason = !state.evidenceCount
    ? "no evidence was retrieved from the selected sources."
    : !state.findings.some((finding) => finding.classification === "evidence-backed" && !finding.withdrawn)
      ? "no finding is backed by retrieved evidence."
      : state.conflicts.length
        ? "the selected sources conflict and must be reconciled first."
        : ""

  return reason
    ? { readiness: "needs evidence" as ReviewReadiness, adjustments: [`Readiness lowered from ready: ${reason}`] }
    : { readiness, adjustments: [] as string[] }
}

function parseFinding(candidate: unknown, id: string, resolveRef: (ref: string) => string | null): ReviewFinding | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null

  const record = candidate as Record<string, unknown>
  const title = normalizeLine(record.title, 160)
  const classification = FINDING_CLASSIFICATIONS.find((value) => value === normalizeEnumValue(record.classification))
  const areaType = FINDING_AREA_TYPES.find((value) => value === normalizeEnumValue(record.areaType)) || "other"

  if (!title || !classification) return null
  if (record.citations != null && !Array.isArray(record.citations)) return null

  const { citationIds, unknownRefs } = resolveCitations(record.citations, resolveRef)
  const adjustments: string[] = []

  if (unknownRefs.length) {
    adjustments.push(`Removed citations not in the retrieved evidence: ${unknownRefs.join(", ")}.`)
  }

  let finalClassification: FindingClassification = classification

  if (classification === "evidence-backed" && !citationIds.length) {
    finalClassification = "inference"
    adjustments.push("Downgraded from evidence-backed to inference: no retrieved source supports it.")
  }

  return {
    id,
    title,
    detail: normalizeBlock(record.detail, MAX_DETAIL_LENGTH),
    classification: finalClassification,
    areaType,
    area: normalizeLine(record.area, 160),
    citationIds,
    adjustments,
    disposition: "unresolved",
    dispositionNote: "",
    dispositionUpdatedAt: null,
    contextRecordId: null,
    recordKind: null,
    withdrawn: false,
    challenges: []
  }
}

/** Fills fields added after a review was stored, so older reviews still render and export. */
export function hydrateReview(review: ArchitectureReview): ArchitectureReview {
  return {
    ...review,
    assumptions: review.assumptions || [],
    openQuestions: review.openQuestions || [],
    nextActions: review.nextActions || [],
    findings: review.findings.map((finding) => ({
      ...finding,
      recordKind: finding.recordKind || (finding.contextRecordId ? "finding" : null),
      withdrawn: Boolean(finding.withdrawn),
      challenges: finding.challenges || []
    }))
  }
}

/**
 * Gives a challenge's retrieved passages refs in the review's own E-numbering:
 * a chunk the review already cites keeps its ref, and a new chunk gets the
 * next free number. `added` is what must be appended to the review's evidence.
 */
export function mergeChallengeEvidence(existing: ReviewEvidence[], citations: LibraryCitation[]) {
  let next = existing.reduce((max, item) => Math.max(max, Number.parseInt(item.ref.slice(1), 10) || 0), 0)
  const added: ReviewEvidence[] = []
  const evidence = citations.map((citation) => {
    const known = existing.find((item) => item.chunkId === citation.id)
    if (known) return known
    next += 1
    const item = { ref: `E${next}`, chunkId: citation.id, fileId: citation.fileId, fileName: citation.fileName, snippet: citation.snippet }
    added.push(item)
    return item
  })

  return { evidence, added }
}

export interface ChallengeResult {
  outcome: ChallengeOutcome
  rationale: string
  counterEvidenceIds: string[]
  revised: FindingSnapshot | null
  adjustments: string[]
}

export type ChallengeResultParse = { ok: true; value: ChallengeResult } | { ok: false; error: string }

/** The result recorded when no passage in the selected sources matched the challenge, so no model call is made. */
export function insufficientChallengeResult(): ChallengeResult {
  return {
    outcome: "insufficient evidence",
    rationale: "No passage in the selected sources matched this challenge, so the finding was neither confirmed nor refuted.",
    counterEvidenceIds: [],
    revised: null,
    adjustments: []
  }
}

/**
 * Validates a challenge reply with the same rules as a review: malformed
 * structure is an error; grounding is corrected. A conclusion may only change
 * (`revised` or `withdrawn`) when the reply cites retrieved counter-evidence;
 * otherwise the outcome becomes `insufficient evidence` and the finding stays.
 */
export function parseChallengeOutput(raw: unknown, evidence: ReviewEvidence[], finding: ReviewFinding): ChallengeResultParse {
  const parsed = typeof raw === "string" ? parseJsonObject(raw) : raw

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "The challenge model did not return a JSON object." }
  }

  const data = parsed as Record<string, unknown>
  const outcome = CHALLENGE_OUTCOMES.find((value) => value === normalizeEnumValue(data.outcome))
  const rationale = normalizeBlock(data.rationale, MAX_DETAIL_LENGTH)

  if (!outcome) {
    return { ok: false, error: "The challenge model returned an unknown outcome." }
  }

  if (!rationale) {
    return { ok: false, error: "The challenge model did not explain its outcome." }
  }

  if (data.counterEvidence != null && !Array.isArray(data.counterEvidence)) {
    return { ok: false, error: "The challenge model returned an invalid counterEvidence list." }
  }

  const resolveRef = createCitationResolver(evidence)
  const { citationIds: counterEvidenceIds, unknownRefs } = resolveCitations(data.counterEvidence, resolveRef)
  const adjustments: string[] = unknownRefs.length ? [`Removed citations not in the retrieved evidence: ${unknownRefs.join(", ")}.`] : []
  let revised: FindingSnapshot | null = null

  if (outcome === "revised") {
    const candidate = parseFinding(data.revisedFinding, finding.id, resolveRef)
    if (!candidate) {
      return { ok: false, error: "The challenge model revised the finding without a valid revisedFinding." }
    }
    revised = toSnapshot(candidate)
    adjustments.push(...candidate.adjustments)
  }

  let finalOutcome: ChallengeOutcome = outcome

  if ((outcome === "revised" || outcome === "withdrawn") && !counterEvidenceIds.length) {
    finalOutcome = "insufficient evidence"
    revised = null
    adjustments.push(`Conclusion kept: the challenge proposed "${outcome}" without citing retrieved counter-evidence.`)
  } else if (!evidence.length && outcome !== "insufficient evidence") {
    finalOutcome = "insufficient evidence"
    revised = null
    adjustments.push("Conclusion kept: no evidence was retrieved for this challenge.")
  }

  return { ok: true, value: { outcome: finalOutcome, rationale, counterEvidenceIds, revised, adjustments } }
}

/**
 * Applies a validated challenge to a stored review in place. The finding's
 * prior state is kept in the challenge history; a changed conclusion clears
 * the old disposition (the caller removes its context record) and re-runs the
 * readiness guards. Returns the context record id that must be removed, if any.
 */
export function applyChallenge(
  review: ArchitectureReview,
  finding: ReviewFinding,
  result: ChallengeResult,
  meta: { requestId: string; reason: string; addedEvidence: ReviewEvidence[]; now: string }
) {
  const before = toSnapshot(finding)
  const conclusionChanged = result.outcome === "revised" || result.outcome === "withdrawn"
  const challenge: FindingChallenge = {
    id: `${finding.id}-C${finding.challenges.length + 1}`,
    requestId: meta.requestId,
    createdAt: meta.now,
    reason: meta.reason,
    outcome: result.outcome,
    conclusionChanged,
    rationale: result.rationale,
    counterEvidenceIds: result.counterEvidenceIds,
    before,
    after: result.revised,
    adjustments: [...result.adjustments]
  }
  let staleContextRecordId: string | null = null

  review.evidence.push(...meta.addedEvidence.filter((item) => !review.evidence.some((known) => known.chunkId === item.chunkId)))

  if (conclusionChanged) {
    if (result.revised) {
      Object.assign(finding, result.revised)
    } else {
      finding.withdrawn = true
    }

    if (finding.disposition !== "unresolved") {
      challenge.adjustments.push(`Disposition "${finding.disposition}" cleared: it applied to the previous conclusion.`)
    }
    staleContextRecordId = finding.contextRecordId
    finding.disposition = "unresolved"
    finding.dispositionNote = ""
    finding.dispositionUpdatedAt = meta.now
    finding.contextRecordId = null
    finding.recordKind = null

    const guarded = applyReadinessGuards(review.readiness, {
      evidenceCount: review.evidence.length,
      findings: review.findings,
      conflicts: review.conflicts
    })
    if (guarded.readiness !== review.readiness) {
      review.readiness = guarded.readiness
      review.adjustments.push(...guarded.adjustments.map((adjustment) => `${adjustment} (after challenge ${challenge.id})`))
    }
  }

  finding.challenges = [...finding.challenges, challenge].slice(-MAX_CHALLENGES_PER_FINDING)
  review.updatedAt = meta.now

  return { challenge, staleContextRecordId }
}

function toSnapshot(finding: ReviewFinding): FindingSnapshot {
  return {
    title: finding.title,
    detail: finding.detail,
    classification: finding.classification,
    areaType: finding.areaType,
    area: finding.area,
    citationIds: [...finding.citationIds]
  }
}

function createCitationResolver(evidence: ReviewEvidence[]) {
  const byRef = new Map<string, string>()

  for (const item of evidence) {
    byRef.set(item.ref.toLowerCase(), item.chunkId)
    byRef.set(item.chunkId.toLowerCase(), item.chunkId)
  }

  return (ref: string) =>
    byRef.get(
      ref
        .trim()
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
    ) || null
}

function resolveCitations(value: unknown, resolveRef: (ref: string) => string | null) {
  const citationIds: string[] = []
  const unknownRefs: string[] = []

  for (const ref of Array.isArray(value) ? value : []) {
    if (typeof ref !== "string" || !ref.trim()) continue
    const chunkId = resolveRef(ref)
    if (chunkId) {
      if (!citationIds.includes(chunkId)) citationIds.push(chunkId)
    } else {
      unknownRefs.push(normalizeLine(ref, 40))
    }
  }

  return { citationIds, unknownRefs: [...new Set(unknownRefs)].slice(0, 6) }
}

/** Accepts bare JSON or JSON wrapped in a Markdown code fence; anything else is malformed. */
function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i)
  const body = fenced ? fenced[1] : trimmed

  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function normalizeEnumValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ") : ""
}

function normalizeLine(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value
        .replace(/\u0000/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength)
    : ""
}

function normalizeBlock(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value
        .replace(/\u0000/g, "")
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, maxLength)
    : ""
}
