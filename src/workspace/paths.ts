import { isAbsolute, relative, resolve, sep } from "node:path";

import { workspaceError } from "./errors.js";

export interface FilesystemCapabilities {
  readonly platform: "windows" | "macos" | "linux";
  readonly caseSensitive: boolean;
  readonly unicodeNormalization: "nfc" | "nfd" | "preserving";
  readonly symlinks: boolean;
  readonly atomicRename: boolean;
  readonly maximumComponentBytes: number;
  readonly maximumPathBytes: number;
}

const WINDOWS_DEVICES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export function normalizeWirePath(
  input: string,
  capabilities: FilesystemCapabilities,
): string {
  if (input.length === 0 || input.includes("\0") || LONE_SURROGATE.test(input)) {
    throw pathFailure("invalid_encoding");
  }
  if (input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/u.test(input)) {
    throw pathFailure("absolute_or_platform_path");
  }
  const components = input.split("/");
  if (components.length > 256) throw pathFailure("nesting_limit");
  const normalized = components.map((component) => {
    if (component.length === 0 || component === "." || component === "..") {
      throw pathFailure("unsafe_component");
    }
    const nfc = component.normalize("NFC");
    if (
      WINDOWS_DEVICES.test(nfc) ||
      nfc.endsWith(".") ||
      nfc.endsWith(" ") ||
      nfc.includes(":")
    ) {
      throw pathFailure("unportable_component");
    }
    if (Buffer.byteLength(nfc, "utf8") > capabilities.maximumComponentBytes) {
      throw pathFailure("component_too_long");
    }
    return nfc;
  });
  const wirePath = normalized.join("/");
  if (Buffer.byteLength(wirePath, "utf8") > capabilities.maximumPathBytes) {
    throw pathFailure("path_too_long");
  }
  return wirePath;
}

export function portabilityCollisionKey(
  wirePath: string,
  capabilities: FilesystemCapabilities,
): string {
  const normalized = normalizeWirePath(wirePath, capabilities).normalize("NFC");
  return capabilities.caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

export function assertNoPortableCollisions(
  paths: readonly string[],
  capabilities: FilesystemCapabilities,
): void {
  const observed = new Map<string, string>();
  for (const path of paths) {
    const normalized = normalizeWirePath(path, capabilities);
    const key = portabilityCollisionKey(normalized, capabilities);
    const previous = observed.get(key);
    if (previous !== undefined) {
      throw workspaceError(
        "portability_conflict",
        "Two workspace paths cannot be represented distinctly on the destination filesystem.",
        "conflict",
        "case_or_unicode_collision",
      );
    }
    observed.set(key, normalized);
  }
}

export function assertLexicallyInsideRoot(root: string, candidate: string): string {
  const canonicalRoot = resolve(root);
  const canonicalCandidate = resolve(candidate);
  const difference = relative(canonicalRoot, canonicalCandidate);
  if (
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw workspaceError(
      "path_escape",
      "The workspace path escapes the canonical local root.",
      "policy",
      "outside_root",
    );
  }
  return canonicalCandidate;
}

function pathFailure(reason: string) {
  return workspaceError(
    "path_invalid",
    "The workspace path is not portable or safely relative.",
    "policy",
    reason,
  );
}
