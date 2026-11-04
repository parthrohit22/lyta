// The promotion check (issue #16). Exits non-zero unless the named candidate
// passed the gate in the given report AND the report came from a real-model run
// on the current dataset and thresholds.
//
//   npm run eval:promote -- --report eval/reports/2026-12-01-first-real-run.json --candidate llama-3.3-70b-fp8-fast
//
// --allow-pipeline-only accepts a scripted report; CI uses it to exercise the
// check itself. It never makes a scripted report evidence for a routing change.
import { readFileSync } from "node:fs"
import type { EvalReport } from "../src/eval/runner"
import { loadDataset, loadThresholds } from "./eval-files"

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const reportPath = argument("report")
const candidateId = argument("candidate")
const allowPipelineOnly = process.argv.includes("--allow-pipeline-only")

if (!reportPath || !candidateId) {
  console.error("Usage: npm run eval:promote -- --report <path> --candidate <id> [--allow-pipeline-only]")
  process.exit(2)
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as EvalReport
const result = report.gate.find((item) => item.candidateId === candidateId)
const problems: string[] = []

if (!result) problems.push(`${reportPath} has no gate result for ${candidateId}.`)
if (result && result.decision !== "pass") problems.push(...result.reasons)
if (report.evidenceGrade !== "real-model" && !allowPipelineOnly) {
  problems.push("The report is pipeline-only (scripted backend); only a real-model report can justify promotion.")
}
if (report.datasetVersion !== loadDataset().version) {
  problems.push(`The report used dataset ${report.datasetVersion}; re-run on the current dataset.`)
}
if (report.thresholdsVersion !== loadThresholds().version) {
  problems.push(`The report used thresholds ${report.thresholdsVersion}; re-run against the current thresholds.`)
}

if (problems.length) {
  console.error(`[eval] ${candidateId} may not be promoted:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`[eval] ${candidateId} (${result!.model}) passed the promotion gate in ${report.reportId} (${report.evidenceGrade}).`)
