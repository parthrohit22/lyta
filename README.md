# LYTA

LYTA is an edge-native AI workspace built on Cloudflare Workers. The goal is not to imitate an existing chat product pixel-for-pixel, but to show how a production-minded AI assistant can be designed with clear state boundaries, reusable document memory, and a cleaner delivery surface for output.

## What It Does

- Guest workspaces for instant access, plus account-backed workspaces for durable storage
- Server-stored chat sessions using Durable Objects
- Upload and reuse images, PDFs, DOCX, and text files
- Searchable personal library with citation-aware answers
- Streaming responses with `Instant`, `Deep`, and `Creative` modes
- Smart follow-up prompts after each assistant answer
- Output board for copying or exporting polished responses
- Per-surface theme customization and focus mode

## Why This Stack

LYTA is intentionally built around a few Cloudflare-native primitives:

- `Workers` handle routing, auth orchestration, streaming, and library indexing logic at the edge.
- `Durable Objects` provide strong consistency for the two places where it matters most:
  - `AuthDirectory`: global account + session token directory
  - `Workspace`: per-user profile, preferences, chat index, and file library
  - `Conversation`: per-chat memory and summarization
- `Workers AI` provides both generation and embeddings without introducing a separate vector database or model gateway for the first version.

This keeps the project compact enough to understand, while still demonstrating good separation of concerns.

## Architecture

```text
Browser UI
   │
   ▼
Cloudflare Worker Router
   │
   ├── AuthDirectory DO      -> account records + auth sessions
   ├── Workspace DO          -> profile, preferences, chat index, file library
   └── Conversation DO       -> per-chat memory, titles, summaries, streaming
   │
   ├── Workers AI (chat model)
   └── Workers AI (embeddings)
```

More detail is in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Key Design Choices

### 1. Workspace state lives on the server

Earlier versions used browser-local chat state. That was fine for prototyping, but not for a real portfolio project. LYTA now supports two server-backed modes:

- guest workspaces for immediate temporary use
- authenticated workspaces for private durable storage

Both are isolated through Durable Objects, but only authenticated accounts are meant for long-term retention.

### 2. File parsing happens in the browser, retrieval happens on the server

The browser extracts readable text from PDFs, DOCX, and text files before upload. That keeps the server simple and avoids adding a separate document ingestion service. Once files arrive, the Worker chunks text, creates embeddings, and stores searchable library metadata in the user workspace.

### 3. Conversation memory is scoped per chat

Each chat maps to its own `Conversation` Durable Object. This gives ordered writes, isolated memory, and a clean place to handle title generation, summarization, and streamed completion persistence.

### 4. Citations are tied to the personal library

When a user asks a question, the router generates a retrieval query, searches that user's saved library, and injects the top matching snippets into the prompt. The matching sources are also returned to the UI so the answer can show which saved files were used.

### 5. Smart follow-ups are explicit product logic

Follow-up suggestions are generated after the main answer instead of being left to UI guesswork. That keeps the next-step UX intentional and makes the assistant feel more guided without becoming noisy.

## Project Structure

```text
pages/
  index.html        UI shell
  styles.css        visual system + responsive layout
  app.js            auth, chat UI, uploads, board, settings

src/
  index.ts                  Worker entry
  router.ts                 request routing + auth/workspace orchestration
  auth/crypto.ts            password hashing + token helpers
  chat/messages.ts          request normalization + prompt building helpers
  durable/
    authDirectory.ts        account + session token storage
    workspace.ts            per-user workspace state + file library
    conversation.ts         per-chat memory, titles, summaries, streaming
  library/chunks.ts         document chunking + citation formatting
  services/
    ai.ts                   Workers AI calls
    embeddings.ts           embedding generation
    retriever.ts            static project retrieval
```

## Local Development

### Requirements

- Node.js 18+
- Wrangler CLI

### Install

```bash
npm install
```

### Run

```bash
wrangler dev --remote
```

Open `http://localhost:8787`.

## Verification

Current lightweight checks:

```bash
node --check pages/app.js
./node_modules/.bin/tsc --noEmit
```

## Tradeoffs and Next Steps

This version is intentionally clean, but not maximal:

- Guests can use the app immediately, but durable storage still depends on account sign-in.
- Auth is email/password based today, not yet full OAuth/social login.
- Library search is embedded inside the workspace Durable Object, which is excellent for a compact showcase build but may need external indexing for larger-scale file collections.
- The output board is a strong artifact surface, but could be extended into multi-artifact generation or shareable pages.
- OCR and web-grounded research are still natural next upgrades.

## Why This Is A Good Showcase Project

LYTA demonstrates more than frontend polish. It shows:

- product thinking
- stateful AI system design
- streaming UX
- authenticated multi-tenant data separation
- retrieval with citations
- clean edge-native architecture

That combination maps well to both AI engineer and software engineer roles because it shows systems thinking, not just model calls.
