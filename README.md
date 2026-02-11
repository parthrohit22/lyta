# LYTA — Edge AI Chat on Cloudflare Workers

LYTA is a stateful, edge-deployed AI assistant built on Cloudflare Workers using:

- Workers AI (Llama 3)
- Durable Objects (session memory)
- Workers runtime
- REST chat API
- Optional browser UI (Pages-compatible)

This project demonstrates production-oriented design patterns for AI systems at the edge.

---

## Architecture Overview

LYTA includes:

### 1. LLM
- Model: `@cf/meta/llama-3-8b-instruct`
- Accessed via Workers AI binding
- Structured system prompt enforcing runtime constraints

### 2. Memory (Stateful Sessions)
- Durable Objects per sessionId
- Stores:
  - Conversation history
  - Extracted profile metadata (e.g. name)
- Memory bounded to avoid unbounded growth

### 3. Coordination
- Main Worker routes `/chat`
- Delegates to per-session Durable Object
- Stateless edge entry + stateful execution model

### 4. Safety Constraints
System prompt enforces:
- No live internet claims
- No real-time data fabrication
- Explicit limitation handling

---

## API Endpoints

### POST /chat

Request:

```json
{
  "sessionId": "user1",
  "message": "Hello"
}

Response:

{
  "reply": "AI response",
  "memory": {
    "name": "Parth"
  }
}


⸻

POST /reset

Clears session memory.

⸻

GET /health

Returns service status.

⸻

Run Locally

Requirements:
	•	Node 18+
	•	Wrangler 4+

Install:

npm install

Start:

wrangler dev

Test:

curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"user1","message":"Hello"}'


⸻

Run with Remote AI (Workers AI)

wrangler dev --remote


⸻

Design Decisions
	•	Durable Objects chosen for strong per-session consistency
	•	Memory window capped to prevent uncontrolled growth
	•	Explicit AI error handling
	•	Session-level rate limiting
	•	Profile memory extraction (lightweight personalization)
	•	Health endpoint for observability

⸻

Future Improvements
	•	Vector memory (Cloudflare Vectorize)
	•	Streaming responses
	•	Structured function calling
	•	Authentication layer
	•	KV-backed long-term memory
	•	Analytics integration

⸻

Repository Requirements
	•	Prefixed with cf_ai_
	•	Includes PROMPTS.md
	•	Original implementation
	•	No copied code

⸻

Author

Parth Rohit
Cloudflare AI Internship Submission

---
