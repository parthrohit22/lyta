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
import { clearAuthCookie, getGuestToken, getAuthToken, setAuthCookie, setGuestCookie } from "./utils/cookies"
import { chunkDocumentText, type LibraryCitation } from "./library/chunks"
import { createEmbedding } from "./services/embeddings"
import { logServerError, scopedPrefix } from "./utils/serverErrors"
import { applyBrowserSecurityHeaders } from "./utils/browserSecurity"
import { recordOperation } from "./utils/telemetry"
import { callWithPolicy } from "./services/ai"
import { getModelProfile } from "./config/modelProfiles"
import {
  REVIEW_CHALLENGE_POLICY_VERSION,
  REVIEW_CONTEXT_POLICY_VERSION,
  insufficientChallengeResult,
  mergeChallengeEvidence,
  normalizeChallengeReason,
  normalizeDisposition,
  normalizeDispositionNote,
  parseChallengeOutput,
  parseReviewOutput,
  toReviewEvidence,
  validateReviewInput,
  type ArchitectureReview,
  type ChallengeResult,
  type ReviewSource
} from "./review/contract"
import { buildChallengeMessages, buildChallengeQuery, buildReviewMessages, buildReviewQuery } from "./review/prompt"
import { renderReviewBrief } from "./review/brief"

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

const CHAT_SERVER_ERROR = "LYTA server error. Please retry; request failed before streaming started."
const REVIEW_EVIDENCE_TOP_K = 6

interface Principal {
  user: AuthUser
  workspaceKey: string
  cookieHeaders: string[]
}

export async function router(request: Request, env: Env): Promise<Response> {
  return applyBrowserSecurityHeaders(await routeRequest(request, env), request.url)
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
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

  const ip = request.headers.get("CF-Connecting-IP") || "unknown"

  if (url.pathname === "/auth/register" && request.method === "POST") {
    const limited = await enforceLimit(env, "auth", ip, { limit: 8, windowMs: 15 * 60_000 })
    if (limited) return limited
    return handleAuth(request, env, "register")
  }

  if (url.pathname === "/auth/login" && request.method === "POST") {
    const limited = await enforceLimit(env, "auth", ip, { limit: 8, windowMs: 15 * 60_000 })
    if (limited) return limited
    return handleAuth(request, env, "login")
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    return handleLogout(request, env)
  }

  const principal = await resolvePrincipal(request, env)

  const limitCategory =
    url.pathname === "/library/import"
      ? "ingestion"
      : url.pathname === "/chat" ||
          url.pathname === "/chat/stream" ||
          (request.method === "POST" &&
            (url.pathname === "/reviews" || /^\/reviews\/[^/]+\/findings\/[^/]+\/challenge$/.test(url.pathname)))
        ? "chat-requests"
        : ""

  if (limitCategory) {
    const limited = await enforceLimit(
      env,
      limitCategory,
      principal.workspaceKey,
      principal.user.isGuest
        ? { limit: limitCategory === "chat-requests" ? 20 : 10, windowMs: 60 * 60_000 }
        : { limit: limitCategory === "chat-requests" ? 120 : 40, windowMs: 60 * 60_000 }
    )
    if (limited) return finalizePrincipalResponse(limited, principal)
  }

  const workspace = getWorkspaceStub(env, principal.workspaceKey)

  if (url.pathname === "/workspace/bootstrap" && request.method === "GET") {
    await ensureWorkspaceInitialized(workspace, principal.user)

    const response = await workspace.fetch("https://internal/bootstrap")

    return finalizePrincipalResponse(
      noStoreJson(await response.json(), {
        user: principal.user
      }),
      principal
    )
  }

  if (url.pathname === "/workspace/profile" && request.method === "POST") {
    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/profile", {
        method: "POST",
        headers: JSON_HEADERS,
        body: await request.text()
      }),
      principal
    )
  }

  if (url.pathname === "/workspace/preferences" && request.method === "POST") {
    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/preferences", {
        method: "POST",
        headers: JSON_HEADERS,
        body: await request.text()
      }),
      principal
    )
  }

  if (url.pathname === "/sessions" && request.method === "GET") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, "/sessions"), principal)
  }

  if (url.pathname === "/sessions/create" && request.method === "POST") {
    await ensureWorkspaceInitialized(workspace, principal.user)

    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/sessions/create", {
        method: "POST"
      }),
      principal
    )
  }

  if (url.pathname === "/sessions/delete" && request.method === "POST") {
    const body = await safeJson<{ id?: string }>(request)

    const sessionId = normalizeSessionId(body?.id)

    if (!sessionId) {
      return new Response("Invalid session", { status: 400 })
    }

    const workspaceResponse = await workspace.fetch("https://internal/sessions/delete", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: sessionId
      })
    })

    const conversation = getConversationStub(env, principal.workspaceKey, sessionId)

    await conversation.fetch("https://internal/reset", {
      method: "POST"
    })

    return finalizePrincipalResponse(copyResponse(workspaceResponse), principal)
  }

  if (url.pathname === "/library" && request.method === "GET") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, `/library${url.search}`), principal)
  }

  if (url.pathname === "/library/import" && request.method === "POST") {
    const requestId = crypto.randomUUID()
    const body = await safeJson<{ attachments?: ChatAttachment[] }>(request)

    if (
      !body ||
      validateChatRequest({
        attachments: Array.isArray(body.attachments) ? body.attachments : []
      })
    ) {
      return new Response("Attachment required", { status: 400 })
    }

    const attachments = normalizeChatRequest({
      attachments: Array.isArray(body.attachments) ? body.attachments : []
    }).attachments

    if (!attachments.length) {
      return new Response("Attachment required", { status: 400 })
    }

    const fileLimited = await enforceLimit(env, "ingestion-files", principal.workspaceKey, {
      limit: principal.user.isGuest ? 40 : 200,
      windowMs: 60 * 60_000,
      cost: attachments.length
    })
    if (fileLimited) return finalizePrincipalResponse(fileLimited, principal)

    let importedFiles: unknown[]

    try {
      importedFiles = await importAttachmentsIntoLibrary(env, workspace, attachments, {
        requestId,
        route: "/library/import",
        attachmentCount: attachments.length,
        principalType: principal.user.isGuest ? "guest" : "account",
        workspacePrefix: scopedPrefix(principal.workspaceKey)
      })
    } catch (error) {
      logServerError("router.library.import", error, {
        requestId,
        route: "/library/import",
        attachmentCount: attachments.length,
        principalType: principal.user.isGuest ? "guest" : "account",
        workspacePrefix: scopedPrefix(principal.workspaceKey)
      })

      return finalizePrincipalResponse(
        noStoreJson(
          {
            error: "Unable to add files to the library right now.",
            requestId
          },
          undefined,
          {
            "X-Lyta-Request-Id": requestId
          },
          502
        ),
        principal
      )
    }

    return finalizePrincipalResponse(
      noStoreJson(
        {
          files: importedFiles,
          requestId
        },
        undefined,
        {
          "X-Lyta-Request-Id": requestId
        }
      ),
      principal
    )
  }

  if (url.pathname === "/library/delete" && request.method === "POST") {
    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/library/delete", {
        method: "POST",
        headers: JSON_HEADERS,
        body: await request.text()
      }),
      principal
    )
  }

  if (url.pathname === "/context" && request.method === "GET") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, `/context${url.search}`), principal)
  }

  if (url.pathname === "/context/records" && request.method === "POST") {
    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/context/records", {
        method: "POST",
        headers: JSON_HEADERS,
        body: await request.text()
      }),
      principal
    )
  }

  if (url.pathname === "/context/records/delete" && request.method === "POST") {
    return finalizePrincipalResponse(
      await forwardWorkspace(workspace, "/context/records/delete", {
        method: "POST",
        headers: JSON_HEADERS,
        body: await request.text()
      }),
      principal
    )
  }

  if (url.pathname === "/context/manifests" && request.method === "GET") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, `/context/manifests${url.search}`), principal)
  }

  if (url.pathname === "/reviews" && request.method === "GET") {
    return finalizePrincipalResponse(await forwardWorkspace(workspace, "/reviews"), principal)
  }

  if (url.pathname === "/reviews" && request.method === "POST") {
    return finalizePrincipalResponse(await handleCreateReview(request, env, workspace, principal), principal)
  }

  const reviewRoute = url.pathname.match(
    /^\/reviews\/([A-Za-z0-9_-]{1,120})(?:\/(export)|\/findings\/([A-Za-z0-9_-]{1,20})(\/challenge)?)?$/
  )

  if (reviewRoute) {
    const [, reviewId, exportSegment, findingId, challengeSegment] = reviewRoute

    if (findingId && challengeSegment && request.method === "POST") {
      return finalizePrincipalResponse(await handleChallengeFinding(request, env, workspace, principal, reviewId, findingId), principal)
    }

    if (findingId && !challengeSegment && request.method === "POST") {
      const body = await safeJson<{ disposition?: string; note?: string; recordAs?: string }>(request)
      const disposition = normalizeDisposition(body?.disposition)

      if (!disposition) {
        return finalizePrincipalResponse(new Response("disposition must be accepted, rejected, or unresolved", { status: 400 }), principal)
      }

      return finalizePrincipalResponse(
        await forwardWorkspace(workspace, "/reviews/disposition", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            id: reviewId,
            findingId,
            disposition,
            note: normalizeDispositionNote(body?.note),
            recordAs: body?.recordAs
          })
        }),
        principal
      )
    }

    if (!findingId && request.method === "GET") {
      const response = await workspace.fetch("https://internal/reviews/get", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: reviewId })
      })

      if (!response.ok || !exportSegment) {
        return finalizePrincipalResponse(copyResponse(response), principal)
      }

      const { review } = (await response.json()) as { review: ArchitectureReview }

      return finalizePrincipalResponse(
        new Response(renderReviewBrief(review), {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="lyta-review-${review.id}.md"`,
            "Cache-Control": "no-store"
          }
        }),
        principal
      )
    }

    return finalizePrincipalResponse(new Response("Method Not Allowed", { status: 405 }), principal)
  }

  const sessionId = normalizeSessionId(url.searchParams.get("session"))

  if (!sessionId) {
    return new Response("Session required", { status: 400 })
  }

  const exists = await workspaceHasSession(workspace, sessionId)

  if (!exists) {
    return new Response("Session not found", { status: 404 })
  }

  if (url.pathname === "/history" && request.method === "GET") {
    return forwardConversationRequest(env, principal.workspaceKey, sessionId, "/history").then((response) =>
      finalizePrincipalResponse(response, principal)
    )
  }

  if (url.pathname === "/meta" && request.method === "GET") {
    const response = await forwardConversationRequest(env, principal.workspaceKey, sessionId, "/meta")

    if (response.ok) {
      const data = (await response.clone().json()) as { title?: string }

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
    return forwardConversationRequest(env, principal.workspaceKey, sessionId, "/stats").then((response) =>
      finalizePrincipalResponse(response, principal)
    )
  }

  if (url.pathname === "/reset" && request.method === "POST") {
    const response = await forwardConversationRequest(env, principal.workspaceKey, sessionId, "/reset", { method: "POST" })

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

  if ((url.pathname === "/chat" || url.pathname === "/chat/stream") && request.method === "POST") {
    const requestId = crypto.randomUUID()
    const body = await safeJson<ChatRequestBody>(request)

    if (!body) {
      return new Response("Body missing", { status: 400 })
    }

    const validationError = validateChatRequest(body)

    if (validationError) {
      return new Response(validationError, { status: 400 })
    }

    const payload = normalizeChatRequest(body)

    if (!payload.message && !payload.attachments.length) {
      return new Response("Message or attachment required", { status: 400 })
    }

    const estimatedTokens = Math.max(
      1,
      Math.ceil(
        (payload.message.length + payload.attachments.reduce((total, attachment) => total + (attachment.extractedText?.length || 0), 0)) / 4
      )
    )
    const tokenLimited = await enforceLimit(env, "chat-tokens", principal.workspaceKey, {
      limit: principal.user.isGuest ? 40_000 : 240_000,
      windowMs: 60 * 60_000,
      cost: estimatedTokens
    })
    if (tokenLimited) return finalizePrincipalResponse(tokenLimited, principal)

    const requestMetadata = {
      requestId,
      route: url.pathname,
      mode: payload.mode,
      attachmentCount: payload.attachments.length,
      principalType: principal.user.isGuest ? "guest" : "account",
      workspacePrefix: scopedPrefix(principal.workspaceKey),
      sessionPrefix: scopedPrefix(sessionId)
    }

    try {
      await workspace.fetch("https://internal/sessions/touch", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: sessionId
        })
      })
    } catch (error) {
      logServerError("router.chat.session.touch", error, requestMetadata)
    }

    if (payload.attachments.length) {
      try {
        await importAttachmentsIntoLibrary(env, workspace, payload.attachments, requestMetadata)
      } catch (error) {
        logServerError("router.chat.library.import", error, requestMetadata)
      }
    }

    const libraryContext = await searchWorkspaceLibrary(env, workspace, payload, requestMetadata)

    try {
      const response = await forwardConversationRequest(
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
            requestId,
            workspaceContext: libraryContext.context,
            citations: libraryContext.citations
          })
        },
        requestId
      )

      return finalizePrincipalResponse(response, principal)
    } catch (error) {
      logServerError("router.chat.forward", error, requestMetadata)

      return finalizePrincipalResponse(
        url.pathname === "/chat/stream" ? serverErrorSse(CHAT_SERVER_ERROR, requestId) : serverErrorJson(CHAT_SERVER_ERROR, requestId),
        principal
      )
    }
  }

  return new Response("Not Found", { status: 404 })
}

/**
 * Architecture Change Review: retrieve evidence only from the selected
 * library sources, ask the `deep` profile for a JSON review, validate it
 * against the review contract, and persist it. A malformed model reply is
 * reported as an error and never stored or shown as a review.
 */
async function handleCreateReview(request: Request, env: Env, workspace: DurableObjectStub, principal: Principal) {
  const requestId = crypto.randomUUID()
  const parsedInput = validateReviewInput(await safeJson(request))

  if (!parsedInput.ok) {
    return new Response(parsedInput.error, { status: 400 })
  }

  const input = parsedInput.value
  const requestMetadata = {
    requestId,
    route: "/reviews",
    sourceCount: input.sourceFileIds.length,
    principalType: principal.user.isGuest ? "guest" : "account",
    workspacePrefix: scopedPrefix(principal.workspaceKey)
  }
  const reviewError = (error: string, status: number, extra: Record<string, unknown> = {}) =>
    noStoreJson({ error, requestId, ...extra }, undefined, { "X-Lyta-Request-Id": requestId }, status)

  const tokenLimited = await enforceLimit(env, "chat-tokens", principal.workspaceKey, {
    limit: principal.user.isGuest ? 40_000 : 240_000,
    windowMs: 60 * 60_000,
    cost: Math.max(1, Math.ceil((input.proposedChange.length + input.intendedOutcome.length + input.constraints.length) / 4))
  })
  if (tokenLimited) return tokenLimited

  const retrieval = await searchWorkspaceLibrary(
    env,
    workspace,
    { message: buildReviewQuery(input), mode: "deep", attachments: [] },
    requestMetadata,
    { sourceFileIds: input.sourceFileIds, topK: REVIEW_EVIDENCE_TOP_K, policyVersion: REVIEW_CONTEXT_POLICY_VERSION }
  )

  if (retrieval.failed) {
    return reviewError("Unable to retrieve evidence from the selected sources. Please retry.", 502)
  }

  if (retrieval.unavailableSourceFileIds.length) {
    return reviewError("Some selected sources are no longer available in this workspace. Reselect your sources and retry.", 409, {
      unavailableSourceFileIds: retrieval.unavailableSourceFileIds
    })
  }

  const evidence = toReviewEvidence(retrieval.citations)
  const profile = getModelProfile("deep")
  let modelReply: unknown

  try {
    const result = await callWithPolicy("ai.review", profile, (model) =>
      env.AI.run(model, {
        messages: buildReviewMessages(input, retrieval.selectedSources, evidence),
        temperature: profile.temperature,
        top_p: profile.top_p,
        max_tokens: profile.max_tokens
      })
    )
    modelReply = result && typeof result === "object" ? (result as { response?: unknown }).response : undefined
  } catch (error) {
    logServerError("router.review.model", error, requestMetadata)
    return reviewError("The review model is unavailable right now. Please retry.", 502)
  }

  const output = parseReviewOutput(modelReply, evidence)

  if (!output.ok) {
    logServerError("router.review.output", new Error(output.error), requestMetadata)
    return reviewError(`${output.error} No review was saved; please retry.`, 502)
  }

  const review: Omit<ArchitectureReview, "id" | "createdAt" | "updatedAt"> = {
    ...output.value,
    type: "architecture-change",
    requestId,
    input,
    sources: retrieval.selectedSources,
    evidence,
    modelVersion: profile.modelVersion,
    policyVersion: REVIEW_CONTEXT_POLICY_VERSION
  }

  const saved = await workspace.fetch("https://internal/reviews/save", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ review })
  })

  if (!saved.ok) {
    logServerError("router.review.save", new Error(`Review storage rejected the review (${saved.status}).`), requestMetadata)
    return reviewError("Unable to save the review right now.", 502)
  }

  return noStoreJson(await saved.json(), { requestId }, { "X-Lyta-Request-Id": requestId }, 201)
}

/**
 * "Challenge this conclusion": search the review's own sources for evidence
 * against one finding, validate the model's verdict with the review contract,
 * and append it to the finding's challenge history. The finding only changes
 * when the reply cites retrieved counter-evidence; with nothing retrieved the
 * model is not called and the challenge is recorded as insufficient evidence.
 */
async function handleChallengeFinding(
  request: Request,
  env: Env,
  workspace: DurableObjectStub,
  principal: Principal,
  reviewId: string,
  findingId: string
) {
  const requestId = crypto.randomUUID()
  const reason = normalizeChallengeReason((await safeJson<{ reason?: string }>(request))?.reason)
  const requestMetadata = {
    requestId,
    route: "/reviews/challenge",
    principalType: principal.user.isGuest ? "guest" : "account",
    workspacePrefix: scopedPrefix(principal.workspaceKey)
  }
  const challengeError = (error: string, status: number) =>
    noStoreJson({ error, requestId }, undefined, { "X-Lyta-Request-Id": requestId }, status)

  const stored = await workspace.fetch("https://internal/reviews/get", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ id: reviewId })
  })

  if (!stored.ok) {
    return copyResponse(stored)
  }

  const { review } = (await stored.json()) as { review: ArchitectureReview }
  const finding = review.findings.find((candidate) => candidate.id === findingId)

  if (!finding) {
    return challengeError("Finding not found.", 404)
  }

  if (finding.withdrawn) {
    return challengeError("This finding was already withdrawn after a challenge.", 409)
  }

  const tokenLimited = await enforceLimit(env, "chat-tokens", principal.workspaceKey, {
    limit: principal.user.isGuest ? 40_000 : 240_000,
    windowMs: 60 * 60_000,
    cost: Math.max(1, Math.ceil((finding.title.length + finding.detail.length + reason.length) / 4))
  })
  if (tokenLimited) return tokenLimited

  const retrieval = await searchWorkspaceLibrary(
    env,
    workspace,
    { message: buildChallengeQuery(finding, reason), mode: "deep", attachments: [] },
    requestMetadata,
    {
      sourceFileIds: review.sources.map((source) => source.fileId),
      topK: REVIEW_EVIDENCE_TOP_K,
      policyVersion: REVIEW_CHALLENGE_POLICY_VERSION
    }
  )

  if (retrieval.failed) {
    return challengeError("Unable to search the review's sources. Please retry.", 502)
  }

  if (!retrieval.selectedSources.length) {
    return challengeError("None of this review's sources are still in the library, so the finding cannot be challenged.", 409)
  }

  const { evidence, added } = mergeChallengeEvidence(review.evidence, retrieval.citations)
  let result: ChallengeResult

  if (!evidence.length) {
    result = insufficientChallengeResult()
  } else {
    const profile = getModelProfile("deep")
    let modelReply: unknown

    try {
      const reply = await callWithPolicy("ai.review.challenge", profile, (model) =>
        env.AI.run(model, {
          messages: buildChallengeMessages(review, finding, reason, evidence),
          temperature: profile.temperature,
          top_p: profile.top_p,
          max_tokens: profile.max_tokens
        })
      )
      modelReply = reply && typeof reply === "object" ? (reply as { response?: unknown }).response : undefined
    } catch (error) {
      logServerError("router.review.challenge.model", error, requestMetadata)
      return challengeError("The review model is unavailable right now. Please retry.", 502)
    }

    const parsed = parseChallengeOutput(modelReply, evidence, finding)

    if (!parsed.ok) {
      logServerError("router.review.challenge.output", new Error(parsed.error), requestMetadata)
      return challengeError(`${parsed.error} The finding was not changed; please retry.`, 502)
    }

    result = parsed.value
  }

  if (retrieval.unavailableSourceFileIds.length) {
    result.adjustments.push(
      `${retrieval.unavailableSourceFileIds.length} of the review's sources were deleted and could not be searched for counter-evidence.`
    )
  }

  // Keep only newly retrieved passages the challenge actually relied on.
  const relied = new Set([...result.counterEvidenceIds, ...(result.revised?.citationIds || [])])
  const saved = await workspace.fetch("https://internal/reviews/challenge", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      id: review.id,
      findingId,
      expectedUpdatedAt: review.updatedAt,
      requestId,
      reason,
      result,
      addedEvidence: added.filter((item) => relied.has(item.chunkId))
    })
  })

  if (!saved.ok) {
    return saved.status === 409 ? copyResponse(saved) : challengeError("Unable to save the challenge right now.", 502)
  }

  return noStoreJson(await saved.json(), { requestId }, { "X-Lyta-Request-Id": requestId })
}

async function handleAuth(request: Request, env: Env, action: "register" | "login") {
  try {
    const body = await safeJson<AuthPayload>(request)

    if (!body?.email || !body?.password) {
      return new Response("Email and password are required", {
        status: 400
      })
    }

    const authDirectory = getAuthDirectoryStub(env)

    const response = await authDirectory.fetch(`https://internal/${action}`, {
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

    const data = (await response.json()) as {
      token: string
      user: AuthUser
    }

    const workspace = getWorkspaceStub(env, data.user.id)

    const initializeResponse = await workspace.fetch("https://internal/initialize", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: data.user.email,
        scope: data.user.id,
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
    logServerError(`router.auth.${action}`, error)
    return new Response("Unable to create account right now", {
      status: 500
    })
  }
}

async function handleLogout(request: Request, env: Env) {
  const token = getAuthToken(request)

  const authDirectory = getAuthDirectoryStub(env)

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
  const token = getAuthToken(request)

  if (token) {
    const authDirectory = getAuthDirectoryStub(env)

    const response = await authDirectory.fetch("https://internal/session", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        token
      })
    })

    if (response.ok) {
      const data = (await response.json()) as {
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

async function createGuestPrincipal(request: Request, cookieHeaders: string[] = []): Promise<Principal> {
  let guestToken = getGuestToken(request)

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

async function ensureWorkspaceInitialized(workspace: DurableObjectStub, user: AuthUser) {
  await workspace.fetch("https://internal/initialize", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      scope: user.id,
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
  init?: RequestInit,
  requestId?: string
) {
  const conversation = getConversationStub(env, userId, sessionId)

  const response = await conversation.fetch(`https://internal${path}`, init)

  return copyResponse(response, requestId ? { "X-Lyta-Request-Id": requestId } : undefined)
}

async function forwardWorkspace(workspace: DurableObjectStub, path: string, init?: RequestInit) {
  const response = await workspace.fetch(`https://internal${path}`, init)

  return copyResponse(response)
}

async function enforceLimit(env: Env, category: string, identity: string, config: { limit: number; windowMs: number; cost?: number }) {
  const startedAt = Date.now()
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${category}:${identity}`))
  const response = await stub.fetch("https://internal/consume", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(config)
  })
  const result = (await response.json()) as { allowed?: boolean; retryAfter?: number }

  recordOperation({
    route: category,
    outcome: result.allowed ? "allowed" : "limited",
    durationMs: Date.now() - startedAt,
    units: config.cost || 1
  })

  if (result.allowed) return null

  return new Response("Rate limit exceeded", {
    status: 429,
    headers: {
      "Retry-After": String(Math.max(1, result.retryAfter || 1)),
      "Cache-Control": "no-store"
    }
  })
}

function getAuthDirectoryStub(env: Env) {
  return env.AUTH_DIRECTORY.get(env.AUTH_DIRECTORY.idFromName("global"))
}

function getWorkspaceStub(env: Env, userId: string) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(userId))
}

function getConversationStub(env: Env, userId: string, sessionId: string) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(`${userId}:${sessionId}`))
}

async function workspaceHasSession(workspace: DurableObjectStub, sessionId: string) {
  const response = await workspace.fetch("https://internal/sessions/has", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      id: sessionId
    })
  })

  if (!response.ok) {
    return false
  }

  const data = (await response.json()) as {
    exists?: boolean
  }

  return Boolean(data.exists)
}

async function importAttachmentsIntoLibrary(
  env: Env,
  workspace: DurableObjectStub,
  attachments: ChatAttachment[],
  metadata: Record<string, unknown> = {}
) {
  const freshAttachments = attachments.filter((attachment) => !attachment.libraryFileId)

  if (!freshAttachments.length) {
    return []
  }

  const quotaResponse = await workspace.fetch("https://internal/library/quota", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      files: freshAttachments.map((attachment) => ({ size: attachment.size }))
    })
  })

  if (!quotaResponse.ok) {
    throw new Error("Workspace artifact quota exceeded.")
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
    const signature = await createAttachmentSignature(attachment)

    if (seen.has(signature)) {
      continue
    }

    seen.add(signature)
    files.push({
      ...attachment,
      signature
    })

    if (attachment.kind === "document" && typeof attachment.extractedText === "string" && attachment.extractedText.trim()) {
      const parts = chunkDocumentText(attachment.extractedText)

      let vectors: number[][] = []

      try {
        vectors = await Promise.all(parts.map((text) => createEmbedding(env, text)))
      } catch (error) {
        logServerError("router.library.import.embeddings", error, {
          ...metadata,
          chunkCount: parts.length
        })
      }

      if (vectors.length === parts.length) {
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
  }

  if (!files.length) {
    return []
  }

  const response = await workspace.fetch("https://internal/library/upsert", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      files,
      chunks
    })
  })

  if (!response.ok) {
    throw new Error(`Library storage rejected the import (${response.status}).`)
  }

  const data = (await response.json()) as {
    files?: unknown[]
  }

  return Array.isArray(data.files) ? data.files : []
}

async function searchWorkspaceLibrary(
  env: Env,
  workspace: DurableObjectStub,
  payload: ReturnType<typeof normalizeChatRequest>,
  metadata: Record<string, unknown> = {},
  scope?: { sourceFileIds: string[]; topK: number; policyVersion: string }
) {
  const empty = {
    context: "",
    citations: [] as LibraryCitation[],
    selectedSources: [] as ReviewSource[],
    unavailableSourceFileIds: [] as string[],
    failed: false
  }
  const userMessage: ChatMessageRecord = {
    role: "user",
    content: payload.message,
    mode: payload.mode,
    attachments: payload.attachments
  }

  const query = buildRetrievalQuery(userMessage)

  if (!query) {
    return empty
  }

  try {
    const queryVector = await createEmbedding(env, query)

    const response = await workspace.fetch("https://internal/library/search", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        queryVector,
        topK: scope?.topK ?? 4,
        requestId: typeof metadata.requestId === "string" ? metadata.requestId : undefined,
        sourceFileIds: scope?.sourceFileIds,
        policyVersion: scope?.policyVersion
      })
    })

    if (!response.ok) {
      logServerError("router.library.search.status", new Error("Library search failed."), {
        ...metadata,
        status: response.status,
        retrievalAttempted: true
      })

      return { ...empty, failed: true }
    }

    const data = (await response.json()) as {
      context?: string
      citations?: LibraryCitation[]
      selectedSources?: ReviewSource[]
      unavailableSourceFileIds?: string[]
    }

    return {
      context: typeof data.context === "string" ? data.context : "",
      citations: Array.isArray(data.citations) ? data.citations : [],
      selectedSources: Array.isArray(data.selectedSources) ? data.selectedSources : [],
      unavailableSourceFileIds: Array.isArray(data.unavailableSourceFileIds) ? data.unavailableSourceFileIds : [],
      failed: false
    }
  } catch (error) {
    logServerError("router.library.search", error, {
      ...metadata,
      retrievalAttempted: true
    })

    return { ...empty, failed: true }
  }
}

async function createAttachmentSignature(attachment: ChatAttachment) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [
        attachment.kind,
        attachment.name,
        attachment.mimeType,
        String(attachment.size),
        attachment.summary || "",
        attachment.kind === "image" ? attachment.dataUrl || "" : attachment.extractedText || ""
      ].join("\n")
    )
  )

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function normalizeSessionId(value: string | undefined | null) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120)
}

function normalizeProfileName(value: string | undefined, email: string) {
  const cleaned = normalizeInlineText(value)

  if (cleaned) {
    return cleaned
  }

  const localPart = email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .trim()

  return titleCase(localPart) || "Guest User"
}

function normalizeWorkspaceName(value: string | undefined, name: string | undefined, email: string) {
  const cleaned = normalizeInlineText(value)

  if (cleaned) {
    return cleaned
  }

  const derivedName = normalizeProfileName(name, email)

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
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 40)
}

function noStoreJson(body: unknown, mergeBody?: Record<string, unknown>, headers?: Record<string, string>, status = 200) {
  return new Response(
    JSON.stringify({
      ...(typeof body === "object" && body ? (body as Record<string, unknown>) : {}),
      ...(mergeBody || {})
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(headers || {})
      }
    }
  )
}

function serverErrorJson(message: string, requestId: string) {
  return noStoreJson(
    {
      error: message,
      requestId
    },
    undefined,
    {
      "X-Lyta-Request-Id": requestId
    },
    502
  )
}

function serverErrorSse(message: string, requestId: string) {
  return new Response(
    `data: ${JSON.stringify({
      error: message,
      done: true,
      requestId
    })}\n\ndata: [DONE]\n\n`,
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Lyta-Request-Id": requestId
      }
    }
  )
}

function copyResponse(response: Response, extraHeaders?: Record<string, string>) {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "no-store")
  Object.entries(extraHeaders || {}).forEach(([key, value]) => {
    headers.set(key, value)
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function finalizePrincipalResponse(response: Response, principal: Principal) {
  if (!principal.cookieHeaders.length) {
    return response
  }

  const headers = new Headers(response.headers)

  principal.cookieHeaders.forEach((value) => {
    headers.append("Set-Cookie", value)
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}
