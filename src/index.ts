export interface Env {
  AI: any;
  CONVERSATION: DurableObjectNamespace;
}

/**
 * Worker Router
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -------------------------
    // HEALTH
    // -------------------------
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "LYTA" });
    }

    // -------------------------
    // STATS
    // -------------------------
    if (url.pathname === "/stats" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") || "default";
      const id = env.CONVERSATION.idFromName(sessionId);
      const stub = env.CONVERSATION.get(id);
      return stub.fetch("https://internal/stats");
    }

    // -------------------------
    // CHAT (normal)
    // -------------------------
    if (url.pathname === "/chat" && request.method === "POST") {
      const body = await safeJson(request);
      if (!body?.message) {
        return new Response("Message required", { status: 400 });
      }

      const id = env.CONVERSATION.idFromName(body.sessionId || "default");
      const stub = env.CONVERSATION.get(id);

      return stub.fetch("https://internal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: body.message }),
      });
    }

    // -------------------------
    // CHAT (streaming)
    // -------------------------
    if (url.pathname === "/chat/stream" && request.method === "POST") {
      const body = await safeJson(request);
      if (!body?.message) {
        return new Response("Message required", { status: 400 });
      }

      const id = env.CONVERSATION.idFromName(body.sessionId || "default");
      const stub = env.CONVERSATION.get(id);

      return stub.fetch("https://internal/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: body.message }),
      });
    }

    // -------------------------
    // RESET
    // -------------------------
    if (url.pathname === "/reset" && request.method === "POST") {
      const body = await safeJson(request);
      const id = env.CONVERSATION.idFromName(body?.sessionId || "default");
      const stub = env.CONVERSATION.get(id);
      return stub.fetch("https://internal/reset", { method: "POST" });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// -------------------------
// DURABLE OBJECT
// -------------------------
export class Conversation {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    // -------------------------
    // RESET
    // -------------------------
    if (pathname === "/reset" && request.method === "POST") {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    // -------------------------
    // STATS
    // -------------------------
    if (pathname === "/stats" && request.method === "GET") {
      const history =
        (await this.state.storage.get<any[]>("history")) || [];
      const profileName =
        await this.state.storage.get<string>("profile_name");
      const rl =
        await this.state.storage.get<{ start: number; count: number }>("rl");

      return Response.json({
        messageCount: history.length,
        profileName: profileName || null,
        rateLimit: rl || null,
      });
    }

    // -------------------------
    // CHAT (STREAM)
    // -------------------------
    if (pathname === "/chat/stream" && request.method === "POST") {
      const body = await safeJson(request);
      if (!body?.message) {
        return new Response("Message required", { status: 400 });
      }

      await this.enforceRateLimit();

      let history = await this.loadHistory();
      history.push({ role: "user", content: body.message });
      history = boundHistory(history);

      const stream = await this.env.AI.run(
        "@cf/meta/llama-3-8b-instruct",
        {
          messages: history,
          stream: true,
        }
      );

      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    // -------------------------
    // CHAT (NORMAL)
    // -------------------------
    if (pathname === "/chat" && request.method === "POST") {
      const body = await safeJson(request);
      if (!body?.message) {
        return new Response("Message required", { status: 400 });
      }

      await this.enforceRateLimit();

      let history = await this.loadHistory();

      // Extract profile memory
      const nameMatch = body.message.match(
        /my name is\s+([A-Za-z][A-Za-z\-']{1,30})/i
      );
      if (nameMatch) {
        await this.state.storage.put("profile_name", nameMatch[1]);
      }

      history.push({ role: "user", content: body.message });
      history = boundHistory(history);

      let aiResponse: any;
      try {
        aiResponse = await this.env.AI.run(
          "@cf/meta/llama-3-8b-instruct",
          { messages: history }
        );
      } catch {
        return Response.json(
          { reply: "AI service error." },
          { status: 500 }
        );
      }

      const reply =
        aiResponse?.response ?? "No response from model.";

      history.push({ role: "assistant", content: reply });
      await this.state.storage.put("history", history);

      const savedName =
        await this.state.storage.get<string>("profile_name");

      return Response.json({
        reply,
        memory: savedName ? { name: savedName } : undefined,
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  // -------------------------
  // HELPERS
  // -------------------------

  async loadHistory() {
    let history =
      (await this.state.storage.get<any[]>("history")) || null;

    if (!history) {
      history = [
        {
          role: "system",
          content:
            "You are LYTA, an edge-deployed AI assistant running on Cloudflare Workers AI. " +
            "You remember session context within this session. " +
            "You do NOT have live internet or real-time data. " +
            "If asked about real-time information, clearly state you do not have live access.",
        },
      ];
    }

    return history;
  }

  async enforceRateLimit() {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
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
      throw new Error("Rate limit exceeded");
    }
  }
}

// -------------------------
// UTILITIES
// -------------------------

async function safeJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function boundHistory(history: any[]) {
  const MAX_MESSAGES = 20;
  if (history.length > MAX_MESSAGES) {
    return [history[0], ...history.slice(-(MAX_MESSAGES - 1))];
  }
  return history;
}