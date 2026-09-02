import { createHash } from "node:crypto";

import { CREDENTIAL_OPENING_SOURCE } from "../core/namespace.js";
import { normalizeWirePath, type FilesystemCapabilities } from "./paths.js";
import { workspaceError } from "./errors.js";

export type ExclusionReason =
  | "immutable_credentials"
  | "immutable_metadata"
  | "immutable_dependency_tree"
  | "immutable_special_file"
  | "user_rule";

export interface ExclusionDecision {
  readonly excluded: boolean;
  readonly immutable: boolean;
  readonly reason?: ExclusionReason;
  readonly ruleIndex?: number;
}

export interface ExclusionRuleSource {
  readonly source: "gitignore" | "cunaignore" | "cli";
  readonly text: string;
}

interface CompiledRule {
  readonly excluded: boolean;
  readonly pattern: string;
  readonly expression: RegExp;
  readonly directoryOnly: boolean;
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

/**
 * Mutable dependency and build trees named by PRD-PM-002 S9(2). These must
 * never depend on a user's `.gitignore`/`.cunaignore` -- absent from both is
 * exactly how a `node_modules/` tree rode along before this fix (S3).
 */
const IMMUTABLE_DEPENDENCY_TREE_COMPONENTS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".gradle",
  ".terraform",
  "vendor",
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
      if (pattern.length === 0) {
        throw policySyntaxFailure(source.source, index, "invalid_rule");
      }
      const compiled = compileGlob(pattern);
      rules.push({
        excluded,
        pattern,
        expression: compiled.expression,
        directoryOnly: compiled.directoryOnly,
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
    .update("cuna-exclusion-policy-v1\0")
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
        const match = rule.expression.exec(normalized);
        if (match === null) continue;
        // A directory-only pattern (a trailing, unescaped "/") only governs an
        // exact match against the entry itself when that entry really is a
        // directory. It still governs anything found *inside* a matched
        // directory (a prefix match followed by "/") regardless of that
        // descendant's own kind -- that descendant is excluded because its
        // ancestor is, not because of what it is.
        const exactMatch = match.groups?.["end"] !== undefined;
        if (rule.directoryOnly && exactMatch && kind !== "directory") continue;
        result = Object.freeze({
          excluded: rule.excluded,
          immutable: false,
          reason: "user_rule",
          ruleIndex,
        });
      }
      return result;
    },
  });
}

/**
 * Every credential namespace the product issues, in every brand, taken from the
 * one authority in `core/namespace.ts` so this denylist can never fall behind
 * the validators. `\b` is unusable as the leading guard because `_` is a word
 * character, so `\bsk_` never matches inside `cuna_sk_…`; an explicit
 * non-identifier boundary is required. Legacy `runa_*` values stay detected:
 * they remain valid credentials.
 */
const SERVICE_TOKEN = new RegExp(
  `(?:^|[^A-Za-z0-9_-])(?:${CREDENTIAL_OPENING_SOURCE}|sk)_[A-Za-z0-9_-]{20,}`,
  "u",
);

export function detectHighConfidenceSecret(content: Uint8Array): string | undefined {
  if (content.byteLength > 2 * 1024 * 1024 || content.includes(0)) return undefined;
  const text = Buffer.from(content).toString("utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) return "private_key";
  if (/\bAKIA[0-9A-Z]{16}\b/u.test(text)) return "cloud_access_key";
  if (SERVICE_TOKEN.test(text)) return "service_token";
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
  if (components.includes(".cuna")) {
    return Object.freeze({ excluded: true, immutable: true, reason: "immutable_metadata" });
  }
  if (
    components.includes(".ssh") ||
    components.includes(".git") ||
    components.some((component) => IMMUTABLE_COMPONENTS.has(component))
  ) {
    return Object.freeze({ excluded: true, immutable: true, reason: "immutable_credentials" });
  }
  if (components.some((component) => IMMUTABLE_DEPENDENCY_TREE_COMPONENTS.has(component))) {
    return Object.freeze({ excluded: true, immutable: true, reason: "immutable_dependency_tree" });
  }
  return undefined;
}

interface PatternToken {
  readonly char: string;
  /** True when this character was reached via a backslash escape and must
   * never be read as glob syntax (`*`, `?`, `/`), matching real gitignore
   * escaping rather than the platform-path meaning of a backslash. */
  readonly literal: boolean;
}

interface CompiledGlob {
  readonly expression: RegExp;
  readonly directoryOnly: boolean;
}

function tokenizePattern(pattern: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  for (let cursor = 0; cursor < pattern.length; cursor += 1) {
    const character = pattern[cursor];
    if (character === "\\") {
      const next = pattern[cursor + 1];
      if (next === undefined) {
        tokens.push({ char: "\\", literal: true });
      } else {
        tokens.push({ char: next, literal: true });
        cursor += 1;
      }
    } else if (character !== undefined) {
      tokens.push({ char: character, literal: false });
    }
  }
  return tokens;
}

function isSyntacticSeparator(token: PatternToken | undefined): boolean {
  return token !== undefined && !token.literal && token.char === "/";
}

function isSyntacticStar(token: PatternToken | undefined): boolean {
  return token !== undefined && !token.literal && token.char === "*";
}

/**
 * Compiles one gitignore-syntax pattern line (already stripped of a leading
 * `!` negation marker by the caller) into a matcher against the CLI's
 * forward-slash wire paths. Follows gitignore(5) precisely rather than a
 * bespoke dialect:
 *  - a leading `/` (or any `/` before the end) anchors the pattern to the
 *    root instead of letting it match at any depth;
 *  - a trailing, unescaped `/` restricts the pattern to directories, but
 *    still governs every path found underneath the matched directory;
 *  - `**` as a whole path segment matches zero or more directories (leading,
 *    mid-pattern, or trailing); a lone `**` that is not segment-bounded
 *    degrades to an ordinary `*` per gitignore(5)'s "other consecutive
 *    asterisks" rule;
 *  - a backslash escapes the next character literally instead of aborting
 *    the whole policy the way a raw backslash did before this fix.
 */
function compileGlob(pattern: string): CompiledGlob {
  const tokens = tokenizePattern(pattern);
  const directoryOnly = isSyntacticSeparator(tokens[tokens.length - 1]);
  if (directoryOnly) tokens.pop();
  const anchored = tokens.some((token) => !token.literal && token.char === "/");
  if (isSyntacticSeparator(tokens[0])) tokens.shift();

  let body = "";
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token === undefined) continue;
    if (isSyntacticStar(token)) {
      const previousIsBoundary = cursor === 0 || isSyntacticSeparator(tokens[cursor - 1]);
      const nextIsStar = isSyntacticStar(tokens[cursor + 1]);
      const followingIsBoundary =
        cursor + 2 === tokens.length || isSyntacticSeparator(tokens[cursor + 2]);
      if (previousIsBoundary && nextIsStar && followingIsBoundary) {
        if (cursor + 2 === tokens.length) {
          body += ".*";
          cursor += 1;
        } else {
          body += "(?:.*/)?";
          cursor += 2;
        }
        continue;
      }
      body += "[^/]*";
    } else if (!token.literal && token.char === "?") {
      body += "[^/]";
    } else if (!token.literal && token.char === "/") {
      body += "/";
    } else {
      body += token.char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }

  const prefix = anchored ? "^" : "(?:^|.*/)";
  // The named `end` group distinguishes an exact match on the tested entry
  // from a prefix match into something the entry contains -- `decide()`
  // needs that distinction to apply `directoryOnly` only to the former.
  const expression = new RegExp(`${prefix}${body}(?:(?<end>$)|/)`, "u");
  return Object.freeze({ expression, directoryOnly });
}

function policySyntaxFailure(source: string, line: number, reason: string) {
  return workspaceError(
    "policy_invalid",
    `The ${source} exclusion policy is invalid at line ${line}.`,
    "policy",
    reason,
  );
}
