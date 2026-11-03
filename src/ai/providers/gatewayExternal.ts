import type { WorkersAI } from "../../index"
import { buildGatewayOptions, type GatewayConfig } from "../gateway"
import { parseStructuredText, type ChatCallRequest, type ModelProvider } from "../provider"
import { ModelError, normalizeModelError } from "../types"

/**
 * External providers reached only through AI Gateway's universal endpoint
 * (`env.AI.gateway(id).run(...)`), using the OpenAI-compatible
 * `chat/completions` shape. Registry model ids are `<provider>/<model>`, e.g.
 * `openai/gpt-4o-mini`.
 *
 * Disabled by default and gated three ways (see src/ai/registry.ts and
 * docs/runbooks/provider-change.md). It has only been exercised against a
 * mocked gateway. No real external call has been made from this code.
 *
 * Credentials: prefer keys stored in the gateway (BYOK), in which case
 * `providerKey` is undefined and no key ever enters the Worker. Otherwise the
 * key comes from the `AI_EXTERNAL_PROVIDER_KEY` Worker secret. It is sent only
 * to the gateway and is never logged or persisted.
 */
export function createGatewayExternalProvider(binding: WorkersAI, gateway: GatewayConfig, providerKey?: string): ModelProvider {
  function target(request: ChatCallRequest) {
    const [provider, ...rest] = request.entry.model.split("/")
    return { provider, model: rest.join("/") }
  }

  async function send(request: ChatCallRequest, extra: Record<string, unknown>) {
    if (gateway.mode !== "gateway" || !binding.gateway) {
      throw new ModelError("not_configured", "External models require a configured AI Gateway.", {
        provider: "gateway-external",
        model: request.entry.model
      })
    }

    const { provider, model } = target(request)
    const { id: _id, ...gatewayOptions } = buildGatewayOptions(
      gateway.id,
      request.attribution,
      { timeoutMs: request.timeoutMs },
      request.attempt
    )

    let response: Response

    try {
      response = await binding.gateway(gateway.id).run(
        {
          provider,
          endpoint: "chat/completions",
          headers: {
            "Content-Type": "application/json",
            ...(providerKey ? { Authorization: `Bearer ${providerKey}` } : {})
          },
          query: {
            model,
            messages: request.messages,
            temperature: request.temperature,
            top_p: request.top_p,
            max_tokens: request.max_tokens,
            ...extra
          }
        },
        { gateway: gatewayOptions }
      )
    } catch (error) {
      throw normalizeModelError(error, { provider: "gateway-external", model: request.entry.model })
    }

    if (!response.ok) {
      // Only the status is kept. Provider error bodies can echo the prompt.
      throw normalizeModelError(Object.assign(new Error(`Gateway returned HTTP ${response.status}.`), { status: response.status }), {
        provider: "gateway-external",
        model: request.entry.model
      })
    }

    return response
  }

  async function chat(request: ChatCallRequest, extra: Record<string, unknown> = {}) {
    const response = await send(request, extra)
    const body = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null
    const content = body?.choices?.[0]?.message?.content

    return { text: typeof content === "string" ? content : "" }
  }

  return {
    id: "gateway-external",
    chat: (request) => chat(request),
    async stream(request) {
      const response = await send(request, { stream: true })

      if (!response.body) {
        throw new ModelError("upstream", "Gateway stream had no body.", { provider: "gateway-external", model: request.entry.model })
      }

      return response.body.pipeThrough(openAiSseToLytaSse())
    },
    async structured(request, validate) {
      const extra = request.entry.capabilities.structuredOutput === "native" ? { response_format: { type: "json_object" } } : {}
      const { text } = await chat(request, extra)
      return parseStructuredText(text, validate, { provider: "gateway-external", model: request.entry.model })
    },
    async embed(request) {
      throw new ModelError("not_configured", "No external embedding model is approved.", {
        provider: "gateway-external",
        model: request.entry.model
      })
    }
  }
}

/** Rewrites OpenAI-style `choices[0].delta.content` SSE into the `{"response": …}` events the rest of LYTA reads. */
export function openAiSseToLytaSse(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  function emit(controller: TransformStreamDefaultController<Uint8Array>, events: string[]) {
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue

        const payload = line.slice(5).trim()

        if (payload === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          continue
        }

        try {
          const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
          const text = parsed.choices?.[0]?.delta?.content

          if (typeof text === "string" && text) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`))
          }
        } catch {}
      }
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const events = buffer.split("\n\n")
      buffer = events.pop() || ""
      emit(controller, events)
    },
    flush(controller) {
      buffer += decoder.decode()
      emit(controller, [buffer])
    }
  })
}
