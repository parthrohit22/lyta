import assert from "node:assert/strict"
import { test } from "node:test"
import { callWithPolicy, runAI, runAIStream } from "../../src/services/ai"
import type { ModelProfile } from "../../src/config/modelProfiles"

function testProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    model: "primary-model",
    modelVersion: "test-version",
    fallbackModel: "fallback-model",
    timeoutMs: 30,
    maxRetries: 1,
    temperature: 0.5,
    top_p: 0.9,
    max_tokens: 100,
    targets: { latencyMsP50: 1, latencyMsP95: 2, estimatedCostPerRequestUsd: 0.001, qualityNotes: "test" },
    ...overrides
  }
}

function never<T>(): Promise<T> {
  return new Promise(() => {})
}

test("a successful first call uses the primary model with no retry", async () => {
  const calls: string[] = []

  const result = await callWithPolicy("test.route", testProfile(), async (model) => {
    calls.push(model)
    return "ok"
  })

  assert.equal(result, "ok")
  assert.deepEqual(calls, ["primary-model"])
})

test("a primary failure followed by success retries on the same model", async () => {
  const calls: string[] = []
  let attempt = 0

  const result = await callWithPolicy("test.route", testProfile(), async (model) => {
    calls.push(model)
    attempt += 1
    if (attempt === 1) throw new Error("transient failure")
    return "recovered"
  })

  assert.equal(result, "recovered")
  assert.deepEqual(calls, ["primary-model", "primary-model"])
})

test("a call that never resolves within timeoutMs is treated as a failure and retried", async () => {
  const calls: string[] = []
  let attempt = 0

  const result = await callWithPolicy("test.route", testProfile({ timeoutMs: 15 }), async (model) => {
    calls.push(model)
    attempt += 1
    if (attempt === 1) return never<string>()
    return "recovered after timeout"
  })

  assert.equal(result, "recovered after timeout")
  assert.equal(calls.length, 2)
})

test("exhausting primary retries falls back to the configured fallback model once", async () => {
  const calls: string[] = []

  const result = await callWithPolicy("test.route", testProfile(), async (model) => {
    calls.push(model)
    if (model === "primary-model") throw new Error("primary down")
    return "fallback reply"
  })

  assert.equal(result, "fallback reply")
  assert.deepEqual(calls, ["primary-model", "primary-model", "fallback-model"])
})

test("primary and fallback both failing surfaces the last error", async () => {
  await assert.rejects(
    callWithPolicy("test.route", testProfile({ maxRetries: 0 }), async () => {
      throw new Error("everything is down")
    }),
    /everything is down/
  )
})

test("no fallback model configured means only the retry budget is spent before failing", async () => {
  const calls: string[] = []

  await assert.rejects(
    callWithPolicy("test.route", testProfile({ fallbackModel: undefined, maxRetries: 2 }), async (model) => {
      calls.push(model)
      throw new Error("down")
    }),
    /down/
  )

  assert.deepEqual(calls, ["primary-model", "primary-model", "primary-model"])
})

test("runAI resolves the instant profile and returns a successful response", async () => {
  const calls: string[] = []
  const env = {
    AI: {
      run: async (model: string) => {
        calls.push(model)
        return { response: "ok" }
      }
    }
  }

  const result = await runAI(env, [{ role: "user", content: "hi" }], { mode: "instant" })

  assert.equal(result.response, "ok")
  assert.equal(calls.length, 1)
})

test("runAI wraps a total failure as a profile-named ModelError", async () => {
  const env = {
    AI: {
      run: async () => {
        throw new Error("down")
      }
    }
  }

  await assert.rejects(runAI(env, [{ role: "user", content: "hi" }], { mode: "instant" }), /Instant model request failed \(upstream\)\./)
})

test("runAIStream applies policy only to obtaining the stream, and rejects a non-stream result", async () => {
  const env = { AI: { run: async () => ({ response: "not a stream" }) } }

  await assert.rejects(
    runAIStream(env, [{ role: "user", content: "hi" }], { mode: "instant" }),
    /Instant model request failed \(upstream\)\./
  )
})

test("runAIStream returns the stream once env.AI.run resolves it", async () => {
  const calls: Array<Record<string, unknown>> = []
  const env = {
    AI: {
      run: async (_model: string, input: Record<string, unknown>) => {
        calls.push(input)
        return new ReadableStream()
      }
    }
  }

  const stream = await runAIStream(env, [{ role: "user", content: "hi" }], { mode: "deep" })

  assert.ok(stream instanceof ReadableStream)
  assert.equal(calls[0].stream, true)
})
