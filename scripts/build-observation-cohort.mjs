import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildObservationCohort } from "./lib/observation-cohort.mjs";
import { invariant, parseArgs, readJson } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const summaryFile = path.resolve(root, args.get("summary") ?? "evidence/observation-summary.json");
const output = path.resolve(root, args.get("output") ?? "evidence/observation-cohort.json");
const candidateRunId = args.get("candidate-run-id");
invariant(/^[1-9][0-9]*$/u.test(String(candidateRunId ?? "")), "--candidate-run-id is required");

const runId = process.env.GITHUB_RUN_ID;
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
invariant(/^[1-9][0-9]*$/u.test(String(runId ?? "")), "GITHUB_RUN_ID is missing or invalid");
invariant(Number.isSafeInteger(runAttempt) && runAttempt > 0, "GITHUB_RUN_ATTEMPT is missing or invalid");

const cohort = buildObservationCohort({
  summary: await readJson(summaryFile),
  candidateRunId,
  runId,
  runAttempt,
  generatedAt: new Date().toISOString(),
});

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(cohort, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({
  status: cohort.status,
  candidateRunId: cohort.candidateRunId,
  runId: cohort.runId,
  observations: cohort.observationIds.length,
})}\n`);
