import { router } from "./router"
import { Conversation } from "./durable/conversation"
import { SessionIndex } from "./durable/sessionIndex"

export interface Env {
  AI:any
  CONVERSATION:DurableObjectNamespace
  SESSION_INDEX:DurableObjectNamespace
}

export default {
  fetch(request:Request, env:Env){
    return router(request,env)
  }
}

export { Conversation, SessionIndex }