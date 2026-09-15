import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { invariant, parseArgs } from "./lib/release-evidence.mjs";
import { buildReleaseApprovalEventReceipt, validateReleaseApprovalEvent } from "./lib/release-approval-event.mjs";

const args = parseArgs(process.argv.slice(2));
const repository = "Cuna-Labs/cuna-cli";
const environment = "release-review-npm-preview";
const requiredReviewer = { id: 312749809, login: "cunitacodeitor" };
const output = path.resolve(process.cwd(), args.get("output") ?? "evidence/release-approval-event.json");

const token = process.env.GITHUB_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const runActorId = process.env.GITHUB_ACTOR_ID;
const runActorLogin = process.env.GITHUB_ACTOR;
invariant(typeof token === "string" && token.length >= 20 && !/\s/u.test(token), "A read-only GitHub token is required");
invariant(process.env.GITHUB_REPOSITORY === repository, "Approval observation is bound to one repository");
invariant(/^[1-9][0-9]*$/u.test(String(runId ?? "")), "GITHUB_RUN_ID is missing or invalid");
invariant(/^[1-9][0-9]*$/u.test(String(runActorId ?? "")), "GITHUB_ACTOR_ID is missing or invalid");

// The destination is fixed in code and built only from the run's own identity.
// Nothing a dispatcher supplies can redirect this token at another resource.
const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/approvals`, {
  method: "GET",
  redirect: "error",
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "cuna-cli-release-approval-event-verifier",
    "x-github-api-version": "2022-11-28",
  },
  signal: AbortSignal.timeout(10_000),
});
invariant(
  response.status === 200,
  `The workflow token cannot read this run's approval events (HTTP ${response.status}): ACTUAL_ENVIRONMENT_APPROVAL_EVENT_NOT_OBSERVABLE_BY_WORKFLOW_TOKEN`,
);
const text = await response.text();
invariant(Buffer.byteLength(text) <= 1_048_576, "Approval event response is too large");

const decision = validateReleaseApprovalEvent({
  approvals: JSON.parse(text),
  environment,
  requiredReviewer,
  runActorId,
});
const receipt = buildReleaseApprovalEventReceipt({
  decision,
  environment,
  repository,
  runId,
  runAttempt,
  runActorId,
  runActorLogin,
  observedAt: new Date().toISOString(),
});

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({
  status: receipt.status,
  environment,
  approverId: receipt.approverId,
  approverLogin: receipt.approverLogin,
  dispatchActorLogin: receipt.dispatchActorLogin,
})}\n`);
