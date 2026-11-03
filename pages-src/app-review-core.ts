// Source for pages/app-review-core.js: typed, DOM-free helpers for the
// Architecture Change Review UI in pages/app-review.js.
type ReviewReadiness = "ready" | "needs evidence" | "blocked"
type FindingClassification = "evidence-backed" | "inference" | "recommendation" | "insufficient evidence"
type FindingDisposition = "accepted" | "rejected" | "unresolved"

interface ReviewEvidenceView {
  ref: string
  chunkId: string
  fileId: string
  fileName: string
  snippet: string
  sourceDeleted: boolean
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
}

interface ReviewView {
  id: string
  readiness: ReviewReadiness
  rationale: string
  proposedChange: string
  findings: ReviewFindingView[]
  conflicts: Array<{ description: string; citationIds: string[] }>
  requiredTests: string[]
  observability: string[]
  rollback: string[]
  missingEvidence: string[]
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
  normalizeReview(value: unknown): ReviewView | null
  normalizeReviewSummaries(value: unknown): ReviewSummaryView[]
  getFindingEvidence(review: ReviewView, finding: ReviewFindingView): ReviewEvidenceView[]
  reviewPath(reviewId: string, suffix?: "export"): string
  findingPath(reviewId: string, findingId: string): string
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
      dispositionNote: asText(record.dispositionNote)
    }
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
      adjustments: asTextList(record.adjustments),
      evidence: (Array.isArray(record.evidence) ? record.evidence : []).map((evidence) => {
        const item = asRecord(evidence)
        return {
          ref: asText(item.ref),
          chunkId: asText(item.chunkId),
          fileId: asText(item.fileId),
          fileName: asText(item.fileName) || "Source",
          snippet: asText(item.snippet),
          sourceDeleted: item.sourceDeleted === true
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

  function reviewPath(reviewId: string, suffix?: "export"): string {
    return `/reviews/${encodeURIComponent(reviewId)}${suffix ? `/${suffix}` : ""}`
  }

  function findingPath(reviewId: string, findingId: string): string {
    return `${reviewPath(reviewId)}/findings/${encodeURIComponent(findingId)}`
  }

  return {
    READINESS_LABELS,
    CLASSIFICATION_LABELS,
    DISPOSITIONS,
    normalizeReview,
    normalizeReviewSummaries,
    getFindingEvidence,
    reviewPath,
    findingPath
  }
})()
