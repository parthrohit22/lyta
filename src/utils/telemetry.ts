/**
 * Content-free operational telemetry suitable for aggregation at the edge.
 * Every field is metadata: route, profile, provider, model id, an opaque
 * workspace tag, timing, counts, and a normalized error code. Prompt,
 * response, file text, credentials, and raw workspace or user ids never
 * appear here, which tests/unit/ai-gateway.test.ts checks.
 */
export function recordOperation(input: {
  route: string
  outcome: "allowed" | "limited" | "failure"
  durationMs: number
  units: number
  model?: string
  modelVersion?: string
  timedOut?: boolean
  usedFallback?: boolean
  retryCount?: number
  profile?: string
  provider?: string
  workspace?: string
  viaGateway?: boolean
  errorCode?: string
  estimatedCostUsd?: number
}) {
  console.log(
    "[lyta-operation]",
    JSON.stringify({
      route: input.route,
      outcome: input.outcome,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      requestCount: 1,
      estimatedSpendUnits: Math.max(0, Math.round(input.units)),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelVersion ? { modelVersion: input.modelVersion } : {}),
      ...(input.timedOut ? { timedOut: true } : {}),
      ...(input.usedFallback ? { usedFallback: true } : {}),
      ...(input.retryCount ? { retryCount: input.retryCount } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.viaGateway ? { viaGateway: true } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(typeof input.estimatedCostUsd === "number" && Number.isFinite(input.estimatedCostUsd)
        ? { estimatedCostUsd: Math.max(0, input.estimatedCostUsd) }
        : {})
    })
  )
}
