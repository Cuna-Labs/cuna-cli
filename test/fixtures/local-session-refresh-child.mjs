import { CredentialVault, LocalEncryptedSessionBackend, localEncryptedSessionPaths } from "../../dist/credentials/index.js";

const [directory, profile, label] = process.argv.slice(2);
const backend = new LocalEncryptedSessionBackend({
  ...localEncryptedSessionPaths(directory, profile),
  platform: process.platform,
});
const vault = new CredentialVault({ backend, platform: process.platform });
const binding = Object.freeze({
  profileId: profile,
  accountId: "https://api.getcuna.com",
  workspaceId: "cli-human-auth",
  kind: "login-code-session-v1",
});

process.send?.({ phase: "ready", pid: process.pid, label });
process.once("message", async (message) => {
  if (message !== "go") return;
  try {
    const snapshot = await vault.refresh(binding, async (current) => {
      if (current === undefined) throw new Error("fixture requires a stored session");
      process.send?.({ phase: "entered", pid: process.pid, label });
      await new Promise((resolve) => process.once("message", resolve));
      return { status: "retained" };
    });
    snapshot.material.dispose();
    process.send?.({ phase: "result", pid: process.pid, label });
    process.exitCode = 0;
  } catch (error) {
    process.send?.({ phase: "error", pid: process.pid, label, code: error?.code, message: error?.message });
    process.exitCode = 1;
  }
});
