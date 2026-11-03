export const CONTEXT_SELECTION_POLICY_VERSION = "2026-11-03"

export type ProjectContextKind = "finding" | "decision" | "summary"

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
  return value === "finding" || value === "decision" || value === "summary" ? value : null
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
