import type { Env } from "../index"
import { EVAL_MODEL_PATTERN } from "./dataset"

/**
 * The eval-only model route used by `npm run eval:run -- --backend workers-ai`.
 * It runs one chat completion on the requested Workers AI model and returns the
 * raw reply and its latency, so the harness can score it with the product's own
 * contracts. It exists only when the Worker is started with
 * LYTA_EVAL_MODE=enabled and a LYTA_EVAL_TOKEN, which wrangler.jsonc never sets
 * (tests/unit/eval-route.test.ts checks that). Otherwise the path is left to the
 * router exactly as before. Nothing is logged or stored.
 */
export const EVAL_PATH_PREFIX = "/__eval/"
const EVAL_COMPLETE_PATH = "/__eval/complete"
const MAX_MESSAGES = 12
const MAX_MESSAGE_LENGTH = 40_000
const MAX_TIMEOUT_MS = 60_000

export function isEvalRouteEnabled(env: Pick<Env, "LYTA_EVAL_MODE" | "LYTA_EVAL_TOKEN">) {
  return env.LYTA_EVAL_MODE === "enabled" && typeof env.LYTA_EVAL_TOKEN === "string" && env.LYTA_EVAL_TOKEN.length >= 16
}

/** Returns null when the request is not for the eval route, or the route is disabled. */
export async function handleEvalRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(EVAL_PATH_PREFIX) || !isEvalRouteEnabled(env)) return null

  if (url.pathname !== EVAL_COMPLETE_PATH || request.method !== "POST") return json({ error: "Not Found" }, 404)
  if (!sameToken(request.headers.get("x-lyta-eval-token") || "", env.LYTA_EVAL_TOKEN!)) return json({ error: "Unauthorized" }, 401)

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const invalid = validateBody(body)
  if (invalid) return json({ error: invalid }, 400)

  const { model, messages, temperature, top_p, max_tokens, timeoutMs } = body as {
    model: string
    messages: Array<{ role: string; content: string }>
    temperature: number
    top_p: number
    max_tokens: number
    timeoutMs: number
  }
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    // No retry and no fallback model: the harness measures exactly the model it asked for.
    const result = await Promise.race([
      env.AI.run(model, { messages, temperature, top_p, max_tokens }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EvalTimeout()), timeoutMs)
      })
    ])
    const response = result && typeof result === "object" ? (result as { response?: unknown }).response : undefined
    return json({
      model,
      latencyMs: Date.now() - startedAt,
      ...(typeof response === "string" ? { response } : { error: "model-error" })
    })
  } catch (error) {
    return json({ model, latencyMs: Date.now() - startedAt, error: error instanceof EvalTimeout ? "timeout" : "model-error" })
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

class EvalTimeout extends Error {}

function validateBody(body: Record<string, unknown> | null) {
  if (!body) return "Body must be JSON."
  if (typeof body.model !== "string" || !EVAL_MODEL_PATTERN.test(body.model)) return "model must be a Workers AI @cf/ model id."
  const messages = body.messages
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > MAX_MESSAGES ||
    messages.some(
      (message) =>
        !message ||
        !["system", "user", "assistant"].includes((message as { role?: string }).role || "") ||
        typeof (message as { content?: unknown }).content !== "string" ||
        (message as { content: string }).content.length > MAX_MESSAGE_LENGTH
    )
  ) {
    return "messages must be 1-12 text chat messages."
  }
  const inRange = (value: unknown, min: number, max: number) => typeof value === "number" && value >= min && value <= max
  if (!inRange(body.temperature, 0, 2) || !inRange(body.top_p, 0, 1)) return "temperature or top_p is out of range."
  if (!inRange(body.max_tokens, 1, 4096) || !Number.isInteger(body.max_tokens)) return "max_tokens must be 1-4096."
  if (!inRange(body.timeoutMs, 1, MAX_TIMEOUT_MS)) return `timeoutMs must be at most ${MAX_TIMEOUT_MS}.`
  return ""
}

function sameToken(given: string, expected: string) {
  if (given.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) difference |= given.charCodeAt(index) ^ expected.charCodeAt(index)
  return difference === 0
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}
