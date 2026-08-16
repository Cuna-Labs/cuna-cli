import { createHash } from "node:crypto";

import type { AgentKind } from "../api/contracts.js";
import { EXIT_CODES, CunaError } from "../core/errors.js";
import type { MachineJourneySelection } from "./intent.js";

/**
 * A deterministic RFC 4122 version-5-shaped identifier for `domain` and `value`.
 *
 * Two call sites now need the same primitive — the workspace binding's
 * `projectId`/`localInstanceId` and the machine-create request identity — so it
 * is defined once. Two private copies of one derivation is the shape that lets
 * one copy be "improved" and silently start minting different identifiers for
 * records already written to a user's disk.
 */
export function stableUuid(domain: string, value: string): string {
  const bytes = createHash("sha256").update(`${domain}\0${value}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Everything that decides WHICH machine a journey create is asking for. */
export interface MachineCreateIdentityInput {
  /** The authenticated principal the create is billed and scoped to. */
  readonly userId: string;
  /** The workspace the machine is created inside. */
  readonly workspaceId: string;
  /** The project root, canonicalized by the same authority the binding uses. */
  readonly canonicalLocalRoot: string;
  /** The agent the machine is created to run. */
  readonly agent: AgentKind;
  /** The machine the invocation asked for. */
  readonly machine: MachineJourneySelection;
}

export interface MachineCreateIdentity {
  /** The producer-side create-request identity, and the reconciliation key. */
  readonly requestId: string;
  /** The transport idempotency key carried by the same create. */
  readonly idempotencyKey: string;
  /** The intent digest both identities project from. Diagnostics only. */
  readonly intentDigest: string;
}

function invalidComponent(component: string): CunaError {
  return new CunaError({
    code: "cuna.journey.machine_create_identity_unavailable",
    message: "Cuna cannot derive a durable identity for this machine-create request.",
    exitCode: EXIT_CODES.policy,
    hint: "Report this with `cuna version --json`; the journey refuses to create a machine it could not later find.",
    details: { component },
  });
}

function component(value: string, name: string): string {
  // NUL is the field separator below. A value carrying one would let two
  // different inputs serialize to the same string, which is the one way a
  // derived identity can collide across genuinely different creates.
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw invalidComponent(name);
  }
  return value;
}

/** The selection, serialized so that no two distinct selections share a string. */
function selectionComponent(machine: MachineJourneySelection): string {
  if (machine === null || typeof machine !== "object") throw invalidComponent("machine_selection");
  if (machine.kind === "exact-name") return `exact-name${component(machine.name, "machine_selection")}`;
  if (machine.kind === "new" || machine.kind === "automatic") return machine.kind;
  throw invalidComponent("machine_selection");
}

/**
 * Derive the durable identity of one machine-create request from the intent
 * that asked for it.
 *
 * WHY THIS IS NOT `randomUUID()`. The identity below is the key
 * `reconcileMachineCreate` looks the create up by. Minted from randomness it is
 * lost with the process that minted it: a CLI interrupted between the provider
 * accepting the create and the CLI recording it comes back with a different id,
 * cannot find its own attempt, and creates a SECOND machine while the first
 * bills forever with nothing able to name it. Derived from the intent, the
 * re-run of an interrupted command re-derives the same id and reconciles.
 * `journey/workspace-effects.ts` already derives the workspace binding's
 * identities this way and for this reason; this is that discipline, not a
 * second mechanism.
 *
 * EVERY INPUT IS NECESSARY:
 *
 *   `userId`   — two principals on one host, in one directory, running one
 *     command must not derive one create identity. The id is a client-chosen
 *     key into a producer-side table; scoping it to the principal makes a
 *     cross-principal collision impossible under any producer keying, including
 *     keyings this repository cannot read.
 *
 *   `workspaceId` — one principal may hold more than one workspace and a
 *     machine belongs to exactly one. A create in workspace B must never
 *     reconcile onto a machine created in workspace A.
 *
 *   `canonicalLocalRoot` — two projects are two machines. This is the same
 *     canonical root `workspace-effects.ts` keys the binding on, taken from the
 *     same authority rather than recomputed here, so the create identity and
 *     the binding identity can never disagree about which project this is. A
 *     lexical path would disagree the moment the user retried through a
 *     symlink, a different case, or a relative spelling.
 *
 *   `agent` — `cuna claude` and `cuna codex` send different create bodies and
 *     different machine names. Sharing an identity would reconcile the second
 *     command onto a machine running the other agent.
 *
 *   `machine` — `--new` is a deliberately different request from the default
 *     reconciling one, and the full selection is serialized rather than only
 *     its kind so that a later change letting `--machine NAME` reach creation
 *     cannot silently alias two names onto one identity.
 *
 * DELIBERATELY EXCLUDED: `syncMode`, `newSession`, `authMode` and
 * `credentialBindingId` describe the AgentSession and the file transfer, not
 * the machine. Admitting them would split one machine into several for
 * invocations that are asking for the same machine.
 *
 * THE COST, stated because it is real. A derived identity is durable in both
 * directions: once a create has settled, that identity keeps resolving to its
 * outcome. If the machine is later deleted AND the local binding removed, the
 * same invocation re-derives a spent identity and cannot create a replacement;
 * `--new` derives a different one and is the way out. That is the price of
 * being able to find an orphan at all, and it is bounded, whereas an orphan
 * that nothing can name is not.
 */
export function deriveMachineCreateIdentity(input: MachineCreateIdentityInput): MachineCreateIdentity {
  const serialized = [
    component(input.userId, "user_id"),
    component(input.workspaceId, "workspace_id"),
    component(input.canonicalLocalRoot, "canonical_local_root"),
    component(input.agent, "agent"),
    selectionComponent(input.machine),
  ].join("\0");
  const intentDigest = createHash("sha256").update(serialized, "utf8").digest("hex");
  return Object.freeze({
    requestId: stableUuid("cuna.machine-create-request.v1", intentDigest),
    // The producer accepts both a create-request identity and a transport
    // idempotency key. Deriving only the first would leave a cross-process
    // replay carrying a fresh key, which is a duplicate create under any
    // producer that deduplicates on the key alone. Both are derived, so the
    // replay is identical in every dimension the request carries.
    idempotencyKey: `cuna-machine-create-${intentDigest}`,
    intentDigest,
  });
}
