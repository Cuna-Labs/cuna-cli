import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildReleaseApprovalConsumption,
  reserveReleaseApprovalConsumption,
} from "./lib/release-approval-consumption.mjs";
import { parseArgs } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());

function confined(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing value for --${name}`);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === "." || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`--${name} must name a file below the evidence root`);
  }
  return resolved;
}

const leaseBytes = await readFile(confined("lease"));
const expectationBytes = await readFile(confined("expectation"));
const declaration = JSON.parse(await readFile(confined("authority"), "utf8"));
const lease = JSON.parse(leaseBytes);
const expectation = JSON.parse(expectationBytes);
const context = {
  repository: process.env.GITHUB_REPOSITORY,
  workflow: ".github/workflows/release.yml",
  ref: process.env.GITHUB_REF,
  event: process.env.GITHUB_EVENT_NAME,
  sourceCommit: process.env.RELEASE_SOURCE_COMMIT,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  actorId: process.env.GITHUB_ACTOR_ID,
  actorLogin: process.env.GITHUB_ACTOR,
  environment: "npm",
};
const built = buildReleaseApprovalConsumption({ lease, expectation, leaseBytes, expectationBytes, context });
const receipt = await reserveReleaseApprovalConsumption({
  declaration,
  consumption: { ...built, context },
  token: process.env.GITHUB_TOKEN,
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
