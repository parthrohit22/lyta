import type { ChatMode } from "../chat/messages"
import { MODE_PROFILES, toModelProfile, type ModelProfile } from "../config/modelProfiles"
import { workspaceTag } from "../ai/gateway"
import { estimateTokens, hasImageContent, type AiChatMessage, type CallAttempt, type ChatCallRequest } from "../ai/provider"
import { createModelRouting, type ModelEnv } from "../ai/providers"
import { PRODUCT_PROFILES, resolveProfile, type ProfileResolution } from "../ai/registry"
import { ModelError, normalizeModelError, type CallAttribution, type ModelRegistryEntry, type ProductProfileId } from "../ai/types"
import { recordOperation } from "../utils/telemetry"

export type { AiChatMessage }

export interface RunAIOptions {
  mode?: ChatMode
  /** Overrides the mode → profile mapping, e.g. "visual-review". */
  profile?: ProductProfileId
  /** Telemetry/gateway route label. Defaults to "ai.chat" / "ai.chat.stream" / "ai.structured". */
  route?: string
  /** Raw workspace key. Only its non-reversible tag (workspaceTag()) leaves this module. */
  workspaceKey?: string
  signal?: AbortSignal
}

/** What a response may say about the model that served it: the profile first, raw model identity only as metadata. */
export interface ModelCallMetadata {
  profile: ProductProfileId
  profileLabel: string
  dataHandling: string
  model: string
  modelVersion: string
  provider: ModelRegistryEntry["provider"]
  usedFallback: boolean
  viaGateway: boolean
}

export interface PolicyOptions {
  signal?: AbortSignal
  telemetry?: {
    profile?: ProductProfileId
    workspace?: string
    viaGateway?: boolean
    describe?: (model: string) => { provider?: string; estimatedCostUsd?: number } | undefined
  }
}

class ModelTimeoutError extends Error {
  override name = "ModelTimeoutError"
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelTimeoutError(`Model call timed out after ${timeoutMs}ms.`)), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ModelError("cancelled", "Model call was cancelled."))
    }

    signal?.addEventListener("abort", onAbort, { once: true })

    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Timeout + bounded retry + single fallback-model attempt around a model call,
 * with the outcome recorded as non-sensitive telemetry (model/version/retry/
 * fallback/timeout, plus profile/provider/workspace tag/error code when the
 * caller supplies them — never prompt or response content).
 *
 * This is the in-Worker half of the policy. When AI_GATEWAY_ID is set the
 * adapters also send each attempt through Cloudflare AI Gateway (see
 * src/ai/gateway.ts). A cancelled call is never retried.
 */
export async function callWithPolicy<T>(
  route: string,
  profile: ModelProfile,
  invoke: (model: string) => Promise<T>,
  options: PolicyOptions = {}
): Promise<T> {
  const startedAt = Date.now()
  const attempts = [
    ...Array.from({ length: profile.maxRetries + 1 }, () => profile.model),
    ...(profile.fallbackModel ? [profile.fallbackModel] : [])
  ]
  const telemetry = options.telemetry || {}

  let timedOut = false
  let retryCount = 0
  let lastError: unknown

  for (let index = 0; index < attempts.length; index++) {
    const model = attempts[index]
    const isFallback = Boolean(profile.fallbackModel) && index === attempts.length - 1

    if (options.signal?.aborted) {
      lastError = new ModelError("cancelled", "Model call was cancelled.")
      break
    }

    if (index > 0 && !isFallback) {
      retryCount += 1
    }

    try {
      const result = await withTimeout(invoke(model), profile.timeoutMs, options.signal)
      const described = telemetry.describe?.(model)

      recordOperation({
        route,
        outcome: "allowed",
        durationMs: Date.now() - startedAt,
        units: 1,
        model,
        modelVersion: profile.modelVersion,
        timedOut,
        usedFallback: isFallback,
        retryCount,
        profile: telemetry.profile,
        provider: described?.provider,
        workspace: telemetry.workspace,
        viaGateway: telemetry.viaGateway,
        estimatedCostUsd: described?.estimatedCostUsd
      })

      return result
    } catch (error) {
      lastError = error

      if (error instanceof ModelTimeoutError) {
        timedOut = true
      }

      if (error instanceof ModelError && error.code === "cancelled") {
        break
      }
    }
  }

  recordOperation({
    route,
    outcome: "failure",
    durationMs: Date.now() - startedAt,
    units: 1,
    model: profile.model,
    modelVersion: profile.modelVersion,
    timedOut,
    retryCount,
    profile: telemetry.profile,
    provider: telemetry.describe?.(profile.model)?.provider,
    workspace: telemetry.workspace,
    viaGateway: telemetry.viaGateway,
    errorCode: normalizeModelError(lastError).code
  })

  throw lastError
}

interface CallPlan {
  routing: ReturnType<typeof createModelRouting>
  resolution: ProfileResolution
  policy: ModelProfile
  attribution: CallAttribution
  entryFor(model: string): ModelRegistryEntry
  metadata(entry: ModelRegistryEntry): ModelCallMetadata
}

async function planCall(env: ModelEnv, messages: AiChatMessage[], options: RunAIOptions, route: string): Promise<CallPlan> {
  const profileId = options.profile || MODE_PROFILES[options.mode || "instant"] || "instant"
  const routing = createModelRouting(env)
  const resolution = resolveProfile(profileId, {
    requires: hasImageContent(messages) ? ["vision"] : [],
    minContextTokens: estimateTokens(messages),
    externalProvidersEnabled: routing.externalProvidersEnabled
  })
  const policy = toModelProfile(resolution)
  const entries = [resolution.primary, ...(resolution.fallback ? [resolution.fallback] : [])]
  const viaGateway = routing.gateway.mode === "gateway"

  return {
    routing,
    resolution,
    policy,
    attribution: { profile: profileId, route, workspace: await workspaceTag(options.workspaceKey) },
    entryFor: (model) => entries.find((entry) => entry.model === model) || resolution.primary,
    metadata: (entry) => ({
      profile: resolution.profile.id,
      profileLabel: resolution.profile.label,
      dataHandling: resolution.profile.dataHandling,
      model: entry.id,
      modelVersion: entry.version,
      provider: entry.provider,
      usedFallback: entry.id !== resolution.primary.id,
      viaGateway
    })
  }
}

/**
 * Runs `call` under the plan's policy. Resolves the result plus metadata about
 * the model that actually served it, or rejects with a normalized ModelError
 * tagged with the profile. Callers turn that into a transparent degraded
 * response (see describeModelFailure()).
 */
async function executePlan<T>(
  plan: CallPlan,
  route: string,
  options: RunAIOptions,
  call: (entry: ModelRegistryEntry, attempt: CallAttempt) => Promise<T>
): Promise<{ value: T; model: ModelCallMetadata }> {
  let calls = 0
  let servedBy = plan.resolution.primary

  try {
    const value = await callWithPolicy(
      route,
      plan.policy,
      async (model) => {
        const entry = plan.entryFor(model)
        const attempt: CallAttempt = entry.id !== plan.resolution.primary.id ? "fallback" : calls === 0 ? "primary" : "retry"
        calls += 1

        const result = await call(entry, attempt)
        servedBy = entry
        return result
      },
      {
        signal: options.signal,
        telemetry: {
          profile: plan.attribution.profile,
          workspace: plan.attribution.workspace,
          viaGateway: plan.routing.gateway.mode === "gateway",
          describe: (model) => {
            const entry = plan.entryFor(model)
            return { provider: entry.provider, estimatedCostUsd: entry.cost.estimatedCostPerRequestUsd }
          }
        }
      }
    )

    return { value, model: plan.metadata(servedBy) }
  } catch (error) {
    const normalized = normalizeModelError(error)
    throw new ModelError(normalized.code, `${plan.resolution.profile.label} model request failed (${normalized.code}).`, {
      cause: error,
      provider: normalized.provider,
      model: normalized.model,
      profile: plan.resolution.profile.id
    })
  }
}

async function prepare(env: ModelEnv, messages: AiChatMessage[], options: RunAIOptions, route: string) {
  try {
    return await planCall(env, messages, options, route)
  } catch (error) {
    // Recorded so "no compatible model" shows up in the same metrics as outages.
    recordOperation({
      route,
      outcome: "failure",
      durationMs: 0,
      units: 0,
      profile: options.profile || MODE_PROFILES[options.mode || "instant"],
      errorCode: normalizeModelError(error).code
    })
    throw error
  }
}

function chatRequest(plan: CallPlan, entry: ModelRegistryEntry, attempt: CallAttempt, messages: AiChatMessage[]): ChatCallRequest {
  return {
    entry,
    messages,
    temperature: plan.policy.temperature,
    top_p: plan.policy.top_p,
    max_tokens: plan.policy.max_tokens,
    timeoutMs: plan.policy.timeoutMs,
    attribution: plan.attribution,
    attempt
  }
}

export async function runAI(env: ModelEnv, messages: AiChatMessage[], options: RunAIOptions = {}) {
  const route = options.route || "ai.chat"
  const plan = await prepare(env, messages, options, route)
  const { value, model } = await executePlan(plan, route, options, (entry, attempt) =>
    plan.routing.provider(entry.provider).chat(chatRequest(plan, entry, attempt, messages))
  )

  return { response: value.text, model }
}

/** Like runAIStream(), plus metadata about the model that opened the stream. */
export async function runAIStreamWithMetadata(env: ModelEnv, messages: AiChatMessage[], options: RunAIOptions = {}) {
  const route = options.route || "ai.chat.stream"
  const plan = await prepare(env, messages, options, route)

  // Policy (timeout/retry/fallback) applies only to obtaining the stream.
  // By the time a caller reads from it, streamChat() has already returned
  // the SSE Response — retrying mid-stream would mean discarding whatever
  // partial reply the client already saw, which is a real behavior change
  // out of scope here.
  const { value, model } = await executePlan(plan, route, options, (entry, attempt) =>
    plan.routing.provider(entry.provider).stream(chatRequest(plan, entry, attempt, messages))
  )

  return { stream: value, model }
}

export async function runAIStream(env: ModelEnv, messages: AiChatMessage[], options: RunAIOptions = {}) {
  return (await runAIStreamWithMetadata(env, messages, options)).stream
}

/**
 * Structured (JSON) output against a caller-supplied validator. Profiles that
 * use this must require the `structured_output` capability. An unusable reply
 * counts as a failed attempt, so it is retried and can fall back like any
 * other failure.
 */
export async function runStructured<T>(
  env: ModelEnv,
  messages: AiChatMessage[],
  validate: (value: unknown) => T | null,
  options: RunAIOptions = {}
) {
  const route = options.route || "ai.structured"
  const plan = await prepare(env, messages, options, route)

  return executePlan(plan, route, options, (entry, attempt) =>
    plan.routing.provider(entry.provider).structured(chatRequest(plan, entry, attempt, messages), validate)
  )
}

const FAILURE_MESSAGES: Record<ModelError["code"], (label: string) => string> = {
  timeout: (label) => `${label} timed out. Please retry.`,
  cancelled: () => "The request was cancelled.",
  rate_limited: (label) => `${label} is rate limited right now. Please retry in a moment.`,
  billing_limit: (label) => `${label} has reached its usage limit for now. Please retry later.`,
  unavailable: (label) => `${label} is unavailable right now. Please retry.`,
  invalid_output: (label) => `${label} returned a reply LYTA could not use. Please retry.`,
  not_configured: () => "Model routing is misconfigured. An operator needs to fix it before this can run.",
  no_compatible_model: (label) => `${label} has no compatible model available.`,
  upstream: (label) => `${label} failed. Please retry.`
}

/**
 * The transparent degraded response for a failed model call: what failed, in
 * product terms, without provider payloads. LYTA reports the failure rather
 * than quietly answering with a model that can't do what the profile promises.
 */
export function describeModelFailure(error: unknown) {
  const normalized = normalizeModelError(error)
  const label = normalized.profile ? PRODUCT_PROFILES[normalized.profile]?.label || "The model" : "The model"

  return {
    code: normalized.code,
    retryable: normalized.retryable,
    ...(normalized.profile ? { profile: normalized.profile } : {}),
    // resolveProfile()'s own message already names the profile and the missing capability.
    message:
      normalized.code === "no_compatible_model"
        ? `${normalized.message} LYTA did not substitute a model that lacks it.`
        : FAILURE_MESSAGES[normalized.code](label)
  }
}
