Good decision. It’s 3 AM engineering mode now — don’t debug UI logic half-asleep. Commit, document, and continue Friday.

Below are clean minimal versions for both files.

No fluff. Clear. Recruiter-friendly.

⸻

README.md

Copy this entire file.

# LYTA — Edge AI Assistant

LYTA is an edge-native AI assistant built entirely on **Cloudflare Workers**.

The project demonstrates how to design **stateful LLM systems at the edge** using:

- Cloudflare Workers
- Durable Objects
- Workers AI
- Streaming responses
- Retrieval Augmented Generation (RAG)

The goal is to show **AI system architecture**, not just a basic chatbot.


## Live Demo

https://lyta.parthrohit-dev.workers.dev

Features:

- streaming AI responses
- persistent conversation sessions
- dark mode UI
- multiple chats
- session memory
- markdown + code rendering


## Architecture

Browser UI
│
▼
Cloudflare Worker (Router)
│
▼
Durable Object (Session State)
│
▼
Workers AI (LLM)
│
▼
Embedding + Retrieval Layer

Responsibilities:

| Layer | Purpose |
|-----|-----|
| Worker | HTTP routing, session handling |
| Durable Object | strongly consistent chat memory |
| Workers AI | LLM inference |
| Retrieval | knowledge context injection |


## Core Features

### Streaming Responses
Token streaming using **Server-Sent Events (SSE)**.

### Stateful Sessions
Each chat session is mapped to a **Durable Object instance**.

### Conversation Memory
Short-term message history with automatic summarization.

### Retrieval Augmented Generation
User messages retrieve relevant knowledge using embeddings.

### Edge Deployment
The entire system runs on **Cloudflare’s edge network**.


## API

### POST /chat

{
“message”: “Hello”
}

Response

{
“reply”: “Hello!”
}

### POST /chat/stream

Returns streaming response tokens.

### GET /history

Returns recent conversation messages.

### POST /reset

Clears session memory.


## Running Locally

Requirements

Node 18+
Wrangler CLI

Install dependencies

npm install

Run development server

wrangler dev –remote

Open

http://localhost:8787

## Technologies

- Cloudflare Workers
- Durable Objects
- Workers AI
- TypeScript
- Server-Sent Events
- Vector embeddings


## Author

Parth Rohit


