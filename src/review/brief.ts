import type { ArchitectureReview, ReviewEvidence, ReviewFinding } from "./contract"

/**
 * Renders a review as a portable Markdown brief. The brief keeps every
 * finding's classification and disposition, links each citation to its
 * source excerpt, and states the final readiness first so it survives being
 * pasted into a PR, ticket, or design doc.
 */
export function renderReviewBrief(review: ArchitectureReview) {
  const evidenceById = new Map(review.evidence.map((item) => [item.chunkId, item]))
  const lines: string[] = [
    "# Architecture Change Review",
    "",
    `**Readiness: ${review.readiness.toUpperCase()}**`,
    "",
    quote(review.rationale),
    "",
    `- Review: \`${review.id}\``,
    `- Created: ${review.createdAt}`,
    `- Model: ${review.modelVersion} · context policy ${review.policyVersion}`,
    `- Sources reviewed: ${review.sources.map((source) => source.fileName).join(", ") || "none"}`,
    "",
    "## Proposed change",
    "",
    review.input.proposedChange,
    "",
    "## Intended outcome",
    "",
    review.input.intendedOutcome,
    ""
  ]

  if (review.input.constraints) {
    lines.push("## Constraints", "", review.input.constraints, "")
  }

  lines.push("## Findings", "")

  if (!review.findings.length) {
    lines.push("_No findings were returned._", "")
  }

  for (const finding of review.findings) {
    lines.push(...renderFinding(finding, evidenceById), "")
  }

  if (review.conflicts.length) {
    lines.push("## Conflicting sources", "")
    for (const conflict of review.conflicts) {
      lines.push(`- ${conflict.description} — ${formatCitations(conflict.citationIds, evidenceById)}`)
    }
    lines.push("")
  }

  lines.push(...renderList("Required tests", review.requiredTests, "No test evidence was identified; treat test coverage as unproven."))
  lines.push(...renderList("Observability", review.observability, "No observability evidence was identified."))
  lines.push(...renderList("Rollback", review.rollback, "No rollback evidence was identified; treat rollback as unproven."))
  lines.push(...renderList("Missing evidence", review.missingEvidence, "None recorded."))

  if (review.adjustments.length) {
    lines.push(...renderList("Server-side corrections", review.adjustments, ""))
  }

  lines.push("## Sources", "")

  if (!review.evidence.length) {
    lines.push("_No passages were retrieved from the selected sources._", "")
  }

  for (const item of review.evidence) {
    lines.push(...renderEvidence(item), "")
  }

  return `${lines.join("\n").trim()}\n`
}

function renderFinding(finding: ReviewFinding, evidenceById: Map<string, ReviewEvidence>) {
  const lines = [
    `### ${finding.id} · ${finding.title}`,
    "",
    `- Classification: **${finding.classification}**`,
    `- Affected area: ${finding.areaType}${finding.area ? ` — ${finding.area}` : ""}`,
    `- Disposition: ${finding.disposition}${finding.dispositionNote ? ` — ${finding.dispositionNote}` : ""}`,
    `- Evidence: ${finding.citationIds.length ? formatCitations(finding.citationIds, evidenceById) : "none cited"}`
  ]

  for (const adjustment of finding.adjustments) {
    lines.push(`- Correction: ${adjustment}`)
  }

  if (finding.detail) {
    lines.push("", finding.detail)
  }

  return lines
}

function renderEvidence(item: ReviewEvidence) {
  return [
    `<a id="evidence-${item.ref.toLowerCase()}"></a>`,
    `### ${item.ref} · ${item.fileName}`,
    "",
    `- File id: \`${item.fileId}\``,
    `- Chunk id: \`${item.chunkId}\``,
    "",
    item.sourceDeleted ? "_This source was deleted after the review was created; its excerpt was removed._" : quote(item.snippet)
  ]
}

function renderList(title: string, items: string[], emptyText: string) {
  return [`## ${title}`, "", ...(items.length ? items.map((item) => `- ${item}`) : [`_${emptyText}_`]), ""]
}

function formatCitations(chunkIds: string[], evidenceById: Map<string, ReviewEvidence>) {
  return chunkIds
    .map((chunkId) => evidenceById.get(chunkId))
    .filter((item): item is ReviewEvidence => Boolean(item))
    .map((item) => `[${item.ref}](#evidence-${item.ref.toLowerCase()}) ${item.fileName}${item.sourceDeleted ? " (deleted)" : ""}`)
    .join("; ")
}

function quote(text: string) {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}
