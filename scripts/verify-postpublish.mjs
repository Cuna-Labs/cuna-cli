import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { invariant, parseArgs, readJson, sha256File, validateEnvelope } from "./lib/release-evidence.mjs";
import { withOwnedTempDirectory } from "./lib/owned-temp.mjs";

const execute = promisify(execFile);
const PROPAGATION_DEADLINE_MS = 180_000;

function propagationReason(error, missingPackageVersion) {
  const diagnostic = `${error?.code ?? ""} ${error?.stderr ?? ""} ${error?.message ?? ""}`;
  if (/\b(?:E404|404 Not Found)\b/iu.test(diagnostic)) return "registry has not exposed the version yet";
  const missingVersion = /no matching version found for\s+(\S+)/iu.exec(diagnostic)?.[1]?.replace(/\.$/u, "");
  if (missingPackageVersion && /\bETARGET\b/iu.test(diagnostic) && missingVersion === missingPackageVersion) {
    return "registry has not exposed the exact version yet";
  }
  if (/\b(?:E429|429 Too Many Requests|E500|E502|E503|E504|5(?:00|02|03|04) (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout))\b/iu.test(diagnostic)) {
    return "registry request is temporarily unavailable";
  }
  if (/\b(?:EAI_AGAIN|ETIMEDOUT|ECONNRESET)\b/iu.test(diagnostic) || (error?.killed && error?.signal === "SIGTERM")) {
    return "registry connection is temporarily unavailable";
  }
  return null;
}

async function waitForRegistry(label, action, { now, sleep, deadline, maxAttemptMs, windowMs, missingPackageVersion }) {
  let attempt = 0;
  let lastObservation = "no registry response";
  while (now() < deadline) {
    attempt += 1;
    const remaining = deadline - now();
    try {
      const observation = await action(Math.min(maxAttemptMs, remaining));
      if (observation.ready) return observation.value;
      lastObservation = observation.reason;
    } catch (error) {
      const reason = propagationReason(error, missingPackageVersion);
      if (reason === null) throw error;
      lastObservation = reason;
    }
    const delay = Math.min(1_000 * 2 ** Math.min(attempt - 1, 4), 10_000, Math.max(0, deadline - now()));
    if (delay > 0) await sleep(delay);
  }
  throw new Error(`Publication outcome requires reconciliation: ${label} was not verified within the ${windowMs / 1_000}s registry propagation window (${lastObservation}). Inspect the exact published version and bytes before any further publication; do not publish again blindly.`);
}

export async function verifyPublishedRegistry(envelope, tag, options = {}) {
  validateEnvelope(envelope);
  invariant(typeof tag === "string" && /^[a-z][a-z0-9._-]*$/u.test(tag), "Registry tag is invalid");
  const run = options.execute ?? execute;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const windowMs = options.propagationDeadlineMs ?? PROPAGATION_DEADLINE_MS;
  invariant(Number.isSafeInteger(windowMs) && windowMs > 0 && windowMs <= PROPAGATION_DEADLINE_MS, "Registry propagation deadline is invalid");
  const deadline = now() + windowMs;
  const packageVersion = `${envelope.packageName}@${envelope.version}`;

  const actual = await waitForRegistry("package bytes", async (timeout) => {
    const digest = await withOwnedTempDirectory("cuna-registry-verify-", async (destination) => {
      await run("npm", [
        "pack", packageVersion, "--ignore-scripts", "--prefer-online", "--pack-destination", destination,
        "--registry", envelope.registry,
      ], { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
      const tarballs = (await readdir(destination)).filter((file) => file.endsWith(".tgz"));
      invariant(tarballs.length === 1, "Registry verification did not recover exactly one tarball");
      return sha256File(path.join(destination, tarballs[0]));
    });
    invariant(digest === envelope.tarball.sha256, "Registry tarball differs from admitted candidate bytes; stop and reconcile before any further publication");
    return { ready: true, value: digest };
  }, { now, sleep, deadline, maxAttemptMs: 60_000, windowMs, missingPackageVersion: packageVersion });

  await waitForRegistry("preview tag", async (timeout) => {
    const result = await run("npm", [
      "view", `${envelope.packageName}@${tag}`, "version", "--json", "--prefer-online", "--registry", envelope.registry,
    ], { windowsHide: true, timeout });
    const observedVersion = JSON.parse(result.stdout);
    invariant(typeof observedVersion === "string", `Registry tag ${tag} returned an invalid version`);
    return observedVersion === envelope.version
      ? { ready: true, value: observedVersion }
      : { ready: false, reason: `tag ${tag} still identifies ${observedVersion}` };
  }, { now, sleep, deadline, maxAttemptMs: 30_000, windowMs });

  return {
    schemaVersion: 1,
    status: "REGISTRY_BYTES_VERIFIED",
    packageName: envelope.packageName,
    version: envelope.version,
    sourceCommit: envelope.sourceCommit,
    sha256: actual,
    tag,
    registry: envelope.registry,
    observedAt: new Date().toISOString(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const envelope = await readJson(args.get("envelope") ?? "release-artifacts/release-envelope.json");
  invariant(envelope.version === args.get("version"), "Post-publication version mismatch");
  let receipt;
  try {
    receipt = await verifyPublishedRegistry(envelope, args.get("tag"));
  } catch (error) {
    throw new Error(`Postpublication verification failed after the publish step. Reconcile the exact registry version and bytes before any further publication: ${error.message}`, { cause: error });
  }
  if (args.get("receipt")) {
    const receiptFile = path.resolve(args.get("receipt"));
    await mkdir(path.dirname(receiptFile), { recursive: true });
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
