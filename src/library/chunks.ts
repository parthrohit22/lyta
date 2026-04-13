import { searchVectors } from "../retrieval/vectorStore"

export interface WorkspaceChunk {
  id: string
  fileId: string
  fileName: string
  text: string
  vector: number[]
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
  topK: number = 4
): LibrarySearchResult {
  if (!chunks.length) {
    return {
      context: "",
      citations: []
    }
  }

  const scored = searchVectors(queryVector, chunks, topK)
  const citations = scored.map((result, index) => {
    const chunk = chunks.find(candidate => candidate.text === result.text)

    if (!chunk) {
      return null
    }

    return {
      id: `source-${index + 1}`,
      label: `Source ${index + 1}`,
      fileId: chunk.fileId,
      fileName: chunk.fileName,
      snippet: chunk.text.slice(0, 260)
    }
  }).filter(Boolean) as LibraryCitation[]

  return {
    context: citations
      .map(citation => {
        return `[${citation.label}] ${citation.fileName}\n${citation.snippet}`
      })
      .join("\n\n"),
    citations
  }
}
