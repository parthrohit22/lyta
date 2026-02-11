# PROMPTS.md — LYTA

This file documents the prompt design and AI-assisted development process for LYTA.

---

## 1. System Prompt (Production Prompt)

The system prompt is embedded during Durable Object initialization to enforce:

- Session-aware memory
- Explicit limitation handling
- No hallucinated real-time data
- Controlled assistant behavior

System Prompt:

"You are LYTA, an edge-deployed AI assistant running on Cloudflare Workers AI.
You maintain session memory within a Durable Object.
You provide concise, technically accurate responses.
You do NOT have live internet access.
If asked about real-time data (weather, stock prices, breaking news, live events),
you must clearly state that you do not have live data access and suggest checking a reliable source."

---

## 2. Memory Strategy

Conversation history is stored in Durable Object storage.

Prompt injection pattern:

messages = [
  system,
  ...previous conversation history,
  current user message
]

Memory window is capped to prevent unbounded growth.

---

## 3. Lightweight Profile Memory

Regex-based extraction is used to capture simple personal data such as:

- "my name is X"

This value is stored separately as `profile_name` and returned in API response.

This demonstrates controlled state extraction rather than relying entirely on LLM recall.

---

## 4. Rate Limiting Strategy

Per-session rate limiting:
- 30 requests per 10 minutes
- Stored in Durable Object state
- Enforced before LLM execution

---

## 5. AI-Assisted Development

During development, AI assistance was used for:
- Durable Object architecture refinement
- Prompt structuring
- Error handling patterns
- Edge-safe memory trimming strategy

All logic was implemented and tested manually.

---

## 6. Design Goals

This project was designed to demonstrate:

- Edge-native AI architecture
- Stateful coordination using Durable Objects
- Safe LLM usage with explicit constraints
- Production-minded engineering practices
