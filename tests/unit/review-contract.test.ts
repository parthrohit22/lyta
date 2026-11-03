import assert from "node:assert/strict"
import { test } from "node:test"
import { parseReviewOutput, toReviewEvidence, validateReviewInput } from "../../src/review/contract"

const evidence = toReviewEvidence([
  { id: "sig-a-0", label: "Source 1", fileId: "file_a", fileName: "proposal.md", snippet: "Use Redis." },
  { id: "sig-b-0", label: "Source 2", fileId: "file_b", fileName: "adr.md", snippet: "Multi-AZ only." }
])

test("review input requires a change, an outcome, and between one and eight sources", () => {
  assert.deepEqual(validateReviewInput(null), { ok: false, error: "Body missing" })
  assert.equal(validateReviewInput({ proposedChange: "x", intendedOutcome: "y", sourceFileIds: "file_a" }).ok, false)
  assert.equal(validateReviewInput({ proposedChange: " ", intendedOutcome: "y", sourceFileIds: ["file_a"] }).ok, false)
  assert.equal(
    validateReviewInput({ proposedChange: "x", intendedOutcome: "y", sourceFileIds: Array.from({ length: 9 }, (_, i) => `f${i}`) }).ok,
    false
  )

  const valid = validateReviewInput({
    proposedChange: " Move to Redis ",
    intendedOutcome: "Stateless gateways",
    sourceFileIds: ["file_a", "file_a"]
  })
  assert.deepEqual(valid, {
    ok: true,
    value: { proposedChange: "Move to Redis", intendedOutcome: "Stateless gateways", sourceFileIds: ["file_a"], constraints: "" }
  })
})

test("fenced JSON, loose enum spelling, and canonical chunk ids are accepted", () => {
  const raw = [
    "```json",
    JSON.stringify({
      readiness: "Needs_Evidence",
      rationale: "Latency is unproven.",
      findings: [{ title: "Uses Redis", classification: "Evidence-Backed", areaType: "component", citations: ["[E1]", "sig-b-0"] }]
    }),
    "```"
  ].join("\n")
  const result = parseReviewOutput(raw, evidence)

  assert.ok(result.ok)
  assert.equal(result.value.readiness, "needs evidence")
  assert.equal(result.value.findings[0].classification, "evidence-backed")
  assert.deepEqual(result.value.findings[0].citationIds, ["sig-a-0", "sig-b-0"])
  assert.deepEqual(result.value.requiredTests, [])
})

test("structural problems are errors rather than partial reviews", () => {
  assert.equal(parseReviewOutput("not json", evidence).ok, false)
  assert.equal(parseReviewOutput('Here you go: {"readiness":"ready"}', evidence).ok, false)
  assert.equal(parseReviewOutput({ readiness: "ready", findings: [] }, evidence).ok, false, "rationale is required")
  assert.equal(parseReviewOutput({ readiness: "ready", rationale: "x" }, evidence).ok, false, "findings are required")
  assert.equal(parseReviewOutput({ readiness: "ready", rationale: "x", findings: [], rollback: "revert" }, evidence).ok, false)
  assert.equal(
    parseReviewOutput({ readiness: "ready", rationale: "x", findings: [{ title: "t", classification: "fact" }] }, evidence).ok,
    false
  )
})

test("grounding corrections are applied and recorded", () => {
  const result = parseReviewOutput(
    {
      readiness: "ready",
      rationale: "Ship it.",
      findings: [
        { title: "Invented support", classification: "evidence-backed", citations: ["E7"] },
        { title: "Suggestion", classification: "recommendation" }
      ]
    },
    evidence
  )

  assert.ok(result.ok)
  assert.equal(result.value.findings[0].classification, "inference")
  assert.deepEqual(result.value.findings[0].citationIds, [])
  assert.equal(result.value.findings[0].adjustments.length, 2)
  assert.equal(result.value.readiness, "needs evidence")
  assert.match(result.value.adjustments[0], /no finding is backed by retrieved evidence/)
})

test("blocked is never raised to ready, and a conflict citing one chunk twice is dropped", () => {
  const result = parseReviewOutput(
    {
      readiness: "blocked",
      rationale: "ADR forbids it.",
      findings: [{ title: "ADR conflict", classification: "evidence-backed", citations: ["E2"] }],
      conflicts: [{ description: "Same chunk twice", citations: ["E1", "sig-a-0"] }]
    },
    evidence
  )

  assert.ok(result.ok)
  assert.equal(result.value.readiness, "blocked")
  assert.deepEqual(result.value.conflicts, [])
  assert.match(result.value.adjustments[0], /Dropped a conflict/)
})
