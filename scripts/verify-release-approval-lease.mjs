import path from "node:path";

import { parseArgs, readJson } from "./lib/release-evidence.mjs";
import { validateReleaseApprovalLease } from "./lib/release-approval-lease.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const required = [
  "lease",
  "expectation",
];
for (const name of required) {
  if (!args.has(name)) throw new Error(`Missing value for --${name}`);
}

function confinedInput(name) {
  const value = args.get(name);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === "." || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`--${name} must name a file below the evidence root`);
  }
  return resolved;
}

const lease = await readJson(confinedInput("lease"));
const expectation = await readJson(confinedInput("expectation"));
validateReleaseApprovalLease(lease, expectation);

process.stdout.write(`${JSON.stringify({
  status: "release-approval-lease-semantically-verified",
  releaseAuthorized: false,
  limitation: "Cryptographic workflow attestation, protected-environment approval, and single-use nonce consumption must be verified separately.",
})}\n`);
