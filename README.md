LYTA — Stateful Edge AI on Cloudflare Workers

LYTA is a stateful AI assistant built entirely on Cloudflare’s edge platform using:
	•	Workers AI (@cf/meta/llama-3-8b-instruct)
	•	Durable Objects for per-session state
	•	Workers runtime for routing
	•	REST + Streaming (SSE) APIs

This project demonstrates production-oriented AI system design at the edge with bounded memory, rate limiting, and session isolation.

⸻

🏗 Architecture Overview

Client
   ↓
Stateless Worker Router
   ↓
Session-Scoped Durable Object
   ↓
Workers AI (LLM Inference)

1️⃣ Edge Entry (Worker)

The main Worker:
	•	Validates requests
	•	Routes by endpoint
	•	Delegates to per-session Durable Object
	•	Remains stateless

This separation keeps ingress logic isolated from session state.

⸻

2️⃣ Session State (Durable Objects)

Each sessionId maps to a unique Durable Object instance.

Durable Objects provide:
	•	Strong per-session consistency
	•	Ordered execution
	•	Isolated storage per user session

Stored per session:
	•	Conversation history
	•	Extracted profile metadata (e.g. name)
	•	Rate limit counters

This prevents cross-session contamination and race conditions.

⸻

3️⃣ LLM Inference

Model:

@cf/meta/llama-3-8b-instruct

Accessed via Workers AI binding.

Two execution modes:

Endpoint	Mode
/chat	Standard completion
/chat/stream	Server-Sent Events streaming

System prompt enforces:
	•	No live internet claims
	•	No fabricated real-time data
	•	Explicit capability limitations

⸻

🧠 Memory Strategy

Conversation history:
	•	Stored per session
	•	Bounded to 20 messages
	•	Old messages trimmed while preserving system prompt

This prevents:
	•	Token explosion
	•	Unbounded growth
	•	Cost amplification

Lightweight personalization:
	•	Regex extraction of user name
	•	Stored separately from history
	•	Returned as structured metadata

⸻

🚦 Rate Limiting

Per-session limit:
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

Request:

{
  "sessionId": "user1",
  "message": "Hello"
}

Response:

{
  "reply": "...",
  "memory": { "name": "Parth" }
}


⸻

POST /chat/stream

Streaming response via SSE:

curl -N -X POST http://localhost:8787/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"user1","message":"Explain Workers."}'


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

Service status endpoint.

⸻

🧩 Design Decisions
	•	Durable Objects chosen for strong per-session consistency.
	•	Bounded memory window prevents token and cost blow-up.
	•	Explicit error handling for AI failures.
	•	Streaming support improves perceived latency.
	•	Stateless router + stateful execution models distributed systems cleanly.

⸻

▶ Running Locally

Requirements:
	•	Node 18+
	•	Wrangler 4+

Install:

npm install

Local:

wrangler dev

Remote AI:

wrangler dev --remote


⸻

🔮 Future Extensions
	•	Vector memory (Cloudflare Vectorize)
	•	Tool / function calling
	•	JWT authentication
	•	KV-backed long-term memory tier
	•	Observability metrics export

⸻

📁 Repository Compliance
	•	Prefixed with cf_ai_
	•	Includes README.md
	•	Includes PROMPTS.md
	•	Original implementation

⸻

👤 Author

Parth Rohit
Cloudflare AI Internship Submission

⸻
