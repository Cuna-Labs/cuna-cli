import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateObservationCohortAgainstCandidate } from "./lib/observation-cohort.mjs";
import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import { validateSupportPolicy } from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(root, args.get("evidence") ?? "admitted/release-artifacts");
const cohortFile = path.resolve(root, args.get("cohort") ?? "admitted/observation/observation-cohort.json");
const output = path.resolve(root, args.get("output") ?? "evidence/observation-cohort-verification.json");
const candidateRunId = args.get("candidate-run-id");
const observationRunId = args.get("observation-run-id");
invariant(/^[1-9][0-9]*$/u.test(String(candidateRunId ?? "")), "--candidate-run-id is required");
invariant(/^[1-9][0-9]*$/u.test(String(observationRunId ?? "")), "--observation-run-id is required");

const envelopeFile = path.join(evidenceRoot, "release-envelope.json");
const envelope = await readJson(envelopeFile);
const releaseEnvelopeSha256 = await sha256File(envelopeFile);
const supportPolicyFile = path.join(evidenceRoot, envelope.supportPolicy.file);
const supportPolicy = await readJson(supportPolicyFile);
validateSupportPolicy(supportPolicy);
const supportPolicySha256 = await sha256File(supportPolicyFile);
invariant(supportPolicySha256 === envelope.supportPolicy.sha256, "Candidate support-policy digest differs from the envelope");

const expectedObservationIds = supportPolicy.ciMatrix
  .filter((entry) => entry.claim === "observation-only")
  .map((entry) => entry.id)
  .sort();
invariant(expectedObservationIds.length > 0, "Support policy declares no observation-only lanes");

// Every way this can fail means the same thing to a release reviewer: there is
// no cohort bound to this candidate. Reporting them under one identifier keeps
// the refusal legible while the message underneath stays specific.
const BLOCKER = "CANDIDATE_BOUND_OBSERVATION_COHORT_NOT_AVAILABLE";
let cohort;
try {
  cohort = await readJson(cohortFile);
  validateObservationCohortAgainstCandidate(cohort, {
    releaseEnvelopeSha256,
    supportPolicySha256,
    candidateRunId,
    expectedObservationIds,
  });
  // The cohort names its own producing run. A dispatcher may point at any run
  // it likes, so the run it names must be the run whose artifact this is.
  invariant(cohort.runId === String(observationRunId), "Observation cohort was produced by a different run than the one supplied");
} catch (error) {
  throw new Error(`${BLOCKER}: ${error instanceof Error ? error.message : "unknown failure"}`);
}

const verification = {
  schemaVersion: 1,
  status: "CANDIDATE_BOUND_OBSERVATION_COHORT_VERIFIED",
  cohortSha256: await sha256File(cohortFile),
  releaseEnvelopeSha256,
  supportPolicySha256,
  candidateRunId: String(candidateRunId),
  observationRunId: String(observationRunId),
  observationRunAttempt: cohort.runAttempt,
  observationIds: cohort.observationIds,
  verifiedAt: new Date().toISOString(),
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(verification, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({
  status: verification.status,
  cohortSha256: verification.cohortSha256,
  observations: verification.observationIds.length,
})}\n`);
