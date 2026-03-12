import { createEmbedding } from "./embeddings"
import { searchVectors } from "../retrieval/vectorStore"
import { knowledgeBase } from "../docs/knowledge"

let embeddedDocs: any[] | null = null

async function embedDocs(env: any) {
  if (embeddedDocs) return embeddedDocs

  embeddedDocs = []

  for (const doc of knowledgeBase) {
    const vector = await createEmbedding(env, doc.text)
    embeddedDocs.push({ text: doc, vector })
  }

  return embeddedDocs
}

export async function retrieveContext(env: any, query: string) {
  const docs = await embedDocs(env)

  const queryVector = await createEmbedding(env, query)

  const results = searchVectors(queryVector, docs, 2)

  return results.map(r => r.text).join("\n")
}