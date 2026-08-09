import { createHash } from "node:crypto";

import { normalizeWirePath, type FilesystemCapabilities } from "./paths.js";
import { workspaceError } from "./errors.js";

export type ExclusionReason =
  | "immutable_credentials"
  | "immutable_metadata"
  | "immutable_special_file"
  | "user_rule";

export interface ExclusionDecision {
  readonly excluded: boolean;
  readonly immutable: boolean;
  readonly reason?: ExclusionReason;
  readonly ruleIndex?: number;
}

export interface ExclusionRuleSource {
  readonly source: "gitignore" | "runaignore" | "cli";
  readonly text: string;
}

interface CompiledRule {
  readonly excluded: boolean;
  readonly pattern: string;
  readonly expression: RegExp;
  readonly source: ExclusionRuleSource["source"];
  readonly line: number;
}

export interface ExclusionPolicy {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly ruleCount: number;
  decide(wirePath: string, kind?: "file" | "directory" | "symlink" | "special"): ExclusionDecision;
}

const IMMUTABLE_COMPONENTS = new Set([
  ".env",
  ".env.local",
  ".netrc",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

export function compileExclusionPolicy(
  sources: readonly ExclusionRuleSource[],
  capabilities: FilesystemCapabilities,
): ExclusionPolicy {
  const rules: CompiledRule[] = [];
  let index = 0;
  for (const source of sources) {
    if (Buffer.byteLength(source.text, "utf8") > 1_048_576) {
      throw policySyntaxFailure(source.source, 0, "file_too_large");
    }
    for (const rawLine of source.text.split(/\r?\n/u)) {
      index += 1;
      if (rules.length >= 10_000) throw policySyntaxFailure(source.source, index, "rule_limit");
      if (rawLine.length === 0 || rawLine.startsWith("#")) continue;
      if (rawLine.includes("\0") || Buffer.byteLength(rawLine, "utf8") > 1_024) {
        throw policySyntaxFailure(source.source, index, "invalid_rule");
      }
      const excluded = !rawLine.startsWith("!");
      const pattern = excluded ? rawLine : rawLine.slice(1);
      if (pattern.length === 0 || pattern === "!" || pattern.includes("\\")) {
        throw policySyntaxFailure(source.source, index, "invalid_rule");
      }
      rules.push({
        excluded,
        pattern,
        expression: compileGlob(pattern),
        source: source.source,
        line: index,
      });
    }
  }
  const canonicalRules = rules.map(({ excluded, pattern, source, line }) => ({
    excluded,
    line,
    pattern: pattern.normalize("NFC"),
    source,
  }));
  const digest = createHash("sha256")
    .update("runa-exclusion-policy-v1\0")
    .update(JSON.stringify(canonicalRules))
    .digest("hex");
  return Object.freeze({
    schemaVersion: 1 as const,
    digest,
    ruleCount: rules.length,
    decide(
      wirePath: string,
      kind: "file" | "directory" | "symlink" | "special" = "file",
    ): ExclusionDecision {
      const normalized = normalizeWirePath(wirePath, capabilities);
      const immutable = immutableDecision(normalized, kind);
      if (immutable !== undefined) return immutable;
      let result: ExclusionDecision = Object.freeze({ excluded: false, immutable: false });
      for (const [ruleIndex, rule] of rules.entries()) {
        if (rule.expression.test(normalized)) {
          result = Object.freeze({
            excluded: rule.excluded,
            immutable: false,
            reason: "user_rule",
            ruleIndex,
          });
        }
      }
      return result;
    },
  });
}

export function detectHighConfidenceSecret(content: Uint8Array): string | undefined {
  if (content.byteLength > 2 * 1024 * 1024 || content.includes(0)) return undefined;
  const text = Buffer.from(content).toString("utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) return "private_key";
  if (/\bAKIA[0-9A-Z]{16}\b/u.test(text)) return "cloud_access_key";
  if (/\b(?:runa|sk)_[A-Za-z0-9_-]{20,}\b/u.test(text)) return "service_token";
  return undefined;
}

function immutableDecision(
  wirePath: string,
  kind: "file" | "directory" | "symlink" | "special",
): ExclusionDecision | undefined {
  if (kind === "special") {
    return Object.freeze({ excluded: true, immutable: true, reason: "immutable_special_file" });
  }
  const components = wirePath.toLocaleLowerCase("en-US").split("/");
  if (components.includes(".runa")) {
    return Object.freeze({ excluded: true, immutable: true, reason: "immutable_metadata" });
  }
  if (
    components.includes(".ssh") ||
    (components.includes(".git") && components.includes("credentials")) ||
    components.some((component) => IMMUTABLE_COMPONENTS.has(component))
  ) {
    return Object.freeze({ excluded: true, immutable: true, reason: "immutable_credentials" });
  }
  return undefined;
}

function compileGlob(pattern: string): RegExp {
  let expression = "";
  for (let cursor = 0; cursor < pattern.length; cursor += 1) {
    const character = pattern[cursor];
    if (character === "*") {
      if (pattern[cursor + 1] === "*") {
        expression += ".*";
        cursor += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character === "/") {
      expression += "/";
    } else {
      expression += character?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "";
    }
  }
  const directoryPrefix = pattern.includes("/") ? "^" : "(?:^|/)";
  return new RegExp(`${directoryPrefix}${expression}(?:$|/)`, "u");
}

function policySyntaxFailure(source: string, line: number, reason: string) {
  return workspaceError(
    "policy_invalid",
    `The ${source} exclusion policy is invalid at line ${line}.`,
    "policy",
    reason,
  );
}
