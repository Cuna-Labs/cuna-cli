import { join } from "node:path";

import type { PlatformAdapter } from "../platform/adapter.js";
import { LOCAL_ACTION_PROVIDERS } from "./providers.js";
import type { LocalActionKind, LocalActionProvider } from "./contracts.js";
import type { LocalActionPolicyInput, LocalActionPolicyRule } from "./policy.js";

export const LOCAL_ACTION_POLICY_FILE = "local-actions.json";
export const MAX_LOCAL_ACTION_POLICY_BYTES = 64 * 1_024;

export async function loadLocalActionDevicePolicy(adapter: PlatformAdapter): Promise<LocalActionPolicyInput> {
  const path = join(adapter.paths.configDirectory, LOCAL_ACTION_POLICY_FILE);
  const snapshot = await adapter.readSafeConfig(path, MAX_LOCAL_ACTION_POLICY_BYTES);
  if (!snapshot.exists) return Object.freeze({ localDevicePolicy: Object.freeze([]) });
  if (snapshot.text === undefined) throw new TypeError("The local action policy file has no readable text.");
  return parseLocalActionDevicePolicy(snapshot.text);
}

export function parseLocalActionDevicePolicy(text: string): LocalActionPolicyInput {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new TypeError("The local action policy is not valid JSON."); }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.rules) ||
    Object.keys(value).some((key) => key !== "version" && key !== "rules") || value.rules.length > 128) {
    throw new TypeError("The local action policy must be a closed version 1 document.");
  }
  const rules = value.rules.map(parseRule);
  return Object.freeze({ localDevicePolicy: Object.freeze(rules) });
}

function parseRule(value: unknown): LocalActionPolicyRule {
  if (!record(value) || typeof value.kind !== "string" || !localActionKind(value.kind) ||
    (value.decision !== "deny" && value.decision !== "ask") ||
    Object.keys(value).some((key) => !["kind", "providers", "scopes", "decision", "userApproved"].includes(key))) {
    throw new TypeError("A local action policy rule is malformed or attempts to persist allow_once.");
  }
  const providers = value.providers === undefined ? undefined : parseProviders(value.providers);
  const scopes = value.scopes === undefined ? undefined : parseScopes(value.scopes);
  if (value.userApproved !== undefined) throw new TypeError("Persistent policy cannot store an interactive grant.");
  return Object.freeze({
    kind: value.kind,
    decision: value.decision,
    ...(providers === undefined ? {} : { providers }),
    ...(scopes === undefined ? {} : { scopes }),
  });
}

function parseProviders(value: unknown): readonly LocalActionProvider[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 ||
    !value.every((item) => typeof item === "string" && item in LOCAL_ACTION_PROVIDERS)) {
    throw new TypeError("Local action policy providers are invalid.");
  }
  return Object.freeze([...new Set(value as LocalActionProvider[])]);
}

function parseScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
    !value.every((item) => typeof item === "string" && /^[A-Za-z0-9._:@/-]{1,256}$/u.test(item))) {
    throw new TypeError("Local action policy scopes are invalid.");
  }
  return Object.freeze([...new Set(value as string[])]);
}

function localActionKind(value: string): value is LocalActionKind {
  return new Set<LocalActionKind>([
    "browser.open", "auth.device.present", "auth.callback.relay", "auth.result.observe", "clipboard.write",
    "port.forward", "file.select", "attachment.import", "artifact.save", "preview.open", "diff.open",
    "editor.open", "notification.show", "git.sign", "local_service.request", "device.select",
  ]).has(value as LocalActionKind);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
