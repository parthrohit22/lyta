import type { ChatMode } from "../chat/messages"
import { resolveProfile, type ProfileResolution } from "../ai/registry"
import type { ProductProfileId } from "../ai/types"

export interface ModelProfile {
  /** Workers AI model id passed to env.AI.run(). */
  model: string
  /** Human-readable version label recorded in telemetry; bump when the underlying model changes. */
  modelVersion: string
  /** Tried once, after primary retries are exhausted, before the call is reported as failed. */
  fallbackModel?: string
  timeoutMs: number
  maxRetries: number
  temperature: number
  top_p: number
  max_tokens: number
  targets: {
    latencyMsP50: number
    latencyMsP95: number
    estimatedCostPerRequestUsd: number
    qualityNotes: string
  }
}

/** Chat modes map onto product profiles; `deep` is the Deep Review profile. */
export const MODE_PROFILES: Record<ChatMode, ProductProfileId> = {
  instant: "instant",
  deep: "deep-review",
  creative: "creative"
}

export function toModelProfile(resolution: ProfileResolution): ModelProfile {
  const { profile, primary, fallback } = resolution

  return {
    model: primary.model,
    modelVersion: primary.version,
    ...(fallback ? { fallbackModel: fallback.model } : {}),
    ...profile.policy,
    targets: { ...profile.targets }
  }
}

/**
 * Per-mode model policy, derived from the provider/capability registry in
 * src/ai/registry.ts. That registry is now the source of truth: change models,
 * fallback order, or policy there. See RELEASE_CHECKLIST.md's AI-evaluation
 * comparison step before promoting a change, and eval/README.md for the
 * pass-rate gate CI enforces.
 *
 * This resolves with no per-request needs (no images, no external providers),
 * which is what direct `callWithPolicy(route, getModelProfile(mode), …)`
 * callers get. src/services/ai.ts re-resolves per request so, for example, an
 * image message never falls back to a text-only model.
 */
export const MODEL_PROFILES: Record<ChatMode, ModelProfile> = {
  instant: toModelProfile(resolveProfile(MODE_PROFILES.instant)),
  deep: toModelProfile(resolveProfile(MODE_PROFILES.deep)),
  creative: toModelProfile(resolveProfile(MODE_PROFILES.creative))
}

export function getModelProfile(mode: ChatMode): ModelProfile {
  return MODEL_PROFILES[mode] || MODEL_PROFILES.instant
}
