import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseArgs } from "./lib/release-evidence.mjs";
import { verifyReleaseApprovalConsumptionAuthority } from "./lib/release-approval-consumption.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const authorityFile = path.resolve(root, args.get("authority") ?? "packaging/release-approval-consumption-authority.json");
const relative = path.relative(root, authorityFile);
if (relative === "" || relative === "." || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
  throw new Error("--authority must name a file below the repository root");
}
const declaration = JSON.parse(await readFile(authorityFile, "utf8"));
const context = {
  repository: "Cuna-Labs/cuna-cli",
  workflow: ".github/workflows/release.yml",
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  sourceCommit: args.get("source-commit"),
  runId: "1",
  runAttempt: 1,
  actorId: args.get("controller-actor-id"),
  actorLogin: args.get("controller-actor-login"),
  environment: "npm",
};
const result = await verifyReleaseApprovalConsumptionAuthority({
  declaration,
  context,
  token: process.env.GITHUB_TOKEN,
});
process.stdout.write(`${JSON.stringify({
  status: "READ_ONLY_EXTERNAL_AUTHORITY_VERIFIED",
  repository: declaration.repository,
  environment: declaration.environment,
  rulesetId: declaration.rulesetId,
  reviewerIds: result.reviewerIds,
})}\n`);
