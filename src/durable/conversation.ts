import { runAI, runAIStream } from "../services/ai"
import { retrieveContext } from "../services/retriever"

const MAX_RECENT = 6

export class Conversation {

  state: DurableObjectState
  env: any
  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: any){
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response>{

    const pathname = new URL(request.url).pathname

    if(pathname === "/reset"){
      await this.state.storage.deleteAll()
      return Response.json({ ok:true })
    }

    if(pathname === "/history"){

      const recent =
        (await this.state.storage.get<any[]>("recent")) || []

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
        (await this.state.storage.get<any[]>("recent")) || []

      const summary =
        await this.state.storage.get("summary")

      return Response.json({
        messageCount: recent.length,
        hasSummary: !!summary
      })
    }

    if(pathname === "/chat"){
      return this.queue(()=>this.handleChat(request,false))
    }

    if(pathname === "/chat/stream"){
      return this.queue(()=>this.handleChat(request,true))
    }

    return new Response("Not Found",{status:404})
  }

  private async queue<T>(fn:()=>Promise<T>):Promise<T>{
    const next = this.lock.then(fn)
    this.lock = next.then(()=>{},()=>{})
    return next
  }

  async handleChat(request:Request, stream:boolean):Promise<Response>{

    const body:{message?:string} = await request.json()

    if(!body?.message){
      return new Response("Message required",{status:400})
    }

    const message = body.message

    let recent =
      (await this.state.storage.get<any[]>("recent")) || []

    recent.push({
      role:"user",
      content:message
    })

    let title =
      await this.state.storage.get<string>("title")

    if(!title){

      const titlePrompt = [
        {
          role:"system",
          content:"Generate a short 3-5 word title for this conversation."
        },
        {
          role:"user",
          content:message
        }
      ]

      const titleResult =
        await runAI(this.env,titlePrompt)

      const newTitle =
        titleResult?.response?.slice(0,60) || "New Chat"

      await this.state.storage.put("title",newTitle)
    }

    const summary =
      (await this.state.storage.get<string>("summary")) || ""

    const retrievedContext =
      await retrieveContext(this.env,message)

    const systemMessage = {
      role:"system",
      content:
      "You are LYTA, an edge AI assistant running on Cloudflare Workers AI."
    }

    const contextMessage = retrievedContext
      ? {
        role:"system",
        content:`Relevant context:\n${retrievedContext}`
      }
      : null

    const summaryMessage = summary
      ? {
        role:"system",
        content:`Conversation summary: ${summary}`
      }
      : null

    const messages = [
      systemMessage,
      ...(contextMessage?[contextMessage]:[]),
      ...(summaryMessage?[summaryMessage]:[]),
      ...recent
    ]

    if(stream){

      const aiStream =
        await runAIStream(this.env,messages)

      let assistantText = ""

      const {readable,writable} =
        new TransformStream()

      const writer = writable.getWriter()
      const reader = aiStream.getReader()
      const decoder = new TextDecoder()

      ;(async()=>{

        while(true){

          const {done,value} = await reader.read()
          if(done) break

          await writer.write(value)

          const chunk =
            decoder.decode(value)

          const lines =
            chunk.split("\n")

          for(const line of lines){

            if(!line.startsWith("data: ")) continue

            try{

              const parsed =
                JSON.parse(
                  line.replace("data: ","")
                )

              if(parsed.response){
                assistantText += parsed.response
              }

            }catch{}

          }

        }

        await writer.close()

        recent.push({
          role:"assistant",
          content:assistantText
        })

        await this.persistConversation(recent)

      })()

      return new Response(readable,{
        headers:{
          "Content-Type":"text/event-stream"
        }
      })

    }

    const aiResponse =
      await runAI(this.env,messages)

    const reply =
      aiResponse?.response ?? "No response from model."

    recent.push({
      role:"assistant",
      content:reply
    })

    await this.persistConversation(recent)

    return Response.json({
      reply
    })

  }

  async persistConversation(recent:any[]){

    if(recent.length > MAX_RECENT){

      const summaryPrompt = [
        {
          role:"system",
          content:
          "Summarize the following conversation preserving important user context."
        },
        ...recent
      ]

      const summaryResult =
        await runAI(this.env,summaryPrompt)

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

}