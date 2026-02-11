LYTA — Edge-Native Stateful AI on Cloudflare Workers

LYTA is a production-oriented, edge-deployed AI assistant built entirely on Cloudflare Workers.

It demonstrates how to architect stateful LLM systems at the edge — not just call an API.

Built to showcase architectural maturity, consistency guarantees, and production-grade LLM system design.

⸻

🌐 Live Demo

Production URL:
https://cf-ai-lyta.parthrohit-dev.workers.dev

Open the link in a browser. No setup required.

You can:
	•	Chat with streaming responses
	•	Send messages using Enter
	•	Reset session memory
	•	Toggle dark mode
	•	Observe deterministic identity persistence

⸻

🏗 Architecture Overview

Stateless Edge Router

The main Worker handles:
	•	GET /health
	•	GET /stats
	•	POST /chat
	•	POST /chat/stream
	•	POST /reset

All stateful execution is delegated to a per-session Durable Object.

This separation ensures:
	•	Horizontal scalability
	•	Clean routing/state boundaries
	•	Explicit session scoping

⸻

Strongly Consistent Session Memory (Durable Objects)

Each sessionId maps to a single Durable Object instance.

Durable Objects were chosen over KV because:
	•	KV is eventually consistent
	•	Chat sessions require ordered, consistent memory
	•	Durable Objects guarantee single-threaded execution per key

Stored state includes:
	•	Conversation history
	•	Extracted profile metadata (e.g., user name)
	•	Rate limiting counters

Memory is bounded to prevent uncontrolled growth.

⸻

Deterministic Identity Injection

Instead of relying on the LLM to “remember” identity:
	•	Identity is extracted via regex
	•	Stored separately as profile_name
	•	Injected into the system prompt on every request

This prevents:
	•	Identity drift
	•	Hallucinated corrections
	•	Session inconsistency

This is intentional engineering — not accidental model behavior.

⸻

Streaming Architecture

/chat/stream uses:
	•	Workers AI streaming
	•	TransformStream passthrough
	•	Server-Sent Events (SSE)
	•	Clean assistant message reconstruction before persistence

Streaming data is:
	•	Forwarded raw to the client
	•	Parsed safely
	•	Persisted only after full reconstruction

No partial SSE fragments are stored.

⸻

Rate Limiting (Per Session)
	•	30 requests per 10 minutes
	•	Stored in Durable Object state
	•	Enforced before model execution

This prevents abuse and cost amplification.

⸻

📡 API Reference

Although a browser UI is provided, the API is fully usable.

POST /chat

Request

{
  "sessionId": "user1",
  "message": "Hello"
}

Response

{
  "reply": "Hello!",
  "memory": { "name": "Parth" }
}


⸻

POST /chat/stream

Streams response via Server-Sent Events.

⸻

POST /reset

Clears session memory for the given session.

⸻

GET /stats?sessionId=...

Returns:
	•	Message count
	•	Stored identity
	•	Rate limit state

⸻

🛠 Run Locally

Requirements
	•	Node 18+
	•	Wrangler 4+

Install

npm install

Run with remote Workers AI

wrangler dev --remote

Then open:

http://localhost:8787


⸻

🧠 Prompt Strategy

The system prompt enforces:
	•	No real-time data hallucination
	•	Explicit limitation acknowledgement
	•	Technical response style
	•	Deterministic identity consistency

The model is constrained deliberately to prevent fabricated “live” claims.

⸻

📈 Design Philosophy

LYTA demonstrates:
	•	Edge-native AI architecture
	•	Strongly consistent state design
	•	Streaming-safe persistence
	•	Deterministic memory injection
	•	Abuse mitigation
	•	Production-minded prompt control

It is intentionally engineered beyond a minimal LLM demo.

⸻

🔮 Future Improvements
	•	Vector-based long-term memory (Cloudflare Vectorize)
	•	Structured tool/function calling
	•	Authentication layer
	•	Analytics integration
	•	Cost tracking per session

⸻

👤 Author

Parth Rohit
Software Engineer

