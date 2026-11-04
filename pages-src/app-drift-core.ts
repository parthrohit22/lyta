// Source for pages/app-drift-core.js: typed, DOM-free helpers for the drift
// check UI in pages/app-drift.js.
type DriftRole = "specification" | "architecture" | "implementation"
type DriftRuleId =
  "requirement-without-support" | "component-without-implementation" | "interface-contradiction" | "stale-or-missing-source"
type DriftConfidence = "high" | "medium" | "low"
type DriftDisposition = "undecided" | "confirmed" | "accepted-deviation" | "false-positive" | "needs-investigation"
type DriftCounterpartKind = "cited" | "not-found-in-supplied-evidence" | "source-check"
type DriftDiffStatus = "new" | "unchanged" | "resolved"

interface DriftSourceView {
  role: DriftRole
  fileId: string
  fileName: string
  sourceVersionId: string
  importedAt: string
  superseded: boolean
}

interface DriftEvidenceView {
  ref: string
  chunkId: string
  fileId: string
  fileName: string
  role: DriftRole
  snippet: string
  rank: number
  retrievalSize: number
  sourceDeleted: boolean
}

interface DriftFindingView {
  key: string
  id: string
  rule: DriftRuleId
  subject: string
  claim: string
  claimRole: DriftRole | null
  claimCitationIds: string[]
  counterpart: {
    kind: DriftCounterpartKind
    description: string
    citationIds: string[]
    searchedSources: string[]
  }
  detail: string
  confidence: DriftConfidence
  confidenceReason: string
  adjustments: string[]
  diffStatus: "new" | "unchanged"
}

interface ResolvedFindingView {
  key: string
  rule: DriftRuleId
  subject: string
  claim: string
  lastSeenRunNumber: number
}

interface DriftRunView {
  id: string
  number: number
  scope: string
  rules: DriftRuleId[]
  createdAt: string
  summary: string
  policyVersion: string
  modelVersion: string
  sources: DriftSourceView[]
  evidence: DriftEvidenceView[]
  coverage: Array<{ role: DriftRole; sourceCount: number; passageCount: number; sourcesWithoutPassages: string[] }>
  findings: DriftFindingView[]
  resolved: ResolvedFindingView[]
  previousRunNumber: number
  adjustments: string[]
}

interface DriftDispositionView {
  disposition: DriftDisposition
  note: string
  at: string
  history: Array<{ disposition: DriftDisposition; note: string; at: string }>
}

interface DriftComparisonView {
  id: string
  scope: string
  runs: Array<{ id: string; number: number; createdAt: string; findingCount: number; newCount: number; resolvedCount: number }>
  dispositions: Record<string, DriftDispositionView>
}

interface DriftSummaryView {
  id: string
  title: string
  runCount: number
  findingCount: number
  updatedAt: string
}

interface CounterpartStateView {
  state: "cited" | "not-found" | "source-check"
  label: string
  description: string
}

interface LytaDriftApi {
  COMPARISON_TYPE: string
  ROLES: DriftRole[]
  ROLE_LABELS: Record<DriftRole, string>
  RULES: Record<DriftRuleId, { code: string; title: string }>
  CONFIDENCE_LABELS: Record<DriftConfidence, string>
  DIFF_LABELS: Record<DriftDiffStatus, string>
  DISPOSITIONS: Array<{ value: DriftDisposition; label: string }>
  normalizeComparison(value: unknown): DriftComparisonView | null
  normalizeRun(value: unknown): DriftRunView | null
  normalizeSummaries(value: unknown): DriftSummaryView[]
  getEvidence(run: DriftRunView, chunkIds: string[]): DriftEvidenceView[]
  describeCounterpart(finding: DriftFindingView): CounterpartStateView
  dispositionOf(comparison: DriftComparisonView, key: string): DriftDispositionView
  buildSelection(choices: Array<{ fileId: string; role: string }>): { sources: Record<DriftRole, string[]>; error: string }
  buildRunAnnouncement(run: DriftRunView): string
  buildDispositionAnnouncement(finding: { id: string; subject: string }, disposition: unknown): string
  driftPath(comparisonId: string): string
  runsPath(comparisonId: string): string
  runPath(comparisonId: string, runId: string, suffix?: "export"): string
  dispositionsPath(comparisonId: string): string
}

interface Window {
  LytaDrift: LytaDriftApi
}

window.LytaDrift = ((): LytaDriftApi => {
  const ROLES: DriftRole[] = ["specification", "architecture", "implementation"]
  const RULE_IDS: DriftRuleId[] = [
    "requirement-without-support",
    "component-without-implementation",
    "interface-contradiction",
    "stale-or-missing-source"
  ]

  const ROLE_LABELS: Record<DriftRole, string> = {
    specification: "Specification / PRD",
    architecture: "Architecture / design",
    implementation: "Implementation evidence"
  }

  const RULES: Record<DriftRuleId, { code: string; title: string }> = {
    "requirement-without-support": { code: "D1", title: "Requirement without support" },
    "component-without-implementation": { code: "D2", title: "Component without implementation" },
    "interface-contradiction": { code: "D3", title: "Interface or constraint contradiction" },
    "stale-or-missing-source": { code: "D4", title: "Stale or missing source" }
  }

  const CONFIDENCE_LABELS: Record<DriftConfidence, string> = {
    high: "High confidence",
    medium: "Medium confidence",
    low: "Low confidence"
  }

  const DIFF_LABELS: Record<DriftDiffStatus, string> = {
    new: "New",
    unchanged: "Unchanged",
    resolved: "Resolved"
  }

  const DISPOSITIONS: Array<{ value: DriftDisposition; label: string }> = [
    { value: "confirmed", label: "Confirmed" },
    { value: "accepted-deviation", label: "Accepted deviation" },
    { value: "false-positive", label: "False positive" },
    { value: "needs-investigation", label: "Needs investigation" },
    { value: "undecided", label: "Undecided" }
  ]

  const DISPOSITION_VALUES = DISPOSITIONS.map((option) => option.value)

  function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  }

  function asText(value: unknown): string {
    return typeof value === "string" ? value : ""
  }

  function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
  }

  function asTextList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []
  }

  function asList(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
  }

  function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? (value as T) : fallback
  }

  function normalizeFinding(value: unknown): DriftFindingView | null {
    const record = asRecord(value)
    const counterpart = asRecord(record.counterpart)
    const key = asText(record.key)
    const rule = RULE_IDS.find((id) => id === record.rule)

    if (!key || !rule) {
      return null
    }

    return {
      key,
      id: asText(record.id) || RULES[rule].code,
      rule,
      subject: asText(record.subject) || key,
      claim: asText(record.claim),
      claimRole: record.claimRole ? pick(record.claimRole, ROLES, "specification") : null,
      claimCitationIds: asTextList(record.claimCitationIds),
      counterpart: {
        // An unknown kind is shown as an absence, never as cited evidence.
        kind: pick(
          counterpart.kind,
          ["cited", "not-found-in-supplied-evidence", "source-check"] as const,
          "not-found-in-supplied-evidence"
        ),
        description: asText(counterpart.description),
        citationIds: asTextList(counterpart.citationIds),
        searchedSources: asTextList(counterpart.searchedSources)
      },
      detail: asText(record.detail),
      confidence: pick(record.confidence, ["high", "medium", "low"] as const, "low"),
      confidenceReason: asText(record.confidenceReason),
      adjustments: asTextList(record.adjustments),
      diffStatus: pick(record.diffStatus, ["new", "unchanged"] as const, "new")
    }
  }

  function normalizeRun(value: unknown): DriftRunView | null {
    const record = asRecord(value)
    const id = asText(record.id)

    if (!id) {
      return null
    }

    const diff = asRecord(record.diff)

    return {
      id,
      number: asNumber(record.number),
      scope: asText(record.scope),
      rules: asTextList(record.rules).filter((rule): rule is DriftRuleId => RULE_IDS.includes(rule as DriftRuleId)),
      createdAt: asText(record.createdAt),
      summary: asText(record.summary),
      policyVersion: asText(record.policyVersion),
      modelVersion: asText(record.modelVersion),
      sources: asList(record.sources).map((item) => {
        const source = asRecord(item)
        return {
          role: pick(source.role, ROLES, "specification"),
          fileId: asText(source.fileId),
          fileName: asText(source.fileName) || "Source",
          sourceVersionId: asText(source.sourceVersionId),
          importedAt: asText(source.importedAt),
          superseded: Boolean(source.supersededBy)
        }
      }),
      evidence: asList(record.evidence).map((item) => {
        const evidence = asRecord(item)
        return {
          ref: asText(evidence.ref),
          chunkId: asText(evidence.chunkId),
          fileId: asText(evidence.fileId),
          fileName: asText(evidence.fileName) || "Source",
          role: pick(evidence.role, ROLES, "specification"),
          snippet: asText(evidence.snippet),
          rank: asNumber(evidence.rank),
          retrievalSize: asNumber(evidence.retrievalSize),
          sourceDeleted: evidence.sourceDeleted === true
        }
      }),
      coverage: asList(record.coverage).map((item) => {
        const coverage = asRecord(item)
        return {
          role: pick(coverage.role, ROLES, "specification"),
          sourceCount: asNumber(coverage.sourceCount),
          passageCount: asNumber(coverage.passageCount),
          sourcesWithoutPassages: asTextList(coverage.sourcesWithoutPassages)
        }
      }),
      findings: asList(record.findings)
        .map(normalizeFinding)
        .filter((finding): finding is DriftFindingView => Boolean(finding)),
      resolved: asList(diff.resolved)
        .map((item) => {
          const resolved = asRecord(item)
          return {
            key: asText(resolved.key),
            rule: pick(resolved.rule, RULE_IDS, "stale-or-missing-source"),
            subject: asText(resolved.subject),
            claim: asText(resolved.claim),
            lastSeenRunNumber: asNumber(resolved.lastSeenRunNumber)
          }
        })
        .filter((item) => item.key),
      previousRunNumber: asNumber(diff.previousRunNumber),
      adjustments: asTextList(record.adjustments)
    }
  }

  function normalizeDisposition(value: unknown): DriftDispositionView {
    const record = asRecord(value)
    return {
      disposition: pick(record.disposition, DISPOSITION_VALUES, "undecided"),
      note: asText(record.note),
      at: asText(record.at),
      history: asList(record.history).map((item) => {
        const entry = asRecord(item)
        return { disposition: pick(entry.disposition, DISPOSITION_VALUES, "undecided"), note: asText(entry.note), at: asText(entry.at) }
      })
    }
  }

  function normalizeComparison(value: unknown): DriftComparisonView | null {
    const record = asRecord(value)
    const id = asText(record.id)

    if (!id) {
      return null
    }

    return {
      id,
      scope: asText(record.scope),
      runs: asList(record.runs).map((item) => {
        const run = asRecord(item)
        return {
          id: asText(run.id),
          number: asNumber(run.number),
          createdAt: asText(run.createdAt),
          findingCount: asNumber(run.findingCount),
          newCount: asNumber(run.newCount),
          resolvedCount: asNumber(run.resolvedCount)
        }
      }),
      dispositions: Object.fromEntries(
        Object.entries(asRecord(record.dispositions)).map(([key, item]) => [key, normalizeDisposition(item)])
      )
    }
  }

  function normalizeSummaries(value: unknown): DriftSummaryView[] {
    return asList(value)
      .map((item) => {
        const record = asRecord(item)
        return {
          id: asText(record.id),
          title: asText(record.title) || "Untitled drift check",
          runCount: asNumber(record.runCount),
          findingCount: asNumber(asRecord(record.latestRun).findingCount),
          updatedAt: asText(record.updatedAt)
        }
      })
      .filter((summary) => summary.id)
  }

  function getEvidence(run: DriftRunView, chunkIds: string[]): DriftEvidenceView[] {
    return chunkIds
      .map((chunkId) => run.evidence.find((item) => item.chunkId === chunkId))
      .filter((item): item is DriftEvidenceView => Boolean(item))
  }

  /** The counterpart state shown when a finding is selected. Absence is always worded as absence from the supplied evidence. */
  function describeCounterpart(finding: DriftFindingView): CounterpartStateView {
    switch (finding.counterpart.kind) {
      case "cited":
        return {
          state: "cited",
          label: "Conflicting evidence",
          description: "Both sides are cited from retrieved passages, shown below."
        }
      case "source-check":
        return {
          state: "source-check",
          label: "Source check",
          description: "A fact about the supplied sources, not about the project."
        }
      default:
        return {
          state: "not-found",
          label: "Not found in the supplied evidence",
          description: `No retrieved passage${
            finding.counterpart.searchedSources.length ? ` from ${finding.counterpart.searchedSources.join(", ")}` : ""
          } supports it. That does not show it is absent from the project.`
        }
    }
  }

  function dispositionOf(comparison: DriftComparisonView, key: string): DriftDispositionView {
    return comparison.dispositions[key] || { disposition: "undecided", note: "", at: "", history: [] }
  }

  /** Turns per-file role choices into the request's role map, or explains what is missing. */
  function buildSelection(choices: Array<{ fileId: string; role: string }>) {
    const sources = { specification: [], architecture: [], implementation: [] } as Record<DriftRole, string[]>

    for (const choice of choices) {
      const role = ROLES.find((candidate) => candidate === choice.role)
      if (role && choice.fileId) sources[role].push(choice.fileId)
    }

    const missing = ROLES.filter((role) => !sources[role].length)
    return {
      sources,
      error: missing.length ? `Choose at least one source for ${missing.map((role) => ROLE_LABELS[role]).join(", ")}.` : ""
    }
  }

  function buildRunAnnouncement(run: DriftRunView): string {
    const count = run.findings.length
    const fresh = run.findings.filter((finding) => finding.diffStatus === "new").length
    const unchanged = count - fresh
    return `Drift run ${run.number} ready: ${count} finding${count === 1 ? "" : "s"}. ${fresh} new, ${unchanged} unchanged, ${
      run.resolved.length
    } resolved since the previous run.`
  }

  function buildDispositionAnnouncement(finding: { id: string; subject: string }, disposition: unknown): string {
    const label = DISPOSITIONS.find((option) => option.value === disposition)?.label || "Undecided"
    return `${finding.id} ${finding.subject}: marked ${label.toLowerCase()}. Kept for later runs.`
  }

  function driftPath(comparisonId: string): string {
    return `/drift/${encodeURIComponent(comparisonId)}`
  }

  function runsPath(comparisonId: string): string {
    return `${driftPath(comparisonId)}/runs`
  }

  function runPath(comparisonId: string, runId: string, suffix?: "export"): string {
    return `${runsPath(comparisonId)}/${encodeURIComponent(runId)}${suffix ? `/${suffix}` : ""}`
  }

  function dispositionsPath(comparisonId: string): string {
    return `${driftPath(comparisonId)}/dispositions`
  }

  return {
    COMPARISON_TYPE: "spec-architecture-implementation",
    ROLES,
    ROLE_LABELS,
    RULES,
    CONFIDENCE_LABELS,
    DIFF_LABELS,
    DISPOSITIONS,
    normalizeComparison,
    normalizeRun,
    normalizeSummaries,
    getEvidence,
    describeCounterpart,
    dispositionOf,
    buildSelection,
    buildRunAnnouncement,
    buildDispositionAnnouncement,
    driftPath,
    runsPath,
    runPath,
    dispositionsPath
  }
})()
