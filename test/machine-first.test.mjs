import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_MACHINE_FIRST_STATE,
  canAutoContinueMachineFirst,
  reduceMachineFirstNavigation,
  resolveMachineContextActions,
  resolveProviderContextActions,
  shouldShowRemoteWaitProgress,
} from "../dist/index.js";

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const machine = (overrides = {}) => ({ id: MACHINE_ID, name: "dev", state: "running", agent: "claude-code", updatedAt: "v7", ...overrides });
const session = (overrides = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  machineId: MACHINE_ID,
  name: "main",
  agent: "claude-code",
  cwd: "/workspace/project",
  authMode: "interactive_login",
  desiredState: "running",
  requestState: "launched",
  processState: "running",
  processEpoch: "epoch-1",
  runtimeObservedAt: new Date(NOW - 1_000).toISOString(),
  runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
  rowVersion: 7,
  createdAt: new Date(NOW - 60_000).toISOString(),
  updatedAt: new Date(NOW - 1_000).toISOString(),
  ...overrides,
});

test("T8.5 machine action resolver is machine-first and provider truthful", () => {
  assert.deepEqual(resolveMachineContextActions(machine({ state: "stopped" })), [
    { kind: "start", label: "Start", machineId: MACHINE_ID },
  ]);
  assert.deepEqual(resolveMachineContextActions(machine()), [
    { kind: "provider", label: "Claude", machineId: MACHINE_ID, provider: "claude-code" },
    { kind: "stop", label: "Stop", machineId: MACHINE_ID },
  ]);
  assert.deepEqual(resolveMachineContextActions(machine(), { hasSessions: false, canCreateSession: true }), [
    { kind: "new-session", label: "New Claude session", machineId: MACHINE_ID, provider: "claude-code" },
    { kind: "stop", label: "Stop", machineId: MACHINE_ID },
  ]);
  assert.deepEqual(resolveMachineContextActions(machine({ agent: "opencode" })), [
    { kind: "provider", label: "OpenCode", machineId: MACHINE_ID, provider: "opencode" },
    { kind: "stop", label: "Stop", machineId: MACHINE_ID },
  ]);
});

test("T8.2 provider context contains existing sessions only; creation belongs to the machine menu", () => {
  const base = { machine: machine(), provider: "claude-code", sessions: [session()], now: NOW };
  assert.deepEqual(resolveProviderContextActions({ ...base, canCreateSession: false }).map((item) => item.kind), ["session"]);
  assert.deepEqual(resolveProviderContextActions({ ...base, canCreateSession: true }).map((item) => item.kind), ["session"]);
  assert.deepEqual(resolveProviderContextActions({ ...base, provider: "codex", canCreateSession: true }), []);
});

test("T8.6 reducer moves through machine -> provider and Back returns exactly one level", () => {
  const machineScreen = reduceMachineFirstNavigation(INITIAL_MACHINE_FIRST_STATE, { type: "open-machine", machineId: MACHINE_ID });
  assert.equal(machineScreen.screen.kind, "machine");
  const providerScreen = reduceMachineFirstNavigation(machineScreen, { type: "open-provider", machineId: MACHINE_ID, provider: "claude-code" });
  assert.equal(providerScreen.screen.kind, "provider");
  assert.equal(reduceMachineFirstNavigation(providerScreen, { type: "back" }).screen.kind, "machine");
  assert.equal(reduceMachineFirstNavigation(machineScreen, { type: "back" }).screen.kind, "machines");
  assert.equal(reduceMachineFirstNavigation(INITIAL_MACHINE_FIRST_STATE, { type: "quit" }).quit, true);
});

test("T8.3 auto-continuation cannot occur before a cancellable three-second screen", () => {
  const base = { safeContinuationCount: 1, screenShownAt: 1_000, cancelled: false };
  assert.equal(canAutoContinueMachineFirst({ ...base, now: 3_999 }), false);
  assert.equal(canAutoContinueMachineFirst({ ...base, now: 4_000 }), true);
  assert.equal(canAutoContinueMachineFirst({ ...base, now: 4_000, cancelled: true }), false);
  assert.equal(canAutoContinueMachineFirst({ ...base, now: 4_000, safeContinuationCount: 2 }), false);
});

test("T8.7 progress threshold is visible by the 150ms deadline", () => {
  assert.equal(shouldShowRemoteWaitProgress(99), false);
  assert.equal(shouldShowRemoteWaitProgress(100), true);
  assert.equal(shouldShowRemoteWaitProgress(149), true);
});
