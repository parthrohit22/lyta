export async function createEmbedding(env: any, text: string) {
  const result = await env.AI.run(
    "@cf/baai/bge-base-en-v1.5",
    {
      text
    }
  )

  return result.data[0]
}