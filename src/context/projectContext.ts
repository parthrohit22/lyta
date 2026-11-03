export const CONTEXT_SELECTION_POLICY_VERSION = "2026-08-21"

export const PROJECT_CONTEXT_KINDS = ["finding", "decision", "risk", "assumption", "follow-up", "summary"] as const

export type ProjectContextKind = (typeof PROJECT_CONTEXT_KINDS)[number]

export interface ContextProvenance {
  createdBy: "user" | "system"
  sourceFileIds: string[]
  sourceVersionIds: string[]
  chunkIds: string[]
}

export interface ProjectContextRecord {
  id: string
  kind: ProjectContextKind
  title: string
  content: string
  workspaceScope: string
  provenance: ContextProvenance
  /** Summaries enter the canonical context only after a user creates them. */
  approval: "not-required" | "user-approved"
  /** Set when the record was promoted from a review finding, so the UI can link back to it. */
  origin?: { reviewId: string; findingId: string }
  retention: "until-user-delete"
  createdAt: string
  updatedAt: string
}

/** A non-sensitive audit record: it intentionally contains no query or content. */
export interface ContextSelectionManifest {
  id: string
  workspaceScope: string
  requestId: string
  policyVersion: string
  selectedSourceFileIds: string[]
  selectedSourceVersionIds: string[]
  selectedChunkIds: string[]
  selectedContextRecordIds: string[]
  createdAt: string
}

export function normalizeContextKind(value: unknown): ProjectContextKind | null {
  return PROJECT_CONTEXT_KINDS.includes(value as ProjectContextKind) ? (value as ProjectContextKind) : null
}

export function uniqueIds(values: unknown, max = 40) {
  if (!Array.isArray(values)) return []

  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().slice(0, 160))
        .filter(Boolean)
    )
  ].slice(0, max)
}
