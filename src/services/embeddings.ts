import type { Env } from "../index"

interface EmbeddingResponse {
  data: number[][]
}

export async function createEmbedding(env: Pick<Env, "AI">, text: string) {
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text
  }) as EmbeddingResponse

  return result.data[0] || []
}
