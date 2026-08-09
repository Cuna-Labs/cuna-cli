// Deprecated compatibility entry point. Preserve the former --projections
// spelling while delegating every policy decision to the authoritative
// release verifier.
const legacyIndex = process.argv.indexOf("--projections");
if (legacyIndex >= 0) process.argv[legacyIndex] = "--distributions";
await import("./verify-release-distributions.mjs");
