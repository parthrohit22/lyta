import type { Env } from "./index"
import { safeJson } from "./utils/safeJson"
import {
  getCookieSession,
  createSessionId,
  setSessionCookie
} from "./utils/cookies"

import { checkRateLimit } from "./utils/rateLimit"

export async function router(request: Request, env: Env): Promise<Response> {

  const url = new URL(request.url)

  console.log(
    JSON.stringify({
      path: url.pathname,
      method: request.method,
      ip: request.headers.get("CF-Connecting-IP"),
      time: new Date().toISOString()
    })
  )

  if (url.pathname === "/" && request.method === "GET") {
    return Response.json({
      service: "LYTA Edge AI",
      status: "running"
    })
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({
      ok: true,
      service: "LYTA"
    })
  }

  const ip = request.headers.get("CF-Connecting-IP")

  if (!checkRateLimit(ip)) {
    return new Response("Rate limit exceeded", { status: 429 })
  }

  let sessionId = url.searchParams.get("session")

  if (!sessionId) {
    sessionId = getCookieSession(request)

    if (!sessionId) {
      sessionId = createSessionId()
    }
  }

  const id = env.CONVERSATION.idFromName(sessionId)
  const stub = env.CONVERSATION.get(id)

  async function forward(path: string, init?: RequestInit) {

    const response =
      await stub.fetch(`https://internal${path}`, init)

    const headers = new Headers(response.headers)

    headers.set(
      "Set-Cookie",
      setSessionCookie(sessionId!)
    )

    return new Response(response.body, {
      status: response.status,
      headers
    })
  }

  if (url.pathname === "/history" && request.method === "GET") {
    return forward("/history")
  }

  if (url.pathname === "/meta" && request.method === "GET") {
    return forward("/meta")
  }

  if (url.pathname === "/stats" && request.method === "GET") {
    return forward("/stats")
  }

  if (url.pathname === "/chat" && request.method === "POST") {

    const body =
      await safeJson<{ message?: string }>(request)

    if (!body?.message) {
      return new Response("Message required", { status: 400 })
    }

    return forward("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: body.message
      })
    })
  }

  if (url.pathname === "/chat/stream" && request.method === "POST") {

    const body =
      await safeJson<{ message?: string }>(request)

    if (!body?.message) {
      return new Response("Message required", { status: 400 })
    }

    return forward("/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: body.message
      })
    })
  }
  if(url.pathname === "/sessions"){

  const id = env.SESSION_INDEX.idFromName("global")
  const stub = env.SESSION_INDEX.get(id)

  return stub.fetch("https://internal/list")
}
  if (url.pathname === "/reset" && request.method === "POST") {
    return forward("/reset", { method: "POST" })
  }

  return new Response("Not Found", { status: 404 })
}