import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

// Automated accessibility checks for the static shell (pages/index.html), the
// stylesheet's focus/motion/contrast rules, and the review helpers that write
// screen-reader text. There is no browser or DOM library in this test setup,
// so markup is checked structurally; docs/demo/review-walkthrough.md covers
// the manual keyboard and screen-reader pass.

const html = readFileSync(new URL("../../pages/index.html", import.meta.url), "utf8")
const css = readFileSync(new URL("../../pages/styles.css", import.meta.url), "utf8")
const reviewScript = readFileSync(new URL("../../pages/app-review.js", import.meta.url), "utf8")
const driftScript = readFileSync(new URL("../../pages/app-drift.js", import.meta.url), "utf8")

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])

function attributes(tag: string) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((match) => [match[1], match[2] ?? ""]))
}

test("element ids are unique and every id reference resolves", () => {
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  assert.deepEqual(duplicates, [])

  const references = [
    ...[...html.matchAll(/\s(?:aria-labelledby|aria-controls|aria-describedby|for)="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)),
    ...[...html.matchAll(/\shref="#([^"]+)"/g)].map((match) => match[1])
  ]
  const missing = references.filter((id) => !ids.includes(id))
  assert.deepEqual(missing, [], `unresolved id references: ${missing.join(", ")}`)
})

test("every button has an accessible name and decorative icons are hidden", () => {
  const unnamed = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, body]) => {
      const text = body
        .replace(/<svg[\s\S]*?<\/svg>/g, "")
        .replace(/<[^>]+>/g, "")
        .trim()
      return !text && !/aria-label(ledby)?="[^"]+"/.test(attrs)
    })
    .map(([tag]) => tag.slice(0, 80))
  assert.deepEqual(unnamed, [])

  const exposedIcons = [...html.matchAll(/<svg class="icon"([^>]*)>/g)].filter(([, attrs]) => !/aria-hidden="true"/.test(attrs))
  assert.equal(exposedIcons.length, 0)
})

test("every form control has a label", () => {
  const labelled = new Set<string>()
  for (const [, body] of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    for (const [, id] of body.matchAll(/<(?:input|textarea|select)\b[^>]*\sid="([^"]+)"/g)) labelled.add(id)
  }
  for (const [, id] of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) labelled.add(id)

  const unlabelled = [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)]
    .map(([, , attrs]) => attributes(`<x ${attrs}>`))
    .filter((attrs) => attrs.type !== "hidden" && !("hidden" in attrs))
    .filter((attrs) => !attrs["aria-label"] && !attrs["aria-labelledby"] && !labelled.has(attrs.id))
    .map((attrs) => attrs.id || "(no id)")
  assert.deepEqual(unlabelled, [])
})

test("the shell has landmarks, a working skip link, and live regions for streaming and review results", () => {
  assert.match(html, /<html lang="en">/)
  assert.equal((html.match(/<main\b/g) || []).length, 1)
  assert.match(html, /<aside id="sidebar" aria-label="[^"]+"/)
  assert.match(html, /<section id="reviewPanel"[^>]*aria-labelledby="reviewPanelTitle"/)
  assert.match(html, /<aside id="evidencePanel"[^>]*aria-labelledby="evidenceTitle"/)

  const skip = html.match(/<a class="skip-link" href="#([^"]+)"/)
  assert.ok(skip)
  assert.match(html, new RegExp(`id="${skip[1]}"[^>]*tabindex="-1"`), "the skip target can receive focus")

  assert.match(html, /id="liveAnnouncer"[^>]*role="status"[^>]*aria-live="polite"/)
  assert.match(html, /id="liveAlert"[^>]*role="alert"[^>]*aria-live="assertive"/)
  assert.match(html, /id="reviewStatus"[^>]*role="status"[^>]*aria-live="polite"/)
  assert.match(html, /id="conversationSurface" role="log" aria-live="polite" aria-busy="false"/)
  assert.match(html, /id="composerStatus"[^>]*aria-live="polite"/)
  assert.match(html, /id="viewSwitch"[^>]*role="group"[^>]*aria-label="Workspace view"/)
  assert.match(html, /data-view="review" aria-pressed="true"/)
})

test("review and drift UI never insert markup from strings", () => {
  assert.doesNotMatch(reviewScript, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/)
  assert.doesNotMatch(driftScript, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/)
})

test("Check drift sits next to Review a change and its form is labelled and announced", () => {
  const openReview = html.indexOf('id="openReview"')
  const openDrift = html.indexOf('id="openDrift"')
  assert.ok(openReview > 0 && openDrift > openReview && openDrift < html.indexOf('id="openRecords"'), "Check drift follows Review a change")
  assert.match(html, /<button id="openDrift"[^>]*aria-label="Check drift"/)
  assert.match(html, /<section class="sidebar-section" aria-labelledby="sidebarDriftTitle">/)
  assert.match(html, /<div id="driftStartView" class="review-view" hidden>/)
  assert.match(html, /<div id="driftRunView" class="review-view" hidden>/)
  assert.match(html, /<fieldset class="review-sources">\s*<legend>Sources and roles<\/legend>/)
  assert.match(html, /<fieldset class="review-sources" id="driftRules">\s*<legend>Drift rules<\/legend>/)
  assert.match(html, /id="driftRoleSummary"[^>]*aria-live="polite"/)
  assert.equal((html.match(/name="driftRule"/g) || []).length, 4, "the four documented rules are offered")
  assert.ok(
    html.indexOf("/app-drift-core.js") < html.indexOf("/app-drift.js") && html.indexOf("/app-review.js") < html.indexOf("/app-drift.js")
  )

  // Role pickers are built at runtime, so check the script names them and announces results.
  assert.match(driftScript, /select\.setAttribute\("aria-label", `Role for \$\{file\.name\}`\)/)
  assert.match(driftScript, /button\.setAttribute\("aria-controls", "evidencePanel"\)/)
  assert.match(driftScript, /group\.setAttribute\("role", "group"\)/)
  assert.match(driftScript, /announce\(buildRunAnnouncement\(run\)\)/)
  assert.match(driftScript, /announce\(`Drift check failed\. \$\{message\}`, "assertive"\)/)
  assert.match(driftScript, /cell\.scope = "col"/, "the sources table has column headers")
})

/* ---------------------------------------------------------------------- */
/* stylesheet: focus, motion, hidden sheets                                */
/* ---------------------------------------------------------------------- */

const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selectors: selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
  body
}))

test("focus is always visible", () => {
  const focusVisible = rules.find((rule) => rule.selectors.includes(":focus-visible"))
  assert.ok(focusVisible, "a global :focus-visible rule exists")
  assert.match(focusVisible.body, /outline:2px solid var\(--accent\)/)

  // Any control that removes its outline must restyle itself on :focus, or
  // sit in a wrapper that restyles on :focus-within.
  const wrappers: Record<string, string> = { ".sidebar-search input": ".sidebar-search", "#message": "#composerShell" }
  const restyles = (selector: string) =>
    rules.some((rule) => rule.selectors.includes(selector) && /border-color:var\(--accent\)/.test(rule.body))
  const hidden = rules.filter((rule) => /outline:\s*none/.test(rule.body)).flatMap((rule) => rule.selectors)
  const unreplaced = hidden
    .filter((selector) => !/:focus/.test(selector))
    .filter((selector) => !restyles(`${selector}:focus`) && !restyles(`${selector}:focus-visible`))
    .filter((selector) => !(wrappers[selector] && restyles(`${wrappers[selector]}:focus-within`)))
  assert.deepEqual(unreplaced, [])

  // Besides the global ":focus" reset (keyboard focus still gets the :focus-visible
  // ring above), programmatic focus targets (tabindex="-1" headings) are the only
  // :focus outline removals.
  const focusRemovals = hidden.filter(
    (selector) => selector !== ":focus" && /:focus$/.test(selector) && !/(input|textarea|select)/.test(selector)
  )
  for (const selector of focusRemovals) {
    const id = selector.match(/^#([\w-]+):focus$/)?.[1]
    assert.ok(
      id && new RegExp(`id="${id}"[^>]*tabindex="-1"`).test(html),
      `${selector} only removes focus rings from programmatic focus targets`
    )
  }
})

test("motion respects prefers-reduced-motion and closed sheets leave the accessibility tree", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?transition-duration:\.001ms !important/)
  const sheets = css.match(/#artifactPanel,\s*body\.board-closed #artifactPanel,\s*#evidencePanel\{([^}]*)\}/)
  assert.ok(sheets, "board and evidence panels share the bottom-sheet rule")
  assert.match(sheets[1], /visibility:hidden/)
  assert.match(css, /body\.board-sheet-open #artifactPanel,\s*body\.evidence-sheet-open #evidencePanel\{[^}]*visibility:visible/)
})

/* ---------------------------------------------------------------------- */
/* contrast                                                                */
/* ---------------------------------------------------------------------- */

function themeTokens(selectorPattern: RegExp) {
  const block = css.match(selectorPattern)
  assert.ok(block, `theme block ${selectorPattern} exists`)
  return Object.fromEntries([...block[1].matchAll(/--([\w-]+):([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
}

function parseColor(value: string, background?: [number, number, number]): [number, number, number] {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16)) as [number, number, number]
  const rgba = value.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/)
  assert.ok(rgba && background, `unsupported color ${value}`)
  const alpha = Number(rgba[4])
  return [1, 2, 3].map((index) => Math.round(Number(rgba[index]) * alpha + background[index - 1] * (1 - alpha))) as [number, number, number]
}

function luminance([r, g, b]: [number, number, number]) {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground: [number, number, number], background: [number, number, number]) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

// [foreground, background, minimum]. Text pairs need 4.5:1 (WCAG 1.4.3);
// component boundaries and focus indicators need 3:1 (WCAG 1.4.11).
const CONTRAST_PAIRS: Array<[string, string, number]> = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["text", "surface-subtle", 4.5],
  ["text-muted", "bg", 4.5],
  ["text-muted", "surface", 4.5],
  ["text-muted", "surface-subtle", 4.5],
  ["text-subtle", "bg", 4.5],
  ["text-subtle", "surface", 4.5],
  ["accent-on", "accent", 4.5],
  ["accent", "accent-subtle", 4.5],
  ["success", "surface", 4.5],
  ["warning", "surface", 4.5],
  ["danger", "surface", 4.5],
  ["danger", "danger-subtle", 4.5],
  ["accent", "bg", 3],
  ["border-strong", "surface", 3],
  ["border-strong", "bg", 3]
]

for (const [theme, pattern] of [
  ["light", /:root,\s*\[data-theme="light"\]\{([^}]*)\}/],
  ["dark", /\[data-theme="dark"\]\{([^}]*)\}/]
] as const) {
  test(`${theme} theme tokens meet WCAG AA contrast`, () => {
    const tokens = themeTokens(pattern)
    const bg = parseColor(tokens.bg)
    const failures = CONTRAST_PAIRS.map(([foreground, background, minimum]) => {
      const back = parseColor(tokens[background], bg)
      const ratio = contrast(parseColor(tokens[foreground], back), back)
      return { pair: `${foreground} on ${background}`, ratio: Number(ratio.toFixed(2)), minimum }
    }).filter((result) => result.ratio < result.minimum)

    assert.deepEqual(failures, [])
  })
}

test("form controls draw their boundary with the 3:1 border token", () => {
  for (const selector of [".settings-field input", ".settings-field textarea", ".settings-field select,", ".drift-role-row select"]) {
    const index = css.indexOf(`${selector}`)
    assert.ok(index >= 0, `${selector} is styled`)
    assert.match(css.slice(index, css.indexOf("}", index)), /border:1px solid var\(--border-strong\)/, `${selector} uses --border-strong`)
  }
})

/* ---------------------------------------------------------------------- */
/* screen-reader and evidence-state text                                   */
/* ---------------------------------------------------------------------- */

function loadReviewCore() {
  const context = { window: {} as { LytaReview?: Record<string, (...args: unknown[]) => unknown> } }
  vm.runInNewContext(readFileSync(new URL("../../pages/app-review-core.js", import.meta.url), "utf8"), context)
  return context.window.LytaReview!
}

const sampleReview = {
  id: "review_1",
  readiness: "needs evidence",
  rationale: "No load test yet.",
  policyVersion: "2026-11-03.architecture-review",
  input: { proposedChange: "Move to Redis", intendedOutcome: "Stateless", sourceFileIds: ["file_a"] },
  sources: [{ fileId: "file_a", fileName: "proposal.md", sourceVersionId: "source-version:a" }],
  evidence: [
    {
      ref: "E1",
      chunkId: "a-0",
      fileId: "file_a",
      fileName: "proposal.md",
      snippet: "Use Redis.",
      retrievedFor: "review",
      rank: 1,
      retrievalSize: 4
    },
    {
      ref: "E5",
      chunkId: "b-0",
      fileId: "file_b",
      fileName: "adr.md",
      snippet: "Multi-AZ.",
      retrievedFor: "F2-C1",
      rank: 1,
      retrievalSize: 6
    }
  ],
  findings: [
    { id: "F1", title: "Interface unchanged", classification: "evidence-backed", citationIds: ["a-0"] },
    { id: "F2", title: "Single-AZ is fine", classification: "evidence-backed", citationIds: ["b-0"], withdrawn: true },
    { id: "F3", title: "Mystery", classification: "certain", citationIds: [] }
  ],
  missingEvidence: ["Load test results"]
}

test("review results are announced with readiness and grounding counts", () => {
  const core = loadReviewCore()
  const review = core.normalizeReview(sampleReview) as { findings: Array<{ classification: string }> }

  assert.equal(core.buildReviewAnnouncement(review), "Review ready: Needs evidence. 3 findings, 1 evidence-backed. 1 gaps in evidence.")
  assert.equal(core.buildChallengeAnnouncement("F2", "revised", true), "F2 challenge: Revised. The conclusion changed.")
  assert.equal(core.buildChallengeAnnouncement("F1", "bogus", false), "F1 challenge: Recorded. The conclusion did not change.")
  assert.equal(review.findings[2].classification, "inference", "an unknown classification is never shown as evidence")
})

test("selecting a claim describes its evidence state and retrieval context truthfully", () => {
  const core = loadReviewCore()
  const review = core.normalizeReview(sampleReview) as {
    findings: Array<Record<string, unknown>>
    evidence: Array<Record<string, unknown>>
  }
  const state = (finding: Record<string, unknown>, cited: number) => core.describeEvidenceState(finding, cited) as { state: string }

  assert.equal(state(review.findings[0], 1).state, "evidence-backed")
  assert.equal(state(review.findings[0], 0).state, "unsupported", "evidence-backed with no live passage is not presented as supported")
  assert.equal(state(review.findings[1], 1).state, "withdrawn")
  assert.equal(state(review.findings[2], 0).state, "inference")
  assert.equal(state({ ...review.findings[0], classification: "insufficient evidence" }, 0).state, "insufficient-evidence")

  assert.equal(
    core.describeRetrieval(review, review.evidence[0]),
    "Retrieved for this review, rank 1 of 4 · policy 2026-11-03.architecture-review"
  )
  assert.equal(
    core.describeRetrieval(review, review.evidence[1]),
    "Retrieved by challenge F2-C1, rank 1 of 6 · policy 2026-11-03.architecture-review.challenge"
  )
  assert.deepEqual(
    { ...(core.countRecordsByKind([{ kind: "risk" }, { kind: "risk" }, { kind: "decision" }]) as object) },
    { risk: 2, decision: 1 }
  )
})

function loadDriftCore() {
  const context = { window: {} as { LytaDrift?: Record<string, (...args: unknown[]) => unknown> } }
  vm.runInNewContext(readFileSync(new URL("../../pages/app-drift-core.js", import.meta.url), "utf8"), context)
  return context.window.LytaDrift!
}

const sampleDriftRun = {
  id: "drift-run_2",
  number: 2,
  rules: ["requirement-without-support", "interface-contradiction", "not-a-rule"],
  findings: [
    {
      key: "requirement-without-support:csv-export",
      id: "D1-1",
      rule: "requirement-without-support",
      subject: "CSV export",
      claim: "REQ-1 requires CSV export.",
      counterpart: { kind: "not-found-in-supplied-evidence", searchedSources: ["architecture.md", "code.md"], description: "Not found." },
      confidence: "medium",
      diffStatus: "unchanged"
    },
    {
      key: "interface-contradiction:ttl",
      id: "D3-1",
      rule: "interface-contradiction",
      subject: "TTL",
      counterpart: { kind: "surely-cited" },
      confidence: "certain"
    },
    { key: "made-up:rule", rule: "vibes", subject: "Unknown" }
  ],
  diff: {
    previousRunNumber: 1,
    resolved: [{ key: "component-without-implementation:indexer", rule: "component-without-implementation", subject: "Indexer" }]
  }
}

test("drift results are announced with their diff, and absence is never described as absence from the project", () => {
  const core = loadDriftCore()
  const run = core.normalizeRun(sampleDriftRun) as {
    rules: string[]
    findings: Array<{ id: string; subject: string; confidence: string; counterpart: { kind: string } }>
  }

  assert.deepEqual(run.rules, ["requirement-without-support", "interface-contradiction"])
  assert.equal(run.findings.length, 2, "a finding with an unknown rule is not shown")
  assert.equal(run.findings[1].counterpart.kind, "not-found-in-supplied-evidence", "an unknown counterpart kind is never shown as cited")
  assert.equal(run.findings[1].confidence, "low", "an unknown confidence is shown as low")
  assert.equal(core.buildRunAnnouncement(run), "Drift run 2 ready: 2 findings. 1 new, 1 unchanged, 1 resolved since the previous run.")
  assert.equal(
    core.buildDispositionAnnouncement(run.findings[0], "accepted-deviation"),
    "D1-1 CSV export: marked accepted deviation. Kept for later runs."
  )

  const absence = core.describeCounterpart(run.findings[0]) as { state: string; label: string; description: string }
  assert.equal(absence.label, "Not found in the supplied evidence")
  assert.equal(absence.state, "not-found")
  assert.match(absence.description, /from architecture\.md, code\.md supports it\. That does not show it is absent from the project\./)
  assert.doesNotMatch(absence.description, /does not exist|not implemented/)

  const selection = core.buildSelection([
    { fileId: "a", role: "specification" },
    { fileId: "b", role: "architecture" },
    { fileId: "c", role: "" }
  ]) as { error: string }
  assert.equal(selection.error, "Choose at least one source for Implementation evidence.")
  assert.equal(core.runPath("drift 1", "run/2", "export"), "/drift/drift%201/runs/run%2F2/export")
})
