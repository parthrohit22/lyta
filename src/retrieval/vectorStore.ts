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

export function searchVectors<T extends VectorDoc>(queryVector: number[], documents: T[], topK: number = 2) {
  const safeQuery = queryVector.filter((value) => Number.isFinite(value))
  const limit = Math.max(0, Math.floor(topK))

  if (!safeQuery.length || !documents.length || limit === 0) {
    return []
  }

  const scored = documents
    .filter((doc) => Array.isArray(doc.vector) && doc.vector.length === safeQuery.length && doc.vector.every((value) => Number.isFinite(value)))
    .map((doc) => ({
      ...doc,
      score: cosineSimilarity(safeQuery, doc.vector)
    }))
    .filter((doc) => Number.isFinite(doc.score))

  if (!scored.length) {
    return []
  }

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, limit)
}
