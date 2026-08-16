import { createHash } from "node:crypto";

import { LocalEncryptedSessionBackend, localEncryptedSessionPaths } from "../../dist/credentials/index.js";

const [directory, profile, mode, candidateBase64] = process.argv.slice(2);
const backend = new LocalEncryptedSessionBackend({
  ...localEncryptedSessionPaths(directory, profile),
  platform: process.platform,
});
const current = await backend.read("ignored");
if (current === undefined) throw new Error("fixture requires an existing value");
const expected = createHash("sha256").update(current).digest("hex");
current.fill(0);
process.send?.({ phase: "ready" });

process.once("message", async (message) => {
  if (message !== "go") return;
  try {
    const result = mode === "delete"
      ? await backend.compareAndDelete("ignored", expected)
      : await backend.compareAndSwap("ignored", expected, Buffer.from(candidateBase64, "base64url"));
    process.send?.({ phase: "result", result });
    process.exitCode = 0;
  } catch (error) {
    process.send?.({ phase: "error", code: error?.code, message: error?.message });
    process.exitCode = 1;
  }
});
