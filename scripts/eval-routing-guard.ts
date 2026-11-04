// CI guard (issue #16): a change that routes a model LYTA did not route before
// must ship with a committed real-model report in eval/reports/ in which that
// model passed the promotion gate. Compares the Workers AI model ids named in
// the routing files at the base revision with the working tree.
//
//   npx tsx scripts/eval-routing-guard.ts [base-ref]   # default origin/main
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { checkRoutingChange } from "../src/eval/gate"
import { loadReports } from "./eval-files"

// src/ai/registry.ts arrives with the model registry (#13/#14); listing it now means the guard keeps working after that merge.
const ROUTING_FILES = ["src/config/modelProfiles.ts", "src/ai/registry.ts"]
const MODEL_ID = /"(@cf\/[^"]+)"/g

const base = process.argv[2] || "origin/main"

function modelsIn(text: string) {
  return [...text.matchAll(MODEL_ID)].map((match) => match[1])
}

function atBase(file: string) {
  try {
    return execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return ""
  }
}

try {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", base], { stdio: "ignore" })
} catch {
  console.log(`[eval] ${base} is not resolvable here; skipping the routing guard.`)
  process.exit(0)
}

const previous = ROUTING_FILES.flatMap((file) => modelsIn(atBase(file)))
const current = ROUTING_FILES.flatMap((file) => (existsSync(file) ? modelsIn(readFileSync(file, "utf8")) : []))
const { introduced, problems } = checkRoutingChange(previous, current, loadReports())

if (!introduced.length) {
  console.log("[eval] No newly routed models; no evaluation report required.")
} else if (!problems.length) {
  console.log(`[eval] Newly routed models have passing real-model reports: ${introduced.join(", ")}.`)
} else {
  for (const problem of problems) console.error(`[eval] ${problem}`)
  console.error('[eval] See eval/README.md "Running against real models" and RELEASE_CHECKLIST.md.')
  process.exit(1)
}
