import { router } from "./router"
import { Conversation } from "./durable/conversation"
import { SessionIndex } from "./durable/sessionIndex"
import { AuthDirectory } from "./durable/authDirectory"
import { Workspace } from "./durable/workspace"
import { RateLimiter } from "./durable/rateLimiter"
import { withModelGateway } from "./ai/gateway"

export interface WorkersAIRunOptions {
  gateway?: {
    id: string
    collectLog?: boolean
    skipCache?: boolean
    cacheTtl?: number
    requestTimeoutMs?: number
    retries?: { maxAttempts?: 1 | 2 | 3 | 4 | 5; retryDelayMs?: number; backoff?: "constant" | "linear" | "exponential" }
    metadata?: Record<string, string | number | boolean | null>
  }
}

export interface WorkersAI {
  run(model: string, input: unknown, options?: WorkersAIRunOptions): Promise<unknown>
  /** AI Gateway universal endpoint, used only by the external-provider adapter. */
  gateway?(gatewayId: string): {
    run(request: unknown, options?: { gateway?: Omit<NonNullable<WorkersAIRunOptions["gateway"]>, "id"> }): Promise<Response>
  }
}

export interface Env {
  AI: WorkersAI
  CONVERSATION: DurableObjectNamespace
  SESSION_INDEX: DurableObjectNamespace
  AUTH_DIRECTORY: DurableObjectNamespace
  WORKSPACE: DurableObjectNamespace
  ARTIFACTS: R2Bucket
  RATE_LIMITER: DurableObjectNamespace
  /** Cloudflare AI Gateway name. Unset = direct Workers AI (local development and tests). See README "Model gateway". */
  AI_GATEWAY_ID?: string
  /** "true" makes a missing AI_GATEWAY_ID a hard error instead of a direct call. */
  AI_GATEWAY_REQUIRED?: string
  /** "enabled" allows registry entries with the gateway-external provider. Has no effect without a gateway. */
  AI_EXTERNAL_PROVIDERS?: string
  /** Worker secret for external providers when the key isn't stored in the gateway (BYOK is preferred). */
  AI_EXTERNAL_PROVIDER_KEY?: string
}

export default {
  fetch(request: Request, env: Env) {
    // Route-level code that calls env.AI directly still goes through the gateway.
    return router(request, withModelGateway(env))
  }
}

export { Conversation, SessionIndex, AuthDirectory, Workspace, RateLimiter }
