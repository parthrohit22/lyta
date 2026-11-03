import { workspaceTag } from "../ai/gateway"
import { createModelRouting, type ModelEnv } from "../ai/providers"
import { resolveProfile } from "../ai/registry"
import { toModelProfile } from "../config/modelProfiles"
import { callWithPolicy } from "./ai"

/**
 * Embeds one text with the `embedding` profile's model (registry-selected,
 * gateway-routed when configured). That profile never falls back: vectors
 * from another model would not be comparable with the ones already stored.
 */
export async function createEmbedding(env: ModelEnv, text: string, options: { workspaceKey?: string; route?: string } = {}) {
  try {
    const routing = createModelRouting(env)
    const resolution = resolveProfile("embedding", { externalProvidersEnabled: routing.externalProvidersEnabled })
    const entry = resolution.primary
    const route = options.route || "ai.embedding"
    const attribution = { profile: "embedding" as const, route, workspace: await workspaceTag(options.workspaceKey) }
    let calls = 0

    const [vector] = await callWithPolicy(
      route,
      toModelProfile(resolution),
      () =>
        routing.provider(entry.provider).embed({
          entry,
          texts: [text],
          timeoutMs: resolution.profile.policy.timeoutMs,
          attribution,
          attempt: calls++ === 0 ? "primary" : "retry"
        }),
      {
        telemetry: {
          profile: "embedding",
          workspace: attribution.workspace,
          viaGateway: routing.gateway.mode === "gateway",
          describe: () => ({ provider: entry.provider, estimatedCostUsd: entry.cost.estimatedCostPerRequestUsd })
        }
      }
    )

    return vector
  } catch (error) {
    throw new Error("Embedding request failed.", {
      cause: error
    })
  }
}
