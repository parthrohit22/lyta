// Runs the cross-model evaluation (issue #16) and writes a report to
// eval/reports/<date>-<label>.json plus a Markdown summary. Reports hold scores
// and ids only.
//
//   npm run eval:run -- --backend scripted --label scripted-pipeline
//   LYTA_EVAL_TOKEN=... npm run eval:run -- --backend workers-ai --url http://localhost:8787 --label first-real-run
//
// The scripted backend calls no model; its report is marked pipeline-only. The
// workers-ai backend needs a `wrangler dev --remote` Worker started with the
// eval route enabled; see eval/README.md "Running against real models".
import { MODEL_PROFILES } from "../src/config/modelProfiles"
import { resolveCandidates, validateDataset, validateThresholds } from "../src/eval/dataset"
import { createScriptedBackend, createWorkersAiBackend, runEvaluation, scriptedCandidate, SCRIPTED_BEHAVIOURS } from "../src/eval/runner"
import { loadCandidateConfig, loadDataset, loadThresholds, writeReport } from "./eval-files"

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const backendName = argument("backend") || "scripted"
  const label = argument("label") || (backendName === "scripted" ? "scripted-pipeline" : "real-run")
  const dataset = loadDataset()
  const thresholds = loadThresholds()
  const config = loadCandidateConfig()
  const problems = [...validateDataset(dataset), ...validateThresholds(thresholds)]

  if (backendName === "scripted") {
    if (problems.length) throw new Error(problems.join("\n"))
    const deep = MODEL_PROFILES.deep
    const report = await runEvaluation({
      dataset,
      thresholds,
      backend: createScriptedBackend(),
      baseline: scriptedCandidate("scripted-baseline", "reference", deep, "deep"),
      candidates: SCRIPTED_BEHAVIOURS.map((behaviour) => scriptedCandidate(`scripted-${behaviour}`, behaviour, deep, "deep")),
      candidatesVersion: "scripted",
      label
    })
    return finish(writeReport(report), report.gate)
  }

  if (backendName !== "workers-ai") throw new Error(`Unknown --backend ${backendName}; use scripted or workers-ai.`)
  const url = argument("url") || "http://localhost:8787"
  const token = process.env.LYTA_EVAL_TOKEN
  if (!token) throw new Error("Set LYTA_EVAL_TOKEN to the token the Worker was started with.")

  const resolved = resolveCandidates(config, MODEL_PROFILES)
  problems.push(...resolved.problems)
  if (problems.length) throw new Error(problems.join("\n"))
  const only = argument("candidates")?.split(",")
  const candidates = only ? resolved.candidates.filter((candidate) => only.includes(candidate.id)) : resolved.candidates

  const report = await runEvaluation({
    dataset,
    thresholds,
    backend: createWorkersAiBackend({ url, token }),
    baseline: resolved.baseline!,
    candidates,
    candidatesVersion: config.version,
    label,
    onProgress: ({ candidateId, fixtureId, done, total }) => console.log(`[eval] ${done}/${total} ${candidateId} ${fixtureId}`)
  })
  finish(writeReport(report), report.gate)
}

function finish(
  paths: { json: string; markdown: string },
  gate: Array<{ candidateId: string; decision: string; promotionEligible: boolean }>
) {
  console.log(`[eval] wrote ${paths.json}`)
  console.log(`[eval] wrote ${paths.markdown}`)
  for (const result of gate) {
    console.log(`[eval] ${result.candidateId}: ${result.decision}${result.promotionEligible ? " (promotion eligible)" : ""}`)
  }
}

main().catch((error) => {
  console.error(`[eval] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
