export interface Env {
  AI: any;
  CONVERSATION: DurableObjectNamespace;
}

/**
 * Worker router:
 * - GET /health
 * - POST /chat  { sessionId, message }
 * - POST /reset { sessionId }
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "LYTA" });
    }

    // Chat
    if (url.pathname === "/chat" && request.method === "POST") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const { message, sessionId } = body;
      if (!message || typeof message !== "string") {
        return new Response("Message required", { status: 400 });
      }

      const id = env.CONVERSATION.idFromName(sessionId || "default");
      const stub = env.CONVERSATION.get(id);

      return stub.fetch("https://internal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
    }

    // Reset
    if (url.pathname === "/reset" && request.method === "POST") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const { sessionId } = body;

      const id = env.CONVERSATION.idFromName(sessionId || "default");
      const stub = env.CONVERSATION.get(id);

      return stub.fetch("https://internal/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true }),
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

export class Conversation {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    // Reset endpoint (per session)
    if (pathname === "/reset" && request.method === "POST") {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    // Chat endpoint
    if (pathname !== "/chat" || request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const { message } = body;
    if (!message || typeof message !== "string") {
      return new Response("Message required", { status: 400 });
    }

    // -------------------------
    // Rate limit (per session)
    // -------------------------
    const now = Date.now();
    const windowMs = 10 * 60 * 1000; // 10 minutes
    const limit = 30;

    const rl =
      (await this.state.storage.get<{ start: number; count: number }>("rl")) || {
        start: now,
        count: 0,
      };

    if (now - rl.start > windowMs) {
      rl.start = now;
      rl.count = 0;
    }

    rl.count += 1;
    await this.state.storage.put("rl", rl);

    if (rl.count > limit) {
      return Response.json(
        { reply: "Rate limit hit. Try again in a few minutes." },
        { status: 429 }
      );
    }

    // -------------------------
    // Load / init history
    // -------------------------
    let history = (await this.state.storage.get<any[]>("history")) || null;

    if (!history) {
      history = [
        {
          role: "system",
          content:
            "You are LYTA, an edge-deployed AI assistant running on Cloudflare Workers AI. " +
            "You remember session context within this session. " +
            "You do NOT have live internet or real-time data. " +
            "If asked about real-time info (weather, stock prices, breaking news, live events), " +
            "you must say you don't have live access and suggest the user check a reliable source.",
        },
      ];
    }

    // Extract lightweight memory (name)
    const nameMatch = message.match(/my name is\s+([A-Za-z][A-Za-z\-']{1,30})/i);
    if (nameMatch) {
      await this.state.storage.put("profile_name", nameMatch[1]);
    }

    // Add user message
    history.push({ role: "user", content: message });

    // Keep memory bounded BEFORE model call
    const MAX_MESSAGES = 20;
    if (history.length > MAX_MESSAGES) {
      history = [history[0], ...history.slice(-(MAX_MESSAGES - 1))];
    }

    // -------------------------
    // Run LLM
    // -------------------------
    let aiResponse: any;
    try {
      aiResponse = await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: history,
      });
    } catch {
      return Response.json(
        { reply: "AI service error. Please try again." },
        { status: 500 }
      );
    }

    const reply = aiResponse?.response ?? "Sorry — no response from model.";

    // Store assistant reply + persist history
    history.push({ role: "assistant", content: reply });
    await this.state.storage.put("history", history);

    const savedName = await this.state.storage.get<string>("profile_name");

    return Response.json({
      reply,
      memory: savedName ? { name: savedName } : undefined,
    });
  }
}