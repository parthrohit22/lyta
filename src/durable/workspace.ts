import { createId } from "../auth/crypto"
import type { Env } from "../index"
import { buildLibrarySearchResult, type WorkspaceChunk } from "../library/chunks"
import {
  CONTEXT_SELECTION_POLICY_VERSION,
  normalizeContextKind,
  uniqueIds,
  type ContextProvenance,
  type ContextSelectionManifest,
  type ProjectContextRecord
} from "../context/projectContext"
import {
  applyChallenge,
  hydrateReview,
  normalizeRecordKind,
  type ArchitectureReview,
  type ChallengeResult,
  type FindingDisposition,
  type ReviewEvidence
} from "../review/contract"
import {
  DRIFT_ROLES,
  applyDriftDisposition,
  diffDriftRuns,
  summarizeDriftRun,
  type DriftComparison,
  type DriftComparisonType,
  type DriftDisposition,
  type DriftRole,
  type DriftRuleId,
  type DriftRun,
  type DriftSource
} from "../drift/contract"

interface WorkspaceProfile {
  name: string
  workspace: string
  email: string
}

interface WorkspacePreferences {
  theme: Record<string, string>
  ui: {
    sidebarHidden: boolean
    boardOpen: boolean
    chatMode: string
  }
}

interface WorkspaceSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface StoredLibraryFile {
  id: string
  signature: string
  contentHash: string
  workspaceScope: string
  objectKey: string
  ingestionState: "ready"
  createdAt: string
  updatedAt: string
  sourceVersionId: string
  retention: "until-user-delete"
  attachment: {
    id?: string
    kind: "image" | "document"
    name: string
    mimeType: string
    size: number
    summary?: string
  }
}

type IncomingLibraryAttachment = StoredLibraryFile["attachment"] & {
  signature?: string
  dataUrl?: string
  extractedText?: string
}

type LegacyStoredLibraryFile = Partial<StoredLibraryFile> & {
  id: string
  signature: string
  attachment: StoredLibraryFile["attachment"] & {
    dataUrl?: string
    extractedText?: string
  }
}

const MAX_SESSIONS = 80
const MAX_LIBRARY_FILES = 40
const MAX_LIBRARY_CHUNKS = 300
const MAX_ARTIFACT_BYTES = 2_400_000
const MAX_WORKSPACE_ARTIFACT_BYTES = 12_000_000
const LIBRARY_PAGE_SIZE = 20
const MAX_REVIEWS = 50
const MAX_DRIFT_COMPARISONS = 30
const MAX_DRIFT_RUNS = 25

export class Workspace {
  state: DurableObjectState
  env: Env
  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname

    if (path === "/initialize" && request.method === "POST") {
      return this.queue(() => this.initialize(request))
    }

    if (path === "/bootstrap" && request.method === "GET") {
      return this.bootstrap()
    }

    if (path === "/profile" && request.method === "POST") {
      return this.queue(() => this.updateProfile(request))
    }

    if (path === "/preferences" && request.method === "POST") {
      return this.queue(() => this.updatePreferences(request))
    }

    if (path === "/sessions" && request.method === "GET") {
      return this.getSessions()
    }

    if (path === "/sessions/create" && request.method === "POST") {
      return this.queue(() => this.createSession())
    }

    if (path === "/sessions/rename" && request.method === "POST") {
      return this.queue(() => this.renameSession(request))
    }

    if (path === "/sessions/delete" && request.method === "POST") {
      return this.queue(() => this.deleteSession(request))
    }

    if (path === "/sessions/touch" && request.method === "POST") {
      return this.queue(() => this.touchSession(request))
    }

    if (path === "/sessions/has" && request.method === "POST") {
      return this.hasSession(request)
    }

    if (path === "/library" && request.method === "GET") {
      return this.getLibrary(request)
    }

    if (path === "/library/upsert" && request.method === "POST") {
      return this.queue(() => this.upsertLibrary(request))
    }

    if (path === "/library/quota" && request.method === "POST") {
      return this.checkLibraryQuota(request)
    }

    if (path === "/library/delete" && request.method === "POST") {
      return this.queue(() => this.deleteLibraryFile(request))
    }

    if (path === "/library/search" && request.method === "POST") {
      return this.queue(() => this.searchLibrary(request))
    }

    if (path === "/context" && request.method === "GET") {
      return this.getContext(request)
    }

    if (path === "/context/records" && request.method === "POST") {
      return this.queue(() => this.upsertContextRecord(request))
    }

    if (path === "/context/records/delete" && request.method === "POST") {
      return this.queue(() => this.deleteContextRecord(request))
    }

    if (path === "/context/manifests" && request.method === "GET") {
      return this.getContextManifests(request)
    }

    if (path === "/reviews" && request.method === "GET") {
      return this.listReviews()
    }

    if (path === "/reviews/get" && request.method === "POST") {
      return this.getReview(request)
    }

    if (path === "/reviews/save" && request.method === "POST") {
      return this.queue(() => this.saveReview(request))
    }

    if (path === "/reviews/disposition" && request.method === "POST") {
      return this.queue(() => this.setFindingDisposition(request))
    }

    if (path === "/reviews/challenge" && request.method === "POST") {
      return this.queue(() => this.recordChallenge(request))
    }

    if (path === "/drift" && request.method === "GET") {
      return this.listDriftComparisons()
    }

    if (path === "/drift/get" && request.method === "POST") {
      return this.getDriftComparison(request)
    }

    if (path === "/drift/sources" && request.method === "POST") {
      return this.resolveDriftSources(request)
    }

    if (path === "/drift/runs/save" && request.method === "POST") {
      return this.queue(() => this.saveDriftRun(request))
    }

    if (path === "/drift/disposition" && request.method === "POST") {
      return this.queue(() => this.setDriftDisposition(request))
    }

    return new Response("Not Found", { status: 404 })
  }

  private async queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn)
    this.lock = next.then(
      () => {},
      () => {}
    )
    return next
  }

  private async initialize(request: Request) {
    const body = (await request.json()) as {
      name?: string
      workspace?: string
      email?: string
      scope?: string
    }

    const profile = (await this.state.storage.get<WorkspaceProfile>("profile")) || null

    if (profile) {
      if (body.scope && !(await this.state.storage.get("workspaceScope"))) {
        await this.state.storage.put("workspaceScope", normalizeText(body.scope, 120) || "legacy")
      }
      return Response.json({ ok: true })
    }

    await this.state.storage.put("profile", {
      name: normalizeText(body.name, 40) || "Guest User",
      workspace: normalizeText(body.workspace, 50) || "Private Workspace",
      email: normalizeText(body.email, 120)
    } satisfies WorkspaceProfile)

    await this.state.storage.put("workspaceScope", normalizeText(body.scope, 120) || "legacy")

    await this.state.storage.put("preferences", {
      theme: {},
      ui: {
        sidebarHidden: false,
        boardOpen: true,
        chatMode: "instant"
      }
    } satisfies WorkspacePreferences)

    return Response.json({ ok: true })
  }

  private async bootstrap() {
    const profile = (await this.state.storage.get<WorkspaceProfile>("profile")) || {
      name: "Guest User",
      workspace: "Private Workspace",
      email: ""
    }

    const preferences = normalizePreferences((await this.state.storage.get<WorkspacePreferences>("preferences")) || null)

    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const library = await this.loadLibrary()

    return Response.json({
      profile,
      preferences,
      sessions,
      library: library.slice(0, LIBRARY_PAGE_SIZE).map(toLibraryClientFile),
      libraryPage: {
        nextCursor: library.length > LIBRARY_PAGE_SIZE ? String(LIBRARY_PAGE_SIZE) : null
      }
    })
  }

  private async updateProfile(request: Request) {
    const body = (await request.json()) as {
      name?: string
      workspace?: string
    }

    const current = (await this.state.storage.get<WorkspaceProfile>("profile")) || {
      name: "Guest User",
      workspace: "Private Workspace",
      email: ""
    }

    const next = {
      ...current,
      name: normalizeText(body.name, 40) || current.name,
      workspace: normalizeText(body.workspace, 50) || current.workspace
    }

    await this.state.storage.put("profile", next)

    return Response.json({
      profile: next
    })
  }

  private async updatePreferences(request: Request) {
    const body = (await request.json()) as {
      theme?: Record<string, string>
      ui?: {
        sidebarHidden?: boolean
        boardOpen?: boolean
        chatMode?: string
      }
    }

    const current = normalizePreferences((await this.state.storage.get<WorkspacePreferences>("preferences")) || null)

    const next = {
      theme: sanitizeTheme(body.theme ?? current.theme),
      ui: {
        sidebarHidden: Boolean(body.ui?.sidebarHidden ?? current.ui.sidebarHidden),
        boardOpen: Boolean(body.ui?.boardOpen ?? current.ui.boardOpen),
        chatMode: body.ui?.chatMode === "deep" || body.ui?.chatMode === "creative" ? body.ui.chatMode : current.ui.chatMode || "instant"
      }
    } satisfies WorkspacePreferences

    await this.state.storage.put("preferences", next)

    return Response.json({
      preferences: next
    })
  }

  private async getSessions() {
    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    return Response.json({ sessions })
  }

  private async createSession() {
    let sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const now = new Date().toISOString()
    const id = createId("chat")

    sessions.unshift({
      id,
      title: "New Chat",
      createdAt: now,
      updatedAt: now
    })

    if (sessions.length > MAX_SESSIONS) {
      sessions = sessions.slice(0, MAX_SESSIONS)
    }

    await this.state.storage.put("sessions", sortSessions(sessions))

    return Response.json({
      session: sortSessions(sessions)[0]
    })
  }

  private async renameSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
      title?: string
    }

    if (!body?.id || !body?.title) {
      return new Response("Invalid rename", { status: 400 })
    }

    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const session = sessions.find((item) => item.id === body.id)

    if (session) {
      session.title = normalizeText(body.title, 60) || session.title
      session.updatedAt = new Date().toISOString()
      await this.state.storage.put("sessions", sortSessions(sessions))
    }

    return Response.json({ ok: true })
  }

  private async deleteSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid session", { status: 400 })
    }

    const sessions = (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []

    await this.state.storage.put("sessions", sortSessions(sessions.filter((session) => session.id !== body.id)))

    return Response.json({ ok: true })
  }

  private async touchSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid session", { status: 400 })
    }

    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const session = sessions.find((item) => item.id === body.id)

    if (session) {
      session.updatedAt = new Date().toISOString()
      await this.state.storage.put("sessions", sortSessions(sessions))
    }

    return Response.json({ ok: true })
  }

  private async hasSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    const sessions = (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []

    return Response.json({
      exists: !!body?.id && sessions.some((session) => session.id === body.id)
    })
  }

  private async getLibrary(request: Request) {
    const files = await this.loadLibrary()
    const url = new URL(request.url)
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0)
    const limit = Math.min(
      LIBRARY_PAGE_SIZE,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || String(LIBRARY_PAGE_SIZE), 10) || LIBRARY_PAGE_SIZE)
    )
    const page = files.slice(offset, offset + limit)

    return Response.json({
      files: page.map(toLibraryClientFile),
      nextCursor: offset + page.length < files.length ? String(offset + page.length) : null
    })
  }

  private async checkLibraryQuota(request: Request) {
    const body = (await request.json()) as { files?: Array<{ size?: number }> }
    const incoming = Array.isArray(body.files) ? body.files : []
    const incomingBytes = incoming.reduce((total, file) => total + (Number.isFinite(file?.size) ? Math.max(0, Number(file.size)) : 0), 0)
    const library = await this.loadLibrary()
    const usedBytes = library.reduce((total, file) => total + file.attachment.size, 0)

    if (incoming.some((file) => Number(file?.size) > MAX_ARTIFACT_BYTES) || usedBytes + incomingBytes > MAX_WORKSPACE_ARTIFACT_BYTES) {
      return new Response("Workspace artifact quota exceeded", { status: 413 })
    }

    return Response.json({ ok: true, remainingBytes: MAX_WORKSPACE_ARTIFACT_BYTES - usedBytes - incomingBytes })
  }

  private async upsertLibrary(request: Request) {
    const body = (await request.json()) as {
      files?: IncomingLibraryAttachment[]
      chunks?: WorkspaceChunk[]
    }

    const incomingFiles = Array.isArray(body.files) ? body.files : []
    const incomingChunks = Array.isArray(body.chunks) ? body.chunks : []

    let library = await this.loadLibrary()
    let chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    const now = new Date().toISOString()
    const storedFiles: StoredLibraryFile[] = []

    for (const incoming of incomingFiles) {
      const signature = normalizeText(incoming.signature, 200)

      if (!signature) {
        continue
      }

      const existing = library.find((file) => file.signature === signature)

      if (existing) {
        existing.updatedAt = now
        storedFiles.push(existing)
        continue
      }

      const id = createId("file")
      const objectKey = `workspaces/${await this.workspaceScope()}/artifacts/${id}/${signature}`
      await this.env.ARTIFACTS.put(
        objectKey,
        JSON.stringify({
          dataUrl: incoming.kind === "image" ? incoming.dataUrl || "" : undefined,
          extractedText: incoming.kind === "document" ? incoming.extractedText || "" : undefined
        }),
        { httpMetadata: { contentType: "application/json" } }
      )

      const next: StoredLibraryFile = {
        id,
        signature,
        contentHash: signature,
        workspaceScope: await this.workspaceScope(),
        objectKey,
        ingestionState: "ready",
        createdAt: now,
        updatedAt: now,
        sourceVersionId: `source-version:${signature}`,
        retention: "until-user-delete",
        attachment: {
          id: incoming.id,
          kind: incoming.kind,
          name: normalizeText(incoming.name, 120) || "Attachment",
          mimeType: normalizeText(incoming.mimeType, 120) || "application/octet-stream",
          size: Number.isFinite(incoming.size) ? incoming.size : 0,
          summary: normalizeText(incoming.summary, 280)
        }
      }

      library.unshift(next)
      storedFiles.push(next)
    }

    for (const storedFile of storedFiles) {
      chunks = chunks.filter((chunk) => chunk.fileId !== storedFile.id)

      const matchingChunks = incomingChunks
        .filter((chunk) => chunk.fileId === storedFile.signature)
        .map((chunk, index) => ({
          // The import pipeline derives this from the immutable source hash and
          // index. Preserve it rather than replacing it with a random DO id.
          id: normalizeText(chunk.id, 240) || `${storedFile.sourceVersionId}:chunk:${index}`,
          fileId: storedFile.id,
          fileName: storedFile.attachment.name,
          text: chunk.text,
          vector: chunk.vector,
          sourceVersionId: storedFile.sourceVersionId,
          createdAt: now
        }))

      chunks.push(...matchingChunks)
    }

    if (library.length > MAX_LIBRARY_FILES) {
      const removed = library.slice(MAX_LIBRARY_FILES)
      const removedIds = new Set(removed.map((file) => file.id))
      library = library.slice(0, MAX_LIBRARY_FILES)
      chunks = chunks.filter((chunk) => !removedIds.has(chunk.fileId))
    }

    if (chunks.length > MAX_LIBRARY_CHUNKS) {
      chunks = chunks.slice(-MAX_LIBRARY_CHUNKS)
    }

    await this.state.storage.put("library", library)
    await this.state.storage.put("libraryChunks", chunks)

    return Response.json({
      files: storedFiles.map(toLibraryClientFile)
    })
  }

  private async deleteLibraryFile(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid file", { status: 400 })
    }

    const library = await this.loadLibrary()
    const chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    const deleted = library.find((file) => file.id === body.id)

    if (deleted) {
      await this.env.ARTIFACTS.delete(deleted.objectKey)
    }

    const deletionImpact = await this.removeContextReferences({
      sourceFileIds: [body.id],
      sourceVersionIds: deleted ? [deleted.sourceVersionId] : [],
      chunkIds: chunks.filter((chunk) => chunk.fileId === body.id).map((chunk) => chunk.id)
    })

    await this.state.storage.put(
      "library",
      library.filter((file) => file.id !== body.id)
    )

    await this.state.storage.put(
      "libraryChunks",
      chunks.filter((chunk) => chunk.fileId !== body.id)
    )

    const affectedReviews = await this.removeReviewEvidence(body.id)
    const affectedDriftRuns = await this.removeDriftEvidence(body.id)

    return Response.json({ ok: true, deletionImpact: { ...deletionImpact, affectedReviews, affectedDriftRuns } })
  }

  private async workspaceScope() {
    return (await this.state.storage.get<string>("workspaceScope")) || "legacy"
  }

  /**
   * One-way lazy migration for v3 inline attachment records. The old Durable
   * Object value is rewritten only after every corresponding R2 write succeeds.
   */
  private async loadLibrary(): Promise<StoredLibraryFile[]> {
    const stored = (await this.state.storage.get<LegacyStoredLibraryFile[]>("library")) || []

    if (!stored.some((file) => !file.ingestionState || !file.objectKey || !file.contentHash || !file.sourceVersionId || !file.retention)) {
      return stored as StoredLibraryFile[]
    }

    const scope = await this.workspaceScope()
    const migrated: StoredLibraryFile[] = []

    for (const file of stored) {
      if (file.ingestionState && file.objectKey && file.contentHash) {
        migrated.push({
          ...(file as StoredLibraryFile),
          sourceVersionId: file.sourceVersionId || `source-version:${file.signature || file.id}`,
          retention: "until-user-delete"
        })
        continue
      }

      const id = file.id || createId("file")
      const signature = file.signature || id
      const objectKey = `workspaces/${scope}/artifacts/${id}/${signature}`
      const attachment = file.attachment || {
        kind: "document" as const,
        name: "Attachment",
        mimeType: "application/octet-stream",
        size: 0
      }

      await this.env.ARTIFACTS.put(
        objectKey,
        JSON.stringify({
          dataUrl: attachment.dataUrl || undefined,
          extractedText: attachment.extractedText || undefined
        }),
        { httpMetadata: { contentType: "application/json" } }
      )

      const { dataUrl: _dataUrl, extractedText: _extractedText, ...metadata } = attachment
      migrated.push({
        id,
        signature,
        contentHash: signature,
        workspaceScope: scope,
        objectKey,
        ingestionState: "ready",
        createdAt: file.createdAt || new Date().toISOString(),
        updatedAt: file.updatedAt || new Date().toISOString(),
        sourceVersionId: `source-version:${signature}`,
        retention: "until-user-delete",
        attachment: metadata
      })
    }

    await this.state.storage.put("library", migrated)
    return migrated
  }

  private async searchLibrary(request: Request) {
    const body = (await request.json()) as {
      queryVector?: number[]
      topK?: number
      requestId?: string
      policyVersion?: string
      sourceFileIds?: string[]
    }

    const queryVector = Array.isArray(body.queryVector) ? body.queryVector.filter((value) => typeof value === "number") : []

    if (!queryVector.length) {
      return Response.json({
        context: "",
        citations: []
      })
    }

    let chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []
    // A review scopes retrieval to the sources the user selected. Ids that are
    // not in this workspace's library (deleted, or another workspace's) are
    // reported back rather than silently ignored.
    const scope = Array.isArray(body.sourceFileIds) ? await this.resolveSelectedSources(body.sourceFileIds) : null

    if (scope) {
      const selectedIds = new Set(scope.selectedSources.map((source) => source.fileId))
      chunks = chunks.filter((chunk) => selectedIds.has(chunk.fileId))
    }

    const result = buildLibrarySearchResult(queryVector, chunks, typeof body.topK === "number" ? body.topK : 4)

    await this.recordContextManifest({
      requestId: normalizeText(body.requestId, 120) || createId("context-request"),
      policyVersion: normalizeText(body.policyVersion, 80) || CONTEXT_SELECTION_POLICY_VERSION,
      citations: result.citations
    })

    return Response.json(scope ? { ...result, ...scope } : result)
  }

  private async getContext(request: Request) {
    const url = new URL(request.url)
    const includeContent = url.searchParams.get("includeContent") === "true"
    const records = await this.loadContextRecords()
    const library = await this.loadLibrary()

    return Response.json({
      sources: library.map(toContextSource),
      records: records.map((record) => (includeContent ? record : toContextRecordMetadata(record)))
    })
  }

  private async getContextManifests(request: Request) {
    const url = new URL(request.url)
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 30, 100))
    const manifests = await this.loadContextManifests()
    return Response.json({ manifests: manifests.slice(0, limit) })
  }

  private async upsertContextRecord(request: Request) {
    const body = (await request.json()) as Partial<ProjectContextRecord> & {
      provenance?: Partial<ContextProvenance>
    }
    const record = await this.writeContextRecord(body)

    if (!record) {
      return new Response("A context kind, title, and content are required", { status: 400 })
    }

    return Response.json({ record: toContextRecordMetadata(record) })
  }

  private async writeContextRecord(
    body: Omit<Partial<ProjectContextRecord>, "provenance" | "origin"> & {
      provenance?: Partial<ContextProvenance>
    },
    origin?: ProjectContextRecord["origin"]
  ) {
    const kind = normalizeContextKind(body.kind)
    const title = normalizeText(body.title, 160)
    const content = normalizeTextBlock(body.content, 12_000)

    if (!kind || !title || !content) {
      return null
    }

    const scope = await this.workspaceScope()
    const records = await this.loadContextRecords()
    const library = await this.loadLibrary()
    const chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []
    const fileIds = new Set(library.map((file) => file.id))
    const sourceVersionIds = new Set(library.map((file) => file.sourceVersionId))
    const chunkIds = new Set(chunks.map((chunk) => chunk.id))
    const now = new Date().toISOString()
    const existing = records.find((record) => record.id === normalizeText(body.id, 180))
    const record: ProjectContextRecord = {
      id: existing?.id || createId(`context-${kind}`),
      kind,
      title,
      content,
      workspaceScope: scope,
      provenance: {
        createdBy: "user",
        sourceFileIds: uniqueIds(body.provenance?.sourceFileIds).filter((id) => fileIds.has(id)),
        sourceVersionIds: uniqueIds(body.provenance?.sourceVersionIds).filter((id) => sourceVersionIds.has(id)),
        chunkIds: uniqueIds(body.provenance?.chunkIds).filter((id) => chunkIds.has(id))
      },
      approval: kind === "summary" ? "user-approved" : "not-required",
      ...((origin || existing?.origin) && { origin: origin || existing?.origin }),
      retention: "until-user-delete",
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }

    await this.state.storage.put(
      "projectContextRecords",
      [record, ...records.filter((candidate) => candidate.id !== record.id)].slice(0, 200)
    )
    return record
  }

  private async deleteContextRecord(request: Request) {
    const body = (await request.json()) as { id?: string }
    const id = normalizeText(body.id, 180)
    if (!id) return new Response("Invalid context record", { status: 400 })

    const records = await this.loadContextRecords()
    const exists = records.some((record) => record.id === id)
    await this.state.storage.put(
      "projectContextRecords",
      records.filter((record) => record.id !== id)
    )
    return Response.json({ ok: true, deleted: exists })
  }

  private async removeContextReferences(provenance: Partial<ContextProvenance>) {
    const sourceFileIds = new Set(provenance.sourceFileIds || [])
    const sourceVersionIds = new Set(provenance.sourceVersionIds || [])
    const chunkIds = new Set(provenance.chunkIds || [])
    const records = await this.loadContextRecords()
    const affectedRecords = records.filter(
      (record) =>
        record.provenance.sourceFileIds.some((id) => sourceFileIds.has(id)) ||
        record.provenance.sourceVersionIds.some((id) => sourceVersionIds.has(id)) ||
        record.provenance.chunkIds.some((id) => chunkIds.has(id))
    )

    // Deleting a source invalidates derived records. This avoids surfacing a
    // finding or decision whose supporting evidence is no longer available.
    await this.state.storage.put(
      "projectContextRecords",
      records.filter((record) => !affectedRecords.includes(record))
    )
    // Manifests are immutable audit evidence. They contain IDs only, so keeping
    // them records what a previous request received without retaining content.
    return { removedDerivedRecords: affectedRecords.length }
  }

  private async recordContextManifest(input: {
    requestId: string
    policyVersion: string
    citations: Array<{ id: string; fileId: string }>
  }) {
    const library = await this.loadLibrary()
    const sourceFileIds = uniqueIds(input.citations.map((citation) => citation.fileId))
    const sourceVersionIds = sourceFileIds
      .map((fileId) => library.find((file) => file.id === fileId)?.sourceVersionId)
      .filter((value): value is string => Boolean(value))
    const manifest: ContextSelectionManifest = {
      id: createId("context-manifest"),
      workspaceScope: await this.workspaceScope(),
      requestId: input.requestId,
      policyVersion: input.policyVersion,
      selectedSourceFileIds: sourceFileIds,
      selectedSourceVersionIds: uniqueIds(sourceVersionIds),
      selectedChunkIds: uniqueIds(input.citations.map((citation) => citation.id)),
      selectedContextRecordIds: [],
      createdAt: new Date().toISOString()
    }
    const manifests = await this.loadContextManifests()
    manifests.unshift(manifest)
    await this.state.storage.put("contextSelectionManifests", manifests.slice(0, 200))
  }

  private async resolveSelectedSources(sourceFileIds: unknown[]) {
    const library = await this.loadLibrary()
    const requested = uniqueIds(sourceFileIds, 20)
    const selectedSources = requested
      .map((fileId) => library.find((file) => file.id === fileId))
      .filter((file): file is StoredLibraryFile => Boolean(file))
      .map((file) => ({ fileId: file.id, fileName: file.attachment.name, sourceVersionId: file.sourceVersionId }))

    return {
      selectedSources,
      unavailableSourceFileIds: requested.filter((fileId) => !selectedSources.some((source) => source.fileId === fileId))
    }
  }

  private async listReviews() {
    const reviews = await this.loadReviews()

    return Response.json({
      reviews: reviews.map((review) => ({
        id: review.id,
        title: normalizeText(review.input.proposedChange, 90),
        readiness: review.readiness,
        findingCount: review.findings.length,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt
      }))
    })
  }

  private async getReview(request: Request) {
    const body = (await request.json()) as { id?: string }
    const review = (await this.loadReviews()).find((candidate) => candidate.id === normalizeText(body.id, 120))

    if (!review) {
      return new Response("Review not found", { status: 404 })
    }

    return Response.json({ review })
  }

  private async saveReview(request: Request) {
    const body = (await request.json()) as { review?: Omit<ArchitectureReview, "id" | "createdAt" | "updatedAt"> }

    if (!body.review || !Array.isArray(body.review.findings) || !body.review.input) {
      return new Response("Invalid review", { status: 400 })
    }

    const now = new Date().toISOString()
    const review: ArchitectureReview = {
      ...body.review,
      id: createId("review"),
      createdAt: now,
      updatedAt: now
    }
    const reviews = await this.loadReviews()

    await this.state.storage.put("architectureReviews", [review, ...reviews].slice(0, MAX_REVIEWS))

    return Response.json({ review })
  }

  /**
   * Accepting a finding promotes it into the canonical project context as a
   * `finding` record with chunk-level provenance, so deleting a cited source
   * invalidates it like any other derived record. Rejecting it, or returning
   * it to unresolved, removes that record again.
   */
  private async setFindingDisposition(request: Request) {
    const body = (await request.json()) as {
      id?: string
      findingId?: string
      disposition?: FindingDisposition
      note?: string
      recordAs?: string
    }
    const reviews = await this.loadReviews()
    const review = reviews.find((candidate) => candidate.id === normalizeText(body.id, 120))
    const finding = review?.findings.find((candidate) => candidate.id === normalizeText(body.findingId, 20))

    if (!review || !finding) {
      return new Response("Finding not found", { status: 404 })
    }

    if (finding.withdrawn && body.disposition === "accepted") {
      return new Response("This finding was withdrawn after a challenge and cannot be accepted", { status: 409 })
    }

    const now = new Date().toISOString()
    finding.disposition = body.disposition === "accepted" || body.disposition === "rejected" ? body.disposition : "unresolved"
    finding.dispositionNote = normalizeTextBlock(body.note, 500)
    finding.dispositionUpdatedAt = now

    if (finding.disposition === "accepted") {
      const cited = review.evidence.filter((item) => finding.citationIds.includes(item.chunkId) && !item.sourceDeleted)
      const recordKind = normalizeRecordKind(body.recordAs)
      const record = await this.writeContextRecord(
        {
          id: finding.contextRecordId || undefined,
          kind: recordKind,
          title: finding.title,
          content: [
            `Classification: ${finding.classification}`,
            `Affected area: ${finding.areaType}${finding.area ? ` — ${finding.area}` : ""}`,
            finding.detail,
            finding.dispositionNote ? `Reviewer note: ${finding.dispositionNote}` : "",
            `Accepted from architecture review ${review.id}.`
          ]
            .filter(Boolean)
            .join("\n"),
          provenance: {
            sourceFileIds: cited.map((item) => item.fileId),
            sourceVersionIds: review.sources
              .filter((source) => cited.some((item) => item.fileId === source.fileId))
              .map((source) => source.sourceVersionId),
            chunkIds: cited.map((item) => item.chunkId)
          }
        },
        { reviewId: review.id, findingId: finding.id }
      )
      finding.contextRecordId = record?.id || null
      finding.recordKind = record ? recordKind : null
    } else if (finding.contextRecordId) {
      const records = await this.loadContextRecords()
      await this.state.storage.put(
        "projectContextRecords",
        records.filter((record) => record.id !== finding.contextRecordId)
      )
      finding.contextRecordId = null
      finding.recordKind = null
    }

    review.updatedAt = now
    await this.state.storage.put("architectureReviews", reviews)

    return Response.json({ review, finding })
  }

  /**
   * Stores a validated challenge. The router ran retrieval and the model
   * against the review as of `expectedUpdatedAt`; if the review changed in the
   * meantime the challenge is refused so evidence refs cannot collide.
   */
  private async recordChallenge(request: Request) {
    const body = (await request.json()) as {
      id?: string
      findingId?: string
      expectedUpdatedAt?: string
      requestId?: string
      reason?: string
      result?: ChallengeResult
      addedEvidence?: ReviewEvidence[]
    }
    const reviews = await this.loadReviews()
    const review = reviews.find((candidate) => candidate.id === normalizeText(body.id, 120))
    const finding = review?.findings.find((candidate) => candidate.id === normalizeText(body.findingId, 20))

    if (!review || !finding || !body.result) {
      return new Response("Finding not found", { status: 404 })
    }

    if (finding.withdrawn) {
      return new Response("This finding was already withdrawn", { status: 409 })
    }

    if (review.updatedAt !== body.expectedUpdatedAt) {
      return new Response("The review changed while the challenge ran. Please retry.", { status: 409 })
    }

    const { challenge, staleContextRecordId } = applyChallenge(review, finding, body.result, {
      requestId: normalizeText(body.requestId, 120),
      reason: normalizeTextBlock(body.reason, 500),
      addedEvidence: Array.isArray(body.addedEvidence) ? body.addedEvidence : [],
      now: new Date().toISOString()
    })

    if (staleContextRecordId) {
      const records = await this.loadContextRecords()
      await this.state.storage.put(
        "projectContextRecords",
        records.filter((record) => record.id !== staleContextRecordId)
      )
    }

    await this.state.storage.put("architectureReviews", reviews)

    return Response.json({ review, finding, challenge })
  }

  /**
   * Deleting a source clears its excerpts from stored reviews. The finding
   * text and citation ids stay so the review history remains auditable, but
   * the deleted content itself is no longer retained or exported.
   */
  private async removeReviewEvidence(fileId: string) {
    const reviews = await this.loadReviews()
    const recordIds = new Set((await this.loadContextRecords()).map((record) => record.id))
    let affected = 0

    for (const review of reviews) {
      const deleted = review.evidence.filter((item) => item.fileId === fileId)
      if (!deleted.length) continue

      affected += 1
      for (const item of deleted) {
        item.sourceDeleted = true
        item.snippet = ""
      }
      for (const finding of review.findings) {
        if (finding.contextRecordId && !recordIds.has(finding.contextRecordId)) {
          finding.contextRecordId = null
        }
      }
      review.updatedAt = new Date().toISOString()
    }

    if (affected) {
      await this.state.storage.put("architectureReviews", reviews)
    }

    return affected
  }

  /* ------------------------------------------------------------------ */
  /* drift comparisons                                                   */
  /* ------------------------------------------------------------------ */

  // Each comparison and each run is stored under its own key, so a long run
  // history never pushes one storage value past its size limit. Runs are
  // written once and never rewritten, except that deleting a library source
  // clears its excerpts (as it does for reviews).

  private async listDriftComparisons() {
    const comparisons = await this.loadDriftComparisons()

    return Response.json({
      comparisons: comparisons.map((comparison) => ({
        id: comparison.id,
        type: comparison.type,
        title: normalizeText(comparison.scope, 90),
        runCount: comparison.runs.length,
        latestRun: comparison.runs[comparison.runs.length - 1] || null,
        createdAt: comparison.createdAt,
        updatedAt: comparison.updatedAt
      }))
    })
  }

  private async getDriftComparison(request: Request) {
    const body = (await request.json()) as { id?: string; runId?: string }
    const comparison = await this.state.storage.get<DriftComparison>(`driftComparison:${normalizeText(body.id, 120)}`)

    if (!comparison) {
      return new Response("Drift comparison not found", { status: 404 })
    }

    const runId = normalizeText(body.runId, 120) || comparison.runs[comparison.runs.length - 1]?.id
    const run = comparison.runs.some((summary) => summary.id === runId)
      ? await this.state.storage.get<DriftRun>(`driftRun:${runId}`)
      : undefined

    if (!run) {
      return new Response("Drift run not found", { status: 404 })
    }

    return Response.json({ comparison, run })
  }

  /**
   * Resolves the role selection against this workspace's library and stamps
   * each source with its version and import date. A selected file is
   * "superseded" when a newer library file has the same name and is not
   * itself part of the comparison.
   */
  private async resolveDriftSources(request: Request) {
    const body = (await request.json()) as { sources?: Partial<Record<DriftRole, string[]>> }
    const library = await this.loadLibrary()
    const selectedIds = new Set(DRIFT_ROLES.flatMap((role) => uniqueIds(body.sources?.[role], 6)))
    const sources: DriftSource[] = []
    const unavailableSourceFileIds: string[] = []

    for (const role of DRIFT_ROLES) {
      for (const fileId of uniqueIds(body.sources?.[role], 6)) {
        const file = library.find((candidate) => candidate.id === fileId)

        if (!file) {
          unavailableSourceFileIds.push(fileId)
          continue
        }

        // Latest import wins; ties keep library order, which is newest first.
        const newest = library
          .filter((candidate) => candidate.attachment.name === file.attachment.name)
          .reduce((latest, candidate) => (candidate.createdAt > latest.createdAt ? candidate : latest))
        const supersededBy =
          newest.id !== file.id && !selectedIds.has(newest.id)
            ? { fileId: newest.id, sourceVersionId: newest.sourceVersionId, importedAt: newest.createdAt }
            : null

        sources.push({
          role,
          fileId: file.id,
          fileName: file.attachment.name,
          sourceVersionId: file.sourceVersionId,
          importedAt: file.createdAt,
          updatedAt: file.updatedAt,
          supersededBy
        })
      }
    }

    return Response.json({ sources, unavailableSourceFileIds })
  }

  /**
   * Stores a validated run. The diff is computed here, under the queue, against
   * whatever run is latest at save time, so concurrent re-runs still chain.
   */
  private async saveDriftRun(request: Request) {
    const body = (await request.json()) as {
      comparisonId?: string | null
      comparison?: { type: DriftComparisonType; scope: string; rules: DriftRuleId[] }
      run?: Omit<DriftRun, "id" | "comparisonId" | "number" | "diff" | "createdAt">
    }

    if (!body.run || !Array.isArray(body.run.findings) || !body.comparison) {
      return new Response("Invalid drift run", { status: 400 })
    }

    const now = new Date().toISOString()
    const existingId = normalizeText(body.comparisonId, 120)
    let comparison: DriftComparison | undefined

    if (existingId) {
      comparison = await this.state.storage.get<DriftComparison>(`driftComparison:${existingId}`)

      if (!comparison) {
        return new Response("Drift comparison not found", { status: 404 })
      }

      if (comparison.runs.length >= MAX_DRIFT_RUNS) {
        return new Response(
          `This comparison already has ${MAX_DRIFT_RUNS} runs. Start a new comparison so earlier run history is kept intact.`,
          { status: 409 }
        )
      }
    } else {
      comparison = {
        id: createId("drift"),
        type: body.comparison.type,
        scope: body.comparison.scope,
        rules: body.comparison.rules,
        createdAt: now,
        updatedAt: now,
        runs: [],
        dispositions: {}
      }
    }

    const latest = comparison.runs[comparison.runs.length - 1]
    const previous = latest ? (await this.state.storage.get<DriftRun>(`driftRun:${latest.id}`)) || null : null
    const { findings, diff } = diffDriftRuns(previous, body.run.findings)
    const run: DriftRun = {
      ...body.run,
      id: createId("drift-run"),
      comparisonId: comparison.id,
      number: comparison.runs.length + 1,
      findings,
      diff,
      createdAt: now
    }

    comparison.runs = [...comparison.runs, summarizeDriftRun(run)]
    comparison.updatedAt = now

    await this.state.storage.put(`driftRun:${run.id}`, run)
    await this.state.storage.put(`driftComparison:${comparison.id}`, comparison)

    if (!existingId) {
      const ids = (await this.state.storage.get<string[]>("driftComparisonIds")) || []
      const next = [comparison.id, ...ids]
      // The oldest comparisons are evicted whole, with all of their runs.
      for (const evictedId of next.slice(MAX_DRIFT_COMPARISONS)) {
        const evicted = await this.state.storage.get<DriftComparison>(`driftComparison:${evictedId}`)
        await this.state.storage.delete([
          `driftComparison:${evictedId}`,
          ...(evicted?.runs || []).map((summary) => `driftRun:${summary.id}`)
        ])
      }
      await this.state.storage.put("driftComparisonIds", next.slice(0, MAX_DRIFT_COMPARISONS))
    }

    return Response.json({ comparison, run })
  }

  /** Dispositions belong to the comparison, keyed by stable finding key, so every later run shows them. */
  private async setDriftDisposition(request: Request) {
    const body = (await request.json()) as {
      id?: string
      runId?: string
      findingKey?: string
      disposition?: DriftDisposition
      note?: string
    }
    const comparison = await this.state.storage.get<DriftComparison>(`driftComparison:${normalizeText(body.id, 120)}`)
    const runId = normalizeText(body.runId, 120)
    const run = comparison?.runs.some((summary) => summary.id === runId)
      ? await this.state.storage.get<DriftRun>(`driftRun:${runId}`)
      : undefined
    const key = normalizeText(body.findingKey, 200)

    if (!comparison || !run || !body.disposition) {
      return new Response("Drift run not found", { status: 404 })
    }

    if (!run.findings.some((finding) => finding.key === key) && !run.diff.resolved.some((item) => item.key === key)) {
      return new Response("That finding is not part of this run", { status: 404 })
    }

    const disposition = applyDriftDisposition(comparison, key, {
      disposition: body.disposition,
      note: normalizeTextBlock(body.note, 500),
      runId: run.id,
      at: new Date().toISOString()
    })

    await this.state.storage.put(`driftComparison:${comparison.id}`, comparison)

    return Response.json({ comparison, run, disposition })
  }

  private async removeDriftEvidence(fileId: string) {
    let affected = 0

    for (const comparison of await this.loadDriftComparisons()) {
      for (const summary of comparison.runs) {
        const run = await this.state.storage.get<DriftRun>(`driftRun:${summary.id}`)
        const deleted = run?.evidence.filter((item) => item.fileId === fileId) || []
        if (!run || !deleted.length) continue

        affected += 1
        for (const item of deleted) {
          item.sourceDeleted = true
          item.snippet = ""
        }
        await this.state.storage.put(`driftRun:${run.id}`, run)
      }
    }

    return affected
  }

  private async loadDriftComparisons() {
    const ids = (await this.state.storage.get<string[]>("driftComparisonIds")) || []
    const comparisons: DriftComparison[] = []

    for (const id of ids) {
      const comparison = await this.state.storage.get<DriftComparison>(`driftComparison:${id}`)
      if (comparison) comparisons.push(comparison)
    }

    return comparisons
  }

  private async loadReviews() {
    return ((await this.state.storage.get<ArchitectureReview[]>("architectureReviews")) || []).map(hydrateReview)
  }

  private async loadContextRecords() {
    return (await this.state.storage.get<ProjectContextRecord[]>("projectContextRecords")) || []
  }

  private async loadContextManifests() {
    return (await this.state.storage.get<ContextSelectionManifest[]>("contextSelectionManifests")) || []
  }
}

function normalizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/\s+/g, " ").trim().slice(0, maxLength)
}

function normalizeTextBlock(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function sanitizeTheme(theme: Record<string, string>) {
  const next: Record<string, string> = {}

  for (const [key, value] of Object.entries(theme)) {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      next[key] = value.toLowerCase()
    }
  }

  return next
}

function toLibraryClientFile(file: StoredLibraryFile) {
  return {
    libraryFileId: file.id,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    ...file.attachment
  }
}

function toContextSource(file: StoredLibraryFile) {
  const { id: _attachmentId, ...attachment } = file.attachment
  return {
    id: file.id,
    sourceVersionId: file.sourceVersionId,
    workspaceScope: file.workspaceScope,
    retention: file.retention,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    ...attachment
  }
}

function toContextRecordMetadata(record: ProjectContextRecord) {
  const { content: _content, ...metadata } = record
  return metadata
}

function sortSessions(sessions: WorkspaceSession[]) {
  return [...sessions].sort((left, right) => {
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function normalizePreferences(preferences: WorkspacePreferences | null): WorkspacePreferences {
  return {
    theme: sanitizeTheme(preferences?.theme || {}),
    ui: {
      sidebarHidden: Boolean(preferences?.ui?.sidebarHidden),
      boardOpen: preferences?.ui?.boardOpen !== false,
      chatMode: preferences?.ui?.chatMode === "deep" || preferences?.ui?.chatMode === "creative" ? preferences.ui.chatMode : "instant"
    }
  }
}
