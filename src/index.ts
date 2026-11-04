import { router } from "./router"
import { Conversation } from "./durable/conversation"
import { SessionIndex } from "./durable/sessionIndex"
import { AuthDirectory } from "./durable/authDirectory"
import { Workspace } from "./durable/workspace"
import { RateLimiter } from "./durable/rateLimiter"
import { handleEvalRequest } from "./eval/route"

export interface WorkersAI {
  run(model: string, input: unknown): Promise<unknown>
}

export interface Env {
  AI: WorkersAI
  CONVERSATION: DurableObjectNamespace
  SESSION_INDEX: DurableObjectNamespace
  AUTH_DIRECTORY: DurableObjectNamespace
  WORKSPACE: DurableObjectNamespace
  ARTIFACTS: R2Bucket
  RATE_LIMITER: DurableObjectNamespace
  /** Local model evaluation only (eval/README.md). Never set in wrangler.jsonc or production. */
  LYTA_EVAL_MODE?: string
  LYTA_EVAL_TOKEN?: string
}

export default {
  async fetch(request: Request, env: Env) {
    return (await handleEvalRequest(request, env)) || router(request, env)
  }
}

export { Conversation, SessionIndex, AuthDirectory, Workspace, RateLimiter }
