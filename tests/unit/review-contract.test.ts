import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyChallenge,
  mergeChallengeEvidence,
  parseChallengeOutput,
  parseReviewOutput,
  toReviewEvidence,
  validateReviewInput,
  type ArchitectureReview
} from "../../src/review/contract"

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

function reviewWith(findings: unknown[]): ArchitectureReview {
  const parsed = parseReviewOutput({ readiness: "ready", rationale: "Grounded.", findings }, evidence)
  assert.ok(parsed.ok)
  return {
    ...parsed.value,
    id: "review_test",
    type: "architecture-change",
    requestId: "request",
    input: { proposedChange: "Move to Redis", intendedOutcome: "Stateless", sourceFileIds: ["file_a", "file_b"], constraints: "" },
    sources: [],
    evidence: [...evidence],
    modelVersion: "test",
    policyVersion: "test",
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z"
  }
}

test("challenge evidence keeps known refs and numbers new chunks after the review's", () => {
  const merged = mergeChallengeEvidence(evidence, [
    { id: "sig-b-0", label: "Source 1", fileId: "file_b", fileName: "adr.md", snippet: "Multi-AZ only." },
    { id: "sig-c-0", label: "Source 2", fileId: "file_c", fileName: "postmortem.md", snippet: "Redis failed." }
  ])

  assert.deepEqual(
    merged.evidence.map((item) => item.ref),
    ["E2", "E3"]
  )
  assert.deepEqual(
    merged.added.map((item) => [item.ref, item.chunkId]),
    [["E3", "sig-c-0"]]
  )
})

test("challenge output is validated like a review", () => {
  const finding = reviewWith([{ title: "Redis is fine", classification: "evidence-backed", citations: ["E1"] }]).findings[0]

  assert.equal(parseChallengeOutput("nope", evidence, finding).ok, false)
  assert.equal(parseChallengeOutput({ outcome: "maybe", rationale: "x" }, evidence, finding).ok, false)
  assert.equal(parseChallengeOutput({ outcome: "upheld" }, evidence, finding).ok, false, "rationale is required")
  assert.equal(
    parseChallengeOutput({ outcome: "revised", rationale: "x", counterEvidence: ["E2"] }, evidence, finding).ok,
    false,
    "revised needs a revisedFinding"
  )

  const unsupported = parseChallengeOutput(
    {
      outcome: "revised",
      rationale: "x",
      counterEvidence: ["E9"],
      revisedFinding: { title: "Redis is not fine", classification: "evidence-backed", citations: ["E9"] }
    },
    evidence,
    finding
  )
  assert.ok(unsupported.ok)
  assert.equal(unsupported.value.outcome, "insufficient evidence")
  assert.equal(unsupported.value.revised, null)

  const revised = parseChallengeOutput(
    {
      outcome: "Revised",
      rationale: "The ADR requires multi-AZ.",
      counterEvidence: ["E2"],
      revisedFinding: { title: "Redis must be multi-AZ", classification: "evidence-backed", citations: ["E2"] }
    },
    evidence,
    finding
  )
  assert.ok(revised.ok)
  assert.equal(revised.value.outcome, "revised")
  assert.deepEqual(revised.value.revised?.citationIds, ["sig-b-0"])
})

test("withdrawing the only evidence-backed finding lowers readiness and keeps the history", () => {
  const review = reviewWith([
    { title: "Redis is fine", classification: "evidence-backed", citations: ["E1"] },
    { title: "Add metrics", classification: "recommendation" }
  ])
  const finding = review.findings[0]
  finding.disposition = "accepted"
  finding.contextRecordId = "context-decision_1"
  finding.recordKind = "decision"

  const { challenge, staleContextRecordId } = applyChallenge(
    review,
    finding,
    { outcome: "withdrawn", rationale: "The ADR forbids it.", counterEvidenceIds: ["sig-b-0"], revised: null, adjustments: [] },
    { requestId: "request-2", reason: "Check the ADR", addedEvidence: [], now: "2026-11-03T01:00:00.000Z" }
  )

  assert.equal(staleContextRecordId, "context-decision_1")
  assert.equal(finding.withdrawn, true)
  assert.equal(finding.disposition, "unresolved")
  assert.equal(finding.recordKind, null)
  assert.equal(challenge.id, "F1-C1")
  assert.equal(challenge.before.title, "Redis is fine")
  assert.equal(review.readiness, "needs evidence")
  assert.match(review.adjustments.join(" "), /no finding is backed by retrieved evidence\. \(after challenge F1-C1\)/)
  assert.equal(review.updatedAt, "2026-11-03T01:00:00.000Z")
})
