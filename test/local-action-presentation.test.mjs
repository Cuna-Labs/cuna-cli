import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopPresentationActions,
  DesktopPresentationError,
  ForegroundNotificationActions,
  ForegroundNotificationError,
  renderEditorCommand,
} from "../dist/local-actions/index.js";

const BINDING = Object.freeze({
  workspaceBindingId: "workspace-1",
  workspaceBindingGeneration: 7,
});
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function presentationHarness(overrides = {}) {
  const calls = { artifact: [], forward: [], previews: [], forwards: [], diffs: [], descriptors: [], installations: [], launches: [] };
  const artifactFor = (input) => ({
    opaqueId: input.opaqueId,
    localCopyPath: `C:\\Cuna\\verified\\${input.opaqueId}`,
    sha256: input.expectedSha256,
    derivedMediaType: overrides.derivedMediaType ?? "text/plain",
    ...BINDING,
  });
  const actions = new DesktopPresentationActions({
    now: () => overrides.now ?? 1_000,
    sources: {
      async resolveArtifact(input) {
        calls.artifact.push(input);
        return overrides.artifact === undefined ? artifactFor(input) : overrides.artifact;
      },
      async resolvePrivateForward(streamId) {
        calls.forward.push(streamId);
        return overrides.forward ?? {
          streamId,
          localHost: "127.0.0.1",
          localPort: 4310,
          expiresAt: 2_000,
          derivedMediaType: overrides.derivedMediaType ?? "text/plain",
        };
      },
    },
    presenter: {
      async openArtifact(input) { calls.previews.push(input); },
      async openPrivateForward(input) { calls.forwards.push(input); },
      async openDiff(input) { calls.diffs.push(input); },
    },
    editorDescriptors: {
      async resolve(id) {
        calls.descriptors.push(id);
        return overrides.descriptor ?? { id, localWorkspacePath: "C:\\Cuna\\workspace", ...BINDING };
      },
    },
    editorInstallations: {
      async resolve(editor) {
        calls.installations.push(editor);
        return overrides.installation === undefined
          ? { editor, absoluteExecutable: `C:\\Editors\\${editor}.exe`, verified: true }
          : overrides.installation;
      },
    },
    editorLauncher: { async launch(command) { calls.launches.push(command); } },
  });
  return { actions, calls };
}

test("verified active artifact is rendered as inert text with every active capability disabled", async () => {
  const { actions, calls } = presentationHarness({ derivedMediaType: "text/html" });
  const receipt = await actions.openPreview({
    source: { kind: "artifact", opaqueId: "artifact-a", sha256: DIGEST_A },
    mediaType: "text/html",
  }, BINDING);
  assert.deepEqual(receipt, { completed: true });
  assert.equal(calls.previews.length, 1);
  assert.deepEqual(calls.previews[0], {
    localCopyPath: "C:\\Cuna\\verified\\artifact-a",
    verifiedMediaType: "text/html",
    presentation: "text",
    scripts: "disabled",
    network: "disabled",
    navigation: "disabled",
    forms: "disabled",
  });
});

test("preview rejects stale digest, media mismatch, expired forward, and arbitrary URI fields before effects", async () => {
  for (const { overrides, args } of [
    {
      overrides: { artifact: { opaqueId: "artifact-a", localCopyPath: "C:\\verified", sha256: DIGEST_B, derivedMediaType: "text/plain", ...BINDING } },
      args: { source: { kind: "artifact", opaqueId: "artifact-a", sha256: DIGEST_A }, mediaType: "text/plain" },
    },
    {
      overrides: { derivedMediaType: "image/png" },
      args: { source: { kind: "artifact", opaqueId: "artifact-a", sha256: DIGEST_A }, mediaType: "text/plain" },
    },
    {
      overrides: { forward: { streamId: "stream-a", localHost: "127.0.0.1", localPort: 4310, expiresAt: 999, derivedMediaType: "text/plain" } },
      args: { source: { kind: "private_forward", streamId: "stream-a" }, mediaType: "text/plain" },
    },
    {
      overrides: {},
      args: { source: { kind: "private_forward", streamId: "stream-a", uri: "file:///secret" }, mediaType: "text/plain" },
    },
  ]) {
    const { actions, calls } = presentationHarness(overrides);
    await assert.rejects(actions.openPreview(args, BINDING), (error) => error instanceof DesktopPresentationError);
    assert.equal(calls.previews.length + calls.forwards.length, 0);
  }
});

test("private forward presenter receives a structured loopback endpoint, never a URI", async () => {
  const { actions, calls } = presentationHarness({ derivedMediaType: "image/svg+xml" });
  await actions.openPreview({ source: { kind: "private_forward", streamId: "stream-a" }, mediaType: "image/svg+xml" }, BINDING);
  assert.equal(calls.forwards.length, 1);
  assert.deepEqual(calls.forwards[0], {
    streamId: "stream-a",
    localHost: "127.0.0.1",
    localPort: 4310,
    verifiedMediaType: "image/svg+xml",
    presentation: "text",
    followRedirects: false,
    scripts: "disabled",
    navigation: "disabled",
    forms: "disabled",
  });
  assert.equal(Object.hasOwn(calls.forwards[0], "url"), false);
});

test("diff opens only two reverified synchronized artifacts", async () => {
  const { actions, calls } = presentationHarness();
  await actions.openDiff({
    leftArtifactId: "left",
    rightArtifactId: "right",
    expectedDigests: [DIGEST_A, DIGEST_B],
  }, BINDING);
  assert.deepEqual(calls.artifact.map(({ opaqueId, expectedSha256 }) => ({ opaqueId, expectedSha256 })), [
    { opaqueId: "left", expectedSha256: DIGEST_A },
    { opaqueId: "right", expectedSha256: DIGEST_B },
  ]);
  assert.deepEqual(calls.diffs, [{
    leftLocalCopyPath: "C:\\Cuna\\verified\\left",
    rightLocalCopyPath: "C:\\Cuna\\verified\\right",
    scripts: "disabled",
    network: "disabled",
    navigation: "disabled",
    forms: "disabled",
  }]);
});

test("editor command is fixed by editor ID and locally resolved absolute paths", async () => {
  const expectedArgs = {
    vscode: ["--new-window", "C:\\Cuna\\workspace"],
    cursor: ["--new-window", "C:\\Cuna\\workspace"],
    windsurf: ["--new-window", "C:\\Cuna\\workspace"],
    zed: ["C:\\Cuna\\workspace"],
    "jetbrains-gateway": ["--project-path", "C:\\Cuna\\workspace"],
  };
  for (const editor of Object.keys(expectedArgs)) {
    const { actions, calls } = presentationHarness();
    const receipt = await actions.openEditor({
      editor,
      connectionDescriptorId: "descriptor-a",
      ...BINDING,
    }, BINDING);
    assert.deepEqual(receipt, { outcome: "opened" });
    assert.equal(calls.launches[0].executable, `C:\\Editors\\${editor}.exe`);
    assert.deepEqual(calls.launches[0].args, expectedArgs[editor]);
    assert.equal(Object.hasOwn(calls.launches[0], "shell"), false);
  }
  assert.throws(
    () => renderEditorCommand("vscode", "code", "C:\\Cuna\\workspace"),
    (error) => error instanceof DesktopPresentationError && error.code === "launch_command_invalid",
  );
});

test("missing editor is unsupported and remote executable or URI injection is rejected", async () => {
  const missing = presentationHarness({ installation: null });
  assert.deepEqual(await missing.actions.openEditor({
    editor: "vscode", connectionDescriptorId: "descriptor-a", ...BINDING,
  }, BINDING), { outcome: "unsupported" });
  assert.equal(missing.calls.launches.length, 0);

  const injected = presentationHarness();
  await assert.rejects(injected.actions.openEditor({
    editor: "vscode",
    connectionDescriptorId: "descriptor-a",
    ...BINDING,
    executable: "C:\\Windows\\System32\\cmd.exe",
    uri: "file:///secret",
  }, BINDING), (error) => error instanceof DesktopPresentationError && error.code === "request_invalid");
  assert.equal(injected.calls.descriptors.length, 0);
  assert.equal(injected.calls.launches.length, 0);
});

function notificationHarness() {
  let now = 1_000;
  let alive = true;
  const shown = [];
  const focused = [];
  const dismissed = [];
  const actions = new ForegroundNotificationActions({
    agentSessionId: "session-a",
    now: () => now,
    isForegroundAlive: () => alive,
    focusRequest: (id) => focused.push(id),
    presenter: {
      async show(input) {
        shown.push(input);
        const index = shown.length;
        return { dismiss() { dismissed.push(index); } };
      },
    },
  });
  return {
    actions, shown, focused, dismissed,
    advance(milliseconds) { now += milliseconds; },
    endForeground() { alive = false; },
  };
}

const notification = (id) => ({ category: "task_complete", title: `Title ${id}`, body: `Body ${id}`, focusRequestId: id });

test("notifications are branded, sanitized, deduplicated, and token-bucket limited", async () => {
  const harness = notificationHarness();
  assert.deepEqual(await harness.actions.show({
    category: "action_required",
    title: "\u001b[31mImportant\u202e",
    body: "Line one\nline two",
    focusRequestId: "request-a",
  }, "session-a"), { outcome: "shown" });
  assert.equal(harness.shown[0].brand, "Cuna");
  assert.equal(harness.shown[0].title, "Important");
  assert.equal(harness.shown[0].body, "Line one line two");
  assert.deepEqual(await harness.actions.show(notification("request-b"), "session-a"), { outcome: "shown" });
  assert.deepEqual(await harness.actions.show(notification("request-c"), "session-a"), { outcome: "shown" });
  assert.deepEqual(await harness.actions.show(notification("request-d"), "session-a"), { outcome: "rate_limited" });
  assert.deepEqual(await harness.actions.show(notification("request-a"), "session-a"), { outcome: "rate_limited" });
  harness.advance(10_000);
  assert.deepEqual(await harness.actions.show(notification("request-d"), "session-a"), { outcome: "shown" });
});

test("foreground close aborts effects, dismisses handles, and disables stale focus actions", async () => {
  const harness = notificationHarness();
  await harness.actions.show(notification("request-a"), "session-a");
  harness.shown[0].onFocus();
  assert.deepEqual(harness.focused, ["request-a"]);
  harness.endForeground();
  harness.shown[0].onFocus();
  assert.deepEqual(harness.focused, ["request-a"]);
  await harness.actions.close();
  assert.deepEqual(harness.dismissed, [1]);
  assert.equal(harness.shown[0].signal.aborted, true);
  await assert.rejects(
    harness.actions.show(notification("request-b"), "session-a"),
    (error) => error instanceof ForegroundNotificationError && error.code === "foreground_closed",
  );
});

test("notification identity and closed schema are checked before presentation", async () => {
  const harness = notificationHarness();
  await assert.rejects(
    harness.actions.show(notification("request-a"), "session-b"),
    (error) => error instanceof ForegroundNotificationError && error.code === "session_mismatch",
  );
  await assert.rejects(
    harness.actions.show({ ...notification("request-a"), command: "calc.exe" }, "session-a"),
    (error) => error instanceof ForegroundNotificationError && error.code === "request_invalid",
  );
  assert.equal(harness.shown.length, 0);
});

test("foreground close waits for an in-flight presenter and dismisses its late handle", async () => {
  let resolvePresentation;
  let dismissed = false;
  let capturedSignal;
  const actions = new ForegroundNotificationActions({
    agentSessionId: "session-a",
    isForegroundAlive: () => true,
    focusRequest() {},
    presenter: {
      show(input) {
        capturedSignal = input.signal;
        return new Promise((resolve) => { resolvePresentation = resolve; });
      },
    },
  });
  const showing = actions.show(notification("request-a"), "session-a");
  const closing = actions.close();
  let closeFinished = false;
  closing.then(() => { closeFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeFinished, false);
  assert.equal(capturedSignal.aborted, true);
  resolvePresentation({ dismiss() { dismissed = true; } });
  await assert.rejects(showing, (error) => error instanceof ForegroundNotificationError && error.code === "foreground_closed");
  await closing;
  assert.equal(dismissed, true);
});
