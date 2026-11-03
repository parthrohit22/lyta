import {
  ModelError,
  type ModelCapability,
  type ModelRegistryEntry,
  type PrivacyClass,
  type ProductProfile,
  type ProductProfileId
} from "./types"

const CLOUDFLARE_HOSTED_POLICY =
  "Runs on Cloudflare Workers AI. Your text and files stay on Cloudflare; model-gateway logging records metadata only (no prompts or responses)."

/** The three models LYTA served before the registry existed. No new entry may use a grandfathered evaluation. */
export const GRANDFATHERED_MODEL_IDS: ReadonlySet<string> = new Set([
  "workers-ai/llama-4-scout-17b-16e-instruct",
  "workers-ai/llama-3.1-8b-instruct",
  "workers-ai/bge-base-en-v1.5"
])

const GRANDFATHERED_EVALUATION = {
  dataset: "eval/dataset.json",
  datasetVersion: "2026-08-21.1",
  method: "grandfathered-baseline",
  passRate: null,
  recordedAt: "2026-08-21",
  reference: "https://github.com/parthrohit22/lyta/pull/26"
} as const

/**
 * Every model LYTA is approved to call. Capabilities and `contextTokens` were
 * taken from the provider's model catalog when the entry was written; LYTA has
 * not measured them. `maxOutputTokens` is LYTA's own ceiling, not a provider
 * guarantee. Re-check the catalog before relying on a value in a new workflow.
 *
 * To add a model: add an entry here, record an evaluation result (see
 * eval/README.md), and list its id in a profile's `candidates`. No product
 * workflow code changes. tests/unit/model-registry.test.ts enforces the rules.
 */
export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = [
  {
    id: "workers-ai/llama-4-scout-17b-16e-instruct",
    provider: "workers-ai",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    version: "llama-4-scout-17b-16e-instruct",
    displayName: "Llama 4 Scout 17B (Workers AI)",
    capabilities: {
      text: true,
      vision: true,
      structuredOutput: "prompted",
      toolCalling: true,
      streaming: true,
      embeddings: false
    },
    limits: { contextTokens: 131_000, maxOutputTokens: 4_096 },
    privacyClass: "cloudflare-hosted",
    availability: "enabled",
    cost: { billing: "workers-ai-neurons", estimatedCostPerRequestUsd: 0.004 },
    evaluation: GRANDFATHERED_EVALUATION
  },
  {
    id: "workers-ai/llama-3.1-8b-instruct",
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
    version: "llama-3.1-8b-instruct",
    displayName: "Llama 3.1 8B (Workers AI)",
    capabilities: {
      text: true,
      vision: false,
      structuredOutput: "prompted",
      toolCalling: false,
      streaming: true,
      embeddings: false
    },
    limits: { contextTokens: 7_968, maxOutputTokens: 2_048 },
    privacyClass: "cloudflare-hosted",
    availability: "enabled",
    cost: { billing: "workers-ai-neurons", estimatedCostPerRequestUsd: 0.001 },
    evaluation: GRANDFATHERED_EVALUATION
  },
  {
    id: "workers-ai/bge-base-en-v1.5",
    provider: "workers-ai",
    model: "@cf/baai/bge-base-en-v1.5",
    version: "bge-base-en-v1.5",
    displayName: "BGE Base EN v1.5 embeddings (Workers AI)",
    capabilities: {
      text: false,
      vision: false,
      structuredOutput: "none",
      toolCalling: false,
      streaming: false,
      embeddings: true
    },
    limits: { contextTokens: 512, maxOutputTokens: 0, embeddingDimensions: 768 },
    privacyClass: "cloudflare-hosted",
    availability: "enabled",
    cost: { billing: "workers-ai-neurons", estimatedCostPerRequestUsd: 0.0001 },
    evaluation: GRANDFATHERED_EVALUATION
  },
  {
    // The external-provider path through AI Gateway. Disabled: no provider
    // key is provisioned, it has no evaluation result, and no profile allows
    // the external-processor privacy class. All three must change, plus
    // AI_EXTERNAL_PROVIDERS="enabled" and a configured gateway, before it can
    // serve a request. See docs/runbooks/provider-change.md.
    id: "gateway-external/openai-gpt-4o-mini",
    provider: "gateway-external",
    model: "openai/gpt-4o-mini",
    version: "gpt-4o-mini",
    displayName: "GPT-4o mini (OpenAI via AI Gateway)",
    capabilities: {
      text: true,
      vision: true,
      structuredOutput: "native",
      toolCalling: true,
      streaming: true,
      embeddings: false
    },
    limits: { contextTokens: 128_000, maxOutputTokens: 16_384 },
    privacyClass: "external-processor",
    availability: "disabled",
    cost: { billing: "provider-invoice", estimatedCostPerRequestUsd: 0.002 },
    evaluation: null
  }
]

/**
 * Product profiles are what users and workflows pick. Instant and Deep Review
 * back the chat modes; Visual Review requires image input and therefore has no
 * text-only fallback. Creative and Embedding are internal and never offered as
 * a primary choice.
 */
export const PRODUCT_PROFILES: Record<ProductProfileId, ProductProfile> = {
  instant: {
    id: "instant",
    label: "Instant",
    dataHandling: CLOUDFLARE_HOSTED_POLICY,
    userFacing: true,
    requiredCapabilities: ["text", "streaming"],
    allowedPrivacyClasses: ["cloudflare-hosted"],
    candidates: ["workers-ai/llama-4-scout-17b-16e-instruct", "workers-ai/llama-3.1-8b-instruct"],
    allowFallback: true,
    policy: { timeoutMs: 12_000, maxRetries: 1, temperature: 0.45, top_p: 0.9, max_tokens: 1100 },
    targets: {
      latencyMsP50: 2_000,
      latencyMsP95: 6_000,
      estimatedCostPerRequestUsd: 0.002,
      qualityNotes: "Quick, direct answers for short technical questions. Some depth/nuance loss is acceptable for speed."
    }
  },
  "deep-review": {
    id: "deep-review",
    label: "Deep Review",
    dataHandling: CLOUDFLARE_HOSTED_POLICY,
    userFacing: true,
    requiredCapabilities: ["text", "streaming", "structured_output"],
    allowedPrivacyClasses: ["cloudflare-hosted"],
    candidates: ["workers-ai/llama-4-scout-17b-16e-instruct", "workers-ai/llama-3.1-8b-instruct"],
    allowFallback: true,
    policy: { timeoutMs: 25_000, maxRetries: 1, temperature: 0.35, top_p: 0.85, max_tokens: 1800 },
    targets: {
      latencyMsP50: 5_000,
      latencyMsP95: 15_000,
      estimatedCostPerRequestUsd: 0.004,
      qualityNotes:
        "Deep Review: prioritizes evidence grounding and completeness over speed. Every claim should be traceable to retrieved context or explicitly flagged as unsupported."
    }
  },
  "visual-review": {
    id: "visual-review",
    label: "Visual Review",
    dataHandling: CLOUDFLARE_HOSTED_POLICY,
    userFacing: true,
    requiredCapabilities: ["text", "vision", "structured_output"],
    allowedPrivacyClasses: ["cloudflare-hosted"],
    candidates: ["workers-ai/llama-4-scout-17b-16e-instruct"],
    allowFallback: true,
    policy: { timeoutMs: 30_000, maxRetries: 1, temperature: 0.3, top_p: 0.85, max_tokens: 1800 },
    targets: {
      latencyMsP50: 6_000,
      latencyMsP95: 18_000,
      estimatedCostPerRequestUsd: 0.005,
      qualityNotes:
        "Reviews diagrams and screenshots. Only vision-capable models qualify; a text-only fallback would silently ignore the image, so none is configured."
    }
  },
  creative: {
    id: "creative",
    label: "Creative",
    dataHandling: CLOUDFLARE_HOSTED_POLICY,
    userFacing: false,
    requiredCapabilities: ["text", "streaming"],
    allowedPrivacyClasses: ["cloudflare-hosted"],
    candidates: ["workers-ai/llama-4-scout-17b-16e-instruct", "workers-ai/llama-3.1-8b-instruct"],
    allowFallback: true,
    policy: { timeoutMs: 18_000, maxRetries: 1, temperature: 0.9, top_p: 0.95, max_tokens: 1400 },
    targets: {
      latencyMsP50: 3_500,
      latencyMsP95: 10_000,
      estimatedCostPerRequestUsd: 0.003,
      qualityNotes: "Exploratory/brainstorming responses. Not currently in #6's required scope; documented for consistency."
    }
  },
  embedding: {
    id: "embedding",
    label: "Library indexing",
    dataHandling: CLOUDFLARE_HOSTED_POLICY,
    userFacing: false,
    requiredCapabilities: ["embeddings"],
    allowedPrivacyClasses: ["cloudflare-hosted"],
    candidates: ["workers-ai/bge-base-en-v1.5"],
    // Vectors from a different model live in a different space. Falling back
    // would silently corrupt retrieval, so an outage fails the call instead.
    allowFallback: false,
    policy: { timeoutMs: 10_000, maxRetries: 0, temperature: 0, top_p: 1, max_tokens: 0 },
    targets: {
      latencyMsP50: 150,
      latencyMsP95: 600,
      estimatedCostPerRequestUsd: 0.0001,
      qualityNotes: "Library and query embeddings. Changing the model requires re-indexing every stored vector."
    }
  }
}

export interface ResolveOptions {
  /** Extra capabilities this request needs on top of the profile's, e.g. `vision` when the message carries an image. */
  requires?: ModelCapability[]
  /** Rules out models whose context window can't hold the request plus its reply budget. */
  minContextTokens?: number
  /** True only when AI_EXTERNAL_PROVIDERS="enabled" and a gateway is configured (see src/ai/gateway.ts). */
  externalProvidersEnabled?: boolean
  registry?: readonly ModelRegistryEntry[]
  profiles?: Record<ProductProfileId, ProductProfile>
}

export interface ProfileResolution {
  profile: ProductProfile
  primary: ModelRegistryEntry
  fallback?: ModelRegistryEntry
  requiredCapabilities: ModelCapability[]
}

/**
 * Picks the primary and (optional) fallback model for a profile. Throws a
 * `no_compatible_model` ModelError naming the profile and the missing
 * capabilities when nothing approved can serve it, rather than quietly using
 * a model that can't.
 */
export function resolveProfile(profileId: ProductProfileId, options: ResolveOptions = {}): ProfileResolution {
  const registry = options.registry || MODEL_REGISTRY
  const profile = (options.profiles || PRODUCT_PROFILES)[profileId]

  if (!profile) {
    throw new ModelError("not_configured", `Unknown model profile "${profileId}".`)
  }

  const requiredCapabilities = [...new Set([...profile.requiredCapabilities, ...(options.requires || [])])]
  const compatible = profile.candidates
    .map((id) => registry.find((entry) => entry.id === id))
    .filter((entry): entry is ModelRegistryEntry => Boolean(entry))
    .filter((entry) => isSelectable(entry, profile.allowedPrivacyClasses, options.externalProvidersEnabled === true))
    .filter((entry) => requiredCapabilities.every((capability) => hasCapability(entry, capability)))
    .filter((entry) => !options.minContextTokens || entry.limits.contextTokens >= options.minContextTokens)

  const [primary, fallback] = compatible

  if (!primary) {
    const context = options.minContextTokens ? ` with a ${options.minContextTokens}-token context` : ""
    throw new ModelError(
      "no_compatible_model",
      `${profile.label} is unavailable: no approved, enabled model supports ${requiredCapabilities.join(", ")}${context}.`,
      { profile: profile.id }
    )
  }

  return {
    profile,
    primary,
    fallback: profile.allowFallback ? fallback : undefined,
    requiredCapabilities
  }
}

export function hasCapability(entry: ModelRegistryEntry, capability: ModelCapability) {
  switch (capability) {
    case "text":
      return entry.capabilities.text
    case "vision":
      return entry.capabilities.vision
    case "structured_output":
      return entry.capabilities.structuredOutput !== "none"
    case "tool_calling":
      return entry.capabilities.toolCalling
    case "streaming":
      return entry.capabilities.streaming
    case "embeddings":
      return entry.capabilities.embeddings
  }
}

function isSelectable(entry: ModelRegistryEntry, allowed: PrivacyClass[], externalProvidersEnabled: boolean) {
  if (entry.availability !== "enabled" || !entry.evaluation || !allowed.includes(entry.privacyClass)) {
    return false
  }

  return entry.provider !== "gateway-external" || externalProvidersEnabled
}

export function findRegistryEntry(id: string, registry: readonly ModelRegistryEntry[] = MODEL_REGISTRY) {
  return registry.find((entry) => entry.id === id)
}

/**
 * Registry rules, checked by tests/unit/model-registry.test.ts. Returns a list
 * of problems rather than throwing so a test can report every one at once.
 */
export function validateRegistry(
  registry: readonly ModelRegistryEntry[] = MODEL_REGISTRY,
  profiles: Record<ProductProfileId, ProductProfile> = PRODUCT_PROFILES,
  baselinePassRate = 1
): string[] {
  const problems: string[] = []
  const ids = new Set<string>()

  for (const entry of registry) {
    if (ids.has(entry.id)) {
      problems.push(`${entry.id}: duplicate registry id`)
    }
    ids.add(entry.id)

    if (entry.availability === "enabled" && !entry.evaluation) {
      problems.push(`${entry.id}: enabled without an evaluation result`)
    }

    if (entry.evaluation?.method === "grandfathered-baseline" && !GRANDFATHERED_MODEL_IDS.has(entry.id)) {
      problems.push(`${entry.id}: only pre-registry models may use a grandfathered evaluation`)
    }

    if (entry.evaluation?.method === "manual-real-model" && (entry.evaluation.passRate ?? -1) < baselinePassRate) {
      problems.push(`${entry.id}: evaluation pass rate is below the dataset baseline (${baselinePassRate})`)
    }

    if (entry.provider === "gateway-external" && entry.privacyClass !== "external-processor") {
      problems.push(`${entry.id}: external providers must use the external-processor privacy class`)
    }
  }

  for (const profile of Object.values(profiles)) {
    for (const candidate of profile.candidates) {
      const entry = registry.find((item) => item.id === candidate)

      if (!entry) {
        problems.push(`${profile.id}: candidate ${candidate} is not in the registry`)
      } else if (profile.policy.max_tokens > entry.limits.maxOutputTokens) {
        problems.push(`${profile.id}: max_tokens ${profile.policy.max_tokens} exceeds ${candidate}'s ceiling`)
      }
    }
  }

  return problems
}
