import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { invariant, parseArgs } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const historyOnly = args.get("history-only") === "true";

const prohibitedTrackedFiles = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "IMPLEMENTATION-OBJECTIVE.md",
  "packaging/DISTRIBUTION-READINESS.md",
  "packaging/EXTERNAL-SETUP.md",
  "test/governance-requirement-traceability.test.mjs",
]);
const prohibitedTrackedPrefixes = [
  ".agents/",
  ".claude/",
  ".codex/",
  ".codex-work/",
  "architecture/",
  "audits/",
  "docs/internal/",
  "governance/",
  "internal/",
  "plans/",
  "prds/",
  "reviews/",
];

const tracked = spawnSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
invariant(tracked.status === 0, `Unable to enumerate tracked files: ${tracked.stderr || "git failed"}`);
const trackedFiles = tracked.stdout.split("\0").filter(Boolean);
for (const file of trackedFiles) {
  invariant(!isProhibited(file), `Internal-only file is tracked by the public repository: ${file}`);
}

const history = spawnSync("git", ["rev-list", "--objects", "--all"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
  maxBuffer: 32 * 1024 * 1024,
});
invariant(history.status === 0, `Unable to enumerate repository history: ${history.stderr || "git failed"}`);
for (const line of history.stdout.split(/\r?\n/u)) {
  const separator = line.indexOf(" ");
  if (separator === -1) continue;
  const file = line.slice(separator + 1);
  invariant(!isProhibited(file), `Internal-only file exists in public repository history: ${file}`);
}

if (historyOnly) {
  process.stdout.write(`${JSON.stringify({ status: "history-verified" })}\n`);
  process.exit(0);
}

async function text(relative) {
  return readFile(path.join(root, relative), "utf8");
}

const license = await text("LICENSE");
invariant(license.includes("Apache License") && license.includes("Version 2.0, January 2004"), "LICENSE is not Apache-2.0");
invariant((await text("NOTICE")).includes("Runa Laboratories"), "NOTICE lacks Runa attribution");
invariant(/private\s+security\s+advisory/i.test(await text("SECURITY.md")), "SECURITY.md lacks a private reporting route");
invariant((await text("CONTRIBUTING.md")).includes("Local workstations must never publish"), "Contribution policy lacks publication boundary");
const codeowners = await text(".github/CODEOWNERS");
const defaultOwner = codeowners
  .split(/\r?\n/u)
  .find((line) => /^\*\s+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]+)?\s*$/u.test(line.trim()));
invariant(defaultOwner !== undefined, "CODEOWNERS lacks a valid default GitHub owner");

const workflowDirectory = path.join(root, ".github", "workflows");
const workflowFiles = (await readdir(workflowDirectory)).filter((file) => /\.ya?ml$/.test(file));
invariant(workflowFiles.length >= 4, "Required workflow set is incomplete");

for (const file of workflowFiles) {
  const content = await readFile(path.join(workflowDirectory, file), "utf8");
  invariant(!content.includes("pull_request_target:"), `${file} uses pull_request_target`);
  invariant(!/uses:\s*[^\s#]+@(main|master|v[0-9]+(?:\.[0-9]+)*)\s*(?:#.*)?$/m.test(content), `${file} contains a mutable action reference`);
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/uses:\s*[^\s#]+@([^\s#]+)/);
    if (match) invariant(/^[0-9a-f]{40}$/.test(match[1]), `${file} action is not pinned to a full commit SHA: ${line.trim()}`);
  }
  if (content.includes("actions/checkout@")) {
    invariant(content.includes("persist-credentials: false"), `${file} persists checkout credentials`);
  }
  invariant(!/NPM_TOKEN|NODE_AUTH_TOKEN/.test(content), `${file} references a prohibited long-lived npm token`);
  if (content.includes("npm publish")) {
    invariant(file === "release.yml", `${file} may publish outside the release workflow`);
    invariant(content.includes("environment: npm"), "Release publication lacks protected npm environment");
    invariant(content.includes("id-token: write"), "Release publication lacks OIDC permission");
    invariant(content.includes("--provenance"), "Release publication lacks npm provenance");
  }
}

process.stdout.write(`${JSON.stringify({ status: "verified", workflows: workflowFiles.sort() })}\n`);

function isProhibited(file) {
  return prohibitedTrackedFiles.has(file) || prohibitedTrackedPrefixes.some((prefix) => file.startsWith(prefix));
}
