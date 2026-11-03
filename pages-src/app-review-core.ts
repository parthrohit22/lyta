// Source for pages/app-review-core.js: typed, DOM-free helpers for the
// Architecture Change Review UI in pages/app-review.js.
type ReviewReadiness = "ready" | "needs evidence" | "blocked"
type FindingClassification = "evidence-backed" | "inference" | "recommendation" | "insufficient evidence"
type FindingDisposition = "accepted" | "rejected" | "unresolved"
type FindingRecordKind = "finding" | "decision" | "risk" | "assumption" | "follow-up"
type ChallengeOutcome = "upheld" | "revised" | "withdrawn" | "insufficient evidence"

interface ReviewEvidenceView {
  ref: string
  chunkId: string
  fileId: string
  fileName: string
  snippet: string
  sourceDeleted: boolean
  retrievedFor: string
  rank: number
  retrievalSize: number
}

interface ReviewSourceView {
  fileId: string
  fileName: string
  sourceVersionId: string
}

interface EvidenceStateView {
  state: "evidence-backed" | "inference" | "recommendation" | "insufficient-evidence" | "withdrawn" | "unsupported"
  label: string
  description: string
}

interface ReviewFindingView {
  id: string
  title: string
  detail: string
  classification: FindingClassification
  areaType: string
  area: string
  citationIds: string[]
  adjustments: string[]
  disposition: FindingDisposition
  dispositionNote: string
  recordKind: FindingRecordKind | null
  withdrawn: boolean
  challenges: FindingChallengeView[]
}

interface FindingChallengeView {
  id: string
  createdAt: string
  reason: string
  outcome: ChallengeOutcome
  conclusionChanged: boolean
  rationale: string
  counterEvidenceIds: string[]
  beforeTitle: string
  afterTitle: string
  adjustments: string[]
}

interface ContextRecordView {
  id: string
  kind: string
  title: string
  content: string
  sourceNames: string[]
  reviewId: string
  findingId: string
  updatedAt: string
}

interface ReviewView {
  id: string
  readiness: ReviewReadiness
  rationale: string
  proposedChange: string
  intendedOutcome: string
  constraints: string
  sourceFileIds: string[]
  policyVersion: string
  sources: ReviewSourceView[]
  findings: ReviewFindingView[]
  conflicts: Array<{ description: string; citationIds: string[] }>
  requiredTests: string[]
  observability: string[]
  rollback: string[]
  missingEvidence: string[]
  assumptions: string[]
  openQuestions: string[]
  nextActions: string[]
  adjustments: string[]
  evidence: ReviewEvidenceView[]
  sourceNames: string[]
  createdAt: string
}

interface ReviewSummaryView {
  id: string
  title: string
  readiness: ReviewReadiness
  findingCount: number
  createdAt: string
}

interface LytaReviewApi {
  READINESS_LABELS: Record<ReviewReadiness, string>
  CLASSIFICATION_LABELS: Record<FindingClassification, string>
  DISPOSITIONS: Array<{ value: FindingDisposition; label: string }>
  RECORD_KINDS: Array<{ value: FindingRecordKind; label: string }>
  CONTEXT_KIND_LABELS: Record<string, string>
  CHALLENGE_OUTCOME_LABELS: Record<ChallengeOutcome, string>
  normalizeReview(value: unknown): ReviewView | null
  normalizeContextRecords(value: unknown): ContextRecordView[]
  normalizeReviewSummaries(value: unknown): ReviewSummaryView[]
  getFindingEvidence(review: ReviewView, finding: ReviewFindingView): ReviewEvidenceView[]
  describeEvidenceState(finding: ReviewFindingView, citedCount: number): EvidenceStateView
  describeRetrieval(review: ReviewView, evidence: ReviewEvidenceView): string
  buildReviewAnnouncement(review: ReviewView): string
  buildChallengeAnnouncement(findingId: string, outcome: unknown, conclusionChanged: boolean): string
  countRecordsByKind(records: ContextRecordView[]): Record<string, number>
  reviewPath(reviewId: string, suffix?: "export"): string
  findingPath(reviewId: string, findingId: string): string
  challengePath(reviewId: string, findingId: string): string
}

interface Window {
  LytaReview: LytaReviewApi
}

window.LytaReview = ((): LytaReviewApi => {
  const READINESS_LABELS: Record<ReviewReadiness, string> = {
    ready: "Ready",
    "needs evidence": "Needs evidence",
    blocked: "Blocked"
  }

  const CLASSIFICATION_LABELS: Record<FindingClassification, string> = {
    "evidence-backed": "Evidence-backed",
    inference: "Inference",
    recommendation: "Recommendation",
    "insufficient evidence": "Insufficient evidence"
  }

  const DISPOSITIONS: Array<{ value: FindingDisposition; label: string }> = [
    { value: "accepted", label: "Accept" },
    { value: "rejected", label: "Reject" },
    { value: "unresolved", label: "Unresolved" }
  ]

  const RECORD_KINDS: Array<{ value: FindingRecordKind; label: string }> = [
    { value: "finding", label: "Finding" },
    { value: "decision", label: "Decision" },
    { value: "risk", label: "Risk" },
    { value: "assumption", label: "Assumption" },
    { value: "follow-up", label: "Follow-up" }
  ]

  const CONTEXT_KIND_LABELS: Record<string, string> = {
    decision: "Decisions",
    risk: "Risks",
    assumption: "Assumptions",
    "follow-up": "Follow-ups",
    finding: "Findings",
    summary: "Summaries"
  }

  const CHALLENGE_OUTCOME_LABELS: Record<ChallengeOutcome, string> = {
    upheld: "Upheld",
    revised: "Revised",
    withdrawn: "Withdrawn",
    "insufficient evidence": "Insufficient evidence"
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  }

  function asText(value: unknown): string {
    return typeof value === "string" ? value : ""
  }

  function asTextList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []
  }

  function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? (value as T) : fallback
  }

  function normalizeReadiness(value: unknown): ReviewReadiness {
    return pick(value, ["ready", "needs evidence", "blocked"] as const, "needs evidence")
  }

  function normalizeFinding(value: unknown): ReviewFindingView | null {
    const record = asRecord(value)
    const id = asText(record.id)
    const title = asText(record.title)

    if (!id || !title) {
      return null
    }

    return {
      id,
      title,
      detail: asText(record.detail),
      // Unknown classifications are shown as the weakest claim, never as evidence.
      classification: pick(
        record.classification,
        ["evidence-backed", "inference", "recommendation", "insufficient evidence"] as const,
        "inference"
      ),
      areaType: asText(record.areaType) || "other",
      area: asText(record.area),
      citationIds: asTextList(record.citationIds),
      adjustments: asTextList(record.adjustments),
      disposition: pick(record.disposition, ["accepted", "rejected", "unresolved"] as const, "unresolved"),
      dispositionNote: asText(record.dispositionNote),
      recordKind: record.recordKind
        ? pick(record.recordKind, ["finding", "decision", "risk", "assumption", "follow-up"] as const, "finding")
        : null,
      withdrawn: record.withdrawn === true,
      challenges: (Array.isArray(record.challenges) ? record.challenges : []).map(normalizeChallenge)
    }
  }

  function normalizeChallenge(value: unknown): FindingChallengeView {
    const record = asRecord(value)

    return {
      id: asText(record.id),
      createdAt: asText(record.createdAt),
      reason: asText(record.reason),
      outcome: pick(record.outcome, ["upheld", "revised", "withdrawn", "insufficient evidence"] as const, "insufficient evidence"),
      conclusionChanged: record.conclusionChanged === true,
      rationale: asText(record.rationale),
      counterEvidenceIds: asTextList(record.counterEvidenceIds),
      beforeTitle: asText(asRecord(record.before).title),
      afterTitle: asText(asRecord(record.after).title),
      adjustments: asTextList(record.adjustments)
    }
  }

  /** Context records from GET /context?includeContent=true, newest first, with source ids resolved to names. */
  function normalizeContextRecords(value: unknown): ContextRecordView[] {
    const data = asRecord(value)
    const sourceNames = new Map(
      (Array.isArray(data.sources) ? data.sources : []).map((source) => [asText(asRecord(source).id), asText(asRecord(source).name)])
    )

    return (Array.isArray(data.records) ? data.records : [])
      .map((item) => {
        const record = asRecord(item)
        const origin = asRecord(record.origin)
        return {
          id: asText(record.id),
          kind: asText(record.kind) || "finding",
          title: asText(record.title),
          content: asText(record.content),
          sourceNames: asTextList(asRecord(record.provenance).sourceFileIds)
            .map((id) => sourceNames.get(id) || "")
            .filter(Boolean),
          reviewId: asText(origin.reviewId),
          findingId: asText(origin.findingId),
          updatedAt: asText(record.updatedAt)
        }
      })
      .filter((record) => record.id && record.title)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  function normalizeReview(value: unknown): ReviewView | null {
    const record = asRecord(value)
    const id = asText(record.id)

    if (!id) {
      return null
    }

    const input = asRecord(record.input)

    return {
      id,
      readiness: normalizeReadiness(record.readiness),
      rationale: asText(record.rationale),
      proposedChange: asText(input.proposedChange),
      intendedOutcome: asText(input.intendedOutcome),
      constraints: asText(input.constraints),
      sourceFileIds: asTextList(input.sourceFileIds),
      policyVersion: asText(record.policyVersion),
      sources: (Array.isArray(record.sources) ? record.sources : []).map((source) => {
        const item = asRecord(source)
        return { fileId: asText(item.fileId), fileName: asText(item.fileName), sourceVersionId: asText(item.sourceVersionId) }
      }),
      findings: (Array.isArray(record.findings) ? record.findings : [])
        .map(normalizeFinding)
        .filter((finding): finding is ReviewFindingView => Boolean(finding)),
      conflicts: (Array.isArray(record.conflicts) ? record.conflicts : []).map((conflict) => {
        const item = asRecord(conflict)
        return { description: asText(item.description), citationIds: asTextList(item.citationIds) }
      }),
      requiredTests: asTextList(record.requiredTests),
      observability: asTextList(record.observability),
      rollback: asTextList(record.rollback),
      missingEvidence: asTextList(record.missingEvidence),
      assumptions: asTextList(record.assumptions),
      openQuestions: asTextList(record.openQuestions),
      nextActions: asTextList(record.nextActions),
      adjustments: asTextList(record.adjustments),
      evidence: (Array.isArray(record.evidence) ? record.evidence : []).map((evidence) => {
        const item = asRecord(evidence)
        return {
          ref: asText(item.ref),
          chunkId: asText(item.chunkId),
          fileId: asText(item.fileId),
          fileName: asText(item.fileName) || "Source",
          snippet: asText(item.snippet),
          sourceDeleted: item.sourceDeleted === true,
          retrievedFor: asText(item.retrievedFor) || "review",
          rank: typeof item.rank === "number" ? item.rank : 0,
          retrievalSize: typeof item.retrievalSize === "number" ? item.retrievalSize : 0
        }
      }),
      sourceNames: (Array.isArray(record.sources) ? record.sources : []).map((source) => asText(asRecord(source).fileName)).filter(Boolean),
      createdAt: asText(record.createdAt)
    }
  }

  function normalizeReviewSummaries(value: unknown): ReviewSummaryView[] {
    return (Array.isArray(value) ? value : [])
      .map((item) => {
        const record = asRecord(item)
        return {
          id: asText(record.id),
          title: asText(record.title) || "Untitled review",
          readiness: normalizeReadiness(record.readiness),
          findingCount: typeof record.findingCount === "number" ? record.findingCount : 0,
          createdAt: asText(record.createdAt)
        }
      })
      .filter((summary) => summary.id)
  }

  function getFindingEvidence(review: ReviewView, finding: ReviewFindingView): ReviewEvidenceView[] {
    return finding.citationIds
      .map((chunkId) => review.evidence.find((item) => item.chunkId === chunkId))
      .filter((item): item is ReviewEvidenceView => Boolean(item))
  }

  /** The evidence state shown when a claim is selected; the copy never claims more than the classification allows. */
  function describeEvidenceState(finding: ReviewFindingView, citedCount: number): EvidenceStateView {
    if (finding.withdrawn) {
      return { state: "withdrawn", label: "Withdrawn", description: "A challenge found counter-evidence, so this claim no longer stands." }
    }

    switch (finding.classification) {
      case "evidence-backed":
        return citedCount
          ? {
              state: "evidence-backed",
              label: "Evidence-backed",
              description: `Supported by ${citedCount} retrieved passage${citedCount === 1 ? "" : "s"} shown below.`
            }
          : {
              state: "unsupported",
              label: "Unsupported",
              description: "Marked evidence-backed, but none of its cited passages are available."
            }
      case "recommendation":
        return {
          state: "recommendation",
          label: "Recommendation",
          description: "A suggested action, not a factual claim about the sources."
        }
      case "insufficient evidence":
        return {
          state: "insufficient-evidence",
          label: "Insufficient evidence",
          description: "The selected sources do not answer this. Add material or challenge it to search again."
        }
      default:
        return { state: "inference", label: "Inference", description: "LYTA's reasoning. No retrieved passage states this directly." }
    }
  }

  /** Where a passage came from: which retrieval, its rank, and the context policy. */
  function describeRetrieval(review: ReviewView, evidence: ReviewEvidenceView): string {
    const by = evidence.retrievedFor === "review" ? "Retrieved for this review" : `Retrieved by challenge ${evidence.retrievedFor}`
    const rank = evidence.rank ? `, rank ${evidence.rank}${evidence.retrievalSize ? ` of ${evidence.retrievalSize}` : ""}` : ""
    const policy = review.policyVersion ? ` · policy ${review.policyVersion}${evidence.retrievedFor === "review" ? "" : ".challenge"}` : ""
    return `${by}${rank}${policy}`
  }

  function buildReviewAnnouncement(review: ReviewView): string {
    const backed = review.findings.filter((finding) => finding.classification === "evidence-backed" && !finding.withdrawn).length
    const count = review.findings.length
    return `Review ready: ${READINESS_LABELS[review.readiness]}. ${count} finding${count === 1 ? "" : "s"}, ${backed} evidence-backed.${
      review.missingEvidence.length ? ` ${review.missingEvidence.length} gaps in evidence.` : ""
    }`
  }

  function buildChallengeAnnouncement(findingId: string, outcome: unknown, conclusionChanged: boolean): string {
    const label = CHALLENGE_OUTCOME_LABELS[outcome as ChallengeOutcome] || "Recorded"
    return `${findingId} challenge: ${label}. The conclusion ${conclusionChanged ? "changed" : "did not change"}.`
  }

  function countRecordsByKind(records: ContextRecordView[]): Record<string, number> {
    return records.reduce<Record<string, number>>((counts, record) => {
      counts[record.kind] = (counts[record.kind] || 0) + 1
      return counts
    }, {})
  }

  function reviewPath(reviewId: string, suffix?: "export"): string {
    return `/reviews/${encodeURIComponent(reviewId)}${suffix ? `/${suffix}` : ""}`
  }

  function findingPath(reviewId: string, findingId: string): string {
    return `${reviewPath(reviewId)}/findings/${encodeURIComponent(findingId)}`
  }

  function challengePath(reviewId: string, findingId: string): string {
    return `${findingPath(reviewId, findingId)}/challenge`
  }

  return {
    READINESS_LABELS,
    CLASSIFICATION_LABELS,
    DISPOSITIONS,
    RECORD_KINDS,
    CONTEXT_KIND_LABELS,
    CHALLENGE_OUTCOME_LABELS,
    normalizeReview,
    normalizeContextRecords,
    normalizeReviewSummaries,
    getFindingEvidence,
    describeEvidenceState,
    describeRetrieval,
    buildReviewAnnouncement,
    buildChallengeAnnouncement,
    countRecordsByKind,
    reviewPath,
    findingPath,
    challengePath
  }
})()
