import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { Env, WorkersAIRunOptions } from "../../src/index"
import { readGatewayConfig, withModelGateway, workspaceTag } from "../../src/ai/gateway"
import { ModelError } from "../../src/ai/types"
import { describeModelFailure, runAI, runAIStreamWithMetadata, runStructured } from "../../src/services/ai"
import { createEmbedding } from "../../src/services/embeddings"
import { router } from "../../src/router"

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url))
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct"
const LLAMA_8B = "@cf/meta/llama-3.1-8b-instruct"
const BGE = "@cf/baai/bge-base-en-v1.5"

interface Call {
  model: string
  input: any
  options?: WorkersAIRunOptions
  argCount: number
}

function recordingAI(respond: (model: string, input: any) => unknown = () => ({ response: "ok" })) {
  const calls: Call[] = []

  return {
    calls,
    AI: {
      async run(model: string, input: unknown, ...rest: [WorkersAIRunOptions?]) {
        calls.push({ model, input, options: rest[0], argCount: 1 + 1 + rest.length })
        return respond(model, input)
      }
    }
  }
}

async function captureLogs<T>(work: () => Promise<T>) {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }

  try {
    const result = await work().catch((error) => error)
    return { result, lines }
  } finally {
    console.log = original
  }
}

test("direct mode (no AI_GATEWAY_ID) calls Workers AI exactly as before: two arguments, no gateway option", async () => {
  const ai = recordingAI()

  await runAI({ AI: ai.AI }, [{ role: "user", content: "hi" }], { mode: "instant" })
  await createEmbedding({ AI: recordingAI(() => ({ data: [[0.1]] })).AI }, "text")

  assert.equal(ai.calls[0].argCount, 2)
  assert.equal(ai.calls[0].options, undefined)
})

test("with AI_GATEWAY_ID every chat attempt carries the profile's gateway policy and content-free attribution", async () => {
  const ai = recordingAI()

  await runAI({ AI: ai.AI, AI_GATEWAY_ID: "lyta-prod" }, [{ role: "user", content: "hi" }], {
    mode: "deep",
    route: "ai.chat",
    workspaceKey: "user-raw-workspace-key"
  })

  const gateway = ai.calls[0].options?.gateway
  assert.ok(gateway)
  assert.equal(gateway.id, "lyta-prod")
  assert.equal(gateway.collectLog, false, "prompt/response logging stays off")
  assert.equal(gateway.skipCache, true, "responses are never cached")
  assert.equal(gateway.requestTimeoutMs, 25_000, "Deep Review timeout")
  assert.deepEqual(gateway.retries, { maxAttempts: 1 })
  assert.equal(gateway.metadata?.profile, "deep-review")
  assert.equal(gateway.metadata?.route, "ai.chat")
  assert.equal(gateway.metadata?.attempt, "primary")
  assert.match(String(gateway.metadata?.workspace), /^ws_[0-9a-f]{12}$/)
  assert.ok(!JSON.stringify(gateway).includes("user-raw-workspace-key"))
})

test("embeddings go through the gateway too, under the embedding profile", async () => {
  const ai = recordingAI(() => ({ data: [[0.1, 0.2]] }))

  const vector = await createEmbedding({ AI: ai.AI, AI_GATEWAY_ID: "lyta-prod" }, "some text", { workspaceKey: "w1" })

  assert.deepEqual(vector, [0.1, 0.2])
  assert.equal(ai.calls[0].model, BGE)
  assert.equal(ai.calls[0].options?.gateway?.metadata?.profile, "embedding")
})

test("retries and fallback stay in the Worker and are labelled per attempt", async () => {
  const ai = recordingAI((model) => {
    if (model === SCOUT) throw new Error("5007: model unavailable")
    return { response: "from fallback" }
  })

  const result = await runAI({ AI: ai.AI, AI_GATEWAY_ID: "lyta-prod" }, [{ role: "user", content: "hi" }], { mode: "instant" })

  assert.equal(result.response, "from fallback")
  assert.deepEqual(
    ai.calls.map((call) => [call.model, call.options?.gateway?.metadata?.attempt]),
    [
      [SCOUT, "primary"],
      [SCOUT, "retry"],
      [LLAMA_8B, "fallback"]
    ]
  )
  assert.equal(result.model.usedFallback, true)
  assert.equal(result.model.model, "workers-ai/llama-3.1-8b-instruct")
  assert.equal(result.model.profileLabel, "Instant")
  assert.equal(result.model.viaGateway, true)
})

test("an image request whose vision model is down fails transparently instead of falling back to a text-only model", async () => {
  const ai = recordingAI(() => {
    throw new Error("5007: model unavailable")
  })
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "What does this diagram show?" },
        { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } }
      ]
    }
  ]

  const error = await runAI({ AI: ai.AI }, messages, { mode: "instant" }).catch((caught) => caught)

  assert.ok(error instanceof ModelError)
  assert.equal(error.code, "unavailable")
  assert.ok(
    ai.calls.every((call) => call.model === SCOUT),
    "never sent to the text-only fallback"
  )
  assert.deepEqual(describeModelFailure(error), {
    code: "unavailable",
    retryable: true,
    profile: "instant",
    message: "Instant is unavailable right now. Please retry."
  })
})

test("Visual Review with no compatible model configured says so instead of answering", async () => {
  const ai = recordingAI()

  // The only vision-capable model is ruled out by a context requirement it can't meet.
  const huge = "x".repeat(600_000)
  const error = await runAI({ AI: ai.AI }, [{ role: "user", content: huge }], { profile: "visual-review" }).catch((caught) => caught)

  assert.ok(error instanceof ModelError)
  assert.equal(error.code, "no_compatible_model")
  assert.equal(ai.calls.length, 0)
  assert.match(describeModelFailure(error).message, /^Visual Review is unavailable: .*LYTA did not substitute a model that lacks it\.$/)
})

test("a cancelled call stops immediately and is not retried or sent to the fallback", async () => {
  const controller = new AbortController()
  const ai = recordingAI(() => {
    controller.abort()
    return new Promise(() => {})
  })

  const error = await runAI({ AI: ai.AI }, [{ role: "user", content: "hi" }], { mode: "instant", signal: controller.signal }).catch(
    (caught) => caught
  )

  assert.ok(error instanceof ModelError)
  assert.equal(error.code, "cancelled")
  assert.equal(ai.calls.length, 1)
})

test("a billing-limit failure is not retried or sent to the fallback, and says so plainly", async () => {
  const ai = recordingAI(() => {
    throw new Error("4006: you have used up your daily free allocation of 10,000 neurons")
  })

  const error = await runAI({ AI: ai.AI }, [{ role: "user", content: "hi" }], { mode: "deep" }).catch((caught) => caught)

  assert.equal(error.code, "billing_limit")
  assert.equal(ai.calls.length, 1)
  assert.equal(describeModelFailure(error).message, "Deep Review has reached its usage limit for now. Please retry later.")
})

test("structured output retries an unusable reply and then returns the validated value", async () => {
  let attempt = 0
  const ai = recordingAI(() => ({ response: attempt++ === 0 ? "not json" : '{"verdict":"ok"}' }))

  const result = await runStructured(
    { AI: ai.AI },
    [{ role: "user", content: "review" }],
    (value) =>
      value && typeof value === "object" && (value as { verdict?: unknown }).verdict === "ok" ? (value as { verdict: string }) : null,
    { profile: "deep-review" }
  )

  assert.deepEqual(result.value, { verdict: "ok" })
  assert.equal(result.model.profile, "deep-review")
  assert.equal(ai.calls.length, 2)
})

test("streaming returns the stream plus the serving model's metadata", async () => {
  const ai = recordingAI(() => new ReadableStream())

  const { stream, model } = await runAIStreamWithMetadata({ AI: ai.AI }, [{ role: "user", content: "hi" }], { mode: "deep" })

  assert.ok(stream instanceof ReadableStream)
  assert.equal(ai.calls[0].input.stream, true)
  assert.deepEqual(
    { profile: model.profile, label: model.profileLabel, usedFallback: model.usedFallback, viaGateway: model.viaGateway },
    { profile: "deep-review", label: "Deep Review", usedFallback: false, viaGateway: false }
  )
})

test("AI_GATEWAY_REQUIRED without an id fails closed for chat, streaming and embeddings", async () => {
  const ai = recordingAI(() => ({ response: "should not run", data: [[1]] }))
  const env = { AI: ai.AI, AI_GATEWAY_REQUIRED: "true" }

  const chatError = await runAI(env, [{ role: "user", content: "hi" }]).catch((caught) => caught)
  const streamError = await runAIStreamWithMetadata(env, [{ role: "user", content: "hi" }]).catch((caught) => caught)
  const embedError = await createEmbedding(env, "text").catch((caught) => caught)

  assert.equal(chatError.code, "not_configured")
  assert.equal(streamError.code, "not_configured")
  assert.equal(embedError.cause.code, "not_configured")
  assert.equal(ai.calls.length, 0)
  assert.equal(describeModelFailure(chatError).message, "Model routing is misconfigured. An operator needs to fix it before this can run.")
})

test("gateway configuration is validated", () => {
  assert.deepEqual(readGatewayConfig({}), { mode: "direct" })
  assert.deepEqual(readGatewayConfig({ AI_GATEWAY_ID: " lyta-prod " }), { mode: "gateway", id: "lyta-prod" })
  assert.equal(readGatewayConfig({ AI_GATEWAY_ID: "../../etc" }).mode, "misconfigured")
  assert.equal(readGatewayConfig({ AI_GATEWAY_REQUIRED: "true" }).mode, "misconfigured")
})

test("withModelGateway routes raw env.AI.run callers through the gateway and leaves direct mode untouched", async () => {
  const ai = recordingAI()
  const direct = { AI: ai.AI }

  assert.equal(withModelGateway(direct), direct)

  const wrapped = withModelGateway({ AI: ai.AI, AI_GATEWAY_ID: "lyta-prod" })
  await wrapped.AI.run(SCOUT, { messages: [] })
  await wrapped.AI.run(SCOUT, { messages: [] }, { gateway: { id: "lyta-prod", metadata: { profile: "deep-review" } } })

  assert.equal(ai.calls[0].options?.gateway?.id, "lyta-prod")
  assert.equal(ai.calls[0].options?.gateway?.collectLog, false)
  assert.equal(ai.calls[0].options?.gateway?.skipCache, true)
  assert.deepEqual(ai.calls[1].options?.gateway?.metadata, { profile: "deep-review" }, "an adapter's own options pass through")

  const failClosed = withModelGateway({ AI: ai.AI, AI_GATEWAY_REQUIRED: "true" })
  await assert.rejects(failClosed.AI.run(SCOUT, {}), (error: unknown) => error instanceof ModelError && error.code === "not_configured")
})

test("the Worker entry wraps env with withModelGateway before routing", () => {
  const entry = readFileSync(path.join(SRC_ROOT, "index.ts"), "utf8")
  assert.match(entry, /router\(request, withModelGateway\(env\)\)/)
})

test("per-profile and per-workspace telemetry is metadata only: no prompt, reply, or raw workspace key", async () => {
  const ai = recordingAI(() => ({ response: "TOP-SECRET-REPLY" }))
  const { lines } = await captureLogs(() =>
    runAI({ AI: ai.AI, AI_GATEWAY_ID: "lyta-prod" }, [{ role: "user", content: "TOP-SECRET-PROMPT" }], {
      mode: "deep",
      workspaceKey: "raw-workspace-key-123"
    })
  )
  const operation = lines.find((line) => line.startsWith("[lyta-operation]"))!
  const record = JSON.parse(operation.slice("[lyta-operation] ".length))

  assert.equal(record.profile, "deep-review")
  assert.equal(record.provider, "workers-ai")
  assert.equal(record.viaGateway, true)
  assert.equal(record.workspace, await workspaceTag("raw-workspace-key-123"))
  assert.equal(typeof record.estimatedCostUsd, "number")
  assert.equal(typeof record.durationMs, "number")

  for (const line of lines) {
    assert.ok(!line.includes("TOP-SECRET"), "no prompt or reply text in telemetry")
    assert.ok(!line.includes("raw-workspace-key-123"), "no raw workspace key in telemetry")
  }
})

test("failure telemetry carries the normalized error code", async () => {
  const ai = recordingAI(() => {
    throw Object.assign(new Error("Too Many Requests"), { status: 429 })
  })
  const { lines } = await captureLogs(() => runAI({ AI: ai.AI }, [{ role: "user", content: "hi" }], { mode: "instant" }))
  const failure = lines.map((line) => JSON.parse(line.slice("[lyta-operation] ".length))).find((record) => record.outcome === "failure")

  assert.equal(failure.errorCode, "rate_limited")
  assert.equal(failure.profile, "instant")
})

test("GET /models/profiles names each profile and its data-handling policy, with model identity as metadata and no secrets", async () => {
  const env = { AI: recordingAI().AI, AI_GATEWAY_ID: "lyta-secret-gateway-name", AI_EXTERNAL_PROVIDER_KEY: "sk-test" } as unknown as Env
  const response = await router(new Request("https://lyta.test/models/profiles"), env)
  const text = await response.text()
  const body = JSON.parse(text)

  assert.equal(response.status, 200)
  assert.equal(body.routing, "gateway")
  assert.deepEqual(
    body.profiles.map((profile: { label: string }) => profile.label),
    ["Instant", "Deep Review", "Visual Review"]
  )

  for (const profile of body.profiles) {
    assert.ok(profile.dataHandling.length > 20)
    assert.equal(profile.available, true)
    assert.equal(profile.model.privacyClass, "cloudflare-hosted")
  }

  assert.ok(!text.includes("lyta-secret-gateway-name"))
  assert.ok(!text.includes("sk-test"))
})

function collectFiles(dir: string, extension: string, relativeTo = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = relativeTo ? `${relativeTo}/${entry.name}` : entry.name
    if (entry.isDirectory()) return collectFiles(path.join(dir, entry.name), extension, relativePath)
    return entry.name.endsWith(extension) ? [relativePath] : []
  })
}

// Model calls go through an adapter so they pick up registry selection and the
// gateway. src/router.ts is allowed because the Worker entry hands it an env
// whose AI binding is already gateway-wrapped (withModelGateway), which covers
// route-level calls such as the Architecture Change Review path.
const RAW_MODEL_CALL_ALLOWLIST = new Set(["ai/providers/workersAi.ts", "ai/providers/gatewayExternal.ts", "ai/gateway.ts", "router.ts"])

test("no source file outside the adapters calls the AI binding directly", () => {
  const offenders = collectFiles(SRC_ROOT, ".ts").filter((file) => {
    if (RAW_MODEL_CALL_ALLOWLIST.has(file)) return false
    const code = readFileSync(path.join(SRC_ROOT, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n")
    return /\bAI\.(run|gateway)\(/.test(code)
  })

  assert.deepEqual(offenders, [])
})

test("gateway and provider credentials stay out of browser code, repository config, and Durable Object code", () => {
  const browserFiles = collectFiles(path.join(REPO_ROOT, "pages"), ".js").map((file) => path.join(REPO_ROOT, "pages", file))
  const durableFiles = collectFiles(path.join(SRC_ROOT, "durable"), ".ts").map((file) => path.join(SRC_ROOT, "durable", file))

  for (const file of [...browserFiles, ...durableFiles]) {
    const contents = readFileSync(file, "utf8")
    assert.ok(!/AI_GATEWAY|AI_EXTERNAL_PROVIDER/.test(contents), `${path.relative(REPO_ROOT, file)} must not reference gateway config`)
  }

  const wrangler = readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8")
  assert.ok(!/AI_EXTERNAL_PROVIDER_KEY/.test(wrangler), "provider keys are Worker secrets, never wrangler vars")
})
