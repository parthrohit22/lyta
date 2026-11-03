import type { Env, WorkersAI, WorkersAIRunOptions } from "../index"
import { ModelError, type CallAttribution } from "./types"

/**
 * Cloudflare AI Gateway as LYTA's model control plane.
 *
 * - `AI_GATEWAY_ID` unset: direct mode. Workers AI is called with no gateway
 *   option. This is the documented path for local development and tests.
 * - `AI_GATEWAY_ID` set: every Workers AI call (chat, stream, embeddings) gets
 *   the binding's `gateway` option, and the external-provider adapter can run.
 * - `AI_GATEWAY_REQUIRED="true"` without an id: misconfigured. Model calls fail
 *   closed with `not_configured` instead of silently going direct. Set this in
 *   production once the gateway exists.
 *
 * The gateway id is a name, not a credential. Provider keys for external
 * models live in the gateway (BYOK) or in a Worker secret, never in the repo,
 * browser code, or Durable Object storage.
 */
export type GatewayConfig = { mode: "direct" } | { mode: "gateway"; id: string } | { mode: "misconfigured"; reason: string }

type GatewayEnv = Pick<Env, "AI_GATEWAY_ID" | "AI_GATEWAY_REQUIRED">

const GATEWAY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function readGatewayConfig(env: Partial<GatewayEnv>): GatewayConfig {
  const id = typeof env.AI_GATEWAY_ID === "string" ? env.AI_GATEWAY_ID.trim() : ""
  const required = env.AI_GATEWAY_REQUIRED === "true"

  if (id && !GATEWAY_ID.test(id)) {
    return { mode: "misconfigured", reason: "AI_GATEWAY_ID is not a valid gateway name." }
  }

  if (id) {
    return { mode: "gateway", id }
  }

  return required ? { mode: "misconfigured", reason: "AI_GATEWAY_REQUIRED is set but AI_GATEWAY_ID is empty." } : { mode: "direct" }
}

export function assertGatewayUsable(config: GatewayConfig) {
  if (config.mode === "misconfigured") {
    throw new ModelError("not_configured", `Model gateway misconfigured: ${config.reason}`)
  }
}

/**
 * Per-call gateway policy:
 * - `collectLog: false` stops the gateway storing a request/response log (the
 *   log is where prompt and response bodies would live). Turning logs on needs
 *   a code change plus a documented, user-consented retention policy.
 * - `skipCache: true`: a cached response is a retained response, and two
 *   workspaces must never share one.
 * - `requestTimeoutMs` mirrors the profile timeout.
 * - `retries.maxAttempts: 1`: retries and fallback stay in the Worker
 *   (callWithPolicy), where they know which models are capability-compatible.
 *   Gateway retries on top would multiply attempts.
 * - `metadata` carries content-free attribution. The gateway accepts at most
 *   five entries; LYTA uses four.
 */
export function buildGatewayOptions(
  id: string,
  attribution: CallAttribution,
  policy: { timeoutMs: number },
  attempt: "primary" | "retry" | "fallback"
): NonNullable<WorkersAIRunOptions["gateway"]> {
  return {
    id,
    collectLog: false,
    skipCache: true,
    requestTimeoutMs: policy.timeoutMs,
    retries: { maxAttempts: 1 },
    metadata: {
      profile: attribution.profile,
      route: attribution.route,
      workspace: attribution.workspace || "unattributed",
      attempt
    }
  }
}

/**
 * Wraps env.AI so a caller that uses the raw binding (`env.AI.run(model, input)`)
 * still goes through the gateway. Applied once at the Worker entry, it covers
 * router-level calls that don't use src/services/ai.ts. Calls that already
 * carry a gateway option (the adapters' own) pass through unchanged.
 * Durable Objects get their env from the runtime, not from here, so they go
 * through the adapters, which add the option themselves.
 */
export function withModelGateway<E extends Pick<Env, "AI"> & Partial<GatewayEnv>>(env: E): E {
  const config = readGatewayConfig(env)

  if (config.mode === "direct") {
    return env
  }

  const binding = env.AI
  const gatewayId = config.mode === "gateway" ? config.id : ""
  const wrapped: WorkersAI = {
    async run(model, input, options) {
      assertGatewayUsable(config)

      if (options?.gateway) {
        return binding.run(model, input, options)
      }

      return binding.run(model, input, {
        ...options,
        gateway: { id: gatewayId, collectLog: false, skipCache: true, retries: { maxAttempts: 1 }, metadata: { route: "unattributed" } }
      })
    },
    ...(binding.gateway ? { gateway: (id: string) => binding.gateway!(id) } : {})
  }

  return { ...env, AI: wrapped }
}

/**
 * A stable, non-reversible tag for per-workspace attribution. The raw
 * workspace key never reaches telemetry or the gateway.
 */
export async function workspaceTag(workspaceKey: string | undefined) {
  if (!workspaceKey) {
    return undefined
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lyta-workspace:${workspaceKey}`))

  return `ws_${[...new Uint8Array(digest)]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}
