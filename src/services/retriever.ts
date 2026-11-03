import type { Env } from "../index"
import { createEmbedding } from "./embeddings"
import { MIN_KNOWLEDGE_SCORE, searchVectors } from "../retrieval/vectorStore"
import { knowledgeBase } from "../docs/knowledge"

interface EmbeddedKnowledgeDoc {
  text: string
  vector: number[]
}

let embeddedDocsPromise: Promise<EmbeddedKnowledgeDoc[]> | null = null

function embedDocs(env: Pick<Env, "AI">) {
  if (!embeddedDocsPromise) {
    embeddedDocsPromise = Promise.all(
      knowledgeBase.map(async (doc) => ({
        text: doc.text,
        vector: await createEmbedding(env, doc.text)
      }))
    ).catch((error) => {
      embeddedDocsPromise = null
      throw error
    })
  }

  return embeddedDocsPromise
}

/**
 * The built-in knowledge base only describes LYTA itself. Injecting it into
 * general questions ("what is a Durable Object?") makes the model repeat
 * LYTA's self-description as if it were a general definition, so it is only
 * consulted when the user asks about LYTA by name.
 */
export function isSelfReferentialQuery(query: string) {
  return /\blyta\b/i.test(query)
}

export async function retrieveContext(env: Pick<Env, "AI">, query: string) {
  if (!isSelfReferentialQuery(query)) {
    return ""
  }

  try {
    const docs = await embedDocs(env)
    const queryVector = await createEmbedding(env, query)
    const results = searchVectors(queryVector, docs, 2, MIN_KNOWLEDGE_SCORE)

    return results.map((r) => r.text).join("\n")
  } catch (error) {
    throw new Error("Built-in retrieval failed.", {
      cause: error
    })
  }
}
