import assert from "node:assert/strict"
import { test } from "node:test"
import {
  assertsProjectAbsence,
  diffDriftRuns,
  driftFindingKey,
  parseDriftOutput,
  validateDriftInput,
  type DriftEvidence,
  type DriftFinding,
  type DriftRun,
  type DriftSource
} from "../../src/drift/contract"

const sources: DriftSource[] = [
  { role: "specification", fileId: "f1", fileName: "prd.md", sourceVersionId: "v1", importedAt: "", updatedAt: "", supersededBy: null },
  { role: "architecture", fileId: "f2", fileName: "design.md", sourceVersionId: "v2", importedAt: "", updatedAt: "", supersededBy: null },
  { role: "implementation", fileId: "f3", fileName: "code.md", sourceVersionId: "v3", importedAt: "", updatedAt: "", supersededBy: null }
]
const evidence: DriftEvidence[] = sources.map((source, index) => ({
  ref: `E${index + 1}`,
  chunkId: `chunk-${source.role}`,
  fileId: source.fileId,
  fileName: source.fileName,
  role: source.role,
  snippet: "",
  rank: 1,
  retrievalSize: 1
}))
const coverage = sources.map((source) => ({ role: source.role, sourceCount: 1, passageCount: 1, sourcesWithoutPassages: [] }))
const context = { evidence, sources, coverage, rules: ["requirement-without-support", "interface-contradiction"] as DriftRun["rules"] }

test("finding keys are stable across wording, case, and punctuation of the same subject", () => {
  assert.equal(driftFindingKey("interface-contradiction", "Session TTL"), "interface-contradiction:session-ttl")
  assert.equal(driftFindingKey("interface-contradiction", "  session   ttl! "), "interface-contradiction:session-ttl")
  assert.equal(driftFindingKey("requirement-without-support", "???"), "requirement-without-support:unspecified")
})

test("project-level absence wording is detected, absence from the supplied evidence is not", () => {
  for (const text of [
    "The indexer does not exist.",
    "Export is not implemented at all.",
    "The worker was never implemented.",
    "Retries are missing from the codebase.",
    "No implementation exists for CSV export."
  ]) {
    assert.ok(assertsProjectAbsence(text), text)
  }
  for (const text of [
    "Not found in the supplied evidence.",
    "No retrieved implementation passage mentions an indexer.",
    "The code export sets MAX_RETRIES = 5."
  ]) {
    assert.ok(!assertsProjectAbsence(text), text)
  }
})

test("rules the run did not select are dropped, and unknown rules are malformed", () => {
  const parsed = parseDriftOutput(
    {
      summary: "s",
      findings: [{ rule: "component-without-implementation", subject: "x", claim: "x", confidence: "low", claimCitations: ["E2"] }]
    },
    context
  )
  assert.ok(parsed.ok)
  assert.equal(parsed.value.findings.length, 0)
  assert.match(parsed.value.adjustments[0], /was not selected for this run/)

  const unknown = parseDriftOutput({ summary: "s", findings: [{ rule: "vibes", claim: "x", confidence: "low" }] }, context)
  assert.equal(unknown.ok, false)
  assert.equal(parseDriftOutput({ findings: [] }, context).ok, false, "a missing summary is malformed")
  assert.equal(
    parseDriftOutput({ summary: "s", findings: [{ rule: "interface-contradiction", claim: "x", confidence: "sure" }] }, context).ok,
    false
  )
})

test("the diff matches by key, and resolved findings come only from the previous run", () => {
  const finding = (key: string): DriftFinding =>
    ({ key, rule: key.split(":")[0], subject: key, claim: key, diffStatus: "new" }) as unknown as DriftFinding
  const previous = {
    id: "run-1",
    number: 1,
    findings: [finding("interface-contradiction:a"), finding("interface-contradiction:b")]
  } as DriftRun
  const { findings, diff } = diffDriftRuns(previous, [finding("interface-contradiction:b"), finding("interface-contradiction:c")])

  assert.deepEqual(
    findings.map((item) => item.diffStatus),
    ["unchanged", "new"]
  )
  assert.deepEqual(diff.new, ["interface-contradiction:c"])
  assert.deepEqual(diff.unchanged, ["interface-contradiction:b"])
  assert.deepEqual(
    diff.resolved.map((item) => [item.key, item.lastSeenRunNumber]),
    [["interface-contradiction:a", 1]]
  )
  assert.equal(diffDriftRuns(null, [finding("interface-contradiction:a")]).diff.previousRunId, null)
})

test("input validation lists what is supported instead of approximating", () => {
  const base = {
    comparisonType: "spec-architecture-implementation",
    scope: "s",
    sources: { specification: ["a"], architecture: ["b"], implementation: ["c"] }
  }
  assert.ok(validateDriftInput(base).ok)
  const rules = validateDriftInput({ ...base, rules: ["interface-contradiction"] })
  assert.ok(rules.ok && rules.value.rules.length === 1)

  const unsupported = validateDriftInput({ ...base, comparisonType: "code-vs-tests" })
  assert.ok(!unsupported.ok && /Supported comparison types: spec-architecture-implementation/.test(unsupported.error))
  const tooMany = validateDriftInput({ ...base, sources: { ...base.sources, implementation: ["1", "2", "3", "4", "5", "6", "7"] } })
  assert.ok(!tooMany.ok && /at most 6/.test(tooMany.error))
  assert.ok(!validateDriftInput({ ...base, rules: [] }).ok)
})
