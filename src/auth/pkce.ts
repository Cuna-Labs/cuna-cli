import { createHash, randomBytes } from "node:crypto";

export interface PkceAuthorization {
  readonly verifier: string;
  readonly challenge: string;
  readonly challengeMethod: "S256";
  readonly state: string;
}

type RandomSource = (size: number) => Uint8Array;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Creates independent high-entropy OAuth state and an RFC 7636 S256 verifier.
 * The verifier is intentionally returned only to the caller; it must never be
 * placed in a browser URL, log record, diagnostic bundle, or command line.
 */
export function createPkceAuthorization(random: RandomSource = randomBytes): PkceAuthorization {
  const verifier = base64Url(random(64));
  const state = base64Url(random(32));
  if (verifier.length < 43 || verifier.length > 128 || state.length < 43) {
    throw new Error("The cryptographic random source returned invalid PKCE material.");
  }
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return Object.freeze({ verifier, challenge, challengeMethod: "S256", state });
}

