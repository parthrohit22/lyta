import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { router } from "../../src/router"
import { Workspace } from "../../src/durable/workspace"
import { Conversation } from "../../src/durable/conversation"
import { AuthDirectory } from "../../src/durable/authDirectory"
import { RateLimiter } from "../../src/durable/rateLimiter"
import { REVIEW_CONTEXT_POLICY_VERSION, type ArchitectureReview } from "../../src/review/contract"
import type { Env } from "../../src/index"

// End-to-end coverage for the four paths issue #10 requires (happy path,
// missing evidence, conflicting sources, inaccessible/deleted source), driven
// through the real router and Durable Objects against faked storage and a
// scripted review model.

const demoChange = readFileSync(new URL("../../fixtures/demo-architecture-change.md", import.meta.url), "utf8")

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function createDurableState() {
  const values = new Map<string, unknown>()
  return {
    storage: {
      get: async <T>(key: string) => clone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => values.set(key, clone(value)),
      delete: async (key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
      },
      deleteAll: async () => values.clear(),
      list: async <T>({ prefix }: { prefix?: string } = {}) =>
        new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix))) as Map<string, T>,
      setAlarm: async () => undefined
    }
  } as unknown as DurableObjectState
}

function createFakeNamespace(createInstance: () => { fetch: (request: Request) => Promise<Response> }) {
  const instances = new Map<string, { fetch: (request: Request) => Promise<Response> }>()

  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!instances.has(id)) {
        instances.set(id, createInstance())
      }

      const instance = instances.get(id)!

      return {
        fetch: async (input: RequestInfo, init?: RequestInit) =>
          instance.fetch(input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init))
      }
    }
  } as unknown as DurableObjectNamespace
}

interface ModelCall {
  model: string
  messages: Array<{ role: string; content: string }>
}

function createReviewEnv(script: { reply: unknown }) {
  const env = {} as Env
  const modelCalls: ModelCall[] = []

  Object.assign(env, {
    AI: {
      async run(model: string, input: { messages?: ModelCall["messages"] }) {
        if (model.includes("bge")) {
          return { data: [[1, 0, 0]] }
        }
        modelCalls.push({ model, messages: input.messages || [] })
        return { response: typeof script.reply === "string" ? script.reply : JSON.stringify(script.reply) }
      }
    },
    ARTIFACTS: {
      put: async () => null,
      delete: async () => undefined
    },
    AUTH_DIRECTORY: createFakeNamespace(() => new AuthDirectory(createDurableState())),
    WORKSPACE: createFakeNamespace(() => new Workspace(createDurableState(), env)),
    CONVERSATION: createFakeNamespace(() => new Conversation(createDurableState(), env)),
    RATE_LIMITER: createFakeNamespace(() => new RateLimiter(createDurableState())),
    SESSION_INDEX: createFakeNamespace(() => ({ fetch: async () => new Response("Not Found", { status: 404 }) }))
  } satisfies Omit<Env, never>)

  return { env, modelCalls }
}

async function signIn(env: Env, email: string) {
  const response = await router(
    new Request("https://internal/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password: "review-suite-password" })
    }),
    env
  )
  const match = (response.headers.get("Set-Cookie") || "").match(/lyta_auth=([^;]+)/)
  const cookie = match ? `lyta_auth=${match[1]}` : ""

  return (path: string, init: RequestInit = {}) =>
    router(
      new Request(`https://internal${path}`, {
        ...init,
        headers: { ...(init.headers || {}), Cookie: cookie, "Content-Type": "application/json" }
      }),
      env
    )
}

type Client = Awaited<ReturnType<typeof signIn>>

async function importDocument(client: Client, name: string, text: string) {
  const response = await client("/library/import", {
    method: "POST",
    body: JSON.stringify({
      attachments: [{ kind: "document", name, mimeType: "text/markdown", size: text.length, extractedText: text }]
    })
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { files: Array<{ libraryFileId: string }> }
  return body.files[0].libraryFileId
}

async function createReview(client: Client, sourceFileIds: string[]) {
  const response = await client("/reviews", {
    method: "POST",
    body: JSON.stringify({
      proposedChange: "Move API gateway session storage from the in-process LRU cache to a single-AZ ElastiCache Redis instance.",
      intendedOutcome: "Sessions survive gateway restarts and work on every instance.",
      constraints: "p99 gateway latency must stay within budget.",
      sourceFileIds
    })
  })
  return { response, body: (await response.json().catch(() => ({}))) as { review?: ArchitectureReview; error?: string } }
}

const happyReply = {
  readiness: "ready",
  rationale: "The proposal keeps call sites behind the SessionStore interface and names its main risks.",
  findings: [
    {
      title: "Gateway call sites are unaffected",
      detail: "RedisSessionStore replaces LocalSessionCache behind the existing SessionStore interface.",
      classification: "evidence-backed",
      areaType: "interface",
      area: "api-gateway SessionStore",
      citations: ["E1"]
    },
    {
      title: "Single-AZ Redis widens the failure blast radius",
      classification: "evidence-backed",
      areaType: "data-path",
      area: "session reads and writes",
      citations: ["E2", "E9"]
    },
    {
      title: "Redis latency will stay within budget",
      classification: "evidence-backed",
      areaType: "operations",
      area: "gateway p99",
      citations: ["E42"]
    },
    {
      title: "Plan multi-AZ failover before traffic grows",
      classification: "recommendation",
      areaType: "operations",
      area: "ElastiCache",
      citations: []
    }
  ],
  requiredTests: ["Load test p99 gateway latency with Redis-backed sessions."],
  observability: ["Cache hit/miss and Redis latency metrics."],
  rollback: ["Switch SessionStore back to LocalSessionCache via configuration."],
  missingEvidence: []
}

test("happy path: review retrieves only selected sources, validates citations, persists, and exports", async () => {
  const { env, modelCalls } = createReviewEnv({ reply: happyReply })
  const client = await signIn(env, "happy@review.test")
  const demoId = await importDocument(client, "demo-architecture-change.md", demoChange)
  await importDocument(client, "unrelated-billing-notes.md", "UNSELECTED-SECRET billing notes that must not reach the review prompt.")

  // The source picker pages the library, so the router must forward the cursor.
  const secondPage = (await (await client("/library?cursor=1&limit=1")).json()) as { files: Array<{ libraryFileId: string }> }
  assert.deepEqual(
    secondPage.files.map((file) => file.libraryFileId),
    [demoId]
  )

  const { response, body } = await createReview(client, [demoId])
  assert.equal(response.status, 201)
  const review = body.review!
  assert.match(review.id, /^review_/)
  assert.equal(review.readiness, "ready")
  assert.deepEqual(
    review.sources.map((source) => source.fileName),
    ["demo-architecture-change.md"]
  )
  assert.ok(review.evidence.length >= 2)
  assert.ok(review.evidence.every((item) => item.fileId === demoId))

  // Evidence came only from the selected source, inside the untrusted wrapper.
  assert.equal(modelCalls.length, 1)
  const prompt = JSON.stringify(modelCalls[0].messages)
  assert.match(prompt, /UNTRUSTED RETRIEVED SOURCE DATA/)
  assert.match(prompt, /<lyta-source id=\\"E1\\" file=\\"demo-architecture-change.md\\">/)
  assert.doesNotMatch(prompt, /UNSELECTED-SECRET/)

  const [f1, f2, f3, f4] = review.findings
  assert.equal(f1.classification, "evidence-backed")
  assert.deepEqual(f1.citationIds, [review.evidence[0].chunkId])
  assert.equal(f2.classification, "evidence-backed")
  assert.deepEqual(f2.citationIds, [review.evidence[1].chunkId], "unknown citation E9 is dropped")
  assert.match(f2.adjustments.join(" "), /E9/)
  assert.equal(f3.classification, "inference", "evidence-backed with only invented citations is downgraded")
  assert.match(f3.adjustments.join(" "), /Downgraded/)
  assert.equal(f4.classification, "recommendation")
  assert.ok(review.findings.every((finding) => finding.disposition === "unresolved"))

  const manifests = (await (await client("/context/manifests")).json()) as {
    manifests: Array<{ requestId: string; policyVersion: string; selectedSourceFileIds: string[] }>
  }
  assert.equal(manifests.manifests[0].requestId, review.requestId)
  assert.equal(manifests.manifests[0].policyVersion, REVIEW_CONTEXT_POLICY_VERSION)
  assert.deepEqual(manifests.manifests[0].selectedSourceFileIds, [demoId])

  const list = (await (await client("/reviews")).json()) as { reviews: Array<{ id: string; readiness: string }> }
  assert.deepEqual(
    list.reviews.map((item) => [item.id, item.readiness]),
    [[review.id, "ready"]]
  )

  // Disposition: accepting promotes the finding into canonical context with provenance.
  const accepted = await client(`/reviews/${review.id}/findings/F1`, {
    method: "POST",
    body: JSON.stringify({ disposition: "accepted", note: "Confirmed with the gateway owner." })
  })
  assert.equal(accepted.status, 200)
  const acceptedBody = (await accepted.json()) as { finding: { disposition: string; contextRecordId: string } }
  assert.equal(acceptedBody.finding.disposition, "accepted")
  const context = (await (await client("/context?includeContent=true")).json()) as {
    records: Array<{ id: string; kind: string; content: string; provenance: { sourceFileIds: string[]; chunkIds: string[] } }>
  }
  const record = context.records.find((candidate) => candidate.id === acceptedBody.finding.contextRecordId)!
  assert.equal(record.kind, "finding")
  assert.deepEqual(record.provenance.sourceFileIds, [demoId])
  assert.deepEqual(record.provenance.chunkIds, [review.evidence[0].chunkId])
  assert.match(record.content, /Classification: evidence-backed/)

  await client(`/reviews/${review.id}/findings/F2`, { method: "POST", body: JSON.stringify({ disposition: "rejected" }) })

  // Export keeps classifications, dispositions, source names, excerpts, and readiness.
  const exported = await client(`/reviews/${review.id}/export`)
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get("Content-Type") || "", /text\/markdown/)
  assert.match(exported.headers.get("Content-Disposition") || "", /attachment; filename="lyta-review-review_/)
  const brief = await exported.text()
  assert.match(brief, /\*\*Readiness: READY\*\*/)
  assert.match(brief, /### F1 · Gateway call sites are unaffected/)
  assert.match(brief, /Classification: \*\*evidence-backed\*\*/)
  assert.match(brief, /Classification: \*\*inference\*\*/)
  assert.match(brief, /Disposition: accepted \(saved as finding\) — Confirmed with the gateway owner\./)
  assert.match(brief, /Disposition: rejected/)
  assert.match(brief, /\[E1\]\(#evidence-e1\) demo-architecture-change\.md/)
  assert.match(brief, /### E1 · demo-architecture-change\.md/)
  assert.ok(brief.includes(`> ${review.evidence[0].snippet.split("\n")[0]}`), "brief quotes the source excerpt")

  // Returning the finding to unresolved removes its context record again.
  await client(`/reviews/${review.id}/findings/F1`, { method: "POST", body: JSON.stringify({ disposition: "unresolved" }) })
  const after = (await (await client("/context?includeContent=true")).json()) as { records: unknown[] }
  assert.equal(after.records.length, 0)
})

test("missing evidence: a source with no readable text cannot produce a ready review", async () => {
  const { env, modelCalls } = createReviewEnv({
    reply: {
      readiness: "ready",
      rationale: "Looks fine.",
      findings: [{ title: "Redis is already approved", classification: "evidence-backed", areaType: "prior-decision", citations: ["E1"] }]
    }
  })
  const client = await signIn(env, "missing@review.test")
  const emptyId = await importDocument(client, "scanned-diagram.pdf", "")

  const { response, body } = await createReview(client, [emptyId])
  assert.equal(response.status, 201)
  const review = body.review!
  assert.equal(review.evidence.length, 0)
  assert.equal(review.readiness, "needs evidence")
  assert.match(review.adjustments.join(" "), /no evidence was retrieved/)
  assert.equal(review.findings[0].classification, "inference")
  assert.deepEqual(review.findings[0].citationIds, [])
  assert.ok(review.missingEvidence.length > 0, "absent evidence is called out")
  assert.match(JSON.stringify(modelCalls[0].messages), /No evidence was retrieved from the selected sources/)

  const brief = await (await client(`/reviews/${review.id}/export`)).text()
  assert.match(brief, /\*\*Readiness: NEEDS EVIDENCE\*\*/)
  assert.match(brief, /No passages were retrieved from the selected sources/)
  assert.match(brief, /No rollback evidence was identified/)
})

test("conflicting sources: an unreconciled conflict blocks a ready verdict and keeps both citations", async () => {
  const { env } = createReviewEnv({
    reply: {
      readiness: "ready",
      rationale: "The change is small and well understood.",
      findings: [
        {
          title: "Single-AZ Redis conflicts with the session-store ADR",
          classification: "evidence-backed",
          areaType: "prior-decision",
          area: "ADR-014 session storage",
          citations: ["E1", "E2"]
        }
      ],
      conflicts: [
        { description: "The proposal starts single-AZ; ADR-014 requires multi-AZ for auth-critical state.", citations: ["E1", "E2"] },
        { description: "One-sided conflict that cites a single source.", citations: ["E1"] }
      ]
    }
  })
  const client = await signIn(env, "conflict@review.test")
  const proposalId = await importDocument(
    client,
    "session-proposal.md",
    "Proposal: replace the in-process cache with a single-AZ ElastiCache Redis instance. Multi-AZ failover is a fast follow."
  )
  const adrId = await importDocument(
    client,
    "adr-014-session-storage.md",
    "ADR-014 (accepted): auth-critical session state must live in a multi-AZ datastore. Single-AZ stores are not permitted."
  )

  const { response, body } = await createReview(client, [proposalId, adrId])
  assert.equal(response.status, 201)
  const review = body.review!
  assert.equal(review.readiness, "needs evidence")
  assert.match(review.adjustments.join(" "), /sources conflict/)
  assert.equal(review.conflicts.length, 1)
  assert.deepEqual(
    review.conflicts[0].citationIds.map((chunkId) => review.evidence.find((item) => item.chunkId === chunkId)?.fileId),
    [proposalId, adrId]
  )
  assert.match(review.adjustments.join(" "), /Dropped a conflict without two retrieved sources/)

  const brief = await (await client(`/reviews/${review.id}/export`)).text()
  assert.match(brief, /## Conflicting sources/)
  assert.match(brief, /session-proposal\.md; \[E2\]\(#evidence-e2\) adr-014-session-storage\.md/)
})

test("inaccessible sources: deleted and cross-workspace files are refused before the model runs", async () => {
  const { env, modelCalls } = createReviewEnv({ reply: happyReply })
  const owner = await signIn(env, "owner@review.test")
  const other = await signIn(env, "other@review.test")
  const ownerFileId = await importDocument(owner, "owner-private.md", demoChange)
  const otherFileId = await importDocument(other, "deleted-later.md", demoChange)
  await other("/library/delete", { method: "POST", body: JSON.stringify({ id: otherFileId }) })

  const crossWorkspace = await createReview(other, [ownerFileId])
  assert.equal(crossWorkspace.response.status, 409)
  assert.match(crossWorkspace.body.error || "", /no longer available/)
  assert.deepEqual((crossWorkspace.body as { unavailableSourceFileIds?: string[] }).unavailableSourceFileIds, [ownerFileId])

  const deleted = await createReview(other, [otherFileId])
  assert.equal(deleted.response.status, 409)

  assert.equal(modelCalls.length, 0)
  const list = (await (await other("/reviews")).json()) as { reviews: unknown[] }
  assert.deepEqual(list.reviews, [])
  assert.equal((await other("/reviews/review_doesnotexist")).status, 404)
})

test("deleting a cited source after review strips its excerpts and invalidates accepted findings", async () => {
  const { env } = createReviewEnv({ reply: happyReply })
  const client = await signIn(env, "delete-after@review.test")
  const demoId = await importDocument(client, "demo-architecture-change.md", demoChange)
  const { body } = await createReview(client, [demoId])
  const review = body.review!
  const snippet = review.evidence[0].snippet
  await client(`/reviews/${review.id}/findings/F1`, { method: "POST", body: JSON.stringify({ disposition: "accepted" }) })

  const deleted = (await (await client("/library/delete", { method: "POST", body: JSON.stringify({ id: demoId }) })).json()) as {
    deletionImpact: { removedDerivedRecords: number; affectedReviews: number }
  }
  assert.equal(deleted.deletionImpact.removedDerivedRecords, 1)
  assert.equal(deleted.deletionImpact.affectedReviews, 1)

  const stored = ((await (await client(`/reviews/${review.id}`)).json()) as { review: ArchitectureReview }).review
  assert.ok(stored.evidence.every((item) => item.sourceDeleted && item.snippet === ""))
  assert.equal(stored.findings[0].contextRecordId, null)

  const brief = await (await client(`/reviews/${review.id}/export`)).text()
  assert.ok(!brief.includes(snippet))
  assert.match(brief, /deleted after the review was created/)
})

test("malformed model output is an error, never a stored review", async () => {
  for (const reply of [
    "Sure! Here is my review: the change looks ready to ship.",
    { readiness: "probably fine", rationale: "x", findings: [] },
    { readiness: "ready", rationale: "x", findings: [{ title: "No classification" }] }
  ]) {
    const { env } = createReviewEnv({ reply })
    const client = await signIn(env, "malformed@review.test")
    const fileId = await importDocument(client, "demo-architecture-change.md", demoChange)
    const { response, body } = await createReview(client, [fileId])
    assert.equal(response.status, 502)
    assert.match(body.error || "", /No review was saved/)
    assert.equal(body.review, undefined)
    const list = (await (await client("/reviews")).json()) as { reviews: unknown[] }
    assert.deepEqual(list.reviews, [])
  }
})

test("review input and disposition are validated", async () => {
  const { env } = createReviewEnv({ reply: happyReply })
  const client = await signIn(env, "validation@review.test")

  const missingSources = await client("/reviews", {
    method: "POST",
    body: JSON.stringify({ proposedChange: "Change", intendedOutcome: "Outcome", sourceFileIds: [] })
  })
  assert.equal(missingSources.status, 400)
  assert.match(await missingSources.text(), /Select at least one library source/)

  const fileId = await importDocument(client, "demo-architecture-change.md", demoChange)
  const { body } = await createReview(client, [fileId])
  const invalid = await client(`/reviews/${body.review!.id}/findings/F1`, {
    method: "POST",
    body: JSON.stringify({ disposition: "maybe" })
  })
  assert.equal(invalid.status, 400)
  const unknown = await client(`/reviews/${body.review!.id}/findings/F99`, {
    method: "POST",
    body: JSON.stringify({ disposition: "accepted" })
  })
  assert.equal(unknown.status, 404)
})
