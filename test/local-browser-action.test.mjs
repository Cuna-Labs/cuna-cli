import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderBrowserActionDetector,
  ProviderOAuthPasteGuard,
  admitProviderAuthUrl,
} from "../dist/local-actions/browser-action.js";

const encoder = new TextEncoder();
const binding = {
  agentSessionId: "300a55d0-661c-4da0-9b93-eb41a3a319f6",
  processEpoch: "400a55d0-661c-4da0-9b93-eb41a3a319f6",
  fencingGeneration: 7,
};
const pasteStart = encoder.encode("\u001b[200~");
const pasteEnd = encoder.encode("\u001b[201~");
const claudeUrl = "https://platform.claude.com/oauth/authorize?code=true&state=opaque";

function browserRequest(overrides = {}) {
  return {
    id: "action-1",
    type: "browser.open",
    provider: "claude-code",
    ...binding,
    url: claudeUrl,
    origin: "https://platform.claude.com",
    nonce: "nonce-1",
    detectedAt: 1_000,
    expiresAt: 121_000,
    state: "pending_permission",
    ...overrides,
  };
}

function joinBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function pushAll(guard, chunks) {
  const forward = [];
  let blocked = false;
  for (const chunk of chunks) {
    const result = guard.push(chunk);
    forward.push(...result.forward);
    blocked ||= result.blocked;
  }
  return { forward, blocked };
}

test("Claude OAuth split across PTY frames becomes one exact scoped request", () => {
  const detector = new ProviderBrowserActionDetector({
    provider: "claude-code", ...binding, clock: () => 1_000, id: () => "action-1", nonce: () => "nonce-1",
  });
  const url = "https://platform.claude.com/oauth/authorize?code=true&state=opaque";
  assert.deepEqual(detector.push(encoder.encode(`\u001b[31m${url.slice(0, 28)}`)), []);
  assert.deepEqual(detector.push(encoder.encode(`${url.slice(28)}\u001b[0m\r\n`)), [{
    id: "action-1", type: "browser.open", provider: "claude-code", ...binding,
    url, origin: "https://platform.claude.com", nonce: "nonce-1",
    detectedAt: 1_000, expiresAt: 121_000, state: "pending_permission",
  }]);
  assert.deepEqual(detector.push(encoder.encode(`${url}\r\n`)), [], "terminal replay must not duplicate an action");
});

test("Codex admits only its remote-safe device page", () => {
  assert.equal(admitProviderAuthUrl("codex", "https://auth.openai.com/codex/device")?.href, "https://auth.openai.com/codex/device");
  assert.equal(admitProviderAuthUrl("codex", "https://auth.openai.com/oauth/authorize?state=x"), undefined);
  assert.equal(admitProviderAuthUrl("codex", "http://auth.openai.com/codex/device"), undefined);
});

test("provider allowlists reject userinfo, ports, lookalikes, and unrelated links", () => {
  for (const url of [
    "https://claude.com.evil.test/oauth/authorize",
    "https://user@platform.claude.com/oauth/authorize",
    "https://platform.claude.com:444/oauth/authorize",
    "https://platform.claude.com/docs/oauth",
    "javascript:https://platform.claude.com/oauth/authorize",
  ]) assert.equal(admitProviderAuthUrl("claude-code", url), undefined, url);
});

test("exact provider OAuth URL split across bracketed-paste chunks is blocked without returning content", () => {
  const guard = new ProviderOAuthPasteGuard(browserRequest());
  const input = joinBytes([pasteStart, encoder.encode(`\r\n${claudeUrl}\n`), pasteEnd]);
  const result = pushAll(guard, [
    input.subarray(0, 2),
    input.subarray(2, 9),
    input.subarray(9, input.byteLength - 3),
    input.subarray(input.byteLength - 3),
  ]);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.forward, []);
  assert.deepEqual(Object.keys(guard.push(new Uint8Array())), ["forward", "blocked"]);
});

test("legitimate split code is forwarded byte-exact with its paste framing", () => {
  const guard = new ProviderOAuthPasteGuard(browserRequest());
  const input = joinBytes([pasteStart, encoder.encode("valid-code-123"), pasteEnd]);
  const result = pushAll(guard, [
    input.subarray(0, 1),
    input.subarray(1, 5),
    input.subarray(5, 12),
    input.subarray(12),
  ]);
  assert.equal(result.blocked, false);
  assert.deepEqual(joinBytes(result.forward), input);
});

test("approved Claude paste strips only framing and terminal newlines then commits one Enter", () => {
  const guard = new ProviderOAuthPasteGuard(browserRequest());
  guard.beginCodeCapture();
  const code = Uint8Array.from([0x80, 0x41, 0x0a, 0x42]);
  const input = joinBytes([pasteStart, Uint8Array.of(0x0d, 0x0a), code, Uint8Array.of(0x0d, 0x0a), pasteEnd]);
  const result = pushAll(guard, [input.subarray(0, 7), input.subarray(7, input.length - 2), input.subarray(input.length - 2)]);
  assert.equal(result.blocked, false);
  assert.deepEqual(joinBytes(result.forward), joinBytes([code, Uint8Array.of(0x0d)]));
});

test("a legitimate code beginning with d is data, never a deny decision", () => {
  const guard = new ProviderOAuthPasteGuard(browserRequest());
  const input = joinBytes([pasteStart, encoder.encode("d-code-is-opaque"), pasteEnd]);
  const result = pushAll(guard, [input.subarray(0, 8), input.subarray(8)]);
  assert.equal(result.blocked, false);
  assert.deepEqual(joinBytes(result.forward), input);
});

test("unrelated and cross-provider URLs are forwarded while another admitted Claude OAuth URL is blocked", () => {
  const unrelated = "https://example.com/oauth/authorize?state=opaque";
  const codex = "https://auth.openai.com/codex/device";
  for (const value of [unrelated, codex]) {
    const guard = new ProviderOAuthPasteGuard(browserRequest());
    const input = joinBytes([pasteStart, encoder.encode(value), pasteEnd]);
    const result = guard.push(input);
    assert.equal(result.blocked, false, value);
    assert.deepEqual(joinBytes(result.forward), input, value);
  }

  const guard = new ProviderOAuthPasteGuard(browserRequest());
  const otherClaudeUrl = "https://claude.com/oauth/authorize?code=true&state=other";
  const result = guard.push(joinBytes([pasteStart, encoder.encode(otherClaudeUrl), pasteEnd]));
  assert.equal(result.blocked, true);
  assert.deepEqual(result.forward, []);
});

test("reset discards partial state and re-arms the same exact request", () => {
  const guard = new ProviderOAuthPasteGuard(browserRequest());
  assert.deepEqual(guard.push(pasteStart.subarray(0, 3)).forward, []);
  guard.reset();
  const opaque = encoder.encode("plain-input");
  assert.deepEqual(joinBytes(guard.push(opaque).forward), opaque);

  const blocked = guard.push(joinBytes([pasteStart, encoder.encode(claudeUrl), pasteEnd]));
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.forward, []);
});

test("an oversized unfinished paste fails open at the one-MiB bound until reset", () => {
  const guard = new ProviderOAuthPasteGuard(browserRequest());
  const oversized = new Uint8Array(1_048_577).fill(0x78);
  oversized.set(pasteStart);
  const result = guard.push(oversized);
  assert.equal(result.blocked, false);
  assert.deepEqual(joinBytes(result.forward), oversized);

  const urlPaste = joinBytes([pasteStart, encoder.encode(claudeUrl), pasteEnd]);
  assert.deepEqual(joinBytes(guard.push(urlPaste).forward), urlPaste);
  guard.reset();
  assert.equal(guard.push(urlPaste).blocked, true);
});
