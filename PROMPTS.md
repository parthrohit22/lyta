LYTA Prompt & AI Architecture Design

This document explains the prompt design, memory strategy, and AI-assisted development decisions behind LYTA.

This is not a generic prompt file — it documents deliberate architectural reasoning.

1. Core System Prompt

LYTA uses a structured system prompt injected on every request.

You are LYTA, an edge-deployed AI assistant running on Cloudflare Workers AI.
You maintain structured session memory.
You provide concise, technically accurate responses.
You do NOT have live internet access.
If asked about real-time data (weather, stock prices, breaking news, live events),
you must clearly state that you do not have live access.

Design Goals

The system prompt enforces:
	•	Explicit limitation handling
	•	No real-time hallucinations
	•	Technical tone
	•	Deterministic behavior
	•	Edge-safe constraints

This prevents:
	•	Fabricated live data
	•	Inconsistent assistant personality
	•	Identity drift across turns

2. Deterministic Identity Injection

Instead of relying purely on LLM memory:
	1.	Identity is extracted via regex:
	•	my name is X
	•	I am X
	•	this is X
	2.	Stored separately in Durable Object state as:

profile_name


	3.	Injected into the system prompt dynamically:

const systemMessage = {
  role: "system",
  content: savedName
    ? BASE_SYSTEM_PROMPT +
      ` The user's name is ${savedName}. Address them consistently by this name unless corrected.`
    : BASE_SYSTEM_PROMPT,
};

Why This Matters

LLMs are probabilistic.

Memory stored only in conversation history can drift.

By injecting identity into the system message:
	•	Identity becomes deterministic.
	•	The assistant cannot “forget” unless explicitly corrected.
	•	No hallucinated corrections.

This is intentional engineering, not accidental behavior.


3. Conversation Memory Strategy

Conversation storage:

conversation: Array<{ role: "user" | "assistant", content: string }>

Memory windowing:

const MAX_MESSAGES = 20;
conversation = conversation.slice(-MAX_MESSAGES);

Why Bound Memory?

Without bounding:
	•	Token usage grows linearly
	•	Latency increases
	•	Cost escalates
	•	Model context degrades

Windowing ensures:
	•	Predictable token usage
	•	Stable performance
	•	Controlled cost



4. Streaming Architecture Strategy

Streaming uses:
	•	Workers AI stream: true
	•	TransformStream passthrough
	•	Raw SSE forwarding
	•	Safe JSON parsing
	•	Clean reconstruction before persistence

Streaming logic:
	1.	Forward raw chunks to client
	2.	Parse only data: lines
	3.	Accumulate parsed.response
	4.	Persist only reconstructed full text

This prevents:
	•	SSE artifacts in storage
	•	Partial JSON fragments
	•	Broken assistant messages


5. Rate Limiting Strategy

Per-session rate limiting:
	•	30 requests / 10 minutes
	•	Stored inside Durable Object state
	•	Enforced before LLM execution

Reasoning:
	•	Prevents abuse
	•	Controls cost amplification
	•	Ensures fairness
	•	Demonstrates production awareness



6. AI-Assisted Development Transparency

AI assistance was used for:
	•	Durable Object architecture refinement
	•	Streaming parsing strategy
	•	Prompt hardening
	•	Error handling patterns
	•	Edge-safe memory windowing

All final logic:
	•	Structured manually
	•	Tested locally and remotely
	•	Validated for deterministic behavior

No copy-paste templates were used without modification.


7. Prompt Design Philosophy

The goal was not to:
	•	Build a chatbot.
	•	Build an LLM demo.

The goal was to:
	•	Demonstrate edge-native AI architecture.
	•	Show strong consistency via Durable Objects.
	•	Enforce deterministic memory.
	•	Prevent hallucinated real-time data.
	•	Implement streaming safely.
	•	Control cost and abuse.

This is a production-minded LLM system, not a toy interface.