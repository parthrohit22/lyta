/**
 * Provider-neutral model types. Product code asks for a *profile* (Instant,
 * Deep Review, Visual Review) and a set of capabilities; the registry
 * (src/ai/registry.ts) decides which approved model serves it, and a
 * ModelProvider adapter (src/ai/providers/) knows how to call that model.
 */

export type ProviderId = "workers-ai" | "gateway-external"

export type ModelCapability = "text" | "vision" | "structured_output" | "tool_calling" | "streaming" | "embeddings"

/**
 * - `cloudflare-hosted`: inference runs on Cloudflare Workers AI; content does
 *   not leave Cloudflare.
 * - `external-processor`: content is sent through AI Gateway to a third-party
 *   provider under that provider's data terms.
 */
export type PrivacyClass = "cloudflare-hosted" | "external-processor"

export interface ModelEvaluation {
  /** Dataset the result was recorded against (eval/dataset.json). */
  dataset: "eval/dataset.json"
  datasetVersion: string
  /**
   * - `manual-real-model`: the dataset was run against the real model following
   *   eval/README.md, and `passRate` is that run's score.
   * - `grandfathered-baseline`: the model was already serving production before
   *   the registry existed. Its real-model scores are not recorded in the repo.
   *   Only the entries in GRANDFATHERED_MODEL_IDS may use this, and no new
   *   entry can.
   */
  method: "manual-real-model" | "grandfathered-baseline"
  passRate: number | null
  recordedAt: string
  /** PR, issue, or doc where the comparison is written up. */
  reference: string
}

export interface ModelRegistryEntry {
  /** Stable registry key, e.g. "workers-ai/llama-4-scout-17b-16e-instruct". */
  id: string
  provider: ProviderId
  /** Model id as the provider expects it (passed to env.AI.run for Workers AI). */
  model: string
  /** Human-readable version label recorded in telemetry. */
  version: string
  displayName: string
  capabilities: {
    text: boolean
    vision: boolean
    /** `native`: provider JSON mode; `prompted`: JSON requested in the prompt and validated by LYTA; `none`: unsupported. */
    structuredOutput: "native" | "prompted" | "none"
    toolCalling: boolean
    streaming: boolean
    embeddings: boolean
  }
  limits: {
    contextTokens: number
    maxOutputTokens: number
    embeddingDimensions?: number
  }
  privacyClass: PrivacyClass
  /** `disabled` entries are never selected, whatever the profile asks for. */
  availability: "enabled" | "disabled"
  cost: {
    billing: "workers-ai-neurons" | "provider-invoice"
    /** Rough planning estimate, not a measured price. Used for attribution only. */
    estimatedCostPerRequestUsd: number
  }
  evaluation: ModelEvaluation | null
}

export type ProductProfileId = "instant" | "deep-review" | "visual-review" | "creative" | "embedding"

export interface ProductProfile {
  id: ProductProfileId
  /** Name shown to users. Raw model identity is only ever secondary metadata. */
  label: string
  /** Plain-language data-handling policy, shown next to the profile name. */
  dataHandling: string
  /** Hidden profiles back internal workflows and are not offered as a choice. */
  userFacing: boolean
  requiredCapabilities: ModelCapability[]
  allowedPrivacyClasses: PrivacyClass[]
  /** Registry ids in preference order; the first compatible one is primary, the next compatible one is the fallback. */
  candidates: string[]
  /** When false, a failed primary is never replaced by a different model (e.g. embeddings, whose vector space would change). */
  allowFallback: boolean
  policy: {
    timeoutMs: number
    maxRetries: number
    temperature: number
    top_p: number
    max_tokens: number
  }
  targets: {
    latencyMsP50: number
    latencyMsP95: number
    estimatedCostPerRequestUsd: number
    qualityNotes: string
  }
}

/** Content-free attribution attached to every model call (telemetry and gateway metadata). */
export interface CallAttribution {
  profile: ProductProfileId
  route: string
  /** Opaque, non-reversible workspace tag (see workspaceTag()), never the raw workspace key. */
  workspace?: string
}

export type ModelErrorCode =
  | "timeout"
  | "cancelled"
  | "rate_limited"
  | "billing_limit"
  | "unavailable"
  | "invalid_output"
  | "not_configured"
  | "no_compatible_model"
  | "upstream"

const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set(["timeout", "rate_limited", "unavailable", "upstream"])

/** The one error type adapters and the model service throw, whatever the provider said. */
export class ModelError extends Error {
  readonly code: ModelErrorCode
  readonly retryable: boolean
  readonly provider?: ProviderId
  readonly model?: string
  readonly profile?: ProductProfileId

  constructor(
    code: ModelErrorCode,
    message: string,
    options: { cause?: unknown; provider?: ProviderId; model?: string; profile?: ProductProfileId } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = "ModelError"
    this.code = code
    this.retryable = RETRYABLE.has(code)
    this.provider = options.provider
    this.model = options.model
    this.profile = options.profile
  }
}

/** Maps whatever a provider threw onto a ModelErrorCode. Never copies provider payloads into the message. */
export function normalizeModelError(
  error: unknown,
  context: { provider?: ProviderId; model?: string; profile?: ProductProfileId } = {}
): ModelError {
  if (error instanceof ModelError) {
    return error
  }

  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const status = readStatus(error)
  const text = message.toLowerCase()

  const code: ModelErrorCode =
    name === "AbortError" || /\baborted\b|\bcancel/.test(text)
      ? "cancelled"
      : name === "ModelTimeoutError" || /timed out|timeout/.test(text)
        ? "timeout"
        : status === 402 || /neurons|billing|quota|credit|allocation|spend limit/.test(text)
          ? "billing_limit"
          : status === 429 || /rate limit|too many requests/.test(text)
            ? "rate_limited"
            : (status !== undefined && status >= 500) || /unavailable|capacity|overloaded|bad gateway/.test(text)
              ? "unavailable"
              : "upstream"

  return new ModelError(code, `Model call failed (${code}).`, { cause: error, ...context })
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }

  const value = (error as { status?: unknown }).status
  return typeof value === "number" ? value : undefined
}
