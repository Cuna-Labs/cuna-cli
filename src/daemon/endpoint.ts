import { createHash } from "node:crypto";
import path from "node:path";

export type DaemonEndpoint =
  | {
      readonly transport: "unix_socket";
      readonly address: string;
      readonly directory: string;
      readonly requiredDirectoryMode: 0o700;
      readonly requiredSocketMode: 0o600;
      readonly ownerIdentity: string;
    }
  | {
      readonly transport: "windows_named_pipe";
      readonly address: string;
      readonly requiredAcl: "owner_only";
      readonly ownerIdentity: string;
    };

export class EndpointSecurityError extends Error {
  readonly code:
    | "missing_owner_identity"
    | "missing_runtime_directory"
    | "cross_user_peer"
    | "unverified_peer"
    | "unsafe_endpoint";

  constructor(code: EndpointSecurityError["code"], message: string) {
    super(message);
    this.name = "EndpointSecurityError";
    this.code = code;
  }
}

function validateOwnerIdentity(value: string): void {
  if (value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new EndpointSecurityError("missing_owner_identity", "A stable OS-user identity is required for daemon IPC.");
  }
}

function ownerToken(ownerIdentity: string): string {
  return createHash("sha256").update("cuna-daemon-owner\0").update(ownerIdentity).digest("hex").slice(0, 24);
}

export function deriveDaemonEndpoint(input: {
  readonly platform: NodeJS.Platform;
  readonly ownerIdentity: string;
  readonly runtimeDirectory?: string;
}): DaemonEndpoint {
  validateOwnerIdentity(input.ownerIdentity);
  if (input.platform === "win32") {
    return {
      transport: "windows_named_pipe",
      address: `\\\\.\\pipe\\cuna-daemon-v1-${ownerToken(input.ownerIdentity)}`,
      requiredAcl: "owner_only",
      ownerIdentity: input.ownerIdentity,
    };
  }
  if (input.runtimeDirectory === undefined || !path.isAbsolute(input.runtimeDirectory) || input.runtimeDirectory.includes("\0")) {
    throw new EndpointSecurityError(
      "missing_runtime_directory",
      "An absolute user-private runtime directory is required for Unix daemon IPC.",
    );
  }
  const directory = path.join(input.runtimeDirectory, "cuna");
  const address = path.join(directory, "daemon-v1.sock");
  // sockaddr_un is commonly limited to roughly 104-108 bytes. Refuse an endpoint
  // that cannot be represented instead of silently moving it to a shared directory.
  if (Buffer.byteLength(address) > 100) {
    throw new EndpointSecurityError("unsafe_endpoint", "The Unix daemon socket path is too long for Tier-1 support.");
  }
  return {
    transport: "unix_socket",
    address,
    directory,
    requiredDirectoryMode: 0o700,
    requiredSocketMode: 0o600,
    ownerIdentity: input.ownerIdentity,
  };
}

export interface PeerIdentityObservation {
  readonly verified: boolean;
  readonly ownerIdentity?: string;
  readonly mechanism: "unix_peer_credentials" | "windows_pipe_token" | "test_fixture";
}

export function assertSameUserPeer(expectedOwnerIdentity: string, observation: PeerIdentityObservation): void {
  validateOwnerIdentity(expectedOwnerIdentity);
  if (!observation.verified || observation.ownerIdentity === undefined) {
    throw new EndpointSecurityError("unverified_peer", "The IPC peer identity was not verified by the OS transport.");
  }
  const expected = Buffer.from(expectedOwnerIdentity, "utf8");
  const actual = Buffer.from(observation.ownerIdentity, "utf8");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    throw new EndpointSecurityError("cross_user_peer", "The IPC peer belongs to a different OS user.");
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
