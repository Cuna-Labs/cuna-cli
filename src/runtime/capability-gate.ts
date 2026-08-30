import type { CapabilityScope, CapabilitySnapshot } from "../api/contracts.js";
import { classifyCapabilitySnapshot } from "../api/capability-evidence.js";

import { runtimeFailure } from "./errors.js";

export interface CapabilityRequirement {
  readonly id: string;
  readonly scope: CapabilityScope;
  readonly subjectId?: string;
  readonly surface?: "cli";
  readonly interaction?: "native" | "read_only";
}

export interface CapabilityAdmission {
  readonly capabilityId: string;
  readonly scope: CapabilityScope;
  readonly subjectId?: string;
  readonly snapshotEtag: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly mutationRequiresReauthorization: true;
}

export function admitCapability(
  snapshot: CapabilitySnapshot,
  requirement: CapabilityRequirement,
  now = Date.now(),
): CapabilityAdmission {
  const validity = classifyCapabilitySnapshot(snapshot, now);
  if (validity !== "valid") {
    throw runtimeFailure(
      validity === "expired" ? "capability_snapshot_expired" : "capability_unknown",
      validity === "expired" ? "The capability snapshot expired before the operation." : "The capability snapshot has invalid authority evidence.",
      { safeDetails: { reason: validity } },
    );
  }
  if (snapshot.subjectScope !== requirement.scope) {
    throw runtimeFailure("capability_scope_mismatch", "The capability snapshot belongs to another resource scope.");
  }
  if (requirement.subjectId !== undefined && snapshot.subjectId !== requirement.subjectId) {
    throw runtimeFailure("capability_scope_mismatch", "The capability snapshot belongs to another resource.");
  }
  const observedAt = Date.parse(snapshot.observedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  const matches = snapshot.capabilities.filter((candidate) => candidate.id === requirement.id);
  if (matches.length !== 1) {
    throw runtimeFailure("capability_unknown", "The required capability is absent or ambiguous.", {
      safeDetails: { capability_id: requirement.id },
    });
  }
  const capability = matches[0];
  if (capability === undefined || capability.availability === "unknown") {
    throw runtimeFailure("capability_unknown", "The server cannot currently prove this capability.", {
      safeDetails: {
        capability_id: requirement.id,
        ...(capability?.reasonCode === undefined ? {} : { reason_code: capability.reasonCode }),
      },
    });
  }
  if (capability.availability === "temporarily_unavailable") {
    throw runtimeFailure("capability_unavailable", "The required capability is temporarily unavailable.", {
      retryable: true,
      safeDetails: {
        capability_id: requirement.id,
        ...(capability.reasonCode === undefined ? {} : { reason_code: capability.reasonCode }),
      },
    });
  }
  if (capability.availability !== "supported") {
    throw runtimeFailure("capability_unsupported", "The required capability is unsupported.", {
      safeDetails: { capability_id: requirement.id },
    });
  }
  const surface = requirement.surface ?? "cli";
  if (!capability.surfaces.includes(surface)) {
    throw runtimeFailure("capability_unsupported", "The capability is not available on the CLI surface.", {
      safeDetails: { capability_id: requirement.id },
    });
  }
  if (requirement.interaction !== undefined && capability.interaction !== requirement.interaction) {
    throw runtimeFailure("capability_unsupported", "The capability does not support the required CLI interaction.", {
      safeDetails: { capability_id: requirement.id },
    });
  }
  return Object.freeze({
    capabilityId: requirement.id,
    scope: requirement.scope,
    ...(requirement.subjectId === undefined ? {} : { subjectId: requirement.subjectId }),
    snapshotEtag: snapshot.etag,
    observedAt,
    expiresAt,
    mutationRequiresReauthorization: true,
  });
}
