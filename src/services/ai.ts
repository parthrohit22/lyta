import type { Env } from "../index"
import type { ChatMode } from "../chat/messages"

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"

export interface AiChatMessage {
  role: "system" | "user" | "assistant"
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >
}

interface AiTextResponse {
  response?: string
}

interface RunAIOptions {
  mode?: ChatMode
}

function getModelSettings(mode: ChatMode | undefined) {
  switch (mode) {
    case "deep":
      return {
        temperature: 0.35,
        top_p: 0.85,
        max_tokens: 1800
      }
    case "creative":
      return {
        temperature: 0.9,
        top_p: 0.95,
        max_tokens: 1400
      }
    default:
      return {
        temperature: 0.45,
        top_p: 0.9,
        max_tokens: 1100
      }
  }
}

export async function runAI(
  env: Pick<Env, "AI">,
  messages: AiChatMessage[],
  options?: RunAIOptions
) {
  return env.AI.run(MODEL, {
    messages,
    ...getModelSettings(options?.mode)
  }) as Promise<AiTextResponse>
}

export async function runAIStream(
  env: Pick<Env, "AI">,
  messages: AiChatMessage[],
  options?: RunAIOptions
) {
  return env.AI.run(MODEL, {
    messages,
    ...getModelSettings(options?.mode),
    stream: true
  }) as Promise<ReadableStream<Uint8Array>>
}
