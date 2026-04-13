import { createId } from "../auth/crypto"
import {
  buildLibrarySearchResult,
  type WorkspaceChunk
} from "../library/chunks"

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
  createdAt: string
  updatedAt: string
  attachment: {
    id?: string
    kind: "image" | "document"
    name: string
    mimeType: string
    size: number
    summary?: string
    dataUrl?: string
    extractedText?: string
  }
}

const MAX_SESSIONS = 80
const MAX_LIBRARY_FILES = 40
const MAX_LIBRARY_CHUNKS = 300

export class Workspace {

  state: DurableObjectState
  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState){
    this.state = state
  }

  async fetch(request: Request): Promise<Response>{
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
      return this.getLibrary()
    }

    if (path === "/library/upsert" && request.method === "POST") {
      return this.queue(() => this.upsertLibrary(request))
    }

    if (path === "/library/delete" && request.method === "POST") {
      return this.queue(() => this.deleteLibraryFile(request))
    }

    if (path === "/library/search" && request.method === "POST") {
      return this.searchLibrary(request)
    }

    return new Response("Not Found", { status: 404 })
  }

  private async queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn)
    this.lock = next.then(() => {}, () => {})
    return next
  }

  private async initialize(request: Request) {
    const body = await request.json() as {
      name?: string
      workspace?: string
      email?: string
    }

    const profile =
      (await this.state.storage.get<WorkspaceProfile>("profile")) || null

    if (profile) {
      return Response.json({ ok: true })
    }

    await this.state.storage.put("profile", {
      name: normalizeText(body.name, 40) || "Guest User",
      workspace: normalizeText(body.workspace, 50) || "Private Workspace",
      email: normalizeText(body.email, 120)
    } satisfies WorkspaceProfile)

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
    const profile =
      (await this.state.storage.get<WorkspaceProfile>("profile")) || {
        name: "Guest User",
        workspace: "Private Workspace",
        email: ""
      }

    const preferences =
      normalizePreferences(
        (await this.state.storage.get<WorkspacePreferences>("preferences")) || null
      )

    const sessions =
      sortSessions(
        (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []
      )

    const library =
      (await this.state.storage.get<StoredLibraryFile[]>("library")) || []

    return Response.json({
      profile,
      preferences,
      sessions,
      library: library.map(toLibraryClientFile)
    })
  }

  private async updateProfile(request: Request) {
    const body = await request.json() as {
      name?: string
      workspace?: string
    }

    const current =
      (await this.state.storage.get<WorkspaceProfile>("profile")) || {
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
    const body = await request.json() as {
      theme?: Record<string, string>
      ui?: {
        sidebarHidden?: boolean
        boardOpen?: boolean
        chatMode?: string
      }
    }

    const current =
      normalizePreferences(
        (await this.state.storage.get<WorkspacePreferences>("preferences")) || null
      )

    const next = {
      theme: sanitizeTheme(body.theme ?? current.theme),
      ui: {
        sidebarHidden: Boolean(body.ui?.sidebarHidden ?? current.ui.sidebarHidden),
        boardOpen: Boolean(body.ui?.boardOpen ?? current.ui.boardOpen),
        chatMode:
          body.ui?.chatMode === "deep" || body.ui?.chatMode === "creative"
            ? body.ui.chatMode
            : current.ui.chatMode || "instant"
      }
    } satisfies WorkspacePreferences

    await this.state.storage.put("preferences", next)

    return Response.json({
      preferences: next
    })
  }

  private async getSessions() {
    const sessions =
      sortSessions(
        (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []
      )

    return Response.json({ sessions })
  }

  private async createSession() {
    let sessions = sortSessions(
      (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []
    )

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
    const body = await request.json() as {
      id?: string
      title?: string
    }

    if (!body?.id || !body?.title) {
      return new Response("Invalid rename", { status: 400 })
    }

    const sessions = sortSessions(
      (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []
    )

    const session = sessions.find(item => item.id === body.id)

    if (session) {
      session.title = normalizeText(body.title, 60) || session.title
      session.updatedAt = new Date().toISOString()
      await this.state.storage.put("sessions", sortSessions(sessions))
    }

    return Response.json({ ok: true })
  }

  private async deleteSession(request: Request) {
    const body = await request.json() as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid session", { status: 400 })
    }

    const sessions =
      (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []

    await this.state.storage.put(
      "sessions",
      sortSessions(
        sessions.filter(session => session.id !== body.id)
      )
    )

    return Response.json({ ok: true })
  }

  private async touchSession(request: Request) {
    const body = await request.json() as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid session", { status: 400 })
    }

    const sessions = sortSessions(
      (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []
    )

    const session = sessions.find(item => item.id === body.id)

    if (session) {
      session.updatedAt = new Date().toISOString()
      await this.state.storage.put("sessions", sortSessions(sessions))
    }

    return Response.json({ ok: true })
  }

  private async hasSession(request: Request) {
    const body = await request.json() as {
      id?: string
    }

    const sessions =
      (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []

    return Response.json({
      exists: !!body?.id && sessions.some(session => session.id === body.id)
    })
  }

  private async getLibrary() {
    const files =
      (await this.state.storage.get<StoredLibraryFile[]>("library")) || []

    return Response.json({
      files: files.map(toLibraryClientFile)
    })
  }

  private async upsertLibrary(request: Request) {
    const body = await request.json() as {
      files?: Array<StoredLibraryFile["attachment"] & { signature?: string }>
      chunks?: WorkspaceChunk[]
    }

    const incomingFiles = Array.isArray(body.files) ? body.files : []
    const incomingChunks = Array.isArray(body.chunks) ? body.chunks : []

    let library =
      (await this.state.storage.get<StoredLibraryFile[]>("library")) || []
    let chunks =
      (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    const now = new Date().toISOString()
    const storedFiles: StoredLibraryFile[] = []

    for (const incoming of incomingFiles) {
      const signature = normalizeText(incoming.signature, 200)

      if (!signature) {
        continue
      }

      const existing = library.find(file => file.signature === signature)

      if (existing) {
        existing.updatedAt = now
        existing.attachment = {
          ...existing.attachment,
          ...incoming
        }
        storedFiles.push(existing)
        continue
      }

      const next: StoredLibraryFile = {
        id: createId("file"),
        signature,
        createdAt: now,
        updatedAt: now,
        attachment: {
          id: incoming.id,
          kind: incoming.kind,
          name: normalizeText(incoming.name, 120) || "Attachment",
          mimeType:
            normalizeText(incoming.mimeType, 120) || "application/octet-stream",
          size: Number.isFinite(incoming.size) ? incoming.size : 0,
          summary: normalizeText(incoming.summary, 280),
          dataUrl: typeof incoming.dataUrl === "string" ? incoming.dataUrl : undefined,
          extractedText:
            typeof incoming.extractedText === "string"
              ? incoming.extractedText
              : undefined
        }
      }

      library.unshift(next)
      storedFiles.push(next)
    }

    for (const storedFile of storedFiles) {
      chunks = chunks.filter(chunk => chunk.fileId !== storedFile.id)

      const matchingChunks = incomingChunks
        .filter(chunk => chunk.fileId === storedFile.signature)
        .map((chunk, index) => ({
          id: createId("chunk"),
          fileId: storedFile.id,
          fileName: storedFile.attachment.name,
          text: chunk.text,
          vector: chunk.vector
        }))

      chunks.push(...matchingChunks)
    }

    if (library.length > MAX_LIBRARY_FILES) {
      const removed = library.slice(MAX_LIBRARY_FILES)
      const removedIds = new Set(removed.map(file => file.id))
      library = library.slice(0, MAX_LIBRARY_FILES)
      chunks = chunks.filter(chunk => !removedIds.has(chunk.fileId))
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
    const body = await request.json() as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid file", { status: 400 })
    }

    const library =
      (await this.state.storage.get<StoredLibraryFile[]>("library")) || []
    const chunks =
      (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    await this.state.storage.put(
      "library",
      library.filter(file => file.id !== body.id)
    )

    await this.state.storage.put(
      "libraryChunks",
      chunks.filter(chunk => chunk.fileId !== body.id)
    )

    return Response.json({ ok: true })
  }

  private async searchLibrary(request: Request) {
    const body = await request.json() as {
      queryVector?: number[]
      topK?: number
    }

    const queryVector = Array.isArray(body.queryVector)
      ? body.queryVector.filter(value => typeof value === "number")
      : []

    if (!queryVector.length) {
      return Response.json({
        context: "",
        citations: []
      })
    }

    const chunks =
      (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    const result = buildLibrarySearchResult(
      queryVector,
      chunks,
      typeof body.topK === "number" ? body.topK : 4
    )

    return Response.json(result)
  }
}

function normalizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return ""
  }

  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
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

function sortSessions(sessions: WorkspaceSession[]) {
  return [...sessions].sort((left, right) => {
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function normalizePreferences(
  preferences: WorkspacePreferences | null
): WorkspacePreferences {
  return {
    theme: sanitizeTheme(preferences?.theme || {}),
    ui: {
      sidebarHidden: Boolean(preferences?.ui?.sidebarHidden),
      boardOpen: preferences?.ui?.boardOpen !== false,
      chatMode:
        preferences?.ui?.chatMode === "deep" ||
        preferences?.ui?.chatMode === "creative"
          ? preferences.ui.chatMode
          : "instant"
    }
  }
}
