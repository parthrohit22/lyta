import { MIN_LIBRARY_SCORE, searchVectors } from "../retrieval/vectorStore"

export interface WorkspaceChunk {
  id: string
  fileId: string
  fileName: string
  text: string
  vector: number[]
  /** Immutable source-version identifier used for provenance and deletion. */
  sourceVersionId?: string
  createdAt?: string
}

export interface LibraryCitation {
  id: string
  label: string
  fileId: string
  fileName: string
  snippet: string
}

export interface LibrarySearchResult {
  context: string
  citations: LibraryCitation[]
}

const CHUNK_SIZE = 780
const CHUNK_OVERLAP = 120

export function chunkDocumentText(text: string) {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (!normalized) {
    return []
  }

  const chunks: string[] = []
  let start = 0

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + CHUNK_SIZE)

    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end)

      if (boundary > start + CHUNK_SIZE / 2) {
        end = boundary
      }
    }

    const next = normalized.slice(start, end).trim()

    if (next) {
      chunks.push(next)
    }

    if (end >= normalized.length) {
      break
    }

    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }

  return chunks.slice(0, 24)
}

export function buildLibrarySearchResult(
  queryVector: number[],
  chunks: WorkspaceChunk[],
  topK: number = 4,
  minScore: number = MIN_LIBRARY_SCORE
): LibrarySearchResult {
  if (!chunks.length) {
    return {
      context: "",
      citations: []
    }
  }

  const scored = searchVectors(queryVector, chunks, topK, minScore)
  const citations = scored.map((chunk, index) => {
    return {
      id: chunk.id,
      label: `Source ${index + 1}`,
      fileId: chunk.fileId,
      fileName: chunk.fileName,
      snippet: chunk.text.slice(0, 260)
    }
  }) as LibraryCitation[]

  return {
    context: citations
      .map((citation) => {
        return `<lyta-source id="${citation.id}" file="${citation.fileName}">\n${citation.snippet}\n</lyta-source>`
      })
      .join("\n\n"),
    citations
  }
}
