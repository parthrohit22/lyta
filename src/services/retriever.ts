import type { Env } from "../index"
import { createEmbedding } from "./embeddings"
import { searchVectors } from "../retrieval/vectorStore"
import { knowledgeBase } from "../docs/knowledge"

interface EmbeddedKnowledgeDoc {
  text: string
  vector: number[]
}

let embeddedDocsPromise: Promise<EmbeddedKnowledgeDoc[]> | null = null

function embedDocs(env: Pick<Env, "AI">) {
  if (!embeddedDocsPromise) {
    embeddedDocsPromise = Promise.all(
      knowledgeBase.map(async doc => ({
        text: doc.text,
        vector: await createEmbedding(env, doc.text)
      }))
    )
  }

  return embeddedDocsPromise
}

export async function retrieveContext(env: Pick<Env, "AI">, query: string) {
  const docs = await embedDocs(env)
  const queryVector = await createEmbedding(env, query)
  const results = searchVectors(queryVector, docs, 2)

  return results.map(r => r.text).join("\n")
}
