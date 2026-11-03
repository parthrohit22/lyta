import type { Env } from "../index"
import { describeModelFailure, runAI, runAIStreamWithMetadata } from "../services/ai"
import type { AiChatMessage } from "../services/ai"
import { retrieveContext } from "../services/retriever"
import { logServerError, scopedPrefix } from "../utils/serverErrors"
import {
  buildConversationMessages,
  buildRetrievalQuery,
  buildSummaryMessages,
  buildTitleSource,
  createAssistantMessage,
  createConversationFollowups,
  createConversationTitle,
  normalizeChatMode,
  normalizeChatRequest,
  normalizeLibraryCitations,
  normalizeWorkspaceContext,
  type ChatMessageRecord,
  type ConversationRequestBody
} from "../chat/messages"

const MAX_RECENT = 6
const CHAT_SERVER_ERROR = "LYTA server error. Please retry; request failed before streaming started."
const encoder = new TextEncoder()
const JSON_HEADERS = {
  "Content-Type": "application/json"
}

function systemMessage(content: string): AiChatMessage {
  return {
    role: "system",
    content
  }
}

function userPromptMessage(content: string): AiChatMessage {
  return {
    role: "user",
    content
  }
}

export class Conversation {
  state: DurableObjectState
  env: Env
  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname

    if (pathname === "/reset") {
      await this.state.storage.deleteAll()
      return Response.json({ ok: true })
    }

    if (pathname === "/history") {
      const messages = await this.loadCanonicalHistory()

      return Response.json({
        messages
      })
    }

    if (pathname === "/meta") {
      const title = (await this.state.storage.get("title")) || "New Chat"

      return Response.json({
        title
      })
    }

    if (pathname === "/stats") {
      const messages = await this.loadCanonicalHistory()

      const summary = await this.state.storage.get("summary")

      return Response.json({
        messageCount: messages.length,
        hasSummary: !!summary
      })
    }

    if (pathname === "/chat") {
      return this.queue(() => this.handleChat(request, false))
    }

    if (pathname === "/chat/stream") {
      return this.queue(() => this.handleChat(request, true))
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

  async handleChat(request: Request, stream: boolean): Promise<Response> {
    const rawBody = (await request.json()) as ConversationRequestBody

    const body = normalizeChatRequest(rawBody)

    const mode = normalizeChatMode(body.mode)

    const workspaceContext = normalizeWorkspaceContext(rawBody.workspaceContext)

    const citations = normalizeLibraryCitations(rawBody.citations)

    const evidenceStatus = citations.length ? "available" : "insufficient"

    const userId = normalizeScopedId(rawBody.userId)

    const sessionId = normalizeScopedId(rawBody.sessionId)

    const requestId = normalizeScopedId(rawBody.requestId) || crypto.randomUUID()

    if (!body.message && !body.attachments.length) {
      return new Response("Message or attachment required", { status: 400 })
    }

    const requestMetadata = {
      requestId,
      route: stream ? "/chat/stream" : "/chat",
      mode,
      attachmentCount: body.attachments.length,
      userPrefix: scopedPrefix(userId),
      sessionPrefix: scopedPrefix(sessionId)
    }

    const history = await this.loadCanonicalHistory()

    const userMessage: ChatMessageRecord = {
      id: requestId,
      role: "user",
      content: body.message,
      mode,
      ...(body.attachments.length ? { attachments: body.attachments } : {}),
      createdAt: new Date().toISOString()
    }

    history.push(userMessage)

    // The canonical user message is durable before generation starts. If an
    // SSE client cancels or a Worker restarts, the user record survives; the
    // assistant record is added only after a completed model response.
    await this.putStorage("messages", history, "conversation.history.store", requestMetadata)

    let title = await this.state.storage.get<string>("title")

    if (!title) {
      title = await this.generateConversationTitle(userMessage, requestMetadata)
      await this.putStorage("title", title, "conversation.title.store", requestMetadata)
      await this.renameWorkspaceSession(userId, sessionId, title, requestMetadata)
    }

    const summary = (await this.state.storage.get<string>("summary")) || ""

    const retrievalQuery = buildRetrievalQuery(userMessage)

    const knowledgeContext = await this.retrieveBuiltInContext(retrievalQuery, requestMetadata)

    const retrievedContext = [knowledgeContext, workspaceContext].filter(Boolean).join("\n\n")

    const messages = buildConversationMessages({
      recent: history.slice(-MAX_RECENT),
      mode,
      summary,
      retrievedContext
    })

    if (stream) {
      return this.streamChat({
        messages,
        mode,
        userMessage,
        citations,
        evidenceStatus,
        title: title || "New Chat",
        userId,
        sessionId,
        requestId,
        requestMetadata
      })
    }

    let aiResponse: Awaited<ReturnType<typeof runAI>>

    try {
      aiResponse = await runAI(this.env, messages, {
        mode,
        route: "ai.chat",
        workspaceKey: userId
      })
    } catch (error) {
      logServerError("conversation.chat.ai", error, requestMetadata)

      return Response.json(
        {
          error: CHAT_SERVER_ERROR,
          degraded: describeModelFailure(error),
          requestId
        },
        {
          status: 502,
          headers: {
            "Cache-Control": "no-store",
            "X-Lyta-Request-Id": requestId
          }
        }
      )
    }

    const reply = aiResponse?.response?.trim() || "No response from model."

    const followups = await this.generateFollowups(userMessage, reply, mode, requestMetadata)

    history.push(
      createAssistantMessage(reply, {
        mode,
        citations,
        followups
      })
    )

    await this.persistConversation(history, requestMetadata)
    await this.touchWorkspaceSession(userId, sessionId, requestMetadata)

    return Response.json(
      {
        reply,
        title: title || "New Chat",
        citations,
        followups,
        evidenceStatus,
        model: aiResponse.model,
        requestId
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Lyta-Request-Id": requestId
        }
      }
    )
  }

  private async streamChat(input: {
    messages: AiChatMessage[]
    mode: ChatMessageRecord["mode"]
    userMessage: ChatMessageRecord
    citations: ReturnType<typeof normalizeLibraryCitations>
    evidenceStatus: "available" | "insufficient"
    title: string
    userId: string
    sessionId: string
    requestId: string
    requestMetadata: Record<string, unknown>
  }) {
    let assistantText = ""

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()

    const writer = writable.getWriter()
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    const decoder = new TextDecoder()
    let parseBuffer = ""
    let modelMetadata: Awaited<ReturnType<typeof runAIStreamWithMetadata>>["model"] | undefined

    ;(async () => {
      try {
        const { stream: aiStream, model } = await runAIStreamWithMetadata(this.env, input.messages, {
          mode: input.mode,
          route: "ai.chat.stream",
          workspaceKey: input.userId
        })

        modelMetadata = model
        reader = aiStream.getReader()

        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          await writer.write(value)

          const chunk = decoder.decode(value, { stream: true })

          parseBuffer = appendAssistantTextFromSse(parseBuffer + chunk, (text) => {
            assistantText += text
          })
        }

        parseBuffer = appendAssistantTextFromSse(
          `${parseBuffer}${decoder.decode()}`,
          (text) => {
            assistantText += text
          },
          true
        )

        if (!assistantText.trim()) {
          assistantText = "No response from model."
        }

        await writer.write(
          encodeSse({
            done: true
          })
        )

        const followups = await this.generateFollowups(input.userMessage, assistantText, input.mode, input.requestMetadata)

        const assistantMessage = createAssistantMessage(assistantText, {
          mode: input.mode,
          citations: input.citations,
          followups
        })

        // Routed through the same queue() lock that serializes handleChat():
        // this background completion can finish well after a later /chat or
        // /chat/stream request has already started, so it must reload the
        // canonical history fresh rather than persist the stale snapshot it
        // started with, or it would clobber that later request's write.
        await this.queue(async () => {
          const canonicalHistory = await this.loadCanonicalHistory()
          canonicalHistory.push(assistantMessage)
          await this.persistConversation(canonicalHistory, input.requestMetadata)
        })

        await this.touchWorkspaceSession(input.userId, input.sessionId, input.requestMetadata)

        await writer.write(
          encodeSse({
            meta: true,
            title: input.title,
            citations: input.citations,
            followups,
            evidenceStatus: input.evidenceStatus,
            ...(modelMetadata ? { model: modelMetadata } : {})
          })
        )

        await writer.write(encoder.encode("data: [DONE]\n\n"))
        await writer.close()
      } catch (error) {
        logServerError("conversation.chat.stream", error, input.requestMetadata)

        try {
          await writer.write(
            encodeSse({
              error: CHAT_SERVER_ERROR,
              degraded: describeModelFailure(error),
              done: true,
              requestId: input.requestId
            })
          )
        } catch {}

        await writer.close().catch(() => {})
      } finally {
        reader?.releaseLock()
      }
    })()

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Lyta-Request-Id": input.requestId
      }
    })
  }

  async persistConversation(history: ChatMessageRecord[], metadata: Record<string, unknown> = {}) {
    await this.putStorage("messages", history, "conversation.history.store", metadata)

    if (history.length > MAX_RECENT) {
      const summaryPrompt = [
        systemMessage(
          "Summarize the following conversation, preserving user preferences, uploaded file context, cited sources, and unresolved asks."
        ),
        ...buildSummaryMessages(history)
      ]

      try {
        const summaryResult = await runAI(this.env, summaryPrompt, {
          mode: "instant",
          route: "ai.summary"
        })

        const newSummary = summaryResult?.response || ""

        await this.putStorage("summary", newSummary, "conversation.summary.store", metadata)
      } catch (error) {
        logServerError("conversation.summary.generate", error, metadata)
      }
    }
  }

  private async loadCanonicalHistory() {
    const messages = await this.state.storage.get<ChatMessageRecord[]>("messages")

    if (messages) {
      return messages
    }

    // v1 records used `recent`; retain every message that survived the older
    // compact format and write it once into the canonical history key.
    const legacy = (await this.state.storage.get<ChatMessageRecord[]>("recent")) || []

    if (legacy.length) {
      await this.state.storage.put("messages", legacy)
    }

    return legacy
  }

  private async generateConversationTitle(message: ChatMessageRecord, metadata: Record<string, unknown>) {
    const titlePrompt = [
      systemMessage("Return only a 2 or 3 word chat title. Use title case. No punctuation. No quotes."),
      userPromptMessage(buildTitleSource(message))
    ]

    try {
      const titleResult = await runAI(this.env, titlePrompt, {
        mode: "instant",
        route: "ai.title"
      })

      return createConversationTitle(titleResult?.response, message).slice(0, 40) || "New Chat"
    } catch (error) {
      logServerError("conversation.title.generate", error, metadata)
      return createConversationTitle(undefined, message).slice(0, 40) || "New Chat"
    }
  }

  private async generateFollowups(
    userMessage: ChatMessageRecord,
    assistantText: string,
    mode: ChatMessageRecord["mode"],
    metadata: Record<string, unknown>
  ) {
    const prompt = [
      systemMessage(
        "Return a JSON array with exactly 3 concise follow-up prompts. Each prompt should sound natural, stay under 12 words, and avoid numbering or commentary."
      ),
      userPromptMessage(
        ["Latest user request:", buildTitleSource(userMessage), "", "Assistant answer:", assistantText.slice(0, 1800)].join("\n")
      )
    ]

    try {
      const result = await runAI(this.env, prompt, {
        mode: mode || "instant",
        route: "ai.followups"
      })

      return createConversationFollowups(result?.response, userMessage)
    } catch (error) {
      logServerError("conversation.followups.generate", error, metadata)
      return createConversationFollowups(undefined, userMessage)
    }
  }

  private async renameWorkspaceSession(userId: string, sessionId: string, title: string, metadata: Record<string, unknown>) {
    await this.updateWorkspaceSession(
      userId,
      "/sessions/rename",
      {
        id: sessionId,
        title
      },
      metadata
    )
  }

  private async touchWorkspaceSession(userId: string, sessionId: string, metadata: Record<string, unknown>) {
    await this.updateWorkspaceSession(
      userId,
      "/sessions/touch",
      {
        id: sessionId
      },
      metadata
    )
  }

  private async updateWorkspaceSession(
    userId: string,
    path: "/sessions/rename" | "/sessions/touch",
    body: Record<string, string>,
    metadata: Record<string, unknown>
  ) {
    if (!userId || !body.id || !this.env.WORKSPACE) {
      return
    }

    const workspace = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(userId))

    try {
      await workspace.fetch(`https://internal${path}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body)
      })
    } catch (error) {
      logServerError(`conversation.workspace${path}`, error, metadata)
    }
  }

  private async retrieveBuiltInContext(query: string, metadata: Record<string, unknown>) {
    if (!query) {
      return ""
    }

    try {
      return await retrieveContext(this.env, query)
    } catch (error) {
      logServerError("conversation.retrieve.builtin", error, {
        ...metadata,
        retrievalAttempted: true
      })
      return ""
    }
  }

  private async putStorage(key: string, value: unknown, scope: string, metadata: Record<string, unknown>) {
    try {
      await this.state.storage.put(key, value)
    } catch (error) {
      logServerError(scope, error, metadata)
    }
  }
}

function normalizeScopedId(value: string | undefined) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120)
}

function encodeSse(payload: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

function appendAssistantTextFromSse(value: string, append: (text: string) => void, flush = false) {
  const parts = value.split("\n\n")
  const completeParts = flush ? parts : parts.slice(0, -1)

  completeParts.forEach((part) => {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data: ")) continue

      const payload = line.slice(6).trim()

      if (!payload || payload === "[DONE]") {
        continue
      }

      try {
        const parsed = JSON.parse(payload)

        if (typeof parsed.response === "string") {
          append(parsed.response)
        }
      } catch {}
    }
  })

  return flush ? "" : parts[parts.length - 1] || ""
}
