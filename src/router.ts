import type { Env } from "./index"
import { safeJson } from "./utils/safeJson"
import {
  buildRetrievalQuery,
  normalizeChatRequest,
  validateChatRequest,
  type ChatAttachment,
  type ChatMessageRecord,
  type ChatRequestBody
} from "./chat/messages"
import {
  clearAuthCookie,
  getGuestToken,
  getAuthToken,
  setAuthCookie,
  setGuestCookie
} from "./utils/cookies"
import { checkRateLimit } from "./utils/rateLimit"
import { chunkDocumentText, type LibraryCitation } from "./library/chunks"
import { createEmbedding } from "./services/embeddings"

interface AuthUser {
  id: string
  email: string
  isGuest?: boolean
}

interface AuthPayload {
  email?: string
  password?: string
  name?: string
  workspace?: string
}

const JSON_HEADERS = {
  "Content-Type": "application/json"
}

interface Principal {
  user: AuthUser
  workspaceKey: string
  cookieHeaders: string[]
}

export async function router(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname === "/" && request.method === "GET") {
    return Response.json({
      service: "LYTA Edge AI",
      status: "running"
    })
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({
      ok: true,
      service: "LYTA"
    })
  }

  const ip = request.headers.get("CF-Connecting-IP")

  if (!checkRateLimit(ip)) {
    return new Response("Rate limit exceeded", { status: 429 })
  }

  if (url.pathname === "/auth/register" && request.method === "POST") {
    return handleAuth(request, env, "register")
  }

  if (url.pathname === "/auth/login" && request.method === "POST") {
    return handleAuth(request, env, "login")
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    return handleLogout(request, env)
  }

  const principal =
    await resolvePrincipal(request, env)

  const workspace =
    getWorkspaceStub(env, principal.workspaceKey)

  if (url.pathname === "/workspace/bootstrap" && request.method === "GET") {
    await ensureWorkspaceInitialized(workspace, principal.user)

    const response =
      await workspace.fetch("https://internal/bootstrap")

    return finalizePrincipalResponse(
      noStoreJson(await response.json(), {
        user: principal.user
      }),
      principal
    )
  }

  if (url.pathname === "/workspace/profile" && request.method === "POST") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, "/profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: await request.text()
    }), principal)
  }

  if (url.pathname === "/workspace/preferences" && request.method === "POST") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, "/preferences", {
      method: "POST",
      headers: JSON_HEADERS,
      body: await request.text()
    }), principal)
  }

  if (url.pathname === "/sessions" && request.method === "GET") {
    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/sessions"),
      principal
    )
  }

  if (url.pathname === "/sessions/create" && request.method === "POST") {
    await ensureWorkspaceInitialized(workspace, principal.user)

    return finalizePrincipalResponse(await forwardWorkspace(workspace, "/sessions/create", {
      method: "POST"
    }), principal)
  }

  if (url.pathname === "/sessions/delete" && request.method === "POST") {
    const body =
      await safeJson<{ id?: string }>(request)

    const sessionId =
      normalizeSessionId(body?.id)

    if (!sessionId) {
      return new Response("Invalid session", { status: 400 })
    }

    const workspaceResponse =
      await workspace.fetch("https://internal/sessions/delete", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: sessionId
        })
      })

    const conversation =
      getConversationStub(env, principal.workspaceKey, sessionId)

    await conversation.fetch("https://internal/reset", {
      method: "POST"
    })

    return finalizePrincipalResponse(copyResponse(workspaceResponse), principal)
  }

  if (url.pathname === "/library" && request.method === "GET") {
    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/library"),
      principal
    )
  }

  if (url.pathname === "/library/import" && request.method === "POST") {
    const body =
      await safeJson<{ attachments?: ChatAttachment[] }>(request)

    if (
      !body ||
      validateChatRequest({
        attachments: Array.isArray(body.attachments) ? body.attachments : []
      })
    ) {
      return new Response("Attachment required", { status: 400 })
    }

    const attachments =
      normalizeChatRequest({
        attachments: Array.isArray(body.attachments) ? body.attachments : []
      }).attachments

    if (!attachments.length) {
      return new Response("Attachment required", { status: 400 })
    }

    const importedFiles =
      await importAttachmentsIntoLibrary(env, workspace, attachments)

    return finalizePrincipalResponse(
      noStoreJson({
        files: importedFiles
      }),
      principal
    )
  }

  if (url.pathname === "/library/delete" && request.method === "POST") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, "/library/delete", {
      method: "POST",
      headers: JSON_HEADERS,
      body: await request.text()
    }), principal)
  }

  const sessionId =
    normalizeSessionId(url.searchParams.get("session"))

  if (!sessionId) {
    return new Response("Session required", { status: 400 })
  }

  const exists =
    await workspaceHasSession(workspace, sessionId)

  if (!exists) {
    return new Response("Session not found", { status: 404 })
  }

  if (url.pathname === "/history" && request.method === "GET") {
    return forwardConversationRequest(
        env,
        principal.workspaceKey,
        sessionId,
        "/history"
      )
      .then(response => finalizePrincipalResponse(response, principal))
  }

  if (url.pathname === "/meta" && request.method === "GET") {
    const response =
      await forwardConversationRequest(
        env,
        principal.workspaceKey,
        sessionId,
        "/meta"
      )

    if (response.ok) {
      const data = await response.clone().json() as { title?: string }

      if (typeof data.title === "string" && data.title.trim()) {
        await workspace.fetch("https://internal/sessions/rename", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            id: sessionId,
            title: data.title
          })
        })
      }
    }

    return finalizePrincipalResponse(response, principal)
  }

  if (url.pathname === "/stats" && request.method === "GET") {
    return forwardConversationRequest(
        env,
        principal.workspaceKey,
        sessionId,
        "/stats"
      )
      .then(response => finalizePrincipalResponse(response, principal))
  }

  if (url.pathname === "/reset" && request.method === "POST") {
    const response =
      await forwardConversationRequest(
        env,
        principal.workspaceKey,
        sessionId,
        "/reset",
        { method: "POST" }
      )

    await workspace.fetch("https://internal/sessions/rename", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: sessionId,
        title: "New Chat"
      })
    })

    return finalizePrincipalResponse(response, principal)
  }

  if (
    (url.pathname === "/chat" || url.pathname === "/chat/stream") &&
    request.method === "POST"
  ) {
    const body = await safeJson<ChatRequestBody>(request)

    if (!body) {
      return new Response("Body missing", { status: 400 })
    }

    const validationError =
      validateChatRequest(body)

    if (validationError) {
      return new Response(validationError, { status: 400 })
    }

    const payload =
      normalizeChatRequest(body)

    if (!payload.message && !payload.attachments.length) {
      return new Response("Message or attachment required", { status: 400 })
    }

    await workspace.fetch("https://internal/sessions/touch", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: sessionId
      })
    })

    if (payload.attachments.length) {
      await importAttachmentsIntoLibrary(env, workspace, payload.attachments)
    }

    const libraryContext =
      await searchWorkspaceLibrary(env, workspace, payload)

    return forwardConversationRequest(
        env,
        principal.workspaceKey,
        sessionId,
        url.pathname,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...payload,
          userId: principal.workspaceKey,
          sessionId,
          workspaceContext: libraryContext.context,
          citations: libraryContext.citations
        })
      }
    )
      .then(response => finalizePrincipalResponse(response, principal))
  }

  return new Response("Not Found", { status: 404 })
}

async function handleAuth(
  request: Request,
  env: Env,
  action: "register" | "login"
) {
  try {
    const body =
      await safeJson<AuthPayload>(request)

    if (!body?.email || !body?.password) {
      return new Response("Email and password are required", {
        status: 400
      })
    }

    const authDirectory =
      getAuthDirectoryStub(env)

    const response =
      await authDirectory.fetch(`https://internal/${action}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          email: body.email,
          password: body.password
        })
      })

    if (!response.ok) {
      return copyResponse(response)
    }

    const data =
      await response.json() as {
        token: string
        user: AuthUser
      }

    const workspace =
      getWorkspaceStub(env, data.user.id)

    const initializeResponse =
      await workspace.fetch("https://internal/initialize", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          email: data.user.email,
          name: normalizeProfileName(body.name, data.user.email),
          workspace: normalizeWorkspaceName(body.workspace, body.name, data.user.email)
        })
      })

    if (!initializeResponse.ok) {
      return new Response("Workspace setup failed", {
        status: 500
      })
    }

    return noStoreJson(
      {
        ok: true,
        user: data.user
      },
      undefined,
      {
        "Set-Cookie": setAuthCookie(data.token, request.url)
      }
    )
  } catch (error) {
    console.error("handleAuth failure", error)
    return new Response("Unable to create account right now", {
      status: 500
    })
  }
}

async function handleLogout(request: Request, env: Env) {
  const token =
    getAuthToken(request)

  const authDirectory =
    getAuthDirectoryStub(env)

  await authDirectory.fetch("https://internal/logout", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      token
    })
  })

  return noStoreJson(
    {
      ok: true
    },
    undefined,
    {
      "Set-Cookie": clearAuthCookie(request.url)
    }
  )
}

async function resolvePrincipal(request: Request, env: Env): Promise<Principal> {
  const token =
    getAuthToken(request)

  if (token) {
    const authDirectory =
      getAuthDirectoryStub(env)

    const response =
      await authDirectory.fetch("https://internal/session", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          token
        })
      })

    if (response.ok) {
      const data =
        await response.json() as {
          user: AuthUser
        }

      return {
        user: {
          ...data.user,
          isGuest: false
        },
        workspaceKey: data.user.id,
        cookieHeaders: []
      }
    }

    return createGuestPrincipal(request, [clearAuthCookie(request.url)])
  }

  return createGuestPrincipal(request)
}

async function createGuestPrincipal(
  request: Request,
  cookieHeaders: string[] = []
): Promise<Principal> {
  let guestToken =
    getGuestToken(request)

  if (!guestToken) {
    guestToken = crypto.randomUUID().replace(/-/g, "")
    cookieHeaders.push(setGuestCookie(guestToken, request.url))
  }

  return {
    user: {
      id: `guest_${guestToken}`,
      email: "",
      isGuest: true
    },
    workspaceKey: `guest:${guestToken}`,
    cookieHeaders
  }
}

async function ensureWorkspaceInitialized(
  workspace: DurableObjectStub,
  user: AuthUser
) {
  await workspace.fetch("https://internal/initialize", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      email: user.email || "",
      name: user.isGuest ? "Guest" : normalizeProfileName(undefined, user.email),
      workspace: user.isGuest ? "Temporary Workspace" : normalizeWorkspaceName(undefined, undefined, user.email)
    })
  })
}

async function forwardConversationRequest(
  env: Env,
  userId: string,
  sessionId: string,
  path: string,
  init?: RequestInit
) {
  const conversation =
    getConversationStub(env, userId, sessionId)

  const response =
    await conversation.fetch(`https://internal${path}`, init)

  return copyResponse(response)
}

async function forwardWorkspace(
  workspace: DurableObjectStub,
  path: string,
  init?: RequestInit
) {
  const response =
    await workspace.fetch(`https://internal${path}`, init)

  return copyResponse(response)
}

function getAuthDirectoryStub(env: Env) {
  return env.AUTH_DIRECTORY.get(
    env.AUTH_DIRECTORY.idFromName("global")
  )
}

function getWorkspaceStub(env: Env, userId: string) {
  return env.WORKSPACE.get(
    env.WORKSPACE.idFromName(userId)
  )
}

function getConversationStub(env: Env, userId: string, sessionId: string) {
  return env.CONVERSATION.get(
    env.CONVERSATION.idFromName(`${userId}:${sessionId}`)
  )
}

async function workspaceHasSession(
  workspace: DurableObjectStub,
  sessionId: string
) {
  const response =
    await workspace.fetch("https://internal/sessions/has", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: sessionId
      })
    })

  if (!response.ok) {
    return false
  }

  const data =
    await response.json() as {
      exists?: boolean
    }

  return Boolean(data.exists)
}

async function importAttachmentsIntoLibrary(
  env: Env,
  workspace: DurableObjectStub,
  attachments: ChatAttachment[]
) {
  const freshAttachments =
    attachments.filter(attachment => !attachment.libraryFileId)

  if (!freshAttachments.length) {
    return []
  }

  const files: Array<ChatAttachment & { signature: string }> = []
  const chunks: Array<{
    id: string
    fileId: string
    fileName: string
    text: string
    vector: number[]
  }> = []
  const seen = new Set<string>()

  for (const attachment of freshAttachments) {
    const signature =
      await createAttachmentSignature(attachment)

    if (seen.has(signature)) {
      continue
    }

    seen.add(signature)
    files.push({
      ...attachment,
      signature
    })

    if (
      attachment.kind === "document" &&
      typeof attachment.extractedText === "string" &&
      attachment.extractedText.trim()
    ) {
      const parts =
        chunkDocumentText(attachment.extractedText)

      const vectors =
        await Promise.all(
          parts.map(text => createEmbedding(env, text))
        )

      parts.forEach((text, index) => {
        chunks.push({
          id: `${signature}-${index}`,
          fileId: signature,
          fileName: attachment.name,
          text,
          vector: vectors[index]
        })
      })
    }
  }

  if (!files.length) {
    return []
  }

  const response =
    await workspace.fetch("https://internal/library/upsert", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        files,
        chunks
      })
    })

  if (!response.ok) {
    throw new Error(await response.text() || "Unable to store files.")
  }

  const data =
    await response.json() as {
      files?: unknown[]
    }

  return Array.isArray(data.files) ? data.files : []
}

async function searchWorkspaceLibrary(
  env: Env,
  workspace: DurableObjectStub,
  payload: ReturnType<typeof normalizeChatRequest>
) {
  const userMessage: ChatMessageRecord = {
    role: "user",
    content: payload.message,
    mode: payload.mode,
    attachments: payload.attachments
  }

  const query =
    buildRetrievalQuery(userMessage)

  if (!query) {
    return {
      context: "",
      citations: [] as LibraryCitation[]
    }
  }

  const queryVector =
    await createEmbedding(env, query)

  const response =
    await workspace.fetch("https://internal/library/search", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        queryVector,
        topK: 4
      })
    })

  if (!response.ok) {
    return {
      context: "",
      citations: [] as LibraryCitation[]
    }
  }

  const data =
    await response.json() as {
      context?: string
      citations?: LibraryCitation[]
    }

  return {
    context:
      typeof data.context === "string"
        ? data.context
        : "",
    citations:
      Array.isArray(data.citations)
        ? data.citations
        : []
  }
}

async function createAttachmentSignature(attachment: ChatAttachment) {
  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode([
        attachment.kind,
        attachment.name,
        attachment.mimeType,
        String(attachment.size),
        attachment.summary || "",
        attachment.kind === "image"
          ? attachment.dataUrl || ""
          : attachment.extractedText || ""
      ].join("\n"))
    )

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

function normalizeSessionId(value: string | undefined | null) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120)
}

function normalizeProfileName(value: string | undefined, email: string) {
  const cleaned =
    normalizeInlineText(value)

  if (cleaned) {
    return cleaned
  }

  const localPart =
    email.split("@")[0]
      .replace(/[._-]+/g, " ")
      .trim()

  return titleCase(localPart) || "Guest User"
}

function normalizeWorkspaceName(
  value: string | undefined,
  name: string | undefined,
  email: string
) {
  const cleaned =
    normalizeInlineText(value)

  if (cleaned) {
    return cleaned
  }

  const derivedName =
    normalizeProfileName(name, email)

  if (derivedName && derivedName !== "Guest User") {
    return `${derivedName} Studio`.slice(0, 50)
  }

  return "Private Workspace"
}

function normalizeInlineText(value: string | undefined) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/\s+/g, " ").trim().slice(0, 50)
}

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 40)
}

function noStoreJson(
  body: unknown,
  mergeBody?: Record<string, unknown>,
  headers?: Record<string, string>
) {
  return new Response(
    JSON.stringify({
      ...(typeof body === "object" && body ? body as Record<string, unknown> : {}),
      ...(mergeBody || {})
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(headers || {})
      }
    }
  )
}

function copyResponse(response: Response) {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "no-store")

  return new Response(response.body, {
    status: response.status,
    headers
  })
}

function finalizePrincipalResponse(response: Response, principal: Principal) {
  if (!principal.cookieHeaders.length) {
    return response
  }

  const headers = new Headers(response.headers)

  principal.cookieHeaders.forEach(value => {
    headers.append("Set-Cookie", value)
  })

  return new Response(response.body, {
    status: response.status,
    headers
  })
}
