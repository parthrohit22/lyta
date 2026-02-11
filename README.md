LYTA - Edge-Native Stateful AI on Cloudflare Workers

LYTA is a production-oriented, edge-deployed AI assistant built entirely on Cloudflare Workers.

It demonstrates how to architect stateful LLM systems at the edge, not just call an API.

Built with:
	•	Workers AI (Llama 3)
	•	Durable Objects (strongly consistent session memory)
	•	Server-Sent Events streaming
	•	Per-session rate limiting
	•	Deterministic identity injection
	•	Bounded memory windowing
	•	Edge-safe system prompt constraints

This project focuses on architectural correctness, consistency, and production thinking.

⸻

🌐 Live Demo

Production URL
https://cf-ai-lyta.parthrohit-dev.workers.dev

Open the link in a browser.

No setup required.

You can:git 
	•	Chat with streaming responses
	•	Use Enter to send messages
	•	Reset session memory
	•	Toggle dark mode
	•	Observe deterministic identity persistence

⸻

🚀 Architecture Overview

1. Stateless Edge Router

The main Worker handles:
	•	GET /health
	•	GET /stats
	•	POST /chat
	•	POST /chat/stream
	•	POST /reset

It delegates all stateful logic to a per-session Durable Object.

This separation ensures:
	•	Horizontal scalability
	•	Clean routing/state boundaries
	•	Explicit session scoping

⸻

2. Strongly Consistent Session Memory (Durable Objects)

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

3. Deterministic Identity Injection

Instead of relying on the LLM to “remember” identity:
	•	Identity is extracted via regex
	•	Stored separately as profile_name
	•	Injected into the system prompt on every request

This prevents:
	•	Identity drift
	•	Hallucinated corrections
	•	Session inconsistency

This is intentional engineering — not accidental memory behavior.

⸻

4. Streaming Architecture

/chat/stream uses:
	•	Workers AI streaming
	•	TransformStream passthrough
	•	SSE forwarding to client
	•	Clean assistant message reconstruction before persistence

Streaming data is:
	•	Forwarded raw to the client
	•	Parsed safely
	•	Persisted only after full reconstruction

No partial SSE fragments are stored.

⸻

5. Rate Limiting (Per Session)
	•	30 requests per 10 minutes
	•	Stored in Durable Object state
	•	Enforced before model execution

Prevents abuse and cost amplification.

⸻

📡 API Reference

Even though the UI is primary, the API remains fully usable.

POST /chat

Request:

{
  "sessionId": "user1",
  "message": "Hello"
}

Response:

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

GET /stats?sessionId=…

Returns:
	•	message count
	•	stored identity
	•	rate limit state

⸻

🛠 Run Locally

Requirements:
	•	Node 18+
	•	Wrangler 4+

Install:

npm install

Run with remote Workers AI:

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
	•	Vector-based long-term memory (Vectorize)
	•	Structured tool/function calling
	•	Authentication layer
	•	Analytics integration
	•	Cost tracking per session

⸻

👤 Author

Parth Rohit
Cloudflare AI Internship Submission

⸻