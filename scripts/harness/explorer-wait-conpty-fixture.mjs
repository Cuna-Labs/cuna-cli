import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// A real terminal/controller boundary with synthetic, in-process backend
// observations. No credentials, HTTP client, provider or remote mutation.
const [moduleRoot, state, reason, mode] = process.argv.slice(2);
assert.ok(moduleRoot && ["error", "stopped", "running"].includes(state));
assert.ok(["opencode_runtime_unverified", "opencode_supervisor_protocol_unavailable"].includes(reason));
assert.ok(["navigate", "pending-stop"].includes(mode));
assert.equal(process.stdin.isTTY, true);
assert.equal(process.stdout.isTTY, true);
const { runNodeMachinesExplorer } = await import(pathToFileURL(path.join(moduleRoot, "dist/machines/explorer.js")).href);
const id = "33333333-3333-4333-8333-333333333333";
const mutations = [];
const capability = (name, availability = "supported", reasonCode) => ({
  id: name, availability, ...(reasonCode ? { reasonCode } : {}), interaction: "native",
  mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: ["machines:write"],
});
const unexpected = async (operation) => { mutations.push({ operation }); throw new Error(`Unexpected local fixture mutation: ${operation}`); };
const result = await runNodeMachinesExplorer({ color: false, client: {
  async listMachines() { return { items: [{ id, name: "wait-fixture", state, agent: "opencode" }] }; },
  async listAgentSessions(machineId) { assert.equal(machineId, id); return { items: [] }; },
  async discoverCapabilities(scope, resourceId) {
    assert.equal(scope, "machine"); assert.equal(resourceId, id);
    return {
      schemaVersion: "1.0", subjectScope: scope, subjectId: id,
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
      etag: "local-conpty-fixture", capabilities: [capability("machines.lifecycle"), capability("agent_sessions.create", "temporarily_unavailable", reason)],
    };
  },
  async transitionMachine(machineId, action, signal) {
    mutations.push({ operation: "transition", machineId, action });
    assert.equal(mode, "pending-stop"); assert.equal(machineId, id); assert.equal(action, "stop");
    // Hold the fake operation until q cancels the explorer. There is no remote
    // mutation; its pending state is what this regression must render truthfully.
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return {};
  },
  async getMachine() { throw new Error("Pending stop must not settle before the fixture quits"); },
  async createAgentSession() { return unexpected("create-agent-session"); },
  async createMachine() { return unexpected("create-machine"); },
  async deleteMachine() { return unexpected("delete-machine"); },
} });
console.log(`EXPLORER_FIXTURE_RESULT ${JSON.stringify({ selectionUndefined: result === undefined, mutations, rawMode: process.stdin.isRaw === true })}`);
