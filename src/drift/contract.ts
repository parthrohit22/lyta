import type { LibraryCitation } from "../library/chunks"

/**
 * Drift detection compares three explicitly chosen source roles and reports
 * bounded, documented kinds of mismatch. It reuses the review architecture:
 * retrieval scoped to the selected sources, one `deep` model call, strict
 * output validation, and server-side corrections recorded in `adjustments`.
 *
 * The one rule it never bends: LYTA only sees the supplied evidence, so a
 * missing counterpart is reported as "not found in the supplied evidence" and
 * never as "does not exist in the project".
 */

/** Recorded on the context-selection manifest of every drift retrieval, suffixed with the role. */
export const DRIFT_POLICY_VERSION = "2026-11-04.drift"

export const DRIFT_ROLES = ["specification", "architecture", "implementation"] as const
export const DRIFT_COMPARISON_TYPES = ["spec-architecture-implementation"] as const
export const DRIFT_RULES = [
  "requirement-without-support",
  "component-without-implementation",
  "interface-contradiction",
  "stale-or-missing-source"
] as const
export const DRIFT_CONFIDENCE = ["high", "medium", "low"] as const
export const DRIFT_DISPOSITIONS = ["undecided", "confirmed", "accepted-deviation", "false-positive", "needs-investigation"] as const

export type DriftRole = (typeof DRIFT_ROLES)[number]
export type DriftComparisonType = (typeof DRIFT_COMPARISON_TYPES)[number]
export type DriftRuleId = (typeof DRIFT_RULES)[number]
export type DriftConfidence = (typeof DRIFT_CONFIDENCE)[number]
export type DriftDisposition = (typeof DRIFT_DISPOSITIONS)[number]
export type DriftCounterpartKind = "cited" | "not-found-in-supplied-evidence" | "source-check"

export interface DriftRuleDefinition {
  code: string
  title: string
  definition: string
  /** "model" rules are proposed by the model and validated; "server" rules are computed deterministically. */
  owner: "model" | "server"
  /** Roles the claim must be cited from. Empty for server-owned rules. */
  claimRoles: DriftRole[]
  /** Roles searched for (absence rules) or cited as (contradiction) the counterpart. */
  counterpartRoles: DriftRole[]
  counterpartKind: DriftCounterpartKind
  /** The highest confidence this rule can ever report. */
  maxConfidence: DriftConfidence
}

/** The four supported drift rules. Anything else is rejected, never approximated. */
export const DRIFT_RULE_DEFINITIONS: Record<DriftRuleId, DriftRuleDefinition> = {
  "requirement-without-support": {
    code: "D1",
    title: "Requirement without architecture or implementation support",
    definition:
      "A requirement stated in the specification sources has no supporting passage in the retrieved architecture or implementation evidence.",
    owner: "model",
    claimRoles: ["specification"],
    counterpartRoles: ["architecture", "implementation"],
    counterpartKind: "not-found-in-supplied-evidence",
    maxConfidence: "medium"
  },
  "component-without-implementation": {
    code: "D2",
    title: "Architecture component not represented in implementation evidence",
    definition:
      "A component, service, or interface described in the architecture sources has no corresponding passage in the retrieved implementation evidence.",
    owner: "model",
    claimRoles: ["architecture"],
    counterpartRoles: ["implementation"],
    counterpartKind: "not-found-in-supplied-evidence",
    maxConfidence: "medium"
  },
  "interface-contradiction": {
    code: "D3",
    title: "Interface or constraint contradiction",
    definition:
      "Two roles state incompatible interfaces, values, limits, or constraints for the same thing, and both sides are cited from the retrieved evidence.",
    owner: "model",
    claimRoles: ["specification", "architecture", "implementation"],
    counterpartRoles: ["specification", "architecture", "implementation"],
    counterpartKind: "cited",
    maxConfidence: "high"
  },
  "stale-or-missing-source": {
    code: "D4",
    title: "Stale or missing source evidence",
    definition:
      "A selected role returned no passage for the scope, or a selected source has been superseded by a newer library file with the same name. Computed by the server, not the model.",
    owner: "server",
    claimRoles: [],
    counterpartRoles: [],
    counterpartKind: "source-check",
    maxConfidence: "high"
  }
}

export const DRIFT_ROLE_LABELS: Record<DriftRole, string> = {
  specification: "Specification / PRD",
  architecture: "Architecture / design",
  implementation: "Implementation evidence"
}

/** Which roles each comparison type compares, and which rules apply to it. */
export const DRIFT_COMPARISONS: Record<DriftComparisonType, { roles: DriftRole[]; rules: DriftRuleId[] }> = {
  "spec-architecture-implementation": { roles: [...DRIFT_ROLES], rules: [...DRIFT_RULES] }
}

/** A comparison refuses further runs at this count rather than dropping earlier history. */
export const MAX_DRIFT_RUNS = 25

const MAX_SCOPE_LENGTH = 1200
const MAX_SOURCES_PER_ROLE = 6
const MAX_FINDINGS = 12
const MAX_LINE_LENGTH = 400
const MAX_DETAIL_LENGTH = 1200
const MAX_NOTE_LENGTH = 500
const MAX_DISPOSITION_HISTORY = 20

/**
 * Wording that asserts something is absent from the project rather than from
 * the supplied evidence. LYTA cannot know that, so model text containing it is
 * removed (and the removal recorded) instead of being shown.
 */
const PROJECT_ABSENCE_PATTERN =
  /\b(?:does not|doesn't|do not|don't|did not|didn't) exist\b|\bnon-?existent\b|\b(?:is|are|was|were|has|have) (?:not|never) (?:been )?(?:implemented|built|present)\b|\bnever (?:implemented|built)\b|\bnot (?:implemented|present) (?:anywhere|at all)\b|\b(?:missing|absent) (?:from|in) the (?:project|codebase|code base|code|system|repo|repository|product)\b|\bnowhere in the (?:project|codebase|code|system|repo|repository)\b|\bno (?:code|implementation) exists\b/i

export interface DriftInput {
  comparisonType: DriftComparisonType
  scope: string
  sources: Record<DriftRole, string[]>
  rules: DriftRuleId[]
}

/** A selected library file as it was when the run used it. */
export interface DriftSource {
  role: DriftRole
  fileId: string
  fileName: string
  sourceVersionId: string
  importedAt: string
  updatedAt: string
  /** A newer library file with the same name, if the selected one is no longer the latest. */
  supersededBy: { fileId: string; sourceVersionId: string; importedAt: string } | null
}

/** A retrieved chunk the model was shown, addressed in the prompt by `ref` (E1, E2, ...). */
export interface DriftEvidence {
  ref: string
  chunkId: string
  fileId: string
  fileName: string
  role: DriftRole
  snippet: string
  /** 1-based position in the role's retrieval, and how many passages it returned. */
  rank: number
  retrievalSize: number
  /** Set when the source file is deleted after the run; the snippet is then cleared. */
  sourceDeleted?: boolean
}

export interface DriftCoverage {
  role: DriftRole
  sourceCount: number
  passageCount: number
  /** Selected sources in this role that contributed no passage. */
  sourcesWithoutPassages: string[]
}

export interface DriftCounterpart {
  kind: DriftCounterpartKind
  description: string
  /** Chunk ids of the conflicting passages (contradictions only). */
  citationIds: string[]
  /** For absence findings: what was actually searched. */
  searchedRoles: DriftRole[]
  searchedPassageCount: number
  searchedSources: string[]
}

export interface DriftFinding {
  /** Stable across runs: `${rule}:${subject slug}`. Used for diffing and dispositions. */
  key: string
  /** Display id within this run (D1-1, D3-2, ...). */
  id: string
  rule: DriftRuleId
  subject: string
  claim: string
  claimRole: DriftRole | null
  claimCitationIds: string[]
  counterpart: DriftCounterpart
  detail: string
  confidence: DriftConfidence
  confidenceReason: string
  adjustments: string[]
  diffStatus: "new" | "unchanged"
}

/** A finding from the previous run that this run did not report. */
export interface ResolvedDriftFinding {
  key: string
  rule: DriftRuleId
  subject: string
  claim: string
  lastSeenRunId: string
  lastSeenRunNumber: number
}

export interface DriftDiff {
  previousRunId: string | null
  previousRunNumber: number | null
  new: string[]
  unchanged: string[]
  resolved: ResolvedDriftFinding[]
}

export interface DriftRun {
  id: string
  comparisonId: string
  number: number
  requestId: string
  comparisonType: DriftComparisonType
  scope: string
  rules: DriftRuleId[]
  sources: DriftSource[]
  evidence: DriftEvidence[]
  coverage: DriftCoverage[]
  summary: string
  findings: DriftFinding[]
  adjustments: string[]
  /** Null when no model call was needed (nothing retrieved to compare). */
  modelVersion: string | null
  policyVersion: string
  diff: DriftDiff
  createdAt: string
}

export interface DriftDispositionEntry {
  disposition: DriftDisposition
  note: string
  runId: string
  at: string
}

export interface DriftDispositionState extends DriftDispositionEntry {
  /** Oldest first, so a changed mind stays visible. */
  history: DriftDispositionEntry[]
}

export interface DriftRunSummary {
  id: string
  number: number
  createdAt: string
  findingCount: number
  newCount: number
  unchangedCount: number
  resolvedCount: number
}

export interface DriftComparison {
  id: string
  type: DriftComparisonType
  scope: string
  rules: DriftRuleId[]
  createdAt: string
  updatedAt: string
  runs: DriftRunSummary[]
  /** Keyed by stable finding key, so a disposition survives re-runs. */
  dispositions: Record<string, DriftDispositionState>
}

export type DriftInputResult = { ok: true; value: DriftInput } | { ok: false; error: string }

/**
 * Validates a new comparison. Unsupported comparison types, roles, and rules
 * are rejected with an error that lists what is supported, so nothing is
 * silently approximated.
 */
export function validateDriftInput(body: unknown): DriftInputResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body missing" }
  }

  const payload = body as Record<string, unknown>
  const comparisonType = DRIFT_COMPARISON_TYPES.find((type) => type === payload.comparisonType)

  if (!comparisonType) {
    const requested = typeof payload.comparisonType === "string" ? `"${normalizeLine(payload.comparisonType, 60)}" is not supported. ` : ""
    return {
      ok: false,
      error: `Unsupported comparison type. ${requested}Supported comparison types: ${DRIFT_COMPARISON_TYPES.join(", ")}.`
    }
  }

  if (payload.scope != null && typeof payload.scope !== "string") {
    return { ok: false, error: "scope must be a string" }
  }

  const scope = normalizeBlock(payload.scope, MAX_SCOPE_LENGTH)

  if (!scope) {
    return { ok: false, error: "Describe the scope to check for drift, e.g. the feature or subsystem." }
  }

  const sources = validateDriftSources(payload.sources, comparisonType)
  if (!sources.ok) return sources

  const rules = validateDriftRules(payload.rules, comparisonType)
  if (!rules.ok) return rules

  return { ok: true, value: { comparisonType, scope, sources: sources.value, rules: rules.value } }
}

/** Validates the role-to-source selection for a comparison type. */
export function validateDriftSources(
  value: unknown,
  comparisonType: DriftComparisonType
): { ok: true; value: Record<DriftRole, string[]> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `sources must map each role (${DRIFT_ROLES.join(", ")}) to library file ids` }
  }

  const record = value as Record<string, unknown>
  const unknownRole = Object.keys(record).find((role) => !DRIFT_ROLES.includes(role as DriftRole))

  if (unknownRole) {
    return {
      ok: false,
      error: `Unsupported source role "${normalizeLine(unknownRole, 40)}". Supported roles: ${DRIFT_ROLES.join(", ")}.`
    }
  }

  const sources = { specification: [], architecture: [], implementation: [] } as Record<DriftRole, string[]>
  const seen = new Map<string, DriftRole>()

  for (const role of DRIFT_COMPARISONS[comparisonType].roles) {
    const ids = record[role]

    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return { ok: false, error: `Select at least one ${DRIFT_ROLE_LABELS[role]} source.` }
    }

    const unique = [...new Set(ids.map((id) => normalizeLine(id, 120)).filter(Boolean))]

    if (!unique.length) {
      return { ok: false, error: `Select at least one ${DRIFT_ROLE_LABELS[role]} source.` }
    }

    if (unique.length > MAX_SOURCES_PER_ROLE) {
      return { ok: false, error: `Select at most ${MAX_SOURCES_PER_ROLE} ${DRIFT_ROLE_LABELS[role]} sources.` }
    }

    for (const id of unique) {
      const other = seen.get(id)
      if (other) {
        return {
          ok: false,
          error: `A source can only have one role; it was selected as both ${DRIFT_ROLE_LABELS[other]} and ${DRIFT_ROLE_LABELS[role]}.`
        }
      }
      seen.set(id, role)
    }

    sources[role] = unique
  }

  return { ok: true, value: sources }
}

function validateDriftRules(
  value: unknown,
  comparisonType: DriftComparisonType
): { ok: true; value: DriftRuleId[] } | { ok: false; error: string } {
  const supported = DRIFT_COMPARISONS[comparisonType].rules

  if (value == null) {
    return { ok: true, value: [...supported] }
  }

  if (!Array.isArray(value) || value.some((rule) => typeof rule !== "string")) {
    return { ok: false, error: "rules must be an array of drift rule ids" }
  }

  const unsupported = value.find((rule) => !supported.includes(rule as DriftRuleId))

  if (unsupported) {
    return {
      ok: false,
      error: `Unsupported drift rule "${normalizeLine(unsupported, 60)}". Supported rules: ${supported.join(", ")}.`
    }
  }

  const rules = supported.filter((rule) => value.includes(rule))
  return rules.length ? { ok: true, value: rules } : { ok: false, error: "Select at least one drift rule." }
}

export function normalizeDriftDisposition(value: unknown): DriftDisposition | null {
  const normalized =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, "-")
      : ""
  return DRIFT_DISPOSITIONS.find((disposition) => disposition === normalized) || null
}

export function normalizeDriftNote(value: unknown) {
  return normalizeBlock(value, MAX_NOTE_LENGTH)
}

/** Numbers evidence across roles in role order, so refs are unique within a run. */
export function toDriftEvidence(byRole: Array<{ role: DriftRole; citations: LibraryCitation[] }>): DriftEvidence[] {
  const evidence: DriftEvidence[] = []

  for (const { role, citations } of byRole) {
    citations.forEach((citation, index) => {
      if (evidence.some((item) => item.chunkId === citation.id)) return
      evidence.push({
        ref: `E${evidence.length + 1}`,
        chunkId: citation.id,
        fileId: citation.fileId,
        fileName: citation.fileName,
        role,
        snippet: citation.snippet,
        rank: index + 1,
        retrievalSize: citations.length
      })
    })
  }

  return evidence
}

export function buildDriftCoverage(roles: DriftRole[], sources: DriftSource[], evidence: DriftEvidence[]): DriftCoverage[] {
  return roles.map((role) => {
    const roleSources = sources.filter((source) => source.role === role)
    const passages = evidence.filter((item) => item.role === role)
    return {
      role,
      sourceCount: roleSources.length,
      passageCount: passages.length,
      sourcesWithoutPassages: roleSources
        .filter((source) => !passages.some((item) => item.fileId === source.fileId))
        .map((source) => source.fileName)
    }
  })
}

/** A stable, URL-safe finding key. The same rule and subject give the same key on every run. */
export function driftFindingKey(rule: DriftRuleId, subject: string) {
  const slug = subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return `${rule}:${slug || "unspecified"}`
}

/** True when text claims project-level absence rather than absence from the supplied evidence. */
export function assertsProjectAbsence(text: string) {
  return PROJECT_ABSENCE_PATTERN.test(text)
}

export type DriftOutputResult =
  { ok: true; value: { summary: string; findings: DriftFinding[]; adjustments: string[] } } | { ok: false; error: string }

interface DriftParseContext {
  evidence: DriftEvidence[]
  sources: DriftSource[]
  coverage: DriftCoverage[]
  rules: DriftRuleId[]
}

/**
 * Parses and strictly validates the model's drift JSON. Structural problems
 * (not JSON, no summary, no findings list, an unknown rule or confidence) are
 * rejected outright so a malformed reply is never shown as a drift run.
 * Grounding problems are corrected, and each correction is recorded:
 *
 * - citations not in the retrieved evidence are dropped;
 * - a claim must be cited from the role its rule names, or the finding is dropped;
 * - a contradiction needs both sides cited from two different roles, or it is dropped;
 * - an absence finding's counterpart is always server text describing what was
 *   searched; its confidence is capped at medium, and at low when a searched
 *   role returned nothing;
 * - wording that asserts project-level absence is removed;
 * - findings for rules the run did not select, or for server-owned rules, are dropped.
 */
export function parseDriftOutput(raw: unknown, context: DriftParseContext): DriftOutputResult {
  const parsed = typeof raw === "string" ? parseJsonObject(raw) : raw

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "The drift model did not return a JSON object." }
  }

  const data = parsed as Record<string, unknown>
  const summary = normalizeBlock(data.summary, MAX_DETAIL_LENGTH)

  if (!summary) {
    return { ok: false, error: "The drift model did not summarise its comparison." }
  }

  if (!Array.isArray(data.findings)) {
    return { ok: false, error: "The drift model did not return a findings list." }
  }

  const byRef = new Map<string, DriftEvidence>()
  for (const item of context.evidence) {
    byRef.set(item.ref.toLowerCase(), item)
    byRef.set(item.chunkId.toLowerCase(), item)
  }

  const adjustments: string[] = []
  const findings: DriftFinding[] = []

  for (const [index, candidate] of data.findings.slice(0, MAX_FINDINGS).entries()) {
    const result = parseDriftFinding(candidate, byRef, context)

    if (result.error) {
      return { ok: false, error: `The drift model returned a malformed finding (#${index + 1}): ${result.error}` }
    }

    if (result.dropped) {
      adjustments.push(result.dropped)
      continue
    }

    findings.push(result.finding!)
  }

  if (data.findings.length > MAX_FINDINGS) {
    adjustments.push(`Only the first ${MAX_FINDINGS} findings were kept.`)
  }

  return { ok: true, value: { summary, findings, adjustments } }
}

type FindingParse = { error?: string; dropped?: string; finding?: DriftFinding }

function parseDriftFinding(candidate: unknown, byRef: Map<string, DriftEvidence>, context: DriftParseContext): FindingParse {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { error: "not an object" }
  }

  const record = candidate as Record<string, unknown>
  const rule = DRIFT_RULES.find((value) => value === normalizeEnumValue(record.rule))

  if (!rule) {
    return { error: `unknown rule "${normalizeLine(record.rule, 60)}"; supported rules are ${DRIFT_RULES.join(", ")}` }
  }

  const requestedConfidence = DRIFT_CONFIDENCE.find((value) => value === normalizeEnumValue(record.confidence))

  if (!requestedConfidence) {
    return { error: "confidence must be high, medium, or low" }
  }

  for (const field of ["claimCitations", "counterpartCitations"]) {
    if (record[field] != null && !Array.isArray(record[field])) {
      return { error: `${field} must be a list` }
    }
  }

  let claim = normalizeLine(record.claim, MAX_LINE_LENGTH)

  if (!claim) {
    return { error: "missing claim" }
  }

  const definition = DRIFT_RULE_DEFINITIONS[rule]
  const subjectText = normalizeLine(record.subject, 120)
  const label = `${definition.code} "${subjectText || claim.slice(0, 80)}"`

  if (definition.owner === "server") {
    return { dropped: `Dropped ${label}: stale or missing source findings are computed by the server, not the model.` }
  }

  if (!context.rules.includes(rule)) {
    return { dropped: `Dropped ${label}: the ${rule} rule was not selected for this run.` }
  }

  if (assertsProjectAbsence(claim)) {
    // Name the finding by subject only: quoting the claim would repeat the overclaim in the corrections list.
    return {
      dropped: `Dropped a ${definition.code} finding${subjectText ? ` about "${subjectText}"` : ""}: it asserted that something does not exist in the project, which LYTA cannot know from the supplied evidence.`
    }
  }

  const adjustments: string[] = []
  const claimRefs = resolveDriftCitations(record.claimCitations, byRef)
  const counterpartRefs = resolveDriftCitations(record.counterpartCitations, byRef)
  const unknownRefs = [...new Set([...claimRefs.unknownRefs, ...counterpartRefs.unknownRefs])]

  if (unknownRefs.length) {
    adjustments.push(`Removed citations not in the retrieved evidence: ${unknownRefs.slice(0, 6).join(", ")}.`)
  }

  // The claim is anchored in one role. For absence rules that role is fixed;
  // for a contradiction it is whichever role the first valid claim citation is from.
  const claimRole =
    definition.counterpartKind === "cited"
      ? claimRefs.items[0]?.role
      : claimRefs.items.find((item) => definition.claimRoles.includes(item.role))?.role
  const claimItems = claimRefs.items.filter((item) => item.role === claimRole)

  if (claimItems.length < claimRefs.items.length) {
    adjustments.push(
      `Removed claim citations from other roles: the claim must be cited from ${claimRole ? DRIFT_ROLE_LABELS[claimRole] : "one role"}.`
    )
  }

  if (!claimRole || !claimItems.length) {
    return {
      dropped: `Dropped ${label}: its claim is not cited from the retrieved ${definition.claimRoles.map((role) => DRIFT_ROLE_LABELS[role]).join(" or ")} evidence.`
    }
  }

  let detail = normalizeBlock(record.detail, MAX_DETAIL_LENGTH)

  if (detail && assertsProjectAbsence(detail)) {
    detail = ""
    adjustments.push(
      "Removed the explanation: it claimed something does not exist in the project, but only the supplied evidence was searched."
    )
  }

  if (!subjectText) {
    adjustments.push("No subject was given, so the finding key is derived from the claim and may not match across runs.")
  }
  const subject = subjectText || claim.split(" ").slice(0, 8).join(" ")

  let confidence = requestedConfidence
  let confidenceReason = "As assessed by the model."
  let counterpart: DriftCounterpart

  if (definition.counterpartKind === "cited") {
    const counterpartItems = counterpartRefs.items.filter((item) => item.role !== claimRole)
    const counterpartRole = counterpartItems[0]?.role

    if (counterpartItems.length < counterpartRefs.items.length) {
      adjustments.push("Removed counterpart citations from the claim's own role: a contradiction compares two different roles.")
    }

    if (!counterpartRole) {
      return { dropped: `Dropped ${label}: a contradiction needs a counterpart cited from a different role.` }
    }

    let description = normalizeLine(record.counterpart, MAX_LINE_LENGTH)
    if (description && assertsProjectAbsence(description)) {
      description = ""
      adjustments.push("Removed counterpart wording that claimed something does not exist in the project.")
    }

    counterpart = {
      kind: "cited",
      description: description || "See the cited counterpart passages.",
      citationIds: counterpartItems.filter((item) => item.role === counterpartRole).map((item) => item.chunkId),
      searchedRoles: [],
      searchedPassageCount: 0,
      searchedSources: []
    }
    confidenceReason = `Both sides are cited: ${DRIFT_ROLE_LABELS[claimRole]} and ${DRIFT_ROLE_LABELS[counterpartRole]}.`
  } else {
    const searched = context.coverage.filter((item) => definition.counterpartRoles.includes(item.role))
    const searchedPassageCount = searched.reduce((total, item) => total + item.passageCount, 0)
    const searchedSources = context.sources
      .filter((source) => definition.counterpartRoles.includes(source.role))
      .map((source) => source.fileName)
    const emptyRoles = searched.filter((item) => !item.passageCount).map((item) => item.role)

    counterpart = {
      kind: "not-found-in-supplied-evidence",
      description: describeAbsence(definition.counterpartRoles, searchedPassageCount, searchedSources),
      citationIds: [],
      searchedRoles: [...definition.counterpartRoles],
      searchedPassageCount,
      searchedSources
    }

    if (normalizeLine(record.counterpart, MAX_LINE_LENGTH)) {
      adjustments.push("Replaced the model's counterpart text with what LYTA actually searched.")
    }

    confidence = capConfidence(requestedConfidence, definition.maxConfidence)
    confidenceReason = "Capped at medium: absence from the supplied evidence is weaker than a cited contradiction."

    if (counterpartRefs.items.length) {
      confidence = "low"
      confidenceReason = "Low: the model cited counterpart passages for something it reported as missing."
      adjustments.push("Ignored counterpart citations: an absence finding cannot cite the counterpart it reports as missing.")
    } else if (emptyRoles.length) {
      confidence = "low"
      confidenceReason = `Low: no passage from the ${emptyRoles.map((role) => DRIFT_ROLE_LABELS[role]).join(" or ")} sources matched the scope, so they may not cover it.`
    } else if (confidence !== requestedConfidence) {
      adjustments.push(`Confidence lowered from ${requestedConfidence} to ${confidence}.`)
    }
  }

  claim = claim.slice(0, MAX_LINE_LENGTH)

  return {
    finding: {
      key: driftFindingKey(rule, subject),
      id: "",
      rule,
      subject,
      claim,
      claimRole,
      claimCitationIds: claimItems.map((item) => item.chunkId),
      counterpart,
      detail,
      confidence,
      confidenceReason,
      adjustments,
      diffStatus: "new"
    }
  }
}

/**
 * The deterministic D4 checks. These are facts about the supplied sources, so
 * they carry high confidence; they say nothing about the project itself.
 */
export function buildSourceCheckFindings(sources: DriftSource[], coverage: DriftCoverage[]): DriftFinding[] {
  const findings: DriftFinding[] = []
  const base = {
    rule: "stale-or-missing-source" as const,
    id: "",
    claimRole: null,
    claimCitationIds: [],
    detail: "",
    confidence: "high" as const,
    adjustments: [],
    diffStatus: "new" as const
  }

  for (const item of coverage.filter((entry) => entry.sourceCount && !entry.passageCount)) {
    const names = sources.filter((source) => source.role === item.role).map((source) => source.fileName)
    findings.push({
      ...base,
      key: driftFindingKey("stale-or-missing-source", `missing ${item.role}`),
      subject: `No ${DRIFT_ROLE_LABELS[item.role]} evidence for this scope`,
      claim: `No passage from the selected ${DRIFT_ROLE_LABELS[item.role]} sources matched the comparison scope.`,
      counterpart: {
        kind: "source-check",
        description: `Searched ${names.join(", ")}. Weak matches are dropped, so these sources may not cover the scope, or the scope may need rewording. Findings that rely on this role are unreliable.`,
        citationIds: [],
        searchedRoles: [item.role],
        searchedPassageCount: 0,
        searchedSources: names
      },
      confidenceReason: "High: this is a fact about the retrieval from the supplied sources, not about the project."
    })
  }

  for (const source of sources.filter((candidate) => candidate.supersededBy)) {
    findings.push({
      ...base,
      key: driftFindingKey("stale-or-missing-source", `superseded ${source.fileName}`),
      subject: `${source.fileName} has a newer version`,
      claim: `The selected ${DRIFT_ROLE_LABELS[source.role]} source ${source.fileName} (${source.sourceVersionId}, imported ${source.importedAt}) is not the newest file with that name in the library.`,
      counterpart: {
        kind: "source-check",
        description: `A newer ${source.fileName} (${source.supersededBy!.sourceVersionId}, imported ${source.supersededBy!.importedAt}) was not compared. Findings may reflect stale evidence; re-run with the newer version to check.`,
        citationIds: [],
        searchedRoles: [source.role],
        searchedPassageCount: 0,
        searchedSources: [source.fileName]
      },
      confidenceReason: "High: the library holds a newer file with the same name."
    })
  }

  return findings
}

/** Gives findings run-local display ids and drops later duplicates of the same key. */
export function finalizeDriftFindings(findings: DriftFinding[], adjustments: string[]) {
  const seen = new Set<string>()
  const counters = new Map<string, number>()
  const kept: DriftFinding[] = []

  for (const finding of findings) {
    if (seen.has(finding.key)) {
      adjustments.push(`Dropped a duplicate finding for "${finding.subject}" (${finding.key}).`)
      continue
    }
    seen.add(finding.key)
    const code = DRIFT_RULE_DEFINITIONS[finding.rule].code
    const next = (counters.get(code) || 0) + 1
    counters.set(code, next)
    kept.push({ ...finding, id: `${code}-${next}` })
  }

  return kept
}

/**
 * Compares a run's findings with the previous run by stable key. Earlier runs
 * are never modified: the diff is stored on the new run only. "Resolved" means
 * the previous run reported it and this one did not, which is not proof the
 * drift was fixed.
 */
export function diffDriftRuns(previous: DriftRun | null, findings: DriftFinding[]): { findings: DriftFinding[]; diff: DriftDiff } {
  const previousKeys = new Set(previous?.findings.map((finding) => finding.key) || [])
  const currentKeys = new Set(findings.map((finding) => finding.key))
  const marked = findings.map((finding) => ({
    ...finding,
    diffStatus: previousKeys.has(finding.key) ? ("unchanged" as const) : ("new" as const)
  }))

  return {
    findings: marked,
    diff: {
      previousRunId: previous?.id || null,
      previousRunNumber: previous?.number || null,
      new: marked.filter((finding) => finding.diffStatus === "new").map((finding) => finding.key),
      unchanged: marked.filter((finding) => finding.diffStatus === "unchanged").map((finding) => finding.key),
      resolved: (previous?.findings || [])
        .filter((finding) => !currentKeys.has(finding.key))
        .map((finding) => ({
          key: finding.key,
          rule: finding.rule,
          subject: finding.subject,
          claim: finding.claim,
          lastSeenRunId: previous!.id,
          lastSeenRunNumber: previous!.number
        }))
    }
  }
}

/** Records a disposition against a stable key, keeping earlier decisions in its history. */
export function applyDriftDisposition(comparison: DriftComparison, key: string, entry: DriftDispositionEntry): DriftDispositionState {
  const existing = comparison.dispositions[key]
  const history = [...(existing?.history || []), entry].slice(-MAX_DISPOSITION_HISTORY)
  const next = { ...entry, history }
  comparison.dispositions[key] = next
  comparison.updatedAt = entry.at
  return next
}

export function summarizeDriftRun(run: DriftRun): DriftRunSummary {
  return {
    id: run.id,
    number: run.number,
    createdAt: run.createdAt,
    findingCount: run.findings.length,
    newCount: run.diff.new.length,
    unchangedCount: run.diff.unchanged.length,
    resolvedCount: run.diff.resolved.length
  }
}

/** The retrieval query for one role: the scope, plus what earlier roles returned so counterparts rank. */
export function buildDriftQuery(scope: string, earlier: DriftEvidence[]) {
  return [scope, ...earlier.slice(0, 4).map((item) => item.snippet)].join("\n\n").slice(0, 1800)
}

function describeAbsence(roles: DriftRole[], passageCount: number, sourceNames: string[]) {
  const roleText = roles.map((role) => DRIFT_ROLE_LABELS[role]).join(" and ")
  return `Not found in the supplied evidence. LYTA searched ${passageCount} retrieved passage${
    passageCount === 1 ? "" : "s"
  } from the ${roleText} sources (${sourceNames.join(", ") || "none"}). This shows only that those passages do not support it, not that it is absent from the project.`
}

function capConfidence(value: DriftConfidence, max: DriftConfidence): DriftConfidence {
  return DRIFT_CONFIDENCE.indexOf(value) < DRIFT_CONFIDENCE.indexOf(max) ? max : value
}

function resolveDriftCitations(value: unknown, byRef: Map<string, DriftEvidence>) {
  const items: DriftEvidence[] = []
  const unknownRefs: string[] = []

  for (const ref of Array.isArray(value) ? value : []) {
    if (typeof ref !== "string" || !ref.trim()) continue
    const item = byRef.get(
      ref
        .trim()
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
    )
    if (item) {
      if (!items.includes(item)) items.push(item)
    } else {
      unknownRefs.push(normalizeLine(ref, 40))
    }
  }

  return { items, unknownRefs }
}

/** Accepts bare JSON or JSON wrapped in a Markdown code fence; anything else is malformed. */
function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i)

  try {
    return JSON.parse(fenced ? fenced[1] : trimmed)
  } catch {
    return null
  }
}

function normalizeEnumValue(value: unknown) {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-")
    : ""
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
