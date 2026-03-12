type VectorDoc = {
  text: string
  vector: number[]
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

export function searchVectors(
  queryVector: number[],
  documents: VectorDoc[],
  topK: number = 2
) {
  const scored = documents.map((doc) => ({
    text: doc.text,
    score: cosineSimilarity(queryVector, doc.vector)
  }))

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, topK)
}