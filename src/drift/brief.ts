import {
  DRIFT_ROLE_LABELS,
  DRIFT_RULE_DEFINITIONS,
  type DriftComparison,
  type DriftDisposition,
  type DriftEvidence,
  type DriftFinding,
  type DriftRun
} from "./contract"

export const DRIFT_DISPOSITION_LABELS: Record<DriftDisposition, string> = {
  undecided: "Undecided",
  confirmed: "Confirmed",
  "accepted-deviation": "Accepted deviation",
  "false-positive": "False positive",
  "needs-investigation": "Needs investigation"
}

/**
 * Renders one drift run as a portable Markdown report: the sources and
 * versions compared, what was searched per role, the diff against the
 * previous run, and each finding with its claim, counterpart, evidence,
 * confidence, and current disposition.
 */
export function renderDriftBrief(comparison: DriftComparison, run: DriftRun) {
  const evidenceById = new Map(run.evidence.map((item) => [item.chunkId, item]))
  const lines: string[] = [
    "# Drift check",
    "",
    quote(run.summary),
    "",
    `- Comparison: \`${comparison.id}\` · ${run.comparisonType}`,
    `- Run ${run.number} of ${comparison.runs.length}: \`${run.id}\` · ${run.createdAt}`,
    `- Model: ${run.modelVersion || "not called (nothing retrieved to compare)"} · context policy ${run.policyVersion}`,
    `- Rules: ${run.rules.map((rule) => `${DRIFT_RULE_DEFINITIONS[rule].code} ${rule}`).join(", ")}`,
    "",
    "## Scope",
    "",
    run.scope,
    "",
    "## Sources compared",
    "",
    "| Role | File | Version | Imported |",
    "| --- | --- | --- | --- |",
    ...run.sources.map(
      (source) =>
        `| ${DRIFT_ROLE_LABELS[source.role]} | ${escapeCell(source.fileName)}${source.supersededBy ? " (newer version exists)" : ""} | \`${
          source.sourceVersionId
        }\` | ${source.importedAt} |`
    ),
    "",
    "## Evidence coverage",
    "",
    ...run.coverage.map(
      (item) =>
        `- ${DRIFT_ROLE_LABELS[item.role]}: ${item.passageCount} passage${item.passageCount === 1 ? "" : "s"} from ${item.sourceCount} source${
          item.sourceCount === 1 ? "" : "s"
        }${item.sourcesWithoutPassages.length ? `; no passage from ${item.sourcesWithoutPassages.join(", ")}` : ""}`
    ),
    "",
    "_LYTA only compares the passages retrieved from these sources. A counterpart marked “not found in the supplied evidence” may still exist elsewhere in the project._",
    "",
    "## Changes since the previous run",
    ""
  ]

  if (run.diff.previousRunId) {
    lines.push(
      `Compared with run ${run.diff.previousRunNumber} (\`${run.diff.previousRunId}\`): ${run.diff.new.length} new, ${run.diff.unchanged.length} unchanged, ${run.diff.resolved.length} resolved.`,
      ""
    )
  } else {
    lines.push("This is the first run of this comparison, so every finding is new.", "")
  }

  lines.push("## Findings", "")

  if (!run.findings.length) {
    lines.push("_No drift was found in the supplied evidence for the selected rules._", "")
  }

  for (const finding of run.findings) {
    lines.push(...renderFinding(comparison, finding, evidenceById), "")
  }

  if (run.diff.resolved.length) {
    lines.push("## Resolved since the previous run", "")
    lines.push(
      "_Reported by the previous run but not by this one. That is not proof the drift was fixed; check the sources changed as expected._",
      ""
    )
    for (const item of run.diff.resolved) {
      const disposition = comparison.dispositions[item.key]?.disposition
      lines.push(
        `- ${DRIFT_RULE_DEFINITIONS[item.rule].code} · ${item.subject} — ${item.claim} (last seen in run ${item.lastSeenRunNumber}${
          disposition && disposition !== "undecided" ? `; disposition ${DRIFT_DISPOSITION_LABELS[disposition]}` : ""
        })`
      )
    }
    lines.push("")
  }

  if (run.adjustments.length) {
    lines.push("## Server-side corrections", "", ...run.adjustments.map((item) => `- ${item}`), "")
  }

  lines.push("## Sources", "")

  if (!run.evidence.length) {
    lines.push("_No passages were retrieved from the selected sources._", "")
  }

  for (const item of run.evidence) {
    lines.push(...renderEvidence(item), "")
  }

  return `${lines.join("\n").trim()}\n`
}

function renderFinding(comparison: DriftComparison, finding: DriftFinding, evidenceById: Map<string, DriftEvidence>) {
  const definition = DRIFT_RULE_DEFINITIONS[finding.rule]
  const disposition = comparison.dispositions[finding.key]
  const lines = [
    `### ${finding.id} · ${finding.subject} (${finding.diffStatus})`,
    "",
    `- Rule: ${definition.code} ${definition.title}`,
    `- Key: \`${finding.key}\``,
    `- Claim${finding.claimRole ? ` (${DRIFT_ROLE_LABELS[finding.claimRole]})` : ""}: ${finding.claim}`,
    `- Claim evidence: ${finding.claimCitationIds.length ? formatCitations(finding.claimCitationIds, evidenceById) : "none (source check)"}`,
    `- Counterpart: **${counterpartLabel(finding)}** — ${finding.counterpart.description}`
  ]

  if (finding.counterpart.citationIds.length) {
    lines.push(`- Counterpart evidence: ${formatCitations(finding.counterpart.citationIds, evidenceById)}`)
  }

  lines.push(`- Confidence: **${finding.confidence}** — ${finding.confidenceReason}`)
  lines.push(
    `- Disposition: ${DRIFT_DISPOSITION_LABELS[disposition?.disposition || "undecided"]}${disposition?.note ? ` — ${disposition.note}` : ""}`
  )

  for (const adjustment of finding.adjustments) {
    lines.push(`- Correction: ${adjustment}`)
  }

  if (finding.detail) {
    lines.push("", finding.detail)
  }

  return lines
}

function counterpartLabel(finding: DriftFinding) {
  switch (finding.counterpart.kind) {
    case "cited":
      return "Conflicting evidence"
    case "not-found-in-supplied-evidence":
      return "Not found in the supplied evidence"
    default:
      return "Source check"
  }
}

function renderEvidence(item: DriftEvidence) {
  return [
    `<a id="evidence-${item.ref.toLowerCase()}"></a>`,
    `### ${item.ref} · ${item.fileName} (${DRIFT_ROLE_LABELS[item.role]})`,
    "",
    `- File id: \`${item.fileId}\``,
    `- Chunk id: \`${item.chunkId}\``,
    "",
    item.sourceDeleted ? "_This source was deleted after the run; its excerpt was removed._" : quote(item.snippet)
  ]
}

function formatCitations(chunkIds: string[], evidenceById: Map<string, DriftEvidence>) {
  return chunkIds
    .map((chunkId) => evidenceById.get(chunkId))
    .filter((item): item is DriftEvidence => Boolean(item))
    .map((item) => `[${item.ref}](#evidence-${item.ref.toLowerCase()}) ${item.fileName}${item.sourceDeleted ? " (deleted)" : ""}`)
    .join("; ")
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|")
}

function quote(text: string) {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}
