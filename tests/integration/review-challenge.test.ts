import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { router } from "../../src/router"
import { Workspace } from "../../src/durable/workspace"
import { Conversation } from "../../src/durable/conversation"
import { AuthDirectory } from "../../src/durable/authDirectory"
import { RateLimiter } from "../../src/durable/rateLimiter"
import {
  REVIEW_CHALLENGE_POLICY_VERSION,
  type ArchitectureReview,
  type FindingChallenge,
  type ReviewFinding
} from "../../src/review/contract"
import type { Env } from "../../src/index"

// "Challenge this conclusion" (#7), driven through the real router and Durable
// Objects with faked storage and a scripted model. Embeddings are keyed on
// text: anything mentioning ADR-014 embeds as [0, 1, 0] and everything else as
// [1, 0, 0]. The review's top six passages therefore never include the ADR,
// while a challenge that mentions ADR-014 ranks it first. That holds with or
// without a retrieval similarity floor.

const demoChange = readFileSync(new URL("../../fixtures/demo-architecture-change.md", import.meta.url), "utf8")
const runbook = [
  "Gateway runbook. Deploys roll one instance at a time behind the round-robin load balancer and wait for health checks before continuing.",
  "Session dashboards read from the gateway metrics endpoint; alerts page the platform on-call when forced re-logins exceed one percent.",
  "Rollback restores the previous gateway image; configuration lives in the deployment manifest and is versioned with each release."
]
  .join("\n\n")
  .repeat(3)
const adr = "ADR-014 (accepted): auth-critical session state must live in a multi-AZ datastore. Single-AZ stores are not permitted."

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

/** Each model call takes the next scripted reply. */
function createChallengeEnv(replies: unknown[]) {
  const env = {} as Env
  const modelCalls: Array<Array<{ role: string; content: string }>> = []

  Object.assign(env, {
    AI: {
      async run(model: string, input: { text?: string; messages?: Array<{ role: string; content: string }> }) {
        if (model.includes("bge")) {
          return { data: [String(input.text).includes("ADR-014") ? [0, 1, 0] : [1, 0, 0]] }
        }
        modelCalls.push(input.messages || [])
        const reply = replies[Math.min(modelCalls.length - 1, replies.length - 1)]
        return { response: typeof reply === "string" ? reply : JSON.stringify(reply) }
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
      body: JSON.stringify({ email, password: "challenge-suite-password" })
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
  const body = (await response.json()) as { files: Array<{ libraryFileId: string }> }
  return body.files[0].libraryFileId
}

const reviewReply = {
  readiness: "ready",
  rationale: "Call sites stay behind SessionStore and the proposal names its risks.",
  findings: [
    {
      title: "SessionStore keeps gateway call sites unchanged",
      detail: "RedisSessionStore replaces LocalSessionCache behind the existing interface.",
      classification: "evidence-backed",
      areaType: "interface",
      area: "api-gateway SessionStore",
      citations: ["E1"]
    },
    {
      title: "Single-AZ Redis is acceptable as a launch configuration",
      detail: "Multi-AZ failover is proposed as a fast follow.",
      classification: "evidence-backed",
      areaType: "prior-decision",
      area: "ElastiCache topology",
      citations: ["E4"]
    },
    { title: "Load test gateway p99 before rollout", classification: "recommendation", areaType: "operations", citations: [] }
  ],
  assumptions: ["Current traffic volume makes a zone outage unlikely to matter before multi-AZ ships."],
  openQuestions: ["Who owns the ElastiCache cluster on call?"],
  nextActions: ["Schedule the load test."]
}

/** Imports fixture + runbook + ADR, creates a review over all three, and returns its handles. */
async function setUpReview(replies: unknown[], email: string) {
  const fixture = createChallengeEnv([reviewReply, ...replies])
  const client = await signIn(fixture.env, email)
  const sourceIds = [
    await importDocument(client, "demo-architecture-change.md", demoChange),
    await importDocument(client, "gateway-runbook.md", runbook),
    await importDocument(client, "adr-014-session-storage.md", adr)
  ]
  const created = await client("/reviews", {
    method: "POST",
    body: JSON.stringify({
      proposedChange: "Move API gateway sessions to a single-AZ ElastiCache Redis instance.",
      intendedOutcome: "Sessions survive gateway restarts.",
      sourceFileIds: sourceIds
    })
  })
  assert.equal(created.status, 201)
  const review = ((await created.json()) as { review: ArchitectureReview }).review

  return { ...fixture, client, review, adrId: sourceIds[2] }
}

async function challenge(client: Client, reviewId: string, findingId: string, reason = "") {
  const response = await client(`/reviews/${reviewId}/findings/${findingId}/challenge`, {
    method: "POST",
    body: JSON.stringify({ reason })
  })
  const body = (await response.json().catch(() => ({}))) as {
    review?: ArchitectureReview
    finding?: ReviewFinding
    challenge?: FindingChallenge
    error?: string
  }
  return { response, body }
}

test("happy path: challenge a finding, save findings as project records, and export the history", async () => {
  const { client, review, modelCalls } = await setUpReview(
    [
      {
        outcome: "upheld",
        rationale: "No source contradicts the SessionStore boundary.",
        counterEvidence: ["E1"]
      }
    ],
    "challenge-happy@review.test"
  )
  assert.equal(review.evidence.length, 6)
  assert.ok(!review.evidence.some((item) => item.fileName.startsWith("adr-014")), "the ADR is outside the review's top six")
  assert.deepEqual(review.openQuestions, ["Who owns the ElastiCache cluster on call?"])

  const { response, body } = await challenge(client, review.id, "F1", "Is the interface really unchanged?")
  assert.equal(response.status, 200)
  assert.equal(body.challenge?.outcome, "upheld")
  assert.equal(body.challenge?.conclusionChanged, false)
  assert.equal(body.challenge?.reason, "Is the interface really unchanged?")
  assert.equal(body.finding?.title, review.findings[0].title)
  assert.equal(body.review?.findings[0].challenges.length, 1)
  assert.equal(body.review?.evidence.length, 6, "no new evidence was needed")

  const prompt = JSON.stringify(modelCalls[1])
  assert.match(prompt, /UNTRUSTED RETRIEVED SOURCE DATA/)
  assert.match(prompt, /Finding F1: SessionStore keeps gateway call sites unchanged/)
  assert.match(prompt, /Originally cited: E1/)
  assert.match(prompt, /Is the interface really unchanged\?/)

  const manifests = (await (await client("/context/manifests")).json()) as { manifests: Array<{ policyVersion: string }> }
  assert.equal(manifests.manifests[0].policyVersion, REVIEW_CHALLENGE_POLICY_VERSION)

  // Findings become persisted decision, risk, and follow-up records.
  for (const [findingId, recordAs] of [
    ["F1", "decision"],
    ["F2", "risk"],
    ["F3", "follow-up"]
  ]) {
    const accepted = await client(`/reviews/${review.id}/findings/${findingId}`, {
      method: "POST",
      body: JSON.stringify({ disposition: "accepted", recordAs })
    })
    assert.equal(accepted.status, 200)
  }

  const context = (await (await client("/context?includeContent=true")).json()) as {
    records: Array<{ kind: string; title: string; origin?: { reviewId: string; findingId: string } }>
  }
  assert.deepEqual(context.records.map((record) => [record.kind, record.origin?.findingId]).sort(), [
    ["decision", "F1"],
    ["follow-up", "F3"],
    ["risk", "F2"]
  ])
  assert.ok(context.records.every((record) => record.origin?.reviewId === review.id))

  const brief = await (await client(`/reviews/${review.id}/export`)).text()
  assert.match(brief, /\*\*Challenge history\*\*/)
  assert.match(brief, /F1-C1 · .* · outcome \*\*upheld\*\* · conclusion unchanged/)
  assert.match(brief, /Challenge: Is the interface really unchanged\?/)
  assert.match(brief, /Disposition: accepted \(saved as decision\)/)
  assert.match(brief, /## Open questions\n\n- Who owns the ElastiCache cluster on call\?/)
})

test("a challenge that changes the conclusion revises or withdraws the finding and keeps its history", async () => {
  const { client, review, adrId } = await setUpReview(
    [
      {
        outcome: "revised",
        rationale: "ADR-014 forbids single-AZ stores for session state.",
        counterEvidence: ["E7"],
        revisedFinding: {
          title: "Single-AZ Redis violates ADR-014",
          detail: "Auth-critical session state must be multi-AZ.",
          classification: "evidence-backed",
          areaType: "prior-decision",
          area: "ADR-014",
          citations: ["E7"]
        }
      },
      { outcome: "withdrawn", rationale: "ADR-014 changes the storage contract the finding relied on.", counterEvidence: ["E7"] }
    ],
    "challenge-changed@review.test"
  )
  await client(`/reviews/${review.id}/findings/F2`, { method: "POST", body: JSON.stringify({ disposition: "accepted", recordAs: "risk" }) })

  const revised = await challenge(client, review.id, "F2", "Does ADR-014 allow a single-AZ store?")
  assert.equal(revised.response.status, 200)
  const challengeRecord = revised.body.challenge!
  const adrEvidence = revised.body.review!.evidence.find((item) => item.ref === "E7")!
  assert.equal(adrEvidence.fileId, adrId, "the ADR passage is appended as E7")
  assert.equal(challengeRecord.outcome, "revised")
  assert.equal(challengeRecord.conclusionChanged, true)
  assert.deepEqual(challengeRecord.counterEvidenceIds, [adrEvidence.chunkId])
  assert.equal(challengeRecord.before.title, "Single-AZ Redis is acceptable as a launch configuration")
  assert.equal(challengeRecord.after?.title, "Single-AZ Redis violates ADR-014")
  assert.equal(revised.body.finding?.title, "Single-AZ Redis violates ADR-014")
  assert.deepEqual(revised.body.finding?.citationIds, [adrEvidence.chunkId])
  assert.equal(revised.body.finding?.disposition, "unresolved", "the old disposition applied to the old conclusion")
  assert.equal(revised.body.finding?.contextRecordId, null)
  assert.match(challengeRecord.adjustments.join(" "), /Disposition "accepted" cleared/)
  const context = (await (await client("/context?includeContent=true")).json()) as { records: unknown[] }
  assert.equal(context.records.length, 0, "the stale risk record is removed")

  const withdrawn = await challenge(client, review.id, "F1", "ADR-014 may change the store contract.")
  assert.equal(withdrawn.body.challenge?.outcome, "withdrawn")
  assert.equal(withdrawn.body.finding?.withdrawn, true)
  assert.equal(withdrawn.body.review?.readiness, "ready", "F2 is still evidence-backed")
  assert.equal((await challenge(client, review.id, "F1")).response.status, 409)
  const acceptWithdrawn = await client(`/reviews/${review.id}/findings/F1`, {
    method: "POST",
    body: JSON.stringify({ disposition: "accepted" })
  })
  assert.equal(acceptWithdrawn.status, 409)

  const brief = await (await client(`/reviews/${review.id}/export`)).text()
  assert.match(brief, /### F1 · ~~SessionStore keeps gateway call sites unchanged~~ \(withdrawn after challenge\)/)
  assert.match(brief, /F2-C1 · .* · outcome \*\*revised\*\* · conclusion \*\*changed\*\*/)
  assert.match(brief, /Before: Single-AZ Redis is acceptable as a launch configuration \[evidence-backed\]/)
  assert.match(brief, /After: Single-AZ Redis violates ADR-014 \[evidence-backed\]/)
  assert.match(brief, /Counter-evidence: \[E7\]\(#evidence-e7\) adr-014-session-storage\.md/)
  assert.match(brief, /### E7 · adr-014-session-storage\.md/)
})

test("a challenge that does not change the conclusion keeps the finding, its disposition, and its record", async () => {
  const { client, review } = await setUpReview(
    [{ outcome: "upheld", rationale: "The runbook supports the rollback path.", counterEvidence: ["E5", "E6"] }],
    "challenge-upheld@review.test"
  )
  await client(`/reviews/${review.id}/findings/F1`, {
    method: "POST",
    body: JSON.stringify({ disposition: "accepted", recordAs: "decision" })
  })

  const first = await challenge(client, review.id, "F1")
  const second = await challenge(client, review.id, "F1", "Check again after the runbook update.")
  assert.equal(second.response.status, 200)
  const finding = second.body.finding!
  assert.equal(first.body.challenge?.conclusionChanged, false)
  assert.deepEqual(
    finding.challenges.map((item) => [item.id, item.outcome]),
    [
      ["F1-C1", "upheld"],
      ["F1-C2", "upheld"]
    ]
  )
  assert.equal(finding.title, review.findings[0].title)
  assert.equal(finding.disposition, "accepted")
  assert.equal(finding.recordKind, "decision")
  const context = (await (await client("/context?includeContent=true")).json()) as { records: Array<{ id: string }> }
  assert.deepEqual(
    context.records.map((record) => record.id),
    [finding.contextRecordId]
  )
})

test("a challenge without retrieved counter-evidence is recorded as insufficient evidence", async () => {
  const invented = await setUpReview(
    [{ outcome: "withdrawn", rationale: "A postmortem shows Redis failed before.", counterEvidence: ["E42"] }],
    "challenge-invented@review.test"
  )
  const result = await challenge(invented.client, invented.review.id, "F1")
  assert.equal(result.response.status, 200)
  assert.equal(result.body.challenge?.outcome, "insufficient evidence")
  assert.equal(result.body.challenge?.conclusionChanged, false)
  assert.deepEqual(result.body.challenge?.counterEvidenceIds, [])
  assert.match(result.body.challenge!.adjustments.join(" "), /Removed citations not in the retrieved evidence: E42/)
  assert.match(result.body.challenge!.adjustments.join(" "), /Conclusion kept: the challenge proposed "withdrawn"/)
  assert.equal(result.body.finding?.withdrawn, false)

  // A review whose only source has no readable text: nothing to retrieve, so no model call.
  const { env, modelCalls } = createChallengeEnv([
    { readiness: "needs evidence", rationale: "Nothing to go on.", findings: [{ title: "Unverified", classification: "inference" }] }
  ])
  const client = await signIn(env, "challenge-empty@review.test")
  const emptyId = await importDocument(client, "whiteboard.md", "")
  const created = (await (
    await client("/reviews", {
      method: "POST",
      body: JSON.stringify({ proposedChange: "Shard sessions.", intendedOutcome: "Less contention.", sourceFileIds: [emptyId] })
    })
  ).json()) as { review: ArchitectureReview }
  const empty = await challenge(client, created.review.id, "F1", "Is this right?")
  assert.equal(empty.response.status, 200)
  assert.equal(modelCalls.length, 1, "only the review called the model")
  assert.equal(empty.body.challenge?.outcome, "insufficient evidence")
  assert.match(empty.body.challenge?.rationale || "", /No passage in the selected sources matched this challenge/)
})

test("malformed challenge output and unavailable sources leave the finding unchanged", async () => {
  const { client, review } = await setUpReview(["The finding is wrong, trust me."], "challenge-malformed@review.test")
  const malformed = await challenge(client, review.id, "F1")
  assert.equal(malformed.response.status, 502)
  assert.match(malformed.body.error || "", /The finding was not changed/)
  const stored = ((await (await client(`/reviews/${review.id}`)).json()) as { review: ArchitectureReview }).review
  assert.deepEqual(stored.findings[0].challenges, [])

  assert.equal((await challenge(client, review.id, "F99")).response.status, 404)
  assert.equal((await challenge(client, "review_missing", "F1")).response.status, 404)

  for (const source of review.sources) {
    await client("/library/delete", { method: "POST", body: JSON.stringify({ id: source.fileId }) })
  }
  const gone = await challenge(client, review.id, "F1")
  assert.equal(gone.response.status, 409)
  assert.match(gone.body.error || "", /cannot be challenged/)
})
