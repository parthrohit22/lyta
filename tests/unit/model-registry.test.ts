import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  GRANDFATHERED_MODEL_IDS,
  MODEL_REGISTRY,
  PRODUCT_PROFILES,
  findRegistryEntry,
  resolveProfile,
  validateRegistry
} from "../../src/ai/registry"
import { ModelError, type ModelRegistryEntry, type ProductProfile, type ProductProfileId } from "../../src/ai/types"
import { MODEL_PROFILES, getModelProfile } from "../../src/config/modelProfiles"

const dataset = JSON.parse(readFileSync(new URL("../../eval/dataset.json", import.meta.url), "utf8")) as {
  version: string
  baselinePassRate: number
}

function cloneProfiles(): Record<ProductProfileId, ProductProfile> {
  return JSON.parse(JSON.stringify(PRODUCT_PROFILES))
}

function candidateEntry(overrides: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  return {
    id: "workers-ai/candidate-model",
    provider: "workers-ai",
    model: "@cf/example/candidate-model",
    version: "candidate-model",
    displayName: "Candidate",
    capabilities: { text: true, vision: false, structuredOutput: "prompted", toolCalling: false, streaming: true, embeddings: false },
    limits: { contextTokens: 32_000, maxOutputTokens: 4_096 },
    privacyClass: "cloudflare-hosted",
    availability: "enabled",
    cost: { billing: "workers-ai-neurons", estimatedCostPerRequestUsd: 0.001 },
    evaluation: {
      dataset: "eval/dataset.json",
      datasetVersion: dataset.version,
      method: "manual-real-model",
      passRate: 1,
      recordedAt: "2026-11-01",
      reference: "test fixture"
    },
    ...overrides
  }
}

test("the shipped registry satisfies every registry rule", () => {
  assert.deepEqual(validateRegistry(MODEL_REGISTRY, PRODUCT_PROFILES, dataset.baselinePassRate), [])
})

test("every entry declares capabilities, limits, privacy class, availability, cost policy and an evaluation slot", () => {
  for (const entry of MODEL_REGISTRY) {
    assert.ok(entry.capabilities, entry.id)
    assert.ok(entry.limits.contextTokens > 0, entry.id)
    assert.ok(["cloudflare-hosted", "external-processor"].includes(entry.privacyClass), entry.id)
    assert.ok(["enabled", "disabled"].includes(entry.availability), entry.id)
    assert.ok(entry.cost.estimatedCostPerRequestUsd >= 0, entry.id)
    assert.ok("evaluation" in entry, entry.id)
  }
})

test("MODEL_PROFILES derived from the registry is identical to the pre-registry per-mode configuration", () => {
  const targets = (latencyMsP50: number, latencyMsP95: number, estimatedCostPerRequestUsd: number) => ({
    latencyMsP50,
    latencyMsP95,
    estimatedCostPerRequestUsd
  })
  const legacy = {
    instant: { timeoutMs: 12_000, temperature: 0.45, top_p: 0.9, max_tokens: 1100, targets: targets(2_000, 6_000, 0.002) },
    deep: { timeoutMs: 25_000, temperature: 0.35, top_p: 0.85, max_tokens: 1800, targets: targets(5_000, 15_000, 0.004) },
    creative: { timeoutMs: 18_000, temperature: 0.9, top_p: 0.95, max_tokens: 1400, targets: targets(3_500, 10_000, 0.003) }
  }

  for (const mode of ["instant", "deep", "creative"] as const) {
    const profile = getModelProfile(mode)
    const { targets: expectedTargets, ...expected } = legacy[mode]
    const { qualityNotes, ...actualTargets } = profile.targets

    assert.equal(profile.model, "@cf/meta/llama-4-scout-17b-16e-instruct")
    assert.equal(profile.modelVersion, "llama-4-scout-17b-16e-instruct")
    assert.equal(profile.fallbackModel, "@cf/meta/llama-3.1-8b-instruct")
    assert.equal(profile.maxRetries, 1)
    assert.deepEqual(
      { timeoutMs: profile.timeoutMs, temperature: profile.temperature, top_p: profile.top_p, max_tokens: profile.max_tokens },
      expected
    )
    assert.deepEqual(actualTargets, expectedTargets)
    assert.ok(qualityNotes.length > 0)
    assert.equal(MODEL_PROFILES[mode], profile)
  }
})

test("getModelProfile still falls back to instant for an unknown mode", () => {
  assert.equal(getModelProfile("unknown" as never), MODEL_PROFILES.instant)
})

test("Instant, Deep Review and Visual Review resolve to capability-compatible models", () => {
  const instant = resolveProfile("instant")
  const deep = resolveProfile("deep-review")
  const visual = resolveProfile("visual-review")

  assert.equal(instant.profile.label, "Instant")
  assert.equal(deep.profile.label, "Deep Review")
  assert.equal(visual.profile.label, "Visual Review")

  for (const resolution of [instant, deep, visual]) {
    for (const entry of [resolution.primary, resolution.fallback].filter(Boolean) as ModelRegistryEntry[]) {
      assert.equal(entry.availability, "enabled")
      assert.ok(resolution.profile.allowedPrivacyClasses.includes(entry.privacyClass))
      assert.ok(resolution.profile.policy.max_tokens <= entry.limits.maxOutputTokens, `${resolution.profile.id} → ${entry.id}`)
    }
  }

  assert.ok(visual.primary.capabilities.vision)
  assert.equal(visual.fallback, undefined, "no text-only model may stand in for Visual Review")
})

test("a request that carries an image never falls back to a text-only model", () => {
  const resolution = resolveProfile("instant", { requires: ["vision"] })

  assert.ok(resolution.primary.capabilities.vision)
  assert.equal(resolution.fallback, undefined)
})

test("a request larger than a model's context window skips that model", () => {
  const resolution = resolveProfile("deep-review", { minContextTokens: 20_000 })

  assert.equal(resolution.primary.id, "workers-ai/llama-4-scout-17b-16e-instruct")
  assert.equal(resolution.fallback, undefined, "the 8B fallback's ~8K context cannot hold this request")
})

test("a profile with no compatible model fails clearly instead of picking an incompatible one", () => {
  const registry = MODEL_REGISTRY.filter((entry) => !entry.capabilities.vision || entry.provider === "gateway-external")

  assert.throws(
    () => resolveProfile("visual-review", { registry }),
    (error: unknown) =>
      error instanceof ModelError &&
      error.code === "no_compatible_model" &&
      error.profile === "visual-review" &&
      /Visual Review is unavailable/.test(error.message) &&
      /vision/.test(error.message)
  )
})

test("the external provider entry is never selected while it is disabled, unevaluated, or not allowed by the profile", () => {
  const external = findRegistryEntry("gateway-external/openai-gpt-4o-mini")!
  const profiles = cloneProfiles()
  profiles.instant.candidates = [external.id, ...profiles.instant.candidates]
  profiles.instant.allowedPrivacyClasses = ["cloudflare-hosted", "external-processor"]

  assert.equal(external.availability, "disabled")
  assert.equal(resolveProfile("instant", { profiles, externalProvidersEnabled: true }).primary.provider, "workers-ai")
  assert.equal(resolveProfile("instant").primary.provider, "workers-ai")
})

test("the external path only activates when the entry, its evaluation, the profile and the runtime gate all allow it", () => {
  const external = { ...findRegistryEntry("gateway-external/openai-gpt-4o-mini")!, availability: "enabled" as const }
  const evaluated = { ...external, evaluation: candidateEntry().evaluation }
  const registry = [...MODEL_REGISTRY.filter((entry) => entry.id !== external.id), evaluated]
  const profiles = cloneProfiles()
  profiles.instant.candidates = [external.id, ...profiles.instant.candidates]

  // Profile still restricted to Cloudflare-hosted models.
  assert.equal(resolveProfile("instant", { registry, profiles, externalProvidersEnabled: true }).primary.provider, "workers-ai")

  profiles.instant.allowedPrivacyClasses = ["cloudflare-hosted", "external-processor"]

  // Runtime gate off (AI_EXTERNAL_PROVIDERS unset or no gateway).
  assert.equal(resolveProfile("instant", { registry, profiles }).primary.provider, "workers-ai")

  // Unevaluated entry.
  const unevaluated = [...MODEL_REGISTRY.filter((entry) => entry.id !== external.id), external]
  assert.equal(
    resolveProfile("instant", { registry: unevaluated, profiles, externalProvidersEnabled: true }).primary.provider,
    "workers-ai"
  )
  assert.ok(validateRegistry(unevaluated, profiles).some((problem) => /enabled without an evaluation/.test(problem)))

  const resolution = resolveProfile("instant", { registry, profiles, externalProvidersEnabled: true })
  assert.equal(resolution.primary.id, external.id)
  assert.equal(resolution.fallback?.id, "workers-ai/llama-4-scout-17b-16e-instruct")
})

test("adding a model takes a registry entry plus an evaluation result, and nothing else", () => {
  const candidate = candidateEntry()
  const registry = [...MODEL_REGISTRY, candidate]
  const profiles = cloneProfiles()
  profiles.instant.candidates = [candidate.id, ...profiles.instant.candidates]

  assert.deepEqual(validateRegistry(registry, profiles, dataset.baselinePassRate), [])
  assert.equal(resolveProfile("instant", { registry, profiles }).primary.id, candidate.id)
})

test("a new model without an acceptable evaluation result is rejected", () => {
  const profiles = cloneProfiles()
  const cases: Array<[ModelRegistryEntry, RegExp]> = [
    [candidateEntry({ evaluation: null }), /without an evaluation/],
    [candidateEntry({ evaluation: { ...candidateEntry().evaluation!, passRate: 0.5 } }), /below the dataset baseline/],
    [candidateEntry({ evaluation: { ...candidateEntry().evaluation!, method: "grandfathered-baseline" } }), /grandfathered/]
  ]

  for (const [entry, problem] of cases) {
    const problems = validateRegistry([...MODEL_REGISTRY, entry], profiles, dataset.baselinePassRate)
    assert.ok(
      problems.some((item) => problem.test(item)),
      `${problem}: ${problems.join("; ")}`
    )
  }

  assert.ok(!GRANDFATHERED_MODEL_IDS.has(candidateEntry().id))
})

test("a profile naming a model that is not in the registry is reported", () => {
  const profiles = cloneProfiles()
  profiles["deep-review"].candidates = ["workers-ai/does-not-exist", ...profiles["deep-review"].candidates]

  assert.ok(validateRegistry(MODEL_REGISTRY, profiles).some((problem) => /does-not-exist is not in the registry/.test(problem)))
})

test("a profile whose reply budget exceeds a candidate's output ceiling is reported", () => {
  const small = candidateEntry({ limits: { contextTokens: 32_000, maxOutputTokens: 512 } })
  const profiles = cloneProfiles()
  profiles["deep-review"].candidates = [small.id, ...profiles["deep-review"].candidates]

  assert.ok(validateRegistry([...MODEL_REGISTRY, small], profiles).some((problem) => /max_tokens 1800 exceeds/.test(problem)))
})

test("the embedding profile never falls back to a different embedding model", () => {
  const second = candidateEntry({
    id: "workers-ai/other-embeddings",
    capabilities: { text: false, vision: false, structuredOutput: "none", toolCalling: false, streaming: false, embeddings: true },
    limits: { contextTokens: 512, maxOutputTokens: 0, embeddingDimensions: 1024 }
  })
  const profiles = cloneProfiles()
  profiles.embedding.candidates = [...profiles.embedding.candidates, second.id]

  const resolution = resolveProfile("embedding", { registry: [...MODEL_REGISTRY, second], profiles })

  assert.equal(resolution.primary.id, "workers-ai/bge-base-en-v1.5")
  assert.equal(resolution.fallback, undefined)
})
