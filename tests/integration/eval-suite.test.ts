import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { router } from "../../src/router"
import { Workspace } from "../../src/durable/workspace"
import { Conversation } from "../../src/durable/conversation"
import { AuthDirectory } from "../../src/durable/authDirectory"
import { RateLimiter } from "../../src/durable/rateLimiter"
import type { Env } from "../../src/index"

// This is a pipeline-correctness regression suite, NOT a live model-quality
// judge: the fake env.AI below returns each case's scripted `modelReply`
// rather than a real model's output, so it proves retrieval/citation wiring
// stays correct across changes — it cannot tell you a candidate model is
// actually "better." See eval/README.md for the promotion policy and how to
// run this dataset against a real model manually before promoting one.

interface ChatEvalCase {
  id: string
  category: "citation-accuracy" | "insufficient-evidence" | "general-quality"
  mode: "instant" | "deep" | "creative"
  sourceDocument: { name: string; text: string } | null
  question: string
  modelReply: string
  expectCitation: boolean
  mustContainPhrase?: string
}

// Architecture Change Review cases post to /reviews instead of /chat. The
// scripted `reviewReply` is the model's JSON (or deliberately malformed text);
// the case checks what survives the review contract's validation.
interface ReviewEvalCase {
  id: string
  category: "architecture-review"
  mode: "deep"
  sourceFixture?: string
  sourceDocuments?: Array<{ name: string; text: string }>
  review: { proposedChange: string; intendedOutcome: string; constraints?: string }
  reviewReply: unknown
  expectStatus: number
  expectReadiness?: string
  expectCitation: boolean
  // Optional "challenge this conclusion" step run against the created review;
  // `reply` is the scripted model JSON for the challenge call.
  challenge?: {
    findingId: string
    reason?: string
    reply: unknown
    expectOutcome: string
    expectConclusionChanged: boolean
  }
}

// Drift cases post to /drift. Each role lists its documents (a committed
// fixture, or inline text); `laterImports` are imported afterwards but not
// selected, so they can supersede a selected source. `expectFindings` is the
// exact set of finding keys that must survive the drift contract, with the
// source files each side must be cited from. An optional `rerun` changes some
// roles' documents and checks the new/unchanged/resolved diff.
type DriftDocument = { fixture: string } | { name: string; text: string }

interface DriftExpectation {
  key: string
  claimFiles?: string[]
  counterpartFiles?: string[]
  counterpartKind?: string
  confidence?: string
}

interface DriftEvalCase {
  id: string
  category: "drift-detection"
  mode: "deep"
  drift: {
    comparisonType?: string
    scope: string
    sources: Record<string, DriftDocument[]>
    laterImports?: DriftDocument[]
  }
  driftReply: unknown
  expectStatus: number
  expectFindings: DriftExpectation[]
  exportMustContain?: string[]
  exportMustNotContain?: string[]
  rerun?: {
    sources: Record<string, DriftDocument[]>
    reply: unknown
    expectStatus: number
    expectDiff: { new: string[]; unchanged: string[]; resolved: string[] }
    expectFindings: DriftExpectation[]
  }
}

type EvalCase = ChatEvalCase | ReviewEvalCase | DriftEvalCase

interface EvalDataset {
  version: string
  baselinePassRate: number
  driftScoring: { rulePrecisionFloor: number; citationIdentityFloor: number }
  cases: EvalCase[]
}

/** One reported drift finding, scored: was it expected, and were its citations the expected sources? */
interface DriftScore {
  rule: string
  key: string
  expected: boolean
  citations: number
  correctCitations: number
}

interface EvalResult {
  id: string
  category: string
  passed: boolean
  failures: string[]
  driftScores?: DriftScore[]
}

const dataset = JSON.parse(readFileSync(new URL("../../eval/dataset.json", import.meta.url), "utf8")) as EvalDataset

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

/** A list of replies is consumed one model call at a time, repeating the last. */
function createEvalEnv(modelReply: string | string[]) {
  const env = {} as Env
  const replies = Array.isArray(modelReply) ? modelReply : [modelReply]
  let modelCallCount = 0

  Object.assign(env, {
    AI: {
      async run(model: string, input: { stream?: boolean; text?: string }) {
        if (model.includes("bge")) {
          // A vector of another dimension never matches the query, which stands
          // in for a passage dropped by the retrieval similarity floor.
          return { data: [String((input as { text?: string }).text).includes("NO-MATCH") ? [1, 0] : [1, 0, 0]] }
        }
        if (input.stream) {
          throw new Error("eval-suite cases only exercise the non-streaming /chat path")
        }
        return { response: replies[Math.min(modelCallCount++, replies.length - 1)] }
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

  return env
}

function extractCookie(response: Response, name: string) {
  const setCookie = response.headers.get("Set-Cookie") || ""
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`))
  return match ? `${name}=${match[1]}` : ""
}

async function runCase(evalCase: EvalCase): Promise<EvalResult> {
  if (evalCase.category === "architecture-review") {
    return runReviewCase(evalCase)
  }

  if (evalCase.category === "drift-detection") {
    return runDriftCase(evalCase)
  }

  const env = createEvalEnv(evalCase.modelReply)

  const authedRequest = await registerEvalUser(env, evalCase.id)

  const sessionResponse = await authedRequest("https://internal/sessions/create", { method: "POST" })
  const { session } = (await sessionResponse.json()) as { session: { id: string } }

  if (evalCase.sourceDocument) {
    await authedRequest("https://internal/library/import", {
      method: "POST",
      body: JSON.stringify({
        attachments: [
          {
            kind: "document",
            name: evalCase.sourceDocument.name,
            mimeType: "text/plain",
            size: evalCase.sourceDocument.text.length,
            extractedText: evalCase.sourceDocument.text
          }
        ]
      })
    })
  }

  const chatResponse = await authedRequest(`https://internal/chat?session=${session.id}`, {
    method: "POST",
    body: JSON.stringify({ message: evalCase.question, mode: evalCase.mode })
  })

  const body = (await chatResponse.json()) as { reply: string; citations: unknown[] }

  const failures: string[] = []

  if (chatResponse.status !== 200) {
    failures.push(`expected 200, got ${chatResponse.status}`)
  }
  if (!body.reply?.trim()) {
    failures.push("reply was empty")
  }
  if (evalCase.expectCitation && body.citations.length === 0) {
    failures.push("expected at least one citation, got none")
  }
  if (!evalCase.expectCitation && body.citations.length > 0) {
    failures.push(`expected no citations, got ${body.citations.length}`)
  }
  if (evalCase.mustContainPhrase && !body.reply.includes(evalCase.mustContainPhrase)) {
    failures.push(`reply did not contain required phrase "${evalCase.mustContainPhrase}"`)
  }

  return { id: evalCase.id, category: evalCase.category, passed: failures.length === 0, failures }
}

async function runReviewCase(evalCase: ReviewEvalCase) {
  const toReply = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))
  const env = createEvalEnv([toReply(evalCase.reviewReply), ...(evalCase.challenge ? [toReply(evalCase.challenge.reply)] : [])])
  const authedRequest = await registerEvalUser(env, evalCase.id)
  const documents = evalCase.sourceFixture
    ? [
        {
          name: evalCase.sourceFixture.split("/").pop()!,
          text: readFileSync(new URL(`../../${evalCase.sourceFixture}`, import.meta.url), "utf8")
        }
      ]
    : evalCase.sourceDocuments || []
  const sourceFileIds: string[] = []

  for (const document of documents) {
    const imported = await authedRequest("https://internal/library/import", {
      method: "POST",
      body: JSON.stringify({
        attachments: [
          { kind: "document", name: document.name, mimeType: "text/markdown", size: document.text.length, extractedText: document.text }
        ]
      })
    })
    const { files } = (await imported.json()) as { files: Array<{ libraryFileId: string }> }
    sourceFileIds.push(files[0].libraryFileId)
  }

  const response = await authedRequest("https://internal/reviews", {
    method: "POST",
    body: JSON.stringify({ ...evalCase.review, sourceFileIds })
  })
  const body = (await response.json()) as {
    review?: { id: string; readiness: string; evidence: unknown[]; findings: Array<{ classification: string; citationIds: string[] }> }
  }
  const failures: string[] = []
  const citedFindings =
    body.review?.findings.filter((finding) => finding.classification === "evidence-backed" && finding.citationIds.length) || []

  if (response.status !== evalCase.expectStatus) {
    failures.push(`expected ${evalCase.expectStatus}, got ${response.status}`)
  }
  if (evalCase.expectStatus !== 201 && body.review) {
    failures.push("a review was returned for a failed request")
  }
  if (evalCase.expectReadiness && body.review?.readiness !== evalCase.expectReadiness) {
    failures.push(`expected readiness "${evalCase.expectReadiness}", got "${body.review?.readiness}"`)
  }
  if (evalCase.expectCitation && !citedFindings.length) {
    failures.push("expected at least one evidence-backed finding with a citation, got none")
  }
  if (!evalCase.expectCitation && citedFindings.length) {
    failures.push(`expected no evidence-backed citations, got ${citedFindings.length}`)
  }

  if (evalCase.challenge && body.review) {
    const challenged = await authedRequest(
      `https://internal/reviews/${body.review.id}/findings/${evalCase.challenge.findingId}/challenge`,
      {
        method: "POST",
        body: JSON.stringify({ reason: evalCase.challenge.reason || "" })
      }
    )
    const result = (await challenged.json()) as { challenge?: { outcome: string; conclusionChanged: boolean } }

    if (challenged.status !== 200) {
      failures.push(`challenge: expected 200, got ${challenged.status}`)
    }
    if (result.challenge?.outcome !== evalCase.challenge.expectOutcome) {
      failures.push(`challenge: expected outcome "${evalCase.challenge.expectOutcome}", got "${result.challenge?.outcome}"`)
    }
    if (result.challenge?.conclusionChanged !== evalCase.challenge.expectConclusionChanged) {
      failures.push(`challenge: expected conclusionChanged ${evalCase.challenge.expectConclusionChanged}`)
    }
  }

  return { id: evalCase.id, category: evalCase.category, passed: failures.length === 0, failures }
}

async function runDriftCase(evalCase: DriftEvalCase): Promise<EvalResult> {
  const toReply = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))
  const env = createEvalEnv([toReply(evalCase.driftReply), ...(evalCase.rerun ? [toReply(evalCase.rerun.reply)] : [])])
  const authedRequest = await registerEvalUser(env, evalCase.id)
  const failures: string[] = []
  const driftScores: DriftScore[] = []

  const importAll = async (documentsByRole: Record<string, DriftDocument[]>) => {
    const ids: Record<string, string[]> = {}
    for (const [role, documents] of Object.entries(documentsByRole)) {
      ids[role] = []
      for (const document of documents) ids[role].push(await importEvalDocument(authedRequest, document))
    }
    return ids
  }

  const sources = await importAll(evalCase.drift.sources)
  for (const document of evalCase.drift.laterImports || []) await importEvalDocument(authedRequest, document)

  const response = await authedRequest("https://internal/drift", {
    method: "POST",
    body: JSON.stringify({
      comparisonType: "comparisonType" in evalCase.drift ? evalCase.drift.comparisonType : "spec-architecture-implementation",
      scope: evalCase.drift.scope,
      sources
    })
  })
  const body = (await response.json().catch(() => ({}))) as { comparison?: { id: string }; run?: DriftRunBody }

  if (response.status !== evalCase.expectStatus) {
    failures.push(`expected ${evalCase.expectStatus}, got ${response.status}`)
  }
  if (evalCase.expectStatus !== 201 && body.run) {
    failures.push("a drift run was returned for a failed request")
  }
  if (body.run) {
    scoreDriftRun("run 1", body.run, evalCase.expectFindings, failures, driftScores)

    const markdown =
      evalCase.exportMustContain || evalCase.exportMustNotContain
        ? await (await authedRequest(`https://internal/drift/${body.comparison!.id}/runs/${body.run.id}/export`)).text()
        : ""
    for (const phrase of evalCase.exportMustContain || []) {
      if (!markdown.includes(phrase)) failures.push(`export is missing "${phrase}"`)
    }
    for (const phrase of evalCase.exportMustNotContain || []) {
      if (markdown.includes(phrase)) failures.push(`export contains "${phrase}"`)
    }
  }

  if (evalCase.rerun && body.comparison) {
    const changed = await importAll(evalCase.rerun.sources)
    const rerun = await authedRequest(`https://internal/drift/${body.comparison.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ sources: { ...sources, ...changed } })
    })
    const rerunBody = (await rerun.json().catch(() => ({}))) as { run?: DriftRunBody }

    if (rerun.status !== evalCase.rerun.expectStatus) {
      failures.push(`rerun: expected ${evalCase.rerun.expectStatus}, got ${rerun.status}`)
    }
    if (rerunBody.run) {
      scoreDriftRun("run 2", rerunBody.run, evalCase.rerun.expectFindings, failures, driftScores)
      const diff = rerunBody.run.diff
      for (const status of ["new", "unchanged"] as const) {
        if (!sameKeys(diff[status], evalCase.rerun.expectDiff[status])) {
          failures.push(`rerun: expected ${status} [${evalCase.rerun.expectDiff[status].join(", ")}], got [${diff[status].join(", ")}]`)
        }
      }
      const resolved = diff.resolved.map((item) => item.key)
      if (!sameKeys(resolved, evalCase.rerun.expectDiff.resolved)) {
        failures.push(`rerun: expected resolved [${evalCase.rerun.expectDiff.resolved.join(", ")}], got [${resolved.join(", ")}]`)
      }
    }
  }

  return { id: evalCase.id, category: evalCase.category, passed: failures.length === 0, failures, driftScores }
}

interface DriftRunBody {
  id: string
  evidence: Array<{ chunkId: string; fileName: string }>
  findings: Array<{
    key: string
    rule: string
    confidence: string
    claimCitationIds: string[]
    counterpart: { kind: string; citationIds: string[] }
  }>
  diff: { new: string[]; unchanged: string[]; resolved: Array<{ key: string }> }
}

/**
 * Every reported finding is scored. It counts toward its rule's precision only
 * when its key was expected; each of its citations counts toward citation
 * identity only when it resolves to a source file the expectation names.
 */
function scoreDriftRun(label: string, run: DriftRunBody, expected: DriftExpectation[], failures: string[], scores: DriftScore[]) {
  const fileOf = new Map(run.evidence.map((item) => [item.chunkId, item.fileName]))

  for (const finding of run.findings) {
    const expectation = expected.find((candidate) => candidate.key === finding.key)
    const sides: Array<[string[], string[] | undefined]> = [
      [finding.claimCitationIds, expectation?.claimFiles],
      [finding.counterpart.citationIds, expectation?.counterpartFiles]
    ]
    let citations = 0
    let correctCitations = 0

    for (const [chunkIds, files] of sides) {
      for (const chunkId of chunkIds) {
        citations += 1
        if (files?.includes(fileOf.get(chunkId) || "")) correctCitations += 1
      }
    }

    scores.push({ rule: finding.rule, key: finding.key, expected: Boolean(expectation), citations, correctCitations })

    if (!expectation) {
      failures.push(`${label}: unexpected finding ${finding.key}`)
      continue
    }
    if (correctCitations !== citations) {
      failures.push(`${label}: ${finding.key} cites ${citations - correctCitations} passage(s) outside its expected sources`)
    }
    for (const [chunkIds, files, side] of [
      [finding.claimCitationIds, expectation.claimFiles, "claim"],
      [finding.counterpart.citationIds, expectation.counterpartFiles, "counterpart"]
    ] as const) {
      if (files?.length && !chunkIds.length) failures.push(`${label}: ${finding.key} has no ${side} citation`)
    }
    if (expectation.counterpartKind && finding.counterpart.kind !== expectation.counterpartKind) {
      failures.push(`${label}: ${finding.key} counterpart is "${finding.counterpart.kind}", expected "${expectation.counterpartKind}"`)
    }
    if (expectation.confidence && finding.confidence !== expectation.confidence) {
      failures.push(`${label}: ${finding.key} confidence is "${finding.confidence}", expected "${expectation.confidence}"`)
    }
  }

  for (const expectation of expected) {
    if (!run.findings.some((finding) => finding.key === expectation.key)) {
      failures.push(`${label}: missing expected finding ${expectation.key}`)
    }
  }
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && [...left].sort().every((key, index) => key === [...right].sort()[index])
}

async function importEvalDocument(authedRequest: Awaited<ReturnType<typeof registerEvalUser>>, document: DriftDocument) {
  const { name, text } =
    "fixture" in document
      ? { name: document.fixture.split("/").pop()!, text: readFileSync(new URL(`../../${document.fixture}`, import.meta.url), "utf8") }
      : document
  const imported = await authedRequest("https://internal/library/import", {
    method: "POST",
    body: JSON.stringify({ attachments: [{ kind: "document", name, mimeType: "text/markdown", size: text.length, extractedText: text }] })
  })
  const { files } = (await imported.json()) as { files: Array<{ libraryFileId: string }> }
  return files[0].libraryFileId
}

async function registerEvalUser(env: Env, id: string) {
  const registerResponse = await router(
    new Request("https://internal/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: `${id}@eval.test`, password: "eval-suite-password" })
    }),
    env
  )
  const authCookie = extractCookie(registerResponse, "lyta_auth")

  return (url: string, init: RequestInit = {}) =>
    router(new Request(url, { ...init, headers: { ...(init.headers || {}), Cookie: authCookie, "Content-Type": "application/json" } }), env)
}

test(`eval suite (version ${dataset.version}) meets its documented baseline pass rate`, async () => {
  assert.ok(dataset.cases.length >= 15, `dataset must have at least 15 cases, found ${dataset.cases.length}`)

  const results: EvalResult[] = []
  for (const evalCase of dataset.cases) {
    results.push(await runCase(evalCase))
  }

  const passed = results.filter((result) => result.passed)
  const failed = results.filter((result) => !result.passed)
  const passRate = passed.length / results.length

  console.log(`[lyta-eval] ${passed.length}/${results.length} cases passed (${(passRate * 100).toFixed(1)}%)`)
  for (const failure of failed) {
    console.log(`[lyta-eval] FAILED ${failure.id} (${failure.category}): ${failure.failures.join("; ")}`)
  }

  assert.ok(
    passRate >= dataset.baselinePassRate,
    `pass rate ${(passRate * 100).toFixed(1)}% is below the documented baseline of ${(dataset.baselinePassRate * 100).toFixed(1)}%`
  )

  // Drift rules are scored across every drift case: precision per rule (reported
  // findings that were expected) and citation identity (citations that resolve
  // to the expected source file). Each supported rule must be exercised.
  const scores = results.flatMap((result) => result.driftScores || [])
  const expectedRules = new Set(
    dataset.cases
      .filter((evalCase): evalCase is DriftEvalCase => evalCase.category === "drift-detection")
      .flatMap((evalCase) => [...evalCase.expectFindings, ...(evalCase.rerun?.expectFindings || [])])
      .map((expectation) => expectation.key.split(":")[0])
  )

  for (const rule of [
    "requirement-without-support",
    "component-without-implementation",
    "interface-contradiction",
    "stale-or-missing-source"
  ]) {
    const reported = scores.filter((score) => score.rule === rule)
    const precision = reported.length ? reported.filter((score) => score.expected).length / reported.length : 0
    console.log(`[lyta-eval] drift ${rule}: precision ${(precision * 100).toFixed(1)}% over ${reported.length} reported findings`)
    assert.ok(expectedRules.has(rule) && reported.length, `drift rule ${rule} has no scored fixture`)
    assert.ok(
      precision >= dataset.driftScoring.rulePrecisionFloor,
      `drift rule ${rule} precision ${(precision * 100).toFixed(1)}% is below the floor of ${(dataset.driftScoring.rulePrecisionFloor * 100).toFixed(1)}%`
    )
  }

  const citations = scores.reduce((total, score) => total + score.citations, 0)
  const identity = citations ? scores.reduce((total, score) => total + score.correctCitations, 0) / citations : 0
  console.log(`[lyta-eval] drift citation identity: ${(identity * 100).toFixed(1)}% over ${citations} citations`)
  assert.ok(
    identity >= dataset.driftScoring.citationIdentityFloor,
    `drift citation identity ${(identity * 100).toFixed(1)}% is below the floor of ${(dataset.driftScoring.citationIdentityFloor * 100).toFixed(1)}%`
  )
})
