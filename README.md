# LYTA — Edge-Native AI Assistant

LYTA is an **edge-native AI assistant** built entirely on **Cloudflare Workers**.

The project demonstrates how to design **stateful LLM systems at the edge**, rather than a typical frontend calling an AI API.

LYTA combines:

- Cloudflare Workers
- Durable Objects
- Workers AI
- Streaming responses
- Retrieval Augmented Generation (RAG)
- Multi-session chat architecture

The goal of the project is to showcase **AI system architecture and distributed edge design**.


---

# Live Demo

https://lyta.parthrohit-dev.workers.dev

You can open the link and interact with the system directly.

Features available in the demo:

- streaming AI responses
- multiple chat sessions
- persistent session memory
- automatic chat titles
- chat deletion
- markdown and code rendering


---

# Architecture

LYTA is designed as an **edge-native distributed system**.
```
Browser UI
│
▼
Cloudflare Worker (Router)
│
├── SessionIndex Durable Object
│       manages chat list
│
▼
Conversation Durable Object
per-session memory and state
│
▼
Workers AI (LLM inference)
│
▼
Retrieval Layer (RAG)
knowledge context injection
```
### Responsibilities
```
| Layer | Purpose |
|-----|-----|
| Browser UI | user interaction and streaming display |
| Worker Router | request routing and session resolution |
| SessionIndex DO | chat list management |
| Conversation DO | strongly consistent session memory |
| Workers AI | LLM inference |
| Retrieval Layer | context injection via embeddings |
```
Each chat session is mapped to **its own Durable Object instance**, ensuring:

- strongly consistent memory
- isolated session state
- deterministic execution



# Core Features


## Streaming Responses

AI responses are streamed using **Server-Sent Events (SSE)**.

Tokens are forwarded from Workers AI to the browser in real time.


## Stateful Chat Sessions

Each chat session maps to a **Durable Object instance**.

This provides:

- consistent session memory
- ordered execution
- concurrent request safety


## Conversation Memory

Short-term conversation history is stored inside the Durable Object.

To prevent unbounded context growth:

- recent messages are kept
- older messages are summarized automatically


## Automatic Chat Titles

The first user message generates a short title for the chat session.


## Multi-Chat System

The interface supports multiple conversations.

Chats can be:

- created
- switched
- deleted


## Retrieval Augmented Generation (RAG)

User queries are augmented with relevant knowledge using embeddings before being sent to the model.


## Edge Deployment

The entire system runs at the **Cloudflare edge network**, providing:

- low latency
- global scalability
- distributed compute




# API Reference

Although LYTA includes a browser UI, the backend is exposed as an API.


## POST /chat

Send a message and receive a full response.

```json
{
  "message": "Hello"
}

Response:

{
  "reply": "Hello!"
}

POST /chat/stream

Streams the response tokens using Server-Sent Events.

GET /history

Returns recent conversation messages.

GET /meta

Returns metadata about a chat session.

Example response:

{
  "title": "Edge AI Architecture"
}

GET /stats

Returns session statistics.

Example:

{
  "messageCount": 6,
  "hasSummary": true
}

POST /reset

Deletes the conversation history for a session.

Running Locally

Requirements
	•	Node.js 18+
	•	Wrangler CLI

Install Dependencies

npm install

Start Development Server

wrangler dev --remote

Open

http://localhost:8787



Technologies

LYTA is built using:
	•	Cloudflare Workers
	•	Durable Objects
	•	Workers AI
	•	TypeScript
	•	Server-Sent Events
	•	Vector embeddings
	•	Retrieval Augmented Generation


Design Goals

This project demonstrates:
	•	edge-native AI system architecture
	•	strongly consistent session state
	•	streaming-safe persistence
	•	scalable multi-chat infrastructure
	•	modular LLM integration



Future Improvements

Planned enhancements include:
	•	vector-based long-term memory
	•	user profiles and customization
	•	theme and UI personalization
	•	tool / function calling
	•	analytics and usage tracking



Author

Parth Rohit

Software Engineer

