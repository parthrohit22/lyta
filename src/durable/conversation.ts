import { runAI, runAIStream } from "../services/ai"
import { retrieveContext } from "../services/retriever"

const MAX_RECENT = 6

export class Conversation {
  state: DurableObjectState
  env: any

  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: any) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname

    if (pathname === "/reset") {
      await this.state.storage.deleteAll()
      return Response.json({ ok: true })
    }

    if (pathname === "/stats") {
      const recent =
        (await this.state.storage.get<any[]>("recent")) || []

      const summary =
        (await this.state.storage.get<string>("summary")) || null

      const profileName =
        await this.state.storage.get<string>("profile_name")

      return Response.json({
        messageCount: recent.length,
        profileName: profileName || null,
        hasSummary: !!summary
      })
    }

    if (pathname === "/history") {
      const recent =
        (await this.state.storage.get<any[]>("recent")) || []

      return Response.json({
        messages: recent
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
    this.lock = next.then(() => {}, () => {})
    return next
  }

  async handleChat(request: Request, stream: boolean): Promise<Response> {
    const body: { message?: string } = await request.json()

    if (!body?.message) {
      return new Response("Message required", { status: 400 })
    }

    const message = body.message

    const summary =
      (await this.state.storage.get<string>("summary")) || ""

    let recent =
      (await this.state.storage.get<any[]>("recent")) || []

    recent.push({
      role: "user",
      content: message
    })

    const retrievedContext = await retrieveContext(this.env, message)

    const systemMessage = {
      role: "system",
      content:
        "You are LYTA, an edge AI assistant running on Cloudflare Workers AI. Provide concise and technically accurate responses."
    }

    const contextMessage = retrievedContext
      ? {
          role: "system",
          content: `Relevant context:\n${retrievedContext}`
        }
      : null

    const summaryMessage = summary
      ? {
          role: "system",
          content: `Conversation summary: ${summary}`
        }
      : null

    const messages = [
      systemMessage,
      ...(contextMessage ? [contextMessage] : []),
      ...(summaryMessage ? [summaryMessage] : []),
      ...recent
    ]

    if (stream) {
      const aiStream = await runAIStream(this.env, messages)

      return new Response(aiStream, {
        headers: {
          "Content-Type": "text/event-stream"
        }
      })
    }

    const aiResponse = await runAI(this.env, messages)

    const reply =
      aiResponse?.response ?? "No response from model."

    recent.push({
      role: "assistant",
      content: reply
    })

    if (recent.length > MAX_RECENT) {
      const summaryPrompt = [
        {
          role: "system",
          content:
            "Summarize the following conversation into a concise memory preserving important user context."
        },
        ...recent
      ]

      const summaryResult = await runAI(this.env, summaryPrompt)

      const newSummary =
        summaryResult?.response ?? summary

      await this.state.storage.put("summary", newSummary)

      recent = recent.slice(-4)
    }

    await this.state.storage.put("recent", recent)

    return Response.json({
      reply
    })
  }
}