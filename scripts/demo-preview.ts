// Local preview of the LYTA UI with no Cloudflare account: serves pages/ and
// routes API calls through the real router and Durable Objects, backed by
// in-memory storage and a scripted model (the same approach as the
// integration tests). With SEED=1 it pre-builds a demo workspace (sources, a
// review, a challenge, and records) and gives every cookieless visitor that
// workspace, which is how assets/demo.png is captured.
//
//   SEED=1 npx tsx scripts/demo-preview.ts        # http://localhost:8799
//
// Not for production: nothing persists and every model reply is canned.
import { createServer } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { router } from "../src/router"
import { Workspace } from "../src/durable/workspace"
import { Conversation } from "../src/durable/conversation"
import { AuthDirectory } from "../src/durable/authDirectory"
import { RateLimiter } from "../src/durable/rateLimiter"
import type { Env } from "../src/index"

const PORT = Number(process.env.PORT || 8799)
const SEED = Boolean(process.env.SEED)
const DEMO_COOKIE = "lyta_guest=demoworkspace"
const root = (path: string) => join(__dirname, "..", path)

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function memoryState() {
  const values = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => clone(values.get(key)),
      put: async (key: string, value: unknown) => void values.set(key, clone(value)),
      delete: async (key: string | string[]) => [key].flat().forEach((item) => values.delete(item)),
      deleteAll: async () => values.clear(),
      list: async () => new Map(values),
      setAlarm: async () => undefined
    }
  } as unknown as DurableObjectState
}

function namespace(create: () => { fetch: (request: Request) => Promise<Response> }) {
  const instances = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!instances.has(id)) instances.set(id, create())
      const instance = instances.get(id)!
      return {
        fetch: (input: RequestInfo, init?: RequestInit) =>
          instance.fetch(input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init))
      }
    }
  } as unknown as DurableObjectNamespace
}

const reviewReply = {
  readiness: "needs evidence",
  rationale:
    "Call sites stay behind SessionStore and the risks are named, but there is no load-test evidence for p99 latency and multi-AZ failover is deferred.",
  findings: [
    {
      title: "SessionStore keeps gateway call sites unchanged",
      detail: "RedisSessionStore replaces LocalSessionCache behind the existing interface.",
      classification: "evidence-backed",
      areaType: "interface",
      area: "api-gateway SessionStore",
      citations: ["E3"]
    },
    {
      title: "Single-AZ Redis is acceptable as a launch configuration",
      detail: "Multi-AZ failover is proposed as a fast follow given current traffic.",
      classification: "evidence-backed",
      areaType: "data-path",
      area: "ElastiCache topology",
      citations: ["E4"]
    },
    {
      title: "Every session read adds a network round-trip",
      detail: "p99 gateway latency must be re-measured with Redis-backed sessions.",
      classification: "evidence-backed",
      areaType: "operations",
      area: "gateway p99 latency",
      citations: ["E4"]
    },
    {
      title: "Users active during cutover are logged out once",
      classification: "evidence-backed",
      areaType: "data-path",
      area: "session migration",
      citations: ["E4"]
    },
    {
      title: "Latency stays within budget",
      classification: "evidence-backed",
      areaType: "operations",
      area: "gateway p99",
      citations: ["E12"]
    },
    { title: "Load test p99 before rollout", classification: "recommendation", areaType: "operations", area: "release plan", citations: [] }
  ],
  requiredTests: [
    "Load test p99 gateway latency with Redis-backed sessions.",
    "Failover drill: restart a gateway instance and confirm sessions survive."
  ],
  observability: ["Redis latency and cache hit/miss metrics.", "Forced re-login rate alert."],
  rollback: ["Switch SessionStore back to LocalSessionCache via configuration."],
  missingEvidence: ["Load-test results for Redis-backed session reads.", "An owner and date for the multi-AZ fast follow."],
  assumptions: ["Current traffic makes a zone outage unlikely before multi-AZ ships."],
  openQuestions: ["Who is on call for the ElastiCache cluster?"],
  nextActions: ["Schedule the load test.", "Decide on multi-AZ before launch."]
}

const revisedChallenge = {
  outcome: "revised",
  rationale: "ADR-014 forbids single-AZ stores for session state, which the proposal treats as a fast follow.",
  counterEvidence: ["E7"],
  revisedFinding: {
    title: "Single-AZ Redis conflicts with ADR-014",
    detail: "ADR-014 requires a multi-AZ datastore for auth-critical session state, so single-AZ cannot be the launch configuration.",
    classification: "evidence-backed",
    areaType: "prior-decision",
    area: "ADR-014 session storage",
    citations: ["E7"]
  }
}
const upheldChallenge = { outcome: "upheld", rationale: "No source contradicts this finding.", counterEvidence: ["E1"] }

const env = {} as Env
Object.assign(env, {
  AI: {
    async run(model: string, input: { text?: string; messages?: Array<{ content: unknown }> }) {
      // Text-keyed embeddings: the ADR only ranks first for queries that mention it.
      if (model.includes("bge")) return { data: [String(input.text).includes("ADR-014") ? [0, 1, 0] : [1, 0, 0]] }
      const prompt = JSON.stringify(input.messages || [])
      if (String(input.messages?.[0]?.content).includes("challenging ONE finding")) {
        return { response: JSON.stringify(prompt.includes("ADR-014") ? revisedChallenge : upheldChallenge) }
      }
      if (prompt.includes("Architecture Change Review")) return { response: JSON.stringify(reviewReply) }
      return { response: "This is a scripted demo reply. Run `npm run dev` with a Workers AI binding for real answers." }
    }
  },
  ARTIFACTS: { put: async () => null, delete: async () => undefined },
  AUTH_DIRECTORY: namespace(() => new AuthDirectory(memoryState())),
  WORKSPACE: namespace(() => new Workspace(memoryState(), env)),
  CONVERSATION: namespace(() => new Conversation(memoryState(), env)),
  RATE_LIMITER: namespace(() => new RateLimiter(memoryState())),
  SESSION_INDEX: namespace(() => ({ fetch: async () => new Response("Not Found", { status: 404 }) }))
})

async function call(path: string, body?: unknown) {
  const response = await router(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: DEMO_COOKIE, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    env
  )
  return response.json() as Promise<Record<string, any>>
}

async function seed() {
  await call("/workspace/bootstrap")
  const runbook = [
    "Gateway runbook. Deploys roll one instance at a time behind the round-robin load balancer and wait for health checks before continuing.",
    "Session dashboards read from the gateway metrics endpoint; alerts page the platform on-call when forced re-logins exceed one percent.",
    "Rollback restores the previous gateway image; configuration lives in the deployment manifest and is versioned with each release."
  ]
    .join("\n\n")
    .repeat(3)
  const sources: Array<[string, string]> = [
    ["demo-architecture-change.md", readFileSync(root("fixtures/demo-architecture-change.md"), "utf8")],
    ["gateway-runbook.md", runbook],
    [
      "adr-014-session-storage.md",
      "ADR-014 (accepted): auth-critical session state must live in a multi-AZ datastore. Single-AZ stores are not permitted for session or token data."
    ]
  ]
  const sourceFileIds: string[] = []
  for (const [name, text] of sources) {
    const imported = await call("/library/import", {
      attachments: [{ kind: "document", name, mimeType: "text/markdown", size: text.length, extractedText: text }]
    })
    sourceFileIds.push(imported.files[0].libraryFileId)
  }

  const { review } = await call("/reviews", {
    proposedChange:
      "Replace the API gateway's in-process LRU session cache with a single-AZ ElastiCache Redis instance behind the SessionStore interface.",
    intendedOutcome: "Sessions survive gateway restarts and are valid on every gateway instance.",
    constraints: "p99 gateway latency must stay within budget.",
    sourceFileIds
  })
  await call(`/reviews/${review.id}/findings/F2/challenge`, { reason: "Does ADR-014 allow a single-AZ store?" })
  await call(`/reviews/${review.id}/findings/F1`, { disposition: "accepted", recordAs: "decision" })
  await call(`/reviews/${review.id}/findings/F3`, { disposition: "accepted", recordAs: "risk" })
  await call(`/reviews/${review.id}/findings/F6`, { disposition: "accepted", recordAs: "follow-up" })
  await call("/context/records", {
    kind: "assumption",
    title: "Traffic stays at today's volume until multi-AZ ships",
    content: "Platform team estimate; revisit if peak traffic grows more than 20%."
  })
  console.log(`[demo-preview] seeded review ${review.id}`)
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }

async function main() {
  if (SEED) await seed()
  serve()
}

function serve() {
  createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url || "/", `http://localhost:${PORT}`)
    const file = root(`pages${url.pathname === "/" ? "/index.html" : url.pathname}`)

    if (incoming.method === "GET" && extname(file) && existsSync(file)) {
      outgoing.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] || "application/octet-stream" })
      outgoing.end(readFileSync(file))
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(chunk as Buffer)
    const headers = new Headers(incoming.headers as Record<string, string>)
    if (SEED && !(headers.get("cookie") || "").includes("lyta_")) headers.set("cookie", DEMO_COOKIE)

    const response = await router(
      new Request(url, { method: incoming.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }),
      env
    )
    const responseHeaders: Record<string, string | string[]> = {}
    response.headers.forEach((value, key) => (responseHeaders[key] = value))
    const cookies = response.headers.getSetCookie()
    if (cookies.length) responseHeaders["set-cookie"] = cookies
    outgoing.writeHead(response.status, responseHeaders)
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  }).listen(PORT, () => console.log(`[demo-preview] http://localhost:${PORT}`))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
