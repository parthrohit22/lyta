import { createModelRouting, type ModelEnv } from "./providers"
import { PRODUCT_PROFILES, resolveProfile } from "./registry"
import { ModelError, type ModelRegistryEntry } from "./types"

/**
 * The public description of LYTA's model profiles, served at GET /models/profiles
 * so the UI can name the profile and its data-handling policy, with model
 * identity as secondary metadata. Contains no secrets: the gateway id and
 * provider keys are not included.
 */
export function describeProfiles(env: ModelEnv) {
  const routing = createModelRouting(env)

  return {
    routing: routing.gateway.mode === "gateway" ? "gateway" : routing.gateway.mode === "direct" ? "direct" : "misconfigured",
    profiles: Object.values(PRODUCT_PROFILES)
      .filter((profile) => profile.userFacing)
      .map((profile) => {
        try {
          const resolution = resolveProfile(profile.id, { externalProvidersEnabled: routing.externalProvidersEnabled })

          return {
            id: profile.id,
            label: profile.label,
            dataHandling: profile.dataHandling,
            available: true,
            model: describeModel(resolution.primary),
            ...(resolution.fallback ? { fallbackModel: describeModel(resolution.fallback) } : {})
          }
        } catch (error) {
          return {
            id: profile.id,
            label: profile.label,
            dataHandling: profile.dataHandling,
            available: false,
            unavailableReason: error instanceof ModelError ? error.message : `${profile.label} is unavailable.`
          }
        }
      })
  }
}

function describeModel(entry: ModelRegistryEntry) {
  return {
    id: entry.id,
    displayName: entry.displayName,
    version: entry.version,
    provider: entry.provider,
    privacyClass: entry.privacyClass
  }
}
