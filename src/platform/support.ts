export interface RuntimeSupport {
  readonly nodeRuntime: boolean;
  readonly platform: boolean;
  readonly architecture: boolean;
}

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["win32", "darwin", "linux"]);
const SUPPORTED_ARCHITECTURES = new Set<NodeJS.Architecture>(["x64", "arm64"]);

export function evaluateRuntimeSupport(input: {
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
}): RuntimeSupport {
  return Object.freeze({
    nodeRuntime: isSupportedNodeVersion(input.nodeVersion),
    platform: SUPPORTED_PLATFORMS.has(input.platform),
    architecture: SUPPORTED_ARCHITECTURES.has(input.architecture),
  });
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  if (major === 22) return minor > 17 || (minor === 17 && patch >= 1);
  if (major === 24) return minor > 4 || (minor === 4 && patch >= 1);
  return false;
}
