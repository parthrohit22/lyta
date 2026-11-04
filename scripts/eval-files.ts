import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { EvalDataset, EvalFixture } from "../src/eval/types"
import type { EvalThresholds, ReportSummary } from "../src/eval/gate"
import type { CandidateConfig } from "../src/eval/dataset"
import { renderReportMarkdown, type EvalReport } from "../src/eval/runner"

/** Node-only file access for the eval harness; src/eval stays free of fs so it can be type-checked with the Worker. */
export const EVAL_ROOT = fileURLToPath(new URL("../eval", import.meta.url))

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

export function loadDataset(root = EVAL_ROOT): EvalDataset {
  const index = readJson<{ version: string; files: string[] }>(join(root, "fixtures", "index.json"))
  const fixtures = index.files.flatMap((file) => readJson<{ fixtures: EvalFixture[] }>(join(root, "fixtures", file)).fixtures)
  return { version: index.version, fixtures }
}

export function loadThresholds(root = EVAL_ROOT) {
  return readJson<EvalThresholds>(join(root, "thresholds.json"))
}

export function loadCandidateConfig(root = EVAL_ROOT) {
  return readJson<CandidateConfig>(join(root, "candidates.json"))
}

export function loadReports(root = EVAL_ROOT): ReportSummary[] {
  const directory = join(root, "reports")
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson<ReportSummary>(join(directory, file)))
}

/** Writes `<id>.json` and `<id>.md` and returns their paths. Refuses to overwrite an existing report. */
export function writeReport(report: EvalReport, directory = join(EVAL_ROOT, "reports")) {
  mkdirSync(directory, { recursive: true })
  const json = join(directory, `${report.reportId}.json`)
  const markdown = join(directory, `${report.reportId}.md`)
  if (existsSync(json)) throw new Error(`${json} already exists; pick another --label.`)
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(markdown, `${renderReportMarkdown(report)}\n`)
  return { json, markdown }
}
