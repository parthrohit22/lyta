import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { router } from "../../src/router"
import { Workspace } from "../../src/durable/workspace"
import { Conversation } from "../../src/durable/conversation"
import { AuthDirectory } from "../../src/durable/authDirectory"
import { RateLimiter } from "../../src/durable/rateLimiter"
import { DRIFT_POLICY_VERSION, type DriftComparison, type DriftFinding, type DriftRun } from "../../src/drift/contract"
import type { Env } from "../../src/index"

// End-to-end coverage for drift detection (issue #11), driven through the real
// router and Durable Objects against faked storage and a scripted model. The
// fixtures are the fictional Lanternfish set in fixtures/drift/.

const fixture = (path: string) => readFileSync(new URL(`../../fixtures/drift/${path}`, import.meta.url), "utf8")
const PRD = fixture("lanternfish-prd.md")
const ARCHITECTURE = fixture("lanternfish-architecture.md")
const CODE_V1 = fixture("v1/lanternfish-code-export.md")
const CODE_V2 = fixture("v2/lanternfish-code-export.md")
const SCOPE = "Lanternfish sessions, API limits, search, export, and trash."

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

type Messages = Array<{ role: string; content: string }>
type Reply = unknown | ((messages: Messages) => unknown)

/** The ref (E1, E2, ...) the prompt gave to the passage containing `needle`, or an unknown ref if none did. */
function refFor(messages: Messages, needle: string) {
  const text = messages.map((message) => message.content).join("\n")
  const match = [...text.matchAll(/<lyta-source id="(E\d+)"[^>]*>\n([\s\S]*?)\n<\/lyta-source>/g)].find(([, , body]) =>
    body.includes(needle)
  )
  return match ? match[1] : "E404"
}

function createDriftEnv(script: { reply: Reply }) {
  const env = {} as Env
  const modelCalls: Messages[] = []

  Object.assign(env, {
    AI: {
      async run(model: string, input: { messages?: Messages; text?: string }) {
        if (model.includes("bge")) {
          // A vector of another dimension never matches the 3-d query, which
          // stands in for a passage dropped by the retrieval similarity floor.
          return { data: [String(input.text).includes("NO-MATCH") ? [1, 0] : [1, 0, 0]] }
        }
        const messages = input.messages || []
        modelCalls.push(messages)
        const reply = typeof script.reply === "function" ? (script.reply as (messages: Messages) => unknown)(messages) : script.reply
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
      body: JSON.stringify({ email, password: "drift-suite-password" })
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
type RunResponse = { comparison?: DriftComparison; run?: DriftRun; error?: string }

async function readRun(response: Response) {
  const text = await response.text()
  let body: RunResponse = {}
  try {
    body = JSON.parse(text) as RunResponse
  } catch {
    body = { error: text }
  }
  return { response, body }
}

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

async function importLanternfish(client: Client, code = CODE_V1) {
  return {
    specification: await importDocument(client, "lanternfish-prd.md", PRD),
    architecture: await importDocument(client, "lanternfish-architecture.md", ARCHITECTURE),
    implementation: await importDocument(client, "lanternfish-code-export.md", code)
  }
}

async function startDrift(client: Client, ids: { specification: string; architecture: string; implementation: string }, extra = {}) {
  const response = await client("/drift", {
    method: "POST",
    body: JSON.stringify({
      comparisonType: "spec-architecture-implementation",
      scope: SCOPE,
      sources: { specification: [ids.specification], architecture: [ids.architecture], implementation: [ids.implementation] },
      ...extra
    })
  })
  return readRun(response)
}

async function rerun(client: Client, comparisonId: string, sources?: Record<string, string[]>) {
  return readRun(await client(`/drift/${comparisonId}/runs`, { method: "POST", body: JSON.stringify(sources ? { sources } : {}) }))
}

/** The v1 drift the Lanternfish fixtures contain, cited by passage content. */
function v1Reply(messages: Messages) {
  const prd = refFor(messages, "REQ-1")
  const architecture = refFor(messages, "SearchIndexer")
  const code = refFor(messages, "SESSION_TTL_SECONDS")
  return {
    summary: "Session lifetime contradicts the PRD, and two items have no counterpart in the supplied evidence.",
    findings: [
      {
        rule: "requirement-without-support",
        subject: "CSV export",
        claim: "REQ-1 requires exporting all bookmarks as CSV.",
        detail: "Neither the architecture nor the code export mentions an export path.",
        confidence: "high",
        claimCitations: [prd],
        counterpartCitations: []
      },
      {
        rule: "component-without-implementation",
        subject: "SearchIndexer",
        claim: "The architecture describes a SearchIndexer that indexes bookmark titles.",
        confidence: "medium",
        claimCitations: [architecture]
      },
      {
        rule: "interface-contradiction",
        subject: "session TTL",
        claim: "Sessions expire after 30 minutes idle.",
        counterpart: "The gateway sets SESSION_TTL_SECONDS = 86400 (24 hours).",
        detail: "Sessions would live 48 times longer than the PRD allows.",
        confidence: "high",
        claimCitations: [prd],
        counterpartCitations: [code]
      }
    ]
  }
}

/** The v2 code export fixes the TTL and adds the indexer, but halves the rate limit. */
function v2Reply(messages: Messages) {
  const prd = refFor(messages, "REQ-1")
  const code = refFor(messages, "RATE_LIMIT_PER_MIN")
  return {
    summary: "CSV export still has no counterpart, and the API rate limit now contradicts the PRD.",
    findings: [
      {
        rule: "requirement-without-support",
        subject: "CSV export",
        claim: "REQ-1 requires exporting all bookmarks as CSV.",
        confidence: "medium",
        claimCitations: [prd]
      },
      {
        rule: "interface-contradiction",
        subject: "API rate limit",
        claim: "The public API allows 120 requests/minute per user.",
        counterpart: "RATE_LIMIT_PER_MIN = 60.",
        confidence: "high",
        claimCitations: [prd],
        counterpartCitations: [code]
      }
    ]
  }
}

function byRule(run: DriftRun, rule: DriftFinding["rule"]) {
  return run.findings.filter((finding) => finding.rule === rule)
}

test("a drift run records the sources it compared and grounds D1, D2, and D3 findings in their roles", async () => {
  const { env, modelCalls } = createDriftEnv({ reply: v1Reply })
  const client = await signIn(env, "rules@drift.test")
  const ids = await importLanternfish(client)
  await importDocument(client, "unselected-notes.md", "UNSELECTED-SECRET notes that must not reach the drift prompt.")

  const { response, body } = await startDrift(client, ids)
  assert.equal(response.status, 201, body.error)
  const run = body.run!
  assert.match(run.id, /^drift-run_/)
  assert.equal(run.number, 1)
  assert.equal(run.comparisonType, "spec-architecture-implementation")

  // Every run records which version of each source it used, and when that version was imported.
  assert.deepEqual(
    run.sources.map((source) => [source.role, source.fileName]),
    [
      ["specification", "lanternfish-prd.md"],
      ["architecture", "lanternfish-architecture.md"],
      ["implementation", "lanternfish-code-export.md"]
    ]
  )
  for (const source of run.sources) {
    assert.match(source.sourceVersionId, /^source-version:/)
    assert.ok(!Number.isNaN(Date.parse(source.importedAt)), "import date is recorded")
    assert.equal(source.supersededBy, null)
  }

  // Retrieval is scoped per role, and only the selected sources reach the model.
  assert.equal(modelCalls.length, 1)
  const prompt = modelCalls[0].map((message) => message.content).join("\n")
  assert.doesNotMatch(prompt, /UNSELECTED-SECRET/)
  assert.match(prompt, /role="specification"[\s\S]*role="architecture"[\s\S]*role="implementation"/)
  assert.deepEqual(
    run.evidence.map((item) => [item.ref, item.role]),
    [
      ["E1", "specification"],
      ["E2", "architecture"],
      ["E3", "implementation"]
    ]
  )
  assert.deepEqual(
    run.coverage.map((item) => [item.role, item.passageCount]),
    [
      ["specification", 1],
      ["architecture", 1],
      ["implementation", 1]
    ]
  )

  const manifests = (await (await client("/context/manifests")).json()) as { manifests: Array<{ policyVersion: string }> }
  for (const role of ["specification", "architecture", "implementation"]) {
    assert.ok(manifests.manifests.some((manifest) => manifest.policyVersion === `${DRIFT_POLICY_VERSION}.${role}`))
  }

  const [requirement] = byRule(run, "requirement-without-support")
  assert.equal(requirement.id, "D1-1")
  assert.equal(requirement.key, "requirement-without-support:csv-export")
  assert.equal(requirement.claimRole, "specification")
  assert.deepEqual(requirement.claimCitationIds, [run.evidence[0].chunkId])
  assert.equal(requirement.counterpart.kind, "not-found-in-supplied-evidence")
  assert.deepEqual(requirement.counterpart.searchedRoles, ["architecture", "implementation"])
  assert.deepEqual(requirement.counterpart.searchedSources, ["lanternfish-architecture.md", "lanternfish-code-export.md"])
  assert.equal(requirement.counterpart.searchedPassageCount, 2)
  assert.equal(requirement.confidence, "medium", "absence findings are capped at medium")
  assert.ok(requirement.adjustments.some((adjustment) => /Confidence lowered from high to medium/.test(adjustment)))

  const [component] = byRule(run, "component-without-implementation")
  assert.equal(component.claimRole, "architecture")
  assert.deepEqual(component.counterpart.searchedRoles, ["implementation"])

  const [contradiction] = byRule(run, "interface-contradiction")
  assert.equal(contradiction.counterpart.kind, "cited")
  assert.deepEqual(contradiction.claimCitationIds, [run.evidence[0].chunkId])
  assert.deepEqual(contradiction.counterpart.citationIds, [run.evidence[2].chunkId])
  assert.equal(contradiction.confidence, "high")
  assert.match(contradiction.counterpart.description, /86400/)

  assert.ok(run.findings.every((finding) => finding.diffStatus === "new"))
  assert.equal(run.diff.previousRunId, null)
  assert.equal(byRule(run, "stale-or-missing-source").length, 0, "nothing is stale or missing")

  const list = (await (await client("/drift")).json()) as { comparisons: Array<{ id: string; runCount: number }> }
  assert.deepEqual(
    list.comparisons.map((item) => [item.id, item.runCount]),
    [[body.comparison!.id, 1]]
  )
})

test("citations must come from the retrieved set and the rule's roles, or the finding is dropped", async () => {
  const { env } = createDriftEnv({
    reply: (messages: Messages) => {
      const prd = refFor(messages, "REQ-1")
      const architecture = refFor(messages, "SearchIndexer")
      const code = refFor(messages, "SESSION_TTL_SECONDS")
      return {
        summary: "Several findings with grounding problems.",
        findings: [
          // D1 claims must be specification passages.
          {
            rule: "requirement-without-support",
            subject: "purge job",
            claim: "Purges after 7 days.",
            confidence: "low",
            claimCitations: [code]
          },
          // A contradiction within one role is not cross-role drift.
          {
            rule: "interface-contradiction",
            subject: "trash window",
            claim: "Recoverable for 7 days.",
            confidence: "high",
            claimCitations: [prd],
            counterpartCitations: [prd]
          },
          // Invented refs are removed; the surviving claim citation keeps the finding.
          {
            rule: "component-without-implementation",
            subject: "SearchIndexer",
            claim: "SearchIndexer indexes bookmark titles.",
            confidence: "medium",
            claimCitations: ["E42", architecture]
          },
          // An absence finding that cites the counterpart it says is missing is low confidence.
          {
            rule: "requirement-without-support",
            subject: "session expiry",
            claim: "Sessions expire after 30 minutes idle.",
            confidence: "medium",
            claimCitations: [prd],
            counterpartCitations: [architecture]
          },
          // Stale/missing source findings are the server's job.
          { rule: "stale-or-missing-source", subject: "old doc", claim: "The PRD looks old.", confidence: "high", claimCitations: [prd] }
        ]
      }
    }
  })
  const client = await signIn(env, "grounding@drift.test")
  const { response, body } = await startDrift(client, await importLanternfish(client))
  assert.equal(response.status, 201, body.error)
  const run = body.run!

  assert.deepEqual(
    run.findings.map((finding) => finding.key),
    ["component-without-implementation:searchindexer", "requirement-without-support:session-expiry"]
  )
  assert.ok(run.findings[0].adjustments.some((adjustment) => /E42/.test(adjustment)))
  assert.equal(run.findings[1].confidence, "low")
  assert.deepEqual(run.findings[1].counterpart.citationIds, [], "the cited counterpart is not kept on an absence finding")
  assert.ok(run.adjustments.some((adjustment) => /D1 "purge job".*not cited from the retrieved Specification/.test(adjustment)))
  assert.ok(run.adjustments.some((adjustment) => /D3 .*counterpart cited from a different role/.test(adjustment)))
  assert.ok(run.adjustments.some((adjustment) => /D4 .*computed by the server/.test(adjustment)))
})

test("a missing counterpart is reported as not found in the supplied evidence, never as absent from the project", async () => {
  const { env } = createDriftEnv({
    reply: (messages: Messages) => ({
      summary: "Two absence findings, one worded as a fact about the project.",
      findings: [
        {
          rule: "component-without-implementation",
          subject: "SearchIndexer",
          claim: "The architecture describes a SearchIndexer.",
          detail: "The SearchIndexer does not exist in the codebase.",
          counterpart: "There is no indexer anywhere in the project.",
          confidence: "high",
          claimCitations: [refFor(messages, "SearchIndexer")]
        },
        {
          rule: "requirement-without-support",
          subject: "CSV export",
          claim: "CSV export is not implemented anywhere.",
          confidence: "high",
          claimCitations: [refFor(messages, "REQ-1")]
        }
      ]
    })
  })
  const client = await signIn(env, "absence@drift.test")
  const { response, body } = await startDrift(client, await importLanternfish(client))
  assert.equal(response.status, 201, body.error)
  const run = body.run!

  assert.equal(run.findings.length, 1, "a claim worded as project-level absence is dropped")
  assert.ok(run.adjustments.some((adjustment) => /asserted that something does not exist in the project/.test(adjustment)))

  const [finding] = run.findings
  assert.equal(finding.counterpart.kind, "not-found-in-supplied-evidence")
  assert.equal(finding.detail, "", "the explanation claiming project-level absence is removed")
  assert.match(
    finding.counterpart.description,
    /^Not found in the supplied evidence\. LYTA searched 1 retrieved passage from the Implementation evidence sources/
  )
  assert.match(finding.counterpart.description, /not that it is absent from the project\.$/)
  assert.doesNotMatch(finding.counterpart.description, /anywhere in the project/, "the model's counterpart wording is replaced")
  assert.ok(finding.adjustments.some((adjustment) => /Removed the explanation/.test(adjustment)))

  const exported = await client(`/drift/${body.comparison!.id}/runs/${run.id}/export`)
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get("Content-Type") || "", /text\/markdown/)
  const markdown = await exported.text()
  assert.match(markdown, /\*\*Not found in the supplied evidence\*\*/)
  assert.match(markdown, /may still exist elsewhere in the project/)
  assert.doesNotMatch(markdown, /does not exist in the codebase|not implemented anywhere|no indexer anywhere/)
  assert.match(markdown, /\| Implementation evidence \| lanternfish-code-export\.md \| `source-version:/)
})

test("D4 reports a role with no retrievable passage and a superseded source as source checks", async () => {
  const { env, modelCalls } = createDriftEnv({ reply: v1Reply })
  const client = await signIn(env, "sources@drift.test")
  const ids = await importLanternfish(client)
  // An implementation export whose passages all fall below the similarity floor.
  const unmatched = await importDocument(client, "unmatched-export.md", "NO-MATCH binary build log with no relevant text.")
  // A newer copy of the architecture doc, not selected for the comparison.
  await importDocument(client, "lanternfish-architecture.md", `${ARCHITECTURE}\n- Added: ExportWorker writes CSV.`)

  const { response, body } = await startDrift(client, { ...ids, implementation: unmatched })
  assert.equal(response.status, 201, body.error)
  const run = body.run!
  const checks = byRule(run, "stale-or-missing-source")

  assert.deepEqual(
    checks.map((finding) => finding.key),
    ["stale-or-missing-source:missing-implementation", "stale-or-missing-source:superseded-lanternfish-architecture-md"]
  )
  assert.ok(checks.every((finding) => finding.confidence === "high" && finding.counterpart.kind === "source-check"))
  assert.equal(run.coverage.find((item) => item.role === "implementation")?.passageCount, 0)
  assert.deepEqual(run.coverage.find((item) => item.role === "implementation")?.sourcesWithoutPassages, ["unmatched-export.md"])
  assert.ok(run.sources.find((source) => source.role === "architecture")?.supersededBy, "the run records that a newer version exists")
  assert.match(checks[1].counterpart.description, /A newer lanternfish-architecture\.md/)

  // The model still ran (spec and architecture passages exist), but nothing it
  // says about implementation can lean on retrieved implementation evidence.
  assert.equal(modelCalls.length, 1)
  const component = byRule(run, "component-without-implementation")[0]
  assert.equal(component.confidence, "low")
  assert.match(component.confidenceReason, /no passage from the Implementation evidence sources matched/)
  assert.equal(byRule(run, "interface-contradiction").length, 0, "the contradiction cited an implementation passage that was not retrieved")

  // With no anchor passages at all, the model is not called and only source checks are reported.
  const blankSpec = await importDocument(client, "blank-prd.md", "NO-MATCH scanned PDF without text.")
  const blankArchitecture = await importDocument(client, "blank-architecture.md", "NO-MATCH diagram export.")
  const empty = await startDrift(client, { specification: blankSpec, architecture: blankArchitecture, implementation: unmatched })
  assert.equal(empty.response.status, 201, empty.body.error)
  assert.equal(modelCalls.length, 1, "no model call without anything to compare")
  assert.equal(empty.body.run!.modelVersion, null)
  assert.equal(empty.body.run!.findings.length, 3)
  assert.ok(empty.body.run!.findings.every((finding) => finding.rule === "stale-or-missing-source"))
})

test("re-running against changed sources shows new, resolved, and unchanged findings without rewriting history", async () => {
  const script: { reply: Reply } = { reply: v1Reply }
  const { env, modelCalls } = createDriftEnv(script)
  const client = await signIn(env, "rerun@drift.test")
  const ids = await importLanternfish(client)
  const first = await startDrift(client, ids)
  assert.equal(first.response.status, 201, first.body.error)
  const comparisonId = first.body.comparison!.id
  const firstRun = first.body.run!

  // The code export changes: a new file with the same name supersedes v1.
  const v2 = await importDocument(client, "lanternfish-code-export.md", CODE_V2)

  // Re-running with the old selection flags the stale implementation evidence.
  const stale = await rerun(client, comparisonId)
  assert.equal(stale.response.status, 201, stale.body.error)
  assert.equal(stale.body.run!.number, 2)
  assert.ok(stale.body.run!.findings.some((finding) => finding.key === "stale-or-missing-source:superseded-lanternfish-code-export-md"))
  assert.match(modelCalls[1].map((message) => message.content).join("\n"), /The previous run reported these subjects[\s\S]*"session TTL"/)

  script.reply = v2Reply
  const updated = await rerun(client, comparisonId, {
    specification: [ids.specification],
    architecture: [ids.architecture],
    implementation: [v2]
  })
  assert.equal(updated.response.status, 201, updated.body.error)
  const run = updated.body.run!
  assert.equal(run.number, 3)
  assert.equal(run.diff.previousRunNumber, 2)
  assert.equal(run.scope, SCOPE, "scope is fixed for the comparison")
  assert.equal(run.sources.find((source) => source.role === "implementation")?.fileId, v2)
  assert.deepEqual(run.diff.new, ["interface-contradiction:api-rate-limit"])
  assert.deepEqual(run.diff.unchanged, ["requirement-without-support:csv-export"])
  assert.deepEqual(run.diff.resolved.map((item) => item.key).sort(), [
    "component-without-implementation:searchindexer",
    "interface-contradiction:session-ttl",
    "stale-or-missing-source:superseded-lanternfish-code-export-md"
  ])
  assert.ok(run.diff.resolved.every((item) => item.lastSeenRunNumber === 2))
  assert.deepEqual(
    run.findings.map((finding) => [finding.key, finding.diffStatus]),
    [
      ["requirement-without-support:csv-export", "unchanged"],
      ["interface-contradiction:api-rate-limit", "new"]
    ]
  )

  // Earlier runs are still readable exactly as they were saved.
  const original = (await (await client(`/drift/${comparisonId}/runs/${firstRun.id}`)).json()) as RunResponse
  assert.deepEqual(original.run, firstRun)
  const latest = (await (await client(`/drift/${comparisonId}`)).json()) as RunResponse
  assert.equal(latest.run!.id, run.id)
  assert.deepEqual(
    latest.comparison!.runs.map((summary) => [summary.number, summary.newCount, summary.unchangedCount, summary.resolvedCount]),
    [
      [1, 3, 0, 0],
      [2, 1, 3, 0],
      [3, 1, 1, 3]
    ]
  )

  const markdown = await (await client(`/drift/${comparisonId}/runs/${run.id}/export`)).text()
  assert.match(markdown, /Compared with run 2 .*: 1 new, 1 unchanged, 3 resolved\./)
  assert.match(markdown, /## Resolved since the previous run[\s\S]*not proof the drift was fixed/)
})

test("dispositions are kept by finding key across runs and keep their history", async () => {
  const { env } = createDriftEnv({ reply: v1Reply })
  const client = await signIn(env, "dispositions@drift.test")
  const first = await startDrift(client, await importLanternfish(client))
  const comparisonId = first.body.comparison!.id
  const runId = first.body.run!.id
  const disposition = (findingKey: string, value: string, note = "", run = runId) =>
    client(`/drift/${comparisonId}/dispositions`, {
      method: "POST",
      body: JSON.stringify({ runId: run, findingKey, disposition: value, note })
    })

  for (const value of ["confirmed", "accepted deviation", "false-positive", "needs-investigation"]) {
    assert.equal((await disposition("interface-contradiction:session-ttl", value)).status, 200, value)
  }
  const accepted = await disposition("component-without-implementation:searchindexer", "accepted-deviation", "Search ships in Q3.")
  assert.equal(accepted.status, 200)
  assert.equal((await disposition("interface-contradiction:session-ttl", "wont-fix")).status, 400)
  assert.equal((await disposition("requirement-without-support:never-reported", "confirmed")).status, 404)

  const second = await rerun(client, comparisonId)
  assert.equal(second.response.status, 201, second.body.error)
  const comparison = second.body.comparison!
  assert.equal(comparison.dispositions["component-without-implementation:searchindexer"].disposition, "accepted-deviation")
  assert.equal(comparison.dispositions["component-without-implementation:searchindexer"].note, "Search ships in Q3.")
  const ttl = comparison.dispositions["interface-contradiction:session-ttl"]
  assert.equal(ttl.disposition, "needs-investigation")
  assert.deepEqual(
    ttl.history.map((entry) => entry.disposition),
    ["confirmed", "accepted-deviation", "false-positive", "needs-investigation"]
  )
  assert.ok(second.body.run!.findings.some((finding) => finding.key === "interface-contradiction:session-ttl"))

  // A disposition can be set from the later run too, and the export shows it.
  assert.equal((await disposition("interface-contradiction:session-ttl", "confirmed", "", second.body.run!.id)).status, 200)
  const markdown = await (await client(`/drift/${comparisonId}/runs/${second.body.run!.id}/export`)).text()
  assert.match(markdown, /- Disposition: Accepted deviation — Search ships in Q3\./)
  assert.match(markdown, /### D3-1 · session TTL \(unchanged\)[\s\S]*?- Disposition: Confirmed/)
})

test("unsupported comparison types, roles, and rules are rejected with a clear error", async () => {
  const { env, modelCalls } = createDriftEnv({ reply: v1Reply })
  const client = await signIn(env, "unsupported@drift.test")
  const ids = await importLanternfish(client)
  const expectError = async (extra: Record<string, unknown>, pattern: RegExp) => {
    const { response, body } = await startDrift(client, ids, extra)
    assert.equal(response.status, 400)
    assert.match(body.error || "", pattern)
  }

  await expectError(
    { comparisonType: "spec-vs-tests" },
    /Unsupported comparison type\. "spec-vs-tests" is not supported\. Supported comparison types: spec-architecture-implementation\./
  )
  await expectError({ comparisonType: undefined }, /Unsupported comparison type\. Supported comparison types/)
  await expectError({ rules: ["requirement-without-support", "performance-regression"] }, /Unsupported drift rule "performance-regression"/)
  await expectError(
    { sources: { specification: [ids.specification], architecture: [ids.architecture], tests: [ids.implementation] } },
    /Unsupported source role "tests"/
  )
  await expectError(
    { sources: { specification: [ids.specification], architecture: [ids.specification], implementation: [ids.implementation] } },
    /only have one role/
  )
  await expectError(
    { sources: { specification: [ids.specification], architecture: [ids.architecture], implementation: [] } },
    /Select at least one Implementation evidence source/
  )
  await expectError({ scope: "  " }, /Describe the scope/)
  assert.equal(modelCalls.length, 0, "rejected requests never reach the model")

  const deleted = await client("/library/delete", { method: "POST", body: JSON.stringify({ id: ids.architecture }) })
  assert.equal(deleted.status, 200)
  const unavailable = await startDrift(client, ids)
  assert.equal(unavailable.response.status, 409)
  assert.match(unavailable.body.error || "", /no longer available/)
})

test("a malformed model reply is an error and saves nothing; deleting a source clears its excerpts from runs", async () => {
  const script: { reply: Reply } = { reply: "Here is my analysis: everything drifted." }
  const { env } = createDriftEnv(script)
  const client = await signIn(env, "malformed@drift.test")
  const ids = await importLanternfish(client)

  const malformed = await startDrift(client, ids)
  assert.equal(malformed.response.status, 502)
  assert.match(malformed.body.error || "", /did not return a JSON object\. No drift run was saved/)

  script.reply = { summary: "Unknown rule.", findings: [{ rule: "naming-drift", claim: "x", confidence: "high" }] }
  const unknownRule = await startDrift(client, ids)
  assert.equal(unknownRule.response.status, 502)
  assert.match(unknownRule.body.error || "", /unknown rule "naming-drift"/)
  assert.deepEqual(((await (await client("/drift")).json()) as { comparisons: unknown[] }).comparisons, [])

  script.reply = v1Reply
  const saved = await startDrift(client, ids)
  assert.equal(saved.response.status, 201)
  const deleted = (await (
    await client("/library/delete", { method: "POST", body: JSON.stringify({ id: ids.implementation }) })
  ).json()) as {
    deletionImpact: { affectedDriftRuns: number }
  }
  assert.equal(deleted.deletionImpact.affectedDriftRuns, 1)
  const after = (await (await client(`/drift/${saved.body.comparison!.id}`)).json()) as RunResponse
  const implementation = after.run!.evidence.find((item) => item.role === "implementation")!
  assert.equal(implementation.sourceDeleted, true)
  assert.equal(implementation.snippet, "")
  assert.equal(after.run!.findings.length, saved.body.run!.findings.length, "findings stay so the run history is auditable")
  // The excerpt is gone; the model's own finding text is kept as part of the run's record.
  assert.doesNotMatch(
    await (await client(`/drift/${saved.body.comparison!.id}/runs/${saved.body.run!.id}/export`)).text(),
    /> gateway\/session\.ts/
  )
})
