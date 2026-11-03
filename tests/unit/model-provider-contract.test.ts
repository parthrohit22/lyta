import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { WorkersAI } from "../../src/index"
import type { GatewayConfig } from "../../src/ai/gateway"
import { parseStructuredText, type ChatCallRequest, type EmbedCallRequest, type ModelProvider } from "../../src/ai/provider"
import { createGatewayExternalProvider } from "../../src/ai/providers/gatewayExternal"
import { createWorkersAiProvider } from "../../src/ai/providers/workersAi"
import { findRegistryEntry } from "../../src/ai/registry"
import { ModelError, normalizeModelError, type ModelErrorCode } from "../../src/ai/types"

// One structured contract, run against a mocked provider and every adapter
// (Workers AI direct, Workers AI through AI Gateway, and the disabled-by-
// default external provider through a mocked AI Gateway). Each harness turns
// the same scripted outcome into that adapter's real wire format.

const SECRET_PROMPT = "TOP-SECRET-PROMPT-TEXT"

type FailureKind = "rate_limited" | "unavailable" | "billing_limit"

interface Script {
  text?: string
  streamParts?: string[]
  vectors?: number[][]
  failure?: FailureKind
}

interface Harness {
  name: string
  provider: ModelProvider
  model: string
  embeddings: boolean
  script(next: Script): void
}

interface ReviewOutput {
  summary: string
  findings: Array<{ title: string; severity: "low" | "medium" | "high"; evidence: string[] }>
}

function validateReview(value: unknown): ReviewOutput | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<ReviewOutput>
  if (typeof candidate.summary !== "string" || !Array.isArray(candidate.findings)) return null

  const valid = candidate.findings.every(
    (finding) =>
      finding &&
      typeof finding.title === "string" &&
      ["low", "medium", "high"].includes(finding.severity) &&
      Array.isArray(finding.evidence) &&
      finding.evidence.every((ref) => typeof ref === "string")
  )

  return valid ? (candidate as ReviewOutput) : null
}

const REVIEW: ReviewOutput = {
  summary: "Moving sessions to Durable Objects removes the shared cache.",
  findings: [{ title: "Cold-start latency", severity: "medium", evidence: ["E1"] }]
}

const encoder = new TextEncoder()

function sse(events: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    }
  })
}

async function readText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let raw = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
  }

  const text = raw
    .split("\n\n")
    .map((event) => event.replace(/^data: /, "").trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => (JSON.parse(payload) as { response: string }).response)
    .join("")

  return { text, done: raw.includes("data: [DONE]") }
}

function workersAiBinding(state: { script: Script }): WorkersAI {
  return {
    async run(_model, input) {
      const { script } = state
      const body = input as { stream?: boolean; text?: unknown }

      if (script.failure === "rate_limited")
        throw Object.assign(new Error("3040: Capacity temporarily exceeded, rate limit"), { status: 429 })
      if (script.failure === "unavailable") throw new Error("5007: model is temporarily unavailable")
      if (script.failure === "billing_limit") throw new Error("4006: you have used up your daily free allocation of 10,000 neurons")

      if (body.stream) {
        return sse([...(script.streamParts || []).map((part) => `data: ${JSON.stringify({ response: part })}\n\n`), "data: [DONE]\n\n"])
      }

      if (body.text !== undefined) return { shape: [1, 3], data: script.vectors || [] }

      return script.text === undefined ? {} : { response: script.text }
    }
  }
}

function externalGatewayBinding(state: { script: Script }): WorkersAI {
  const status: Record<FailureKind, number> = { rate_limited: 429, unavailable: 503, billing_limit: 402 }

  return {
    async run() {
      throw new Error("the external adapter must not call env.AI.run")
    },
    gateway() {
      return {
        async run(request) {
          const { script } = state
          const query = (request as { query: { stream?: boolean } }).query

          if (script.failure) {
            // Provider error bodies can echo the prompt; the adapter must drop them.
            return new Response(`error near: ${SECRET_PROMPT}`, { status: status[script.failure] })
          }

          if (query.stream) {
            return new Response(
              sse([
                ...(script.streamParts || []).map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`),
                "data: [DONE]\n\n"
              ])
            )
          }

          return Response.json({ choices: [{ message: { content: script.text ?? null } }] })
        }
      }
    }
  }
}

/** A provider written directly against the interface, the reference the adapters must match. */
function mockProvider(state: { script: Script }): ModelProvider {
  const fail = () => {
    const code: ModelErrorCode = state.script.failure!
    throw new ModelError(code, `Model call failed (${code}).`, { provider: "workers-ai", model: "mock" })
  }

  return {
    id: "workers-ai",
    async chat() {
      if (state.script.failure) fail()
      return { text: state.script.text ?? "" }
    },
    async stream() {
      if (state.script.failure) fail()
      return sse([...(state.script.streamParts || []).map((part) => `data: ${JSON.stringify({ response: part })}\n\n`), "data: [DONE]\n\n"])
    },
    async structured(_request, validate) {
      if (state.script.failure) fail()
      return parseStructuredText(state.script.text ?? "", validate, { provider: "workers-ai", model: "mock" })
    },
    async embed() {
      if (state.script.failure) fail()
      return state.script.vectors || []
    }
  }
}

const directGateway: GatewayConfig = { mode: "direct" }
const testGateway: GatewayConfig = { mode: "gateway", id: "lyta-test" }

function harness(name: string, model: string, embeddings: boolean, build: (state: { script: Script }) => ModelProvider): Harness {
  const state = { script: {} as Script }
  return { name, model, embeddings, provider: build(state), script: (next) => (state.script = next) }
}

const harnesses: Harness[] = [
  harness("mock provider", "workers-ai/llama-4-scout-17b-16e-instruct", true, mockProvider),
  harness("Workers AI adapter (direct)", "workers-ai/llama-4-scout-17b-16e-instruct", true, (state) =>
    createWorkersAiProvider(workersAiBinding(state), directGateway)
  ),
  harness("Workers AI adapter (through AI Gateway)", "workers-ai/llama-4-scout-17b-16e-instruct", true, (state) =>
    createWorkersAiProvider(workersAiBinding(state), testGateway)
  ),
  harness("external adapter (mocked AI Gateway)", "gateway-external/openai-gpt-4o-mini", false, (state) =>
    createGatewayExternalProvider(externalGatewayBinding(state), testGateway)
  )
]

function chatRequest(model: string): ChatCallRequest {
  return {
    entry: findRegistryEntry(model)!,
    messages: [{ role: "user", content: SECRET_PROMPT }],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 200,
    timeoutMs: 1_000,
    attribution: { profile: "deep-review", route: "test.contract" },
    attempt: "primary"
  }
}

function embedRequest(): EmbedCallRequest {
  return {
    entry: findRegistryEntry("workers-ai/bge-base-en-v1.5")!,
    texts: ["hello"],
    timeoutMs: 1_000,
    attribution: { profile: "embedding", route: "test.contract" },
    attempt: "primary"
  }
}

function assertModelError(code: ModelErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof ModelError, `expected a ModelError, got ${String(error)}`)
    assert.equal(error.code, code)
    assert.ok(!error.message.includes(SECRET_PROMPT), "error messages must not carry provider payloads")
    return true
  }
}

for (const subject of harnesses) {
  describe(`model provider contract: ${subject.name}`, () => {
    test("chat returns the reply text", async () => {
      subject.script({ text: "Use a canary." })
      assert.deepEqual(await subject.provider.chat(chatRequest(subject.model)), { text: "Use a canary." })
    })

    test("chat with no reply returns an empty string, not undefined", async () => {
      subject.script({})
      assert.deepEqual(await subject.provider.chat(chatRequest(subject.model)), { text: "" })
    })

    test("stream yields LYTA-format SSE ending in [DONE]", async () => {
      subject.script({ streamParts: ["Hello ", "world."] })
      assert.deepEqual(await readText(await subject.provider.stream(chatRequest(subject.model))), { text: "Hello world.", done: true })
    })

    test("structured output returns the validated review", async () => {
      subject.script({ text: "```json\n" + JSON.stringify(REVIEW) + "\n```" })
      assert.deepEqual(await subject.provider.structured(chatRequest(subject.model), validateReview), REVIEW)
    })

    test("structured output that fails validation is invalid_output", async () => {
      subject.script({ text: JSON.stringify({ summary: "x", findings: [{ title: "t", severity: "critical", evidence: [] }] }) })
      await assert.rejects(subject.provider.structured(chatRequest(subject.model), validateReview), assertModelError("invalid_output"))

      subject.script({ text: "I could not produce JSON." })
      await assert.rejects(subject.provider.structured(chatRequest(subject.model), validateReview), assertModelError("invalid_output"))
    })

    for (const failure of ["rate_limited", "unavailable", "billing_limit"] as const) {
      test(`a provider ${failure.replace("_", " ")} failure is normalized to ${failure}`, async () => {
        subject.script({ failure })
        await assert.rejects(subject.provider.chat(chatRequest(subject.model)), assertModelError(failure))
        await assert.rejects(subject.provider.stream(chatRequest(subject.model)), assertModelError(failure))
      })
    }

    test(subject.embeddings ? "embed returns one vector per text" : "embed is refused when no embedding model is approved", async () => {
      subject.script({ vectors: [[0.1, 0.2, 0.3]] })

      if (subject.embeddings) {
        assert.deepEqual(await subject.provider.embed(embedRequest()), [[0.1, 0.2, 0.3]])
      } else {
        await assert.rejects(subject.provider.embed(embedRequest()), assertModelError("not_configured"))
      }
    })
  })
}

test("the external adapter refuses to run without a configured gateway", async () => {
  const provider = createGatewayExternalProvider(externalGatewayBinding({ script: { text: "hi" } }), directGateway)

  await assert.rejects(provider.chat(chatRequest("gateway-external/openai-gpt-4o-mini")), assertModelError("not_configured"))
})

test("the external adapter sends gateway policy and the key only to the gateway, and asks for native JSON", async () => {
  const seen: Array<{ request: any; options: any }> = []
  const binding: WorkersAI = {
    run: async () => ({}),
    gateway: (id) => {
      assert.equal(id, "lyta-test")
      return {
        run: async (request, options) => {
          seen.push({ request, options })
          return Response.json({ choices: [{ message: { content: JSON.stringify(REVIEW) } }] })
        }
      }
    }
  }
  const provider = createGatewayExternalProvider(binding, testGateway, "sk-test-not-real")

  await provider.structured(chatRequest("gateway-external/openai-gpt-4o-mini"), validateReview)

  const [{ request, options }] = seen
  assert.equal(request.provider, "openai")
  assert.equal(request.endpoint, "chat/completions")
  assert.equal(request.query.model, "gpt-4o-mini")
  assert.deepEqual(request.query.response_format, { type: "json_object" })
  assert.equal(request.headers.Authorization, "Bearer sk-test-not-real")
  assert.equal(options.gateway.collectLog, false)
  assert.equal(options.gateway.skipCache, true)
  assert.deepEqual(options.gateway.metadata, {
    profile: "deep-review",
    route: "test.contract",
    workspace: "unattributed",
    attempt: "primary"
  })
})

test("normalizeModelError maps timeouts, cancellations and unknown failures", () => {
  assert.equal(normalizeModelError(new Error("Model call timed out after 10ms.")).code, "timeout")
  assert.equal(normalizeModelError(Object.assign(new Error("x"), { name: "AbortError" })).code, "cancelled")
  assert.equal(normalizeModelError(new Error("something odd")).code, "upstream")
  assert.equal(normalizeModelError("weird").retryable, true)
  assert.equal(normalizeModelError(new ModelError("invalid_output", "bad")).retryable, false)
})
