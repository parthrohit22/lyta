import type { WorkersAI, WorkersAIRunOptions } from "../../index"
import { buildGatewayOptions, type GatewayConfig, assertGatewayUsable } from "../gateway"
import { isReadableStream, parseStructuredText, type ChatCallRequest, type EmbedCallRequest, type ModelProvider } from "../provider"
import { ModelError, normalizeModelError } from "../types"

/**
 * Workers AI through the `AI` binding. With a gateway configured every call
 * carries the binding's `gateway` option; in direct mode the call is exactly
 * `env.AI.run(model, input)`, the same two-argument call LYTA made before the
 * registry existed.
 */
export function createWorkersAiProvider(binding: WorkersAI, gateway: GatewayConfig): ModelProvider {
  async function run(request: ChatCallRequest | EmbedCallRequest, input: Record<string, unknown>) {
    assertGatewayUsable(gateway)

    const options: WorkersAIRunOptions | undefined =
      gateway.mode === "gateway"
        ? { gateway: buildGatewayOptions(gateway.id, request.attribution, { timeoutMs: request.timeoutMs }, request.attempt) }
        : undefined

    try {
      return options ? await binding.run(request.entry.model, input, options) : await binding.run(request.entry.model, input)
    } catch (error) {
      throw normalizeModelError(error, { provider: "workers-ai", model: request.entry.model })
    }
  }

  function chatInput(request: ChatCallRequest) {
    return {
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens
    }
  }

  async function chat(request: ChatCallRequest) {
    const result = await run(request, chatInput(request))
    const response = result && typeof result === "object" ? (result as { response?: unknown }).response : undefined

    // JSON-mode replies arrive as an already-parsed object.
    return { text: typeof response === "string" ? response : response && typeof response === "object" ? JSON.stringify(response) : "" }
  }

  return {
    id: "workers-ai",
    chat,
    async stream(request) {
      const result = await run(request, { ...chatInput(request), stream: true })

      if (!isReadableStream(result)) {
        throw new ModelError("upstream", "Workers AI did not return a readable stream.", {
          provider: "workers-ai",
          model: request.entry.model
        })
      }

      return result
    },
    async structured(request, validate) {
      const { text } = await chat(request)
      return parseStructuredText(text, validate, { provider: "workers-ai", model: request.entry.model })
    },
    async embed(request) {
      const result = (await run(request, { text: request.texts.length === 1 ? request.texts[0] : request.texts })) as { data?: unknown }
      const rows = Array.isArray(result?.data) ? result.data : []
      const vectors = rows.map((row) => (Array.isArray(row) ? row.filter(isFiniteNumber) : []))

      if (vectors.length !== request.texts.length || vectors.some((vector) => !vector.length)) {
        throw new ModelError("invalid_output", "Embedding response did not include a vector.", {
          provider: "workers-ai",
          model: request.entry.model
        })
      }

      return vectors
    }
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
