export interface Env {
  AI: any;
  CONVERSATION: DurableObjectNamespace;
}

/**
 * Main Worker Router
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "LYTA" });
    }

    if (url.pathname === "/stats" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") || "default";
      const id = env.CONVERSATION.idFromName(sessionId);
      const stub = env.CONVERSATION.get(id);
      return stub.fetch("https://internal/stats");
    }

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

    if (url.pathname === "/reset" && request.method === "POST") {
      const body = await safeJson(request);
      const id = env.CONVERSATION.idFromName(body?.sessionId || "default");
      const stub = env.CONVERSATION.get(id);
      return stub.fetch("https://internal/reset", { method: "POST" });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// --------------------------------------------------
// Durable Object
// --------------------------------------------------

export class Conversation {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === "/reset") {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    if (pathname === "/stats") {
      const conversation =
        (await this.state.storage.get<any[]>("conversation")) || [];
      const profileName =
        await this.state.storage.get<string>("profile_name");
      const rl =
        await this.state.storage.get<{ start: number; count: number }>("rl");

      return Response.json({
        messageCount: conversation.length,
        profileName: profileName || null,
        rateLimit: rl || null,
      });
    }

    if (pathname === "/chat") {
      return this.handleChat(request, false);
    }

    if (pathname === "/chat/stream") {
      return this.handleChat(request, true);
    }

    return new Response("Not Found", { status: 404 });
  }

  // --------------------------------------------------
  // Core Chat Logic
  // --------------------------------------------------

  private async handleChat(
    request: Request,
    stream: boolean
  ): Promise<Response> {
    const body = await safeJson(request);
    if (!body?.message || typeof body.message !== "string") {
      return new Response("Message required", { status: 400 });
    }

    const message = body.message;

    // -------------------------
    // RATE LIMIT
    // -------------------------
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
      return Response.json(
        { reply: "Rate limit hit. Try again in a few minutes." },
        { status: 429 }
      );
    }

    // -------------------------
    // LOAD CONVERSATION
    // -------------------------
    let conversation =
      (await this.state.storage.get<any[]>("conversation")) || [];

    // -------------------------
    // ADD USER MESSAGE
    // -------------------------
    conversation.push({ role: "user", content: message });

    // -------------------------
    // EXTRACT IDENTITY
    // -------------------------
    const nameMatch = message.match(
      /\b(my name is|i am|this is)\s+([A-Za-z][A-Za-z\-']{1,30})/i
    );

    if (nameMatch) {
      await this.state.storage.put("profile_name", nameMatch[2]);
    }

    // -------------------------
    // MEMORY BOUND (before LLM)
    // -------------------------
    const MAX_MESSAGES = 20;
    if (conversation.length > MAX_MESSAGES) {
      conversation = conversation.slice(-MAX_MESSAGES);
    }

    // -------------------------
    // BUILD SYSTEM PROMPT
    // -------------------------
    const savedName =
      await this.state.storage.get<string>("profile_name");

    const BASE_SYSTEM_PROMPT =
      "You are LYTA, an edge-deployed AI assistant running on Cloudflare Workers AI. " +
      "You maintain structured session memory. " +
      "You provide concise, technically accurate responses. " +
      "You do NOT have live internet access. " +
      "If asked about real-time data (weather, stock prices, breaking news, live events), " +
      "you must clearly state that you do not have live access.";

    const systemMessage = {
      role: "system",
      content: savedName
        ? BASE_SYSTEM_PROMPT +
          ` The user's name is ${savedName}. Address them consistently by this name unless corrected.`
        : BASE_SYSTEM_PROMPT,
    };

    const messages = [systemMessage, ...conversation];

    // -------------------------
    // STREAMING
    // -------------------------
    if (stream) {
      const aiStream = await this.env.AI.run(
        "@cf/meta/llama-3-8b-instruct",
        { messages, stream: true }
      );

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      (async () => {
        const reader = aiStream.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          await writer.write(value);

          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ") && !line.includes("[DONE]")) {
              try {
                const parsed = JSON.parse(line.replace("data: ", ""));
                if (parsed.response) {
                  fullText += parsed.response;
                }
              } catch {}
            }
          }
        }

        conversation.push({
          role: "assistant",
          content: fullText.trim(),
        });

        if (conversation.length > MAX_MESSAGES) {
          conversation = conversation.slice(-MAX_MESSAGES);
        }

        await this.state.storage.put("conversation", conversation);
        await writer.close();
      })();

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // -------------------------
    // NORMAL RESPONSE
    // -------------------------
    let aiResponse: any;
    try {
      aiResponse = await this.env.AI.run(
        "@cf/meta/llama-3-8b-instruct",
        { messages }
      );
    } catch {
      return Response.json(
        { reply: "AI service error. Please try again." },
        { status: 500 }
      );
    }

    const reply =
      aiResponse?.response ?? "No response from model.";

    conversation.push({ role: "assistant", content: reply });

    if (conversation.length > MAX_MESSAGES) {
      conversation = conversation.slice(-MAX_MESSAGES);
    }

    await this.state.storage.put("conversation", conversation);

    return Response.json({
      reply,
      memory: savedName ? { name: savedName } : undefined,
    });
  }
}

// --------------------------------------------------
// Helper
// --------------------------------------------------

async function safeJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}