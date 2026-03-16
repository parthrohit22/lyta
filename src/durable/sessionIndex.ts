export interface ChatSession {
  id: string
  title: string
}

export class SessionIndex {

  state: DurableObjectState
  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState){
    this.state = state
  }

  async fetch(request: Request): Promise<Response>{

    const url = new URL(request.url)
    const path = url.pathname

    if(path === "/list"){
      const sessions =
        (await this.state.storage.get<ChatSession[]>("sessions")) || []

      return Response.json({ sessions })
    }

    if(path === "/add"){
      return this.queue(() => this.addSession(request))
    }

    if(path === "/delete"){
      return this.queue(() => this.deleteSession(request))
    }

    if(path === "/rename"){
      return this.queue(() => this.renameSession(request))
    }

    return new Response("Not Found",{status:404})
  }

  private async queue<T>(fn:()=>Promise<T>):Promise<T>{
    const next = this.lock.then(fn)
    this.lock = next.then(()=>{},()=>{})
    return next
  }

  async addSession(request:Request):Promise<Response>{

    const body = await request.json() as { id?: string, title?: string }

    if(!body?.id){
      return new Response("Invalid session",{status:400})
    }

    let sessions =
      (await this.state.storage.get<ChatSession[]>("sessions")) || []

    if(sessions.find(s => s.id === body.id)){
      return Response.json({ok:true})
    }

    sessions.unshift({
      id: body.id,
      title: body.title || "New Chat"
    })

    if(sessions.length > 100){
      sessions = sessions.slice(0,100)
    }

    await this.state.storage.put("sessions",sessions)

    return Response.json({ok:true})
  }

  async deleteSession(request:Request):Promise<Response>{

    const body = await request.json() as { id?: string }

    if(!body?.id){
      return new Response("Invalid session",{status:400})
    }

    let sessions =
      (await this.state.storage.get<ChatSession[]>("sessions")) || []

    sessions = sessions.filter(s => s.id !== body.id)

    await this.state.storage.put("sessions",sessions)

    return Response.json({ok:true})
  }

  async renameSession(request:Request):Promise<Response>{

    const body =
      await request.json() as { id?: string, title?: string }

    if(!body?.id || !body?.title){
      return new Response("Invalid rename",{status:400})
    }

    const sessions =
      (await this.state.storage.get<ChatSession[]>("sessions")) || []

    const chat =
      sessions.find(s => s.id === body.id)

    if(chat){
      chat.title = body.title.slice(0,80)
    }

    await this.state.storage.put("sessions",sessions)

    return Response.json({ok:true})
  }

}