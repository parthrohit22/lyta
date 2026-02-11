PROMPTS — LYTA

This document outlines the prompt design and AI-assisted development strategy used in LYTA.

⸻

1. System Prompt Philosophy

The system prompt enforces strict behavioral constraints:
	•	No live internet claims
	•	No fabricated real-time data
	•	Concise technical responses
	•	Deterministic identity consistency
	•	Session-aware memory

Core Base Prompt:

“You are LYTA, an edge-deployed AI assistant running on Cloudflare Workers AI.
You maintain structured session memory.
You provide concise, technically accurate responses.
You do NOT have live internet access.
If asked about real-time data (weather, stock prices, breaking news, live events),
you must clearly state that you do not have live access.”

⸻

2. Deterministic Memory Injection

Identity is not left to model recall.

Workflow:
	1.	Extract identity via regex
	2.	Store in Durable Object storage
	3.	Inject into system prompt on every request:

“The user’s name is X. Address them consistently unless corrected.”

This avoids:
	•	Name drift
	•	Hallucinated identity changes
	•	Context forgetting under memory truncation

⸻

3. Memory Windowing

Conversation history is capped:
	•	Prevents token explosion
	•	Controls latency
	•	Reduces cost amplification
	•	Maintains predictable context size

Only the most recent N messages are preserved.

⸻

4. Streaming Safety

Streaming responses are:
	•	Forwarded to client in raw SSE form
	•	Parsed safely
	•	Reconstructed into clean assistant output
	•	Persisted only after full reconstruction

No SSE protocol fragments are stored.

⸻

5. AI-Assisted Development

AI tools were used for:
	•	Architectural refinement
	•	Streaming parsing strategies
	•	Durable Object coordination patterns
	•	Prompt safety reinforcement

All code was reviewed, restructured, and tested manually.

The design decisions (state isolation, rate limiting, deterministic injection) were deliberate engineering choices.

⸻
