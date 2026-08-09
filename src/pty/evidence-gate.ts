import { LOCAL_PTY_PROTOCOL, type PtyAdapter, type PtyAdapterEvidence } from "./contracts.js";
import { runtimeFailure } from "../runtime/errors.js";

export interface VerifiedPtyAdapter {
  readonly adapter: PtyAdapter;
  readonly evidence: PtyAdapterEvidence & { readonly status: "verified" };
}

export async function requireVerifiedPtyAdapter(input: {
  readonly adapter: PtyAdapter | undefined;
  readonly platform?: NodeJS.Platform;
  readonly now?: number;
  readonly signal?: AbortSignal;
}): Promise<VerifiedPtyAdapter> {
  if (input.adapter === undefined) {
    throw runtimeFailure("pty_unavailable", "No PTY adapter is installed for this runtime.");
  }
  const evidence = await input.adapter.probe(input.signal);
  const now = input.now ?? Date.now();
  const platform = input.platform ?? process.platform;
  if (
    evidence.status !== "verified" ||
    evidence.protocol !== LOCAL_PTY_PROTOCOL ||
    evidence.platform !== platform ||
    !Number.isFinite(evidence.observedAt) ||
    !Number.isFinite(evidence.expiresAt) ||
    evidence.expiresAt <= now ||
    evidence.expiresAt < evidence.observedAt ||
    !/^sha256:[a-f0-9]{64}$/u.test(evidence.artifactDigest) ||
    !evidence.capabilities.rawInput ||
    !evidence.capabilities.resize ||
    !evidence.capabilities.signals ||
    !evidence.capabilities.utf8
  ) {
    throw runtimeFailure("pty_evidence_invalid", "The installed PTY adapter lacks current conformance evidence.", {
      safeDetails: {
        adapter_id: boundedIdentifier(evidence.adapterId),
        evidence_status: evidence.status,
        platform: evidence.platform,
      },
    });
  }
  return Object.freeze({ adapter: input.adapter, evidence: evidence as PtyAdapterEvidence & { readonly status: "verified" } });
}

function boundedIdentifier(value: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : "invalid_adapter";
}
