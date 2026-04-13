import { router } from "./router"
import { Conversation } from "./durable/conversation"
import { SessionIndex } from "./durable/sessionIndex"
import { AuthDirectory } from "./durable/authDirectory"
import { Workspace } from "./durable/workspace"

export interface Env {
  AI:any
  CONVERSATION:DurableObjectNamespace
  SESSION_INDEX:DurableObjectNamespace
  AUTH_DIRECTORY: DurableObjectNamespace
  WORKSPACE: DurableObjectNamespace
}

export default {
  fetch(request:Request, env:Env){
    return router(request,env)
  }
}

export { Conversation, SessionIndex, AuthDirectory, Workspace }
