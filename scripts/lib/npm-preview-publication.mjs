import { invariant } from "./release-evidence.mjs";

export async function executeNpmPreviewPublication(phases) {
  const expected = ["verifyLease", "verifyAttestation", "verifyNonce", "verifyRegistryAbsent", "publish"];
  invariant(phases && typeof phases === "object" && !Array.isArray(phases), "Publication phases are missing");
  invariant(JSON.stringify(Object.keys(phases).sort()) === JSON.stringify([...expected].sort()), "Publication phase set differs");
  for (const name of expected) invariant(typeof phases[name] === "function", `Publication phase is not executable: ${name}`);
  await phases.verifyLease();
  await phases.verifyAttestation();
  await phases.verifyNonce();
  await phases.verifyRegistryAbsent();
  return phases.publish();
}
