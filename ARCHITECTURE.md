# Architecture Notes

This document explains the main implementation choices in LYTA and why they were chosen for this project.

## 1. Durable Objects For The Stateful Parts

LYTA uses three Durable Object roles:

- `AuthDirectory`
  - Stores account records and hashed session tokens
  - Gives the Worker a single place to validate auth cookies
- `Workspace`
  - Stores one workspace's profile, theme preferences, chat index, and reusable library
  - Works for both temporary guest sessions and signed-in users
- `Conversation`
  - Stores one chat's memory, title, and summary
  - Guarantees ordered writes for streaming and follow-up persistence

This split keeps each object focused and avoids mixing account state with conversation state.

## 2. Why The Router Orchestrates Retrieval

The Worker router sits above the chat Durable Object because it has cross-cutting responsibilities:

- validate the authenticated user
- create or resume a guest workspace when no account session is present
- confirm the requested chat belongs to that user
- import fresh attachments into the personal library
- generate embeddings for library search
- retrieve matching file context before forwarding the request

That keeps `Conversation` focused on conversation logic instead of becoming a general-purpose coordinator.

## 3. File Library Strategy

The personal file library is intentionally simple:

- browser extracts readable text from PDFs, DOCX, and text files
- Worker chunks extracted text
- Worker generates embeddings with Workers AI
- Workspace DO stores library files and chunk vectors
- chat requests search the saved chunks and return top snippets as citations

This approach works well for a showcase-sized system because it avoids operational overhead while still demonstrating retrieval, persistence, and source grounding.

## 4. Streaming Design

The streaming flow is:

1. Router authenticates and enriches the request with library context.
2. `Conversation` starts the Workers AI stream.
3. Tokens are forwarded to the browser as Server-Sent Events.
4. When generation ends, the server sends:
   - a `done` event so the UI can stop showing "thinking"
   - a metadata event with citations and follow-up prompts
5. The final assistant message is persisted only after the response is complete.

This keeps the UX responsive while still ensuring the stored message includes the full metadata.

## 5. Why There Is Still A Small Static Retriever

There are two retrieval layers:

- static project knowledge in `src/docs/knowledge.ts`
- personal user library retrieval from `Workspace`

The static layer gives LYTA a little built-in product awareness. The user library layer provides the real personalized value.

## 6. Frontend Philosophy

The UI aims for "minimal but intentional":

- fewer decorative sections
- strong information hierarchy
- account-backed settings instead of browser-only state
- a dedicated output board instead of forcing everything to live inside the chat stream

The board is especially useful for showcase work because it lets a recruiter or reviewer see that the project thinks beyond raw conversation bubbles and toward deliverable-oriented interaction.

## 7. What I Would Scale Next

If LYTA grew beyond portfolio scope, the next changes would likely be:

- move library search to a dedicated vector store
- add OCR for scanned PDFs and images
- introduce OAuth and password reset flows
- support shareable artifacts and read-only published outputs
- add optional web-grounded research mode with explicit citations
