LYTA — Edge-Native Stateful AI on Cloudflare Workers

LYTA is a production-oriented, edge-deployed AI assistant built on Cloudflare Workers.

# It demonstrates how to architect stateful LLM applications at the edge using:
	•	Workers AI (Llama 3)
	•	Durable Objects (strongly consistent session memory)
	•	Streaming responses (SSE)
	•	Per-session rate limiting
	•	Deterministic identity injection
	•	Bounded memory windowing
	•	Edge-safe system prompt constraints

This project was built to demonstrate engineering maturity in designing LLM systems, not just invoking an API.

⸻

## 🚀 Architecture Overview

# Edge Entry (Stateless Router)

# The main Worker handles:
	•	GET /health
	•	GET /stats
	•	POST /chat
	•	POST /chat/stream
	•	POST /reset

It delegates all stateful execution to a per-session Durable Object.

# This preserves:
	•	Horizontal scalability at the edge
	•	Clean separation of routing and state
	•	Explicit session scoping


## Strongly Consistent Session Memory (Durable Objects)

Each sessionId maps to a single Durable Object instance.

# Durable Objects were chosen over KV because:
	•	KV is eventually consistent
	•	Chat sessions require ordered, consistent state
	•	Durable Objects guarantee single-threaded execution per key

# Stored state includes:
	•	Conversation history
	•	Extracted profile metadata (e.g. user name)
	•	Rate limiting counters

Memory is capped to prevent unbounded growth.


## Deterministic Identity Injection

# Instead of relying purely on the LLM to “remember” identity:
	•	User identity is extracted via regex
	•	Stored separately as profile_name
	•	Injected into the system prompt on every request

This prevents identity drift and hallucinated corrections.

This is intentional engineering, not accidental memory.

## Streaming Architecture

# /chat/stream uses:
	•	Workers AI streaming
	•	TransformStream passthrough
	•	SSE forwarding to client
	•	Clean assistant message reconstruction before persistence

# Streaming data is:
	•	Forwarded raw to client
	•	Parsed safely
	•	Persisted cleanly

No partial SSE artifacts stored.


#  Rate Limiting (Per Session)
	•	30 requests / 10 minutes
	•	Stored in Durable Object state
	•	Enforced before model execution

Protects against abuse and cost amplification.


## 📡 API

# POST /chat

# Request:

{
  "sessionId": "user1",
  "message": "Hello"
}

# Response:

{
  "reply": "Hello!",
  "memory": { "name": "Parth" }
}



# POST /chat/stream

Streams response via Server-Sent Events.


# POST /reset

Clears session memory.


# GET /stats?sessionId=...

# Returns:
	•	message count
	•	stored identity
	•	rate limit state


## 🛠 Run Locally

# Requirements:
	•	Node 18+
	•	Wrangler 4+

Install:

npm install

Run locally:

wrangler dev --remote

## Test:
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"user1","message":"Hello"}'



## 🧠 Prompt Strategy

# The system prompt enforces:
	•	No real-time data hallucination
	•	Explicit limitation acknowledgement
	•	Technical response style
	•	Deterministic identity consistency

This prevents fabricated “live” information.


## 📈 Design Philosophy

# This project demonstrates:
	•	Edge-native AI architecture
	•	Strongly consistent state design
	•	Streaming-safe persistence
	•	Deterministic memory handling
	•	Abuse mitigation
	•	Production-minded prompt control

It is intentionally engineered beyond a minimal LLM demo.



## 🔮 Future Improvements
	•	Vector-based long-term memory (Vectorize)
	•	Structured tool calling
	•	Authentication layer
	•	Analytics integration
	•	Cost tracking per session



# 👤 Author

Parth Rohit
