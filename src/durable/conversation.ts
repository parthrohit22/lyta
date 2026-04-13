import type { Env } from "../index"
import { runAI, runAIStream } from "../services/ai"
import type { AiChatMessage } from "../services/ai"
import { retrieveContext } from "../services/retriever"
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

  constructor(state: DurableObjectState, env: Env){
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response>{

    const pathname = new URL(request.url).pathname

    if(pathname === "/reset"){
      await this.state.storage.deleteAll()
      return Response.json({ ok: true })
    }

    if(pathname === "/history"){

      const recent =
        (await this.state.storage.get<ChatMessageRecord[]>("recent")) || []

      return Response.json({
        messages: recent
      })
    }

    if(pathname === "/meta"){

      const title =
        (await this.state.storage.get("title")) || "New Chat"

      return Response.json({
        title
      })
    }

    if(pathname === "/stats"){

      const recent =
        (await this.state.storage.get<ChatMessageRecord[]>("recent")) || []

      const summary =
        await this.state.storage.get("summary")

      return Response.json({
        messageCount: recent.length,
        hasSummary: !!summary
      })
    }

    if(pathname === "/chat"){
      return this.queue(() => this.handleChat(request, false))
    }

    if(pathname === "/chat/stream"){
      return this.queue(() => this.handleChat(request, true))
    }

    return new Response("Not Found", { status: 404 })
  }

  private async queue<T>(fn: () => Promise<T>): Promise<T>{
    const next = this.lock.then(fn)
    this.lock = next.then(() => {}, () => {})
    return next
  }

  async handleChat(request: Request, stream: boolean): Promise<Response>{

    const rawBody =
      await request.json() as ConversationRequestBody

    const body =
      normalizeChatRequest(rawBody)

    const mode =
      normalizeChatMode(body.mode)

    const workspaceContext =
      normalizeWorkspaceContext(rawBody.workspaceContext)

    const citations =
      normalizeLibraryCitations(rawBody.citations)

    const userId =
      normalizeScopedId(rawBody.userId)

    const sessionId =
      normalizeScopedId(rawBody.sessionId)

    if(!body.message && !body.attachments.length){
      return new Response("Message or attachment required", { status: 400 })
    }

    let recent =
      (await this.state.storage.get<ChatMessageRecord[]>("recent")) || []

    const userMessage: ChatMessageRecord = {
      role: "user",
      content: body.message,
      mode,
      ...(body.attachments.length
        ? { attachments: body.attachments }
        : {}),
      createdAt: new Date().toISOString()
    }

    recent.push(userMessage)

    let title =
      await this.state.storage.get<string>("title")

    if(!title){
      title = await this.generateConversationTitle(userMessage)
      await this.state.storage.put("title", title)
      await this.renameWorkspaceSession(userId, sessionId, title)
    }

    const summary =
      (await this.state.storage.get<string>("summary")) || ""

    const retrievalQuery =
      buildRetrievalQuery(userMessage)

    const knowledgeContext = retrievalQuery
      ? await retrieveContext(this.env, retrievalQuery)
      : ""

    const retrievedContext = [
      knowledgeContext,
      workspaceContext
    ]
      .filter(Boolean)
      .join("\n\n")

    const messages =
      buildConversationMessages({
        recent,
        mode,
        summary,
        retrievedContext
      })

    if(stream){
      return this.streamChat({
        messages,
        mode,
        recent,
        userMessage,
        citations,
        title: title || "New Chat",
        userId,
        sessionId
      })
    }

    const aiResponse =
      await runAI(this.env, messages, {
        mode
      })

    const reply =
      aiResponse?.response?.trim() || "No response from model."

    const followups =
      await this.generateFollowups(userMessage, reply, mode)

    recent.push(
      createAssistantMessage(reply, {
        mode,
        citations,
        followups
      })
    )

    await this.persistConversation(recent)
    await this.touchWorkspaceSession(userId, sessionId)

    return Response.json({
      reply,
      title: title || "New Chat",
      citations,
      followups
    })
  }

  private async streamChat(input: {
    messages: AiChatMessage[]
    mode: ChatMessageRecord["mode"]
    recent: ChatMessageRecord[]
    userMessage: ChatMessageRecord
    citations: ReturnType<typeof normalizeLibraryCitations>
    title: string
    userId: string
    sessionId: string
  }) {
    const aiStream =
      await runAIStream(this.env, input.messages, {
        mode: input.mode
      })

    let assistantText = ""

    const { readable, writable } =
      new TransformStream()

    const writer = writable.getWriter()
    const reader = aiStream.getReader()
    const decoder = new TextDecoder()

    ;(async () => {
      try{
        while(true){

          const { done, value } = await reader.read()

          if(done){
            break
          }

          await writer.write(value)

          const chunk =
            decoder.decode(value, { stream: true })

          for(const line of chunk.split("\n")){
            if(!line.startsWith("data: ")) continue

            try{
              const parsed = JSON.parse(line.slice(6))

              if(typeof parsed.response === "string"){
                assistantText += parsed.response
              }
            }catch{}
          }
        }

        if(!assistantText.trim()){
          assistantText = "No response from model."
        }

        await writer.write(
          encodeSse({
            done: true
          })
        )

        const followups =
          await this.generateFollowups(
            input.userMessage,
            assistantText,
            input.mode
          )

        input.recent.push(
          createAssistantMessage(assistantText, {
            mode: input.mode,
            citations: input.citations,
            followups
          })
        )

        await this.persistConversation(input.recent)
        await this.touchWorkspaceSession(input.userId, input.sessionId)

        await writer.write(
          encodeSse({
            meta: true,
            title: input.title,
            citations: input.citations,
            followups
          })
        )

        await writer.write(encoder.encode("data: [DONE]\n\n"))
        await writer.close()
      }catch(error){
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Streaming failed."

        try{
          await writer.write(
            encodeSse({
              error: message,
              done: true
            })
          )
        }catch{}

        await writer.close()
      }finally{
        reader.releaseLock()
      }
    })()

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store"
      }
    })
  }

  async persistConversation(recent: ChatMessageRecord[]){

    if(recent.length > MAX_RECENT){

      const summaryPrompt = [
        systemMessage(
          "Summarize the following conversation, preserving user preferences, uploaded file context, cited sources, and unresolved asks."
        ),
        ...buildSummaryMessages(recent)
      ]

      const summaryResult =
        await runAI(this.env, summaryPrompt, {
          mode: "instant"
        })

      const newSummary =
        summaryResult?.response || ""

      await this.state.storage.put(
        "summary",
        newSummary
      )

      recent = recent.slice(-4)
    }

    await this.state.storage.put(
      "recent",
      recent
    )
  }

  private async generateConversationTitle(message: ChatMessageRecord) {
    const titlePrompt = [
      systemMessage(
        "Return only a 2 or 3 word chat title. Use title case. No punctuation. No quotes."
      ),
      userPromptMessage(buildTitleSource(message))
    ]

    const titleResult =
      await runAI(this.env, titlePrompt, {
        mode: "instant"
      })

    return (
      createConversationTitle(
        titleResult?.response,
        message
      ).slice(0, 40) || "New Chat"
    )
  }

  private async generateFollowups(
    userMessage: ChatMessageRecord,
    assistantText: string,
    mode: ChatMessageRecord["mode"]
  ) {
    const prompt = [
      systemMessage(
        "Return a JSON array with exactly 3 concise follow-up prompts. Each prompt should sound natural, stay under 12 words, and avoid numbering or commentary."
      ),
      userPromptMessage([
        "Latest user request:",
        buildTitleSource(userMessage),
        "",
        "Assistant answer:",
        assistantText.slice(0, 1800)
      ].join("\n"))
    ]

    const result =
      await runAI(this.env, prompt, {
        mode: mode || "instant"
      })

    return createConversationFollowups(
      result?.response,
      userMessage
    )
  }

  private async renameWorkspaceSession(
    userId: string,
    sessionId: string,
    title: string
  ) {
    await this.updateWorkspaceSession(userId, "/sessions/rename", {
      id: sessionId,
      title
    })
  }

  private async touchWorkspaceSession(userId: string, sessionId: string) {
    await this.updateWorkspaceSession(userId, "/sessions/touch", {
      id: sessionId
    })
  }

  private async updateWorkspaceSession(
    userId: string,
    path: "/sessions/rename" | "/sessions/touch",
    body: Record<string, string>
  ) {
    if(!userId || !body.id || !this.env.WORKSPACE){
      return
    }

    const workspace =
      this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(userId)
      )

    await workspace.fetch(`https://internal${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body)
    })
  }
}

function normalizeScopedId(value: string | undefined) {
  if(typeof value !== "string"){
    return ""
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120)
}

function encodeSse(payload: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}
