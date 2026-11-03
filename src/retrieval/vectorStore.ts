/**
 * Cosine-similarity floors for @cf/baai/bge-base-en-v1.5 (mean pooling, the
 * Workers AI default). BGE scores are compressed — unrelated questions still
 * reach ~0.69 against a technical library — so a plain top-K always "finds"
 * something. These floors drop nearest-but-unrelated chunks instead of citing
 * them. Values come from the calibration run recorded in eval/README.md; tune
 * here, not at call sites.
 */
export const MIN_LIBRARY_SCORE = 0.7
export const MIN_KNOWLEDGE_SCORE = 0.7

type VectorDoc = {
  id?: string
  text: string
  vector: number[]
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0
  }

  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return 0
    }

    dot += left * right
    magA += left * left
    magB += right * right
  }

  if (magA === 0 || magB === 0) {
    return 0
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

export function searchVectors<T extends VectorDoc>(queryVector: number[], documents: T[], topK: number = 2, minScore: number = 0) {
  const safeQuery = queryVector.filter((value) => Number.isFinite(value))
  const limit = Math.max(0, Math.floor(topK))

  if (!safeQuery.length || !documents.length || limit === 0) {
    return []
  }

  const scored = documents
    .filter(
      (doc) => Array.isArray(doc.vector) && doc.vector.length === safeQuery.length && doc.vector.every((value) => Number.isFinite(value))
    )
    .map((doc) => ({
      ...doc,
      score: cosineSimilarity(safeQuery, doc.vector)
    }))
    .filter((doc) => Number.isFinite(doc.score) && doc.score > 0 && doc.score >= minScore)

  if (!scored.length) {
    return []
  }

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, limit)
}
