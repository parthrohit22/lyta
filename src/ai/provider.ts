import { ModelError, type CallAttribution, type ModelRegistryEntry, type ProviderId } from "./types"

export interface AiChatMessage {
  role: "system" | "user" | "assistant"
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>
}

export type CallAttempt = "primary" | "retry" | "fallback"

export interface ChatCallRequest {
  entry: ModelRegistryEntry
  messages: AiChatMessage[]
  temperature: number
  top_p: number
  max_tokens: number
  timeoutMs: number
  attribution: CallAttribution
  attempt: CallAttempt
}

export interface EmbedCallRequest {
  entry: ModelRegistryEntry
  texts: string[]
  timeoutMs: number
  attribution: CallAttribution
  attempt: CallAttempt
}

/**
 * What every model adapter provides. Product code never calls a provider SDK
 * or binding directly; it goes through src/services/ai.ts, which picks an
 * entry from the registry and calls one of these.
 *
 * Contract (tests/unit/model-provider-contract.test.ts runs it against every
 * adapter and a mock):
 * - `chat` resolves `{ text }`; a missing reply is `""`, never undefined.
 * - `stream` resolves a byte stream of Workers-AI-style SSE
 *   (`data: {"response":"…"}` events, then `data: [DONE]`), whatever the
 *   provider's own wire format.
 * - `structured` resolves a value the caller's validator accepted, or rejects
 *   with `invalid_output`.
 * - `embed` resolves one finite-number vector per input text.
 * - Every rejection is a ModelError with a normalized code.
 */
export interface ModelProvider {
  readonly id: ProviderId
  chat(request: ChatCallRequest): Promise<{ text: string }>
  stream(request: ChatCallRequest): Promise<ReadableStream<Uint8Array>>
  structured<T>(request: ChatCallRequest, validate: (value: unknown) => T | null): Promise<T>
  embed(request: EmbedCallRequest): Promise<number[][]>
}

/**
 * Shared structured-output step for adapters without native JSON mode, and
 * the final check for those with it: take the model's text, pull out the JSON
 * value, and hand it to the caller's validator.
 */
export function parseStructuredText<T>(
  text: string,
  validate: (value: unknown) => T | null,
  context: { provider: ProviderId; model: string }
): T {
  const parsed = extractJson(text)
  const value = parsed === undefined ? null : validate(parsed)

  if (value === null) {
    throw new ModelError("invalid_output", "Model reply did not match the expected structured format.", context)
  }

  return value
}

function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim()
  const start = trimmed.search(/[[{]/)

  if (start === -1) {
    return undefined
  }

  const closer = trimmed[start] === "{" ? "}" : "]"
  const end = trimmed.lastIndexOf(closer)

  if (end <= start) {
    return undefined
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function hasImageContent(messages: AiChatMessage[]) {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"))
}

/** Rough token estimate (≈4 characters per token) used only to rule out models whose context window is clearly too small. */
export function estimateTokens(messages: AiChatMessage[]) {
  const characters = messages.reduce((total, message) => {
    if (typeof message.content === "string") {
      return total + message.content.length
    }

    return total + message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0)
  }, 0)

  return Math.ceil(characters / 4)
}

export function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof value === "object" && typeof (value as ReadableStream<Uint8Array>).getReader === "function")
}
