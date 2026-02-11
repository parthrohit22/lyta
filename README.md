
LYTA — Stateful Edge AI on Cloudflare Workers

LYTA is a stateful AI assistant built entirely on Cloudflare’s edge platform using:
	•	Workers AI (@cf/meta/llama-3-8b-instruct)
	•	Durable Objects for per-session state isolation
	•	Cloudflare Workers runtime for routing
	•	REST + Streaming (SSE) APIs

This project demonstrates how to design a production-oriented AI system at the edge with bounded memory, rate limiting, and strong session consistency.

⸻

🏗 Architecture Overview

Client
   ↓
Stateless Worker Router
   ↓
Session-Scoped Durable Object
   ↓
Workers AI (LLM Inference)

1️⃣ Stateless Edge Router

The main Worker:
	•	Validates and parses requests
	•	Routes by endpoint
	•	Delegates to a per-session Durable Object
	•	Remains fully stateless

This separates ingress logic from session state management and mirrors distributed edge design patterns.

⸻

2️⃣ Session State via Durable Objects

Each sessionId maps to a unique Durable Object instance.

Durable Objects provide:
	•	Strong per-session consistency
	•	Single-threaded ordered execution
	•	Isolated storage per user session
	•	No cross-session race conditions

Stored per session:
	•	Conversation history
	•	Extracted profile metadata (e.g. user name)
	•	Rate limit state

Why Durable Objects (Not KV)?

This system requires strongly consistent, ordered execution per session.
Cloudflare KV is eventually consistent and would introduce race conditions under concurrent requests.

Durable Objects guarantee single-instance execution per key, aligning naturally with chat session semantics.

⸻

3️⃣ LLM Inference (Workers AI)

Model used:

@cf/meta/llama-3-8b-instruct

Accessed via Workers AI binding.

Two execution modes:

Endpoint	Mode
/chat	Standard completion
/chat/stream	Server-Sent Events streaming

The system prompt explicitly enforces:
	•	No live internet claims
	•	No fabricated real-time data
	•	Clear capability boundaries

⸻

🧠 Memory Strategy

Conversation history:
	•	Stored per session
	•	Bounded to 20 messages
	•	Old messages trimmed while preserving system prompt

This prevents:
	•	Token explosion
	•	Unbounded memory growth
	•	Cost amplification

Stateless Alternative (Why Not?)

A purely stateless design would require the client to resend full conversation history on every request:
	•	Increases token usage
	•	Increases cost
	•	Exposes context to tampering
	•	Increases payload size

By anchoring memory server-side in Durable Objects, context integrity and cost control are enforced centrally.

⸻

🚦 Rate Limiting

Per-session rate limit:
	•	30 requests per 10 minutes
	•	Stored in Durable Object state
	•	Enforced before LLM invocation

Prevents:
	•	Abuse
	•	Excess inference cost
	•	Resource exhaustion

⸻

📡 API Endpoints

POST /chat

Standard JSON completion.

Request:

{
  "sessionId": "user1",
  "message": "Hello"
}

Response:

{
  "reply": "...",
  "memory": {
    "name": "Parth"
  }
}


⸻

POST /chat/stream

Streaming response via Server-Sent Events:

curl -N -X POST http://localhost:8787/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"user1","message":"Explain Workers."}'

Returns incremental token chunks followed by [DONE].

⸻

POST /reset

Clears session memory.

⸻

GET /stats?sessionId=user1

Returns:
	•	Message count
	•	Profile metadata
	•	Rate limit state

⸻

GET /health

Basic service status endpoint.

⸻

🌍 Edge Deployment Considerations

The system is intentionally designed for edge execution:
	•	Stateless ingress layer
	•	Strong per-session isolation
	•	Controlled token usage
	•	Latency-sensitive streaming support
	•	Server-side memory enforcement

Routing and state management are separated to reflect distributed edge architecture patterns.

⸻

▶ Running Locally

Requirements
	•	Node 18+
	•	Wrangler 4+

Install

npm install

Local (without remote AI)

wrangler dev

Remote Workers AI

wrangler dev --remote


⸻

🔮 Future Extensions
	•	Vector-based semantic memory (Cloudflare Vectorize)
	•	Tool / function calling
	•	JWT authentication
	•	KV-backed long-term memory tier
	•	Observability metrics export

⸻

📁 Repository Compliance
	•	Repository prefix: cf_ai_
	•	Includes README.md
	•	Includes PROMPTS.md
	•	Original implementation
	•	No copied submissions

⸻

👤 Author

Parth Rohit
Cloudflare AI Internship Submission

⸻
