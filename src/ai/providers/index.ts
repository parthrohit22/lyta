import type { Env } from "../../index"
import { readGatewayConfig, type GatewayConfig } from "../gateway"
import type { ModelProvider } from "../provider"
import type { ProviderId } from "../types"
import { createGatewayExternalProvider } from "./gatewayExternal"
import { createWorkersAiProvider } from "./workersAi"

export type ModelEnv = Pick<Env, "AI"> &
  Partial<Pick<Env, "AI_GATEWAY_ID" | "AI_GATEWAY_REQUIRED" | "AI_EXTERNAL_PROVIDERS" | "AI_EXTERNAL_PROVIDER_KEY">>

export interface ModelRouting {
  gateway: GatewayConfig
  /** External adapters run only behind a gateway and only when explicitly enabled. */
  externalProvidersEnabled: boolean
  provider(id: ProviderId): ModelProvider
}

export function createModelRouting(env: ModelEnv): ModelRouting {
  const gateway = readGatewayConfig(env)
  const externalProvidersEnabled = env.AI_EXTERNAL_PROVIDERS === "enabled" && gateway.mode === "gateway"
  const providers: Partial<Record<ProviderId, ModelProvider>> = {}

  return {
    gateway,
    externalProvidersEnabled,
    provider(id) {
      providers[id] ??=
        id === "workers-ai"
          ? createWorkersAiProvider(env.AI, gateway)
          : createGatewayExternalProvider(env.AI, gateway, env.AI_EXTERNAL_PROVIDER_KEY || undefined)

      return providers[id]!
    }
  }
}
