import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import worker, { type Env } from "../../src/index"
import { handleEvalRequest } from "../../src/eval/route"
import { createWorkersAiBackend, runEvaluation, scriptedCandidate } from "../../src/eval/runner"
import { MODEL_PROFILES } from "../../src/config/modelProfiles"
import { loadDataset, loadThresholds } from "../../scripts/eval-files"

const TOKEN = "eval-token-0123456789abcdef"

function envWith(run: (model: string, input: unknown) => Promise<unknown>, vars: Partial<Env> = {}) {
  return { AI: { run }, ...vars } as Env
}

const enabled = { LYTA_EVAL_MODE: "enabled", LYTA_EVAL_TOKEN: TOKEN }
const body = {
  model: "@cf/meta/llama-3.1-8b-instruct",
  messages: [
    { role: "system", content: "Return JSON." },
    { role: "user", content: "Review." }
  ],
  temperature: 0.35,
  top_p: 0.85,
  max_tokens: 1800,
  timeoutMs: 1000
}

function request(payload: unknown = body, token = TOKEN, path = "/__eval/complete") {
  return new Request(`http://localhost:8787${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-lyta-eval-token": token },
    body: JSON.stringify(payload)
  })
}

test("eval route: production configuration never enables it", () => {
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")
  assert.doesNotMatch(config, /LYTA_EVAL_MODE|LYTA_EVAL_TOKEN/)
})

test("eval route: disabled unless both the mode and a long token are set, and never calls the model then", async () => {
  const run = async () => {
    throw new Error("the model must not be called")
  }
  assert.equal(await handleEvalRequest(request(), envWith(run)), null)
  assert.equal(await handleEvalRequest(request(), envWith(run, { LYTA_EVAL_MODE: "enabled" })), null)
  assert.equal(await handleEvalRequest(request(), envWith(run, { LYTA_EVAL_MODE: "enabled", LYTA_EVAL_TOKEN: "short" })), null)
  assert.equal(await handleEvalRequest(request(), envWith(run, { LYTA_EVAL_MODE: "true", LYTA_EVAL_TOKEN: TOKEN })), null)
  assert.equal(await handleEvalRequest(new Request("http://localhost/health"), envWith(run, enabled)), null)
})

test("eval route: the Worker entry point serves it only when enabled", async () => {
  const response = await worker.fetch(
    request(),
    envWith(async () => ({ response: "{}" }), enabled)
  )
  assert.equal(response.status, 200)
  assert.equal(((await response.json()) as { response: string }).response, "{}")
})

test("eval route: rejects a wrong token, other paths, and malformed requests", async () => {
  const run = async () => ({ response: "{}" })
  assert.equal((await handleEvalRequest(request(body, "x".repeat(TOKEN.length)), envWith(run, enabled)))!.status, 401)
  assert.equal((await handleEvalRequest(request(body, TOKEN, "/__eval/other"), envWith(run, enabled)))!.status, 404)
  for (const payload of [
    { ...body, model: "openai/gpt-4o-mini" },
    { ...body, messages: [] },
    { ...body, messages: [{ role: "tool", content: "x" }] },
    { ...body, max_tokens: 100_000 },
    { ...body, timeoutMs: 600_000 },
    { ...body, temperature: 5 }
  ]) {
    assert.equal((await handleEvalRequest(request(payload), envWith(run, enabled)))!.status, 400, JSON.stringify(payload).slice(0, 80))
  }
})

test("eval route: runs exactly the requested model with the profile's sampling, without retry or fallback", async () => {
  const calls: Array<{ model: string; input: unknown }> = []
  const response = await handleEvalRequest(
    request(),
    envWith(async (model, input) => {
      calls.push({ model, input })
      return { response: '{"ok":true}' }
    }, enabled)
  )
  const json = (await response!.json()) as { model: string; response: string; latencyMs: number }
  assert.equal(response!.status, 200)
  assert.equal(response!.headers.get("Cache-Control"), "no-store")
  assert.equal(json.model, body.model)
  assert.equal(json.response, '{"ok":true}')
  assert.equal(typeof json.latencyMs, "number")
  assert.deepEqual(calls, [{ model: body.model, input: { messages: body.messages, temperature: 0.35, top_p: 0.85, max_tokens: 1800 } }])
})

test("eval route: reports model errors and timeouts without retrying", async () => {
  let calls = 0
  const failing = await handleEvalRequest(
    request(),
    envWith(async () => {
      calls += 1
      throw new Error("upstream")
    }, enabled)
  )
  assert.equal(((await failing!.json()) as { error: string }).error, "model-error")
  assert.equal(calls, 1)

  const slow = await handleEvalRequest(
    request({ ...body, timeoutMs: 20 }),
    envWith(() => new Promise(() => undefined), enabled)
  )
  assert.equal(((await slow!.json()) as { error: string }).error, "timeout")
})

test("eval route: the workers-ai backend drives the runner through the route", async () => {
  const dataset = loadDataset()
  const fixtures = dataset.fixtures.filter((item) => item.id === "drift-no-drift" || item.id === "acr-no-evidence-retrieved")
  const seen: string[] = []
  const env = envWith(async (model, input) => {
    seen.push(model)
    const system = String((input as { messages: Array<{ content: string }> }).messages[0].content)
    return {
      response: system.includes("drift check")
        ? JSON.stringify({ summary: "All roles agree.", findings: [] })
        : JSON.stringify({ readiness: "needs evidence", rationale: "Nothing was retrieved.", findings: [] })
    }
  }, enabled)
  const backend = createWorkersAiBackend({
    url: "http://localhost:8787",
    token: TOKEN,
    fetch: (async (input: RequestInfo, init?: RequestInit) =>
      (await handleEvalRequest(new Request(input, init), env)) || new Response("Not Found", { status: 404 })) as typeof fetch
  })
  const deep = MODEL_PROFILES.deep
  const baseline = { ...scriptedCandidate("deep-current", "reference", deep, "deep"), model: deep.model }
  const candidate = { ...baseline, id: "small", model: "@cf/meta/llama-3.1-8b-instruct" }

  const report = await runEvaluation({
    dataset: { version: dataset.version, fixtures },
    thresholds: loadThresholds(),
    backend,
    baseline,
    candidates: [candidate],
    candidatesVersion: "test",
    label: "route test"
  })

  assert.equal(report.backend, "workers-ai")
  assert.equal(report.evidenceGrade, "real-model")
  assert.deepEqual(seen, [deep.model, deep.model, candidate.model, candidate.model])
  assert.ok(report.results.every((result) => result.fixtures.every((score) => score.valid && score.taskCorrect)))

  const disabled = createWorkersAiBackend({
    url: "http://localhost:8787",
    token: TOKEN,
    fetch: (async () => new Response("", { status: 404 })) as typeof fetch
  })
  await assert.rejects(
    runEvaluation({
      dataset: { version: dataset.version, fixtures },
      thresholds: loadThresholds(),
      backend: disabled,
      baseline,
      candidates: [],
      candidatesVersion: "test",
      label: "x"
    }),
    /LYTA_EVAL_MODE:enabled/
  )
})
