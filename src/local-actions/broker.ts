import { createHash, timingSafeEqual } from "node:crypto";

import {
  LOCAL_ACTION_PROTOCOL_VERSION,
  MAX_LOCAL_ACTION_ARGUMENT_BYTES,
  MAX_LOCAL_ACTION_FUTURE_SKEW_MS,
  MAX_LOCAL_ACTION_HISTORY,
  MAX_LOCAL_ACTION_QUEUE,
  MAX_LOCAL_ACTION_REPLAY_ENTRIES,
  MAX_LOCAL_ACTION_TTL_MS,
  type LocalActionRequest,
  type LocalActionResult,
  type LocalActionSafeReason,
  type LocalActionSessionIdentity,
  type LocalActionSnapshot,
  type LocalActionState,
  type PolicyDecision,
  sameLocalActionIdentity,
} from "./contracts.js";
import { LocalActionPolicyEvaluator } from "./policy.js";
import { providerAllowsLocalAction } from "./providers.js";
import { validateLocalActionArguments, validateLocalActionResult } from "./schemas.js";

const TERMINAL_STATES: ReadonlySet<LocalActionState> = new Set([
  "succeeded", "failed", "denied", "expired", "cancelled",
]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface LocalActionBrokerOptions {
  readonly policy?: LocalActionPolicyEvaluator;
  readonly clock?: () => number;
  readonly maximumQueuedRequests?: number;
  readonly onChange?: (snapshot: LocalActionSnapshot) => void;
  /** Synchronous authority check backed by the currently attached, fenced runtime binding. */
  readonly isIdentityLive: (identity: LocalActionSessionIdentity) => boolean;
  readonly onObserverError?: (error: unknown) => void;
}

export class LocalActionBroker {
  readonly #policy: LocalActionPolicyEvaluator;
  readonly #clock: () => number;
  readonly #maximumQueuedRequests: number;
  readonly #onChange: ((snapshot: LocalActionSnapshot) => void) | undefined;
  readonly #isIdentityLive: (identity: LocalActionSessionIdentity) => boolean;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #requests = new Map<string, LocalActionSnapshot>();
  readonly #queue: string[] = [];
  readonly #nonces = new Map<string, string>();
  readonly #nonceExpiry = new Map<string, number>();
  readonly #terminalOrder: string[] = [];

  constructor(options: LocalActionBrokerOptions) {
    const maximum = options.maximumQueuedRequests ?? MAX_LOCAL_ACTION_QUEUE;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_LOCAL_ACTION_QUEUE) {
      throw new RangeError(`Local action queue must contain 1 through ${MAX_LOCAL_ACTION_QUEUE} requests.`);
    }
    this.#policy = options.policy ?? new LocalActionPolicyEvaluator();
    this.#clock = options.clock ?? Date.now;
    this.#maximumQueuedRequests = maximum;
    this.#onChange = options.onChange;
    this.#isIdentityLive = options.isIdentityLive;
    this.#onObserverError = options.onObserverError;
  }

  submit(request: LocalActionRequest): LocalActionSnapshot {
    const now = this.#clock();
    this.#prune(now);
    validateRequest(request, now);
    this.#assertLive(request.identity, request.id);
    const existing = this.#requests.get(request.id);
    if (existing !== undefined) {
      if (sameRequest(existing.request, request)) return existing;
      throw new LocalActionBrokerError("duplicate_request", request.id);
    }
    if (!providerAllowsLocalAction(request.provider, request.kind)) {
      throw new LocalActionBrokerError("provider_action_unavailable", request.id);
    }
    try {
      validateLocalActionArguments(request);
    } catch {
      throw new LocalActionBrokerError("invalid_request", request.id);
    }
    const nonceKey = `${identityKey(request.identity)}:${request.nonce}`;
    const priorNonceRequest = this.#nonces.get(nonceKey);
    if (priorNonceRequest !== undefined) {
      throw new LocalActionBrokerError("replayed_nonce", request.id);
    }
    if (this.#nonces.size >= MAX_LOCAL_ACTION_REPLAY_ENTRIES) {
      throw new LocalActionBrokerError("replay_registry_full", request.id);
    }
    if (this.#queue.length >= this.#maximumQueuedRequests) throw new LocalActionBrokerError("queue_full", request.id);
    const immutableRequest = immutableCopy(request);
    this.#nonces.set(nonceKey, request.id);
    this.#nonceExpiry.set(nonceKey, request.expiresAt);
    let snapshot = freezeSnapshot(immutableRequest, "validated");
    this.#requests.set(request.id, snapshot);
    this.#emit(snapshot);
    const initialPolicy = this.#policy.evaluate(immutableRequest, this.#clock());
    if (initialPolicy.decision === "deny") {
      return this.#finish(request.id, "denied", initialPolicy, "denied_by_policy");
    }
    this.#queue.push(request.id);
    return this.#queue[0] === request.id ? this.#activateHead() ?? snapshot : snapshot;
  }

  current(): LocalActionSnapshot | undefined {
    this.expire();
    return this.#activateHead();
  }

  get(requestId: string): LocalActionSnapshot | undefined {
    return this.#requests.get(requestId);
  }

  decide(requestId: string, allow: boolean, grantedScope: string | null = null): LocalActionSnapshot {
    const snapshot = this.#requireState(requestId, "pending_user");
    if (this.#queue[0] !== requestId) throw new LocalActionBrokerError("illegal_transition", requestId);
    this.#assertLive(snapshot.request.identity, requestId);
    const now = this.#clock();
    if (now >= snapshot.request.expiresAt) return this.#finish(requestId, "expired", undefined, "request_expired");
    if (allow && grantedScope !== null && grantedScope !== snapshot.request.requestedScope) {
      throw new LocalActionBrokerError("scope_widening", requestId);
    }
    const policy: PolicyDecision = Object.freeze({
      requestId,
      decision: allow ? "allow_once" : "deny",
      grantedScope: allow ? snapshot.request.requestedScope : null,
      policySource: "interactive_user",
      decidedAt: now,
    });
    if (!allow) return this.#finish(requestId, "denied", policy, "denied_by_user");
    return this.#transition(requestId, "executing", policy);
  }

  awaitingRemoteCompletion(requestId: string): LocalActionSnapshot {
    const snapshot = this.#requests.get(requestId);
    if (snapshot === undefined) throw new LocalActionBrokerError("unknown_request", requestId);
    if (this.#clock() >= snapshot.request.expiresAt) return this.#finish(requestId, "expired", undefined, "request_expired");
    this.#assertLive(snapshot.request.identity, requestId);
    return this.#transition(requestId, "awaiting_remote_completion");
  }

  complete(
    requestId: string,
    identity: LocalActionSessionIdentity,
    status: LocalActionResult["status"],
    safeData?: LocalActionResult["safeData"],
    safeReason?: LocalActionSafeReason,
  ): LocalActionSnapshot {
    const snapshot = this.#requests.get(requestId);
    if (snapshot === undefined) throw new LocalActionBrokerError("unknown_request", requestId);
    if (!sameLocalActionIdentity(snapshot.request.identity, identity)) {
      throw new LocalActionBrokerError("identity_mismatch", requestId);
    }
    if (TERMINAL_STATES.has(snapshot.state)) return snapshot;
    if (this.#clock() >= snapshot.request.expiresAt) return this.#finish(requestId, "expired", undefined, "request_expired");
    this.#assertLive(identity, requestId);
    if ((status !== "succeeded" && status !== "failed" && status !== "cancelled") ||
      (status !== "cancelled" && snapshot.state !== "executing" && snapshot.state !== "awaiting_remote_completion")) {
      throw new LocalActionBrokerError("illegal_transition", requestId);
    }
    if (safeData !== undefined && Buffer.byteLength(canonicalJson(safeData), "utf8") > MAX_LOCAL_ACTION_ARGUMENT_BYTES) {
      throw new LocalActionBrokerError("invalid_result", requestId);
    }
    try {
      validateLocalActionResult(snapshot.request, status, safeData, safeReason);
    } catch {
      throw new LocalActionBrokerError("invalid_result", requestId);
    }
    const immutableSafeData = safeData === undefined ? undefined : deepFreezeJson(safeData);
    const result: LocalActionResult = Object.freeze({
      version: LOCAL_ACTION_PROTOCOL_VERSION,
      requestId,
      kind: snapshot.request.kind,
      identity: snapshot.request.identity,
      status,
      ...(immutableSafeData === undefined ? {} : { safeData: immutableSafeData }),
      ...(safeReason === undefined ? {} : { safeReason }),
      completedAt: this.#clock(),
    });
    const next = freezeSnapshot(snapshot.request, status, snapshot.decision, result);
    this.#requests.set(requestId, next);
    this.#dequeue(requestId);
    this.#recordTerminal(requestId);
    this.#emit(next);
    this.#activateHead();
    return next;
  }

  cancelBinding(identity: LocalActionSessionIdentity, reason: LocalActionSafeReason = "terminal_binding_changed"): readonly LocalActionSnapshot[] {
    const cancelled: LocalActionSnapshot[] = [];
    for (const snapshot of this.#requests.values()) {
      if (!TERMINAL_STATES.has(snapshot.state) && sameLocalActionIdentity(snapshot.request.identity, identity)) {
        cancelled.push(this.#finish(snapshot.request.id, "cancelled", undefined, reason));
      }
    }
    return Object.freeze(cancelled);
  }

  cancelStaleForIdentity(identity: LocalActionSessionIdentity, reason: LocalActionSafeReason = "terminal_binding_changed"): readonly LocalActionSnapshot[] {
    const cancelled: LocalActionSnapshot[] = [];
    for (const snapshot of this.#requests.values()) {
      const candidate = snapshot.request.identity;
      if (!TERMINAL_STATES.has(snapshot.state) &&
        candidate.agentSessionId === identity.agentSessionId &&
        !sameLocalActionIdentity(candidate, identity)) {
        cancelled.push(this.#finish(snapshot.request.id, "cancelled", undefined, reason));
      }
    }
    return Object.freeze(cancelled);
  }

  expire(): readonly LocalActionSnapshot[] {
    const now = this.#clock();
    const expired: LocalActionSnapshot[] = [];
    for (const snapshot of this.#requests.values()) {
      if (!TERMINAL_STATES.has(snapshot.state) && now >= snapshot.request.expiresAt) {
        expired.push(this.#finish(snapshot.request.id, "expired", undefined, "request_expired"));
      }
    }
    return Object.freeze(expired);
  }

  #transition(requestId: string, state: "executing" | "awaiting_remote_completion", decision?: PolicyDecision): LocalActionSnapshot {
    const snapshot = this.#requests.get(requestId);
    if (snapshot === undefined) throw new LocalActionBrokerError("unknown_request", requestId);
    const allowed = state === "executing"
      ? new Set<LocalActionState>(["pending_user", "validated"])
      : new Set<LocalActionState>(["executing"]);
    if (!allowed.has(snapshot.state)) throw new LocalActionBrokerError("illegal_transition", requestId);
    const next = freezeSnapshot(snapshot.request, state, decision ?? snapshot.decision);
    this.#requests.set(requestId, next);
    this.#emit(next);
    return next;
  }

  #activateHead(): LocalActionSnapshot | undefined {
    const requestId = this.#queue[0];
    if (requestId === undefined) return undefined;
    const snapshot = this.#requests.get(requestId);
    if (snapshot === undefined) throw new LocalActionBrokerError("unknown_request", requestId);
    if (snapshot.state !== "validated") return snapshot;
    if (!this.#isIdentityLive(snapshot.request.identity)) {
      this.#finish(requestId, "cancelled", undefined, "stale_identity");
      const nextId = this.#queue[0];
      return nextId === undefined ? undefined : this.#requests.get(nextId);
    }
    const policy = this.#policy.evaluate(snapshot.request, this.#clock());
    if (policy.decision === "deny") {
      this.#finish(requestId, "denied", policy, "denied_by_policy");
      return this.#activateHead();
    }
    const next = freezeSnapshot(snapshot.request, policy.decision === "ask" ? "pending_user" : "executing", policy);
    this.#requests.set(requestId, next);
    this.#emit(next);
    return next;
  }

  #finish(
    requestId: string,
    status: LocalActionResult["status"],
    decision?: PolicyDecision,
    safeReason?: LocalActionSafeReason,
  ): LocalActionSnapshot {
    const snapshot = this.#requests.get(requestId);
    if (snapshot === undefined) throw new LocalActionBrokerError("unknown_request", requestId);
    if (TERMINAL_STATES.has(snapshot.state)) return snapshot;
    const result: LocalActionResult = Object.freeze({
      version: LOCAL_ACTION_PROTOCOL_VERSION,
      requestId,
      kind: snapshot.request.kind,
      identity: snapshot.request.identity,
      status,
      ...(safeReason === undefined ? {} : { safeReason }),
      completedAt: this.#clock(),
    });
    const next = freezeSnapshot(snapshot.request, status, decision ?? snapshot.decision, result);
    this.#requests.set(requestId, next);
    this.#dequeue(requestId);
    this.#recordTerminal(requestId);
    this.#emit(next);
    this.#activateHead();
    return next;
  }

  #requireState(requestId: string, state: LocalActionState): LocalActionSnapshot {
    const snapshot = this.#requests.get(requestId);
    if (snapshot === undefined) throw new LocalActionBrokerError("unknown_request", requestId);
    if (snapshot.state !== state) throw new LocalActionBrokerError("illegal_transition", requestId);
    return snapshot;
  }

  #dequeue(requestId: string): void {
    const index = this.#queue.indexOf(requestId);
    if (index >= 0) this.#queue.splice(index, 1);
  }

  #emit(snapshot: LocalActionSnapshot): void {
    try {
      this.#onChange?.(snapshot);
    } catch (error) {
      try { this.#onObserverError?.(error); } catch { /* observers never own broker state */ }
    }
  }

  #assertLive(identity: LocalActionSessionIdentity, requestId: string): void {
    if (!this.#isIdentityLive(identity)) throw new LocalActionBrokerError("stale_identity", requestId);
  }

  #recordTerminal(requestId: string): void {
    this.#terminalOrder.push(requestId);
    while (this.#terminalOrder.length > MAX_LOCAL_ACTION_HISTORY) {
      const evicted = this.#terminalOrder.shift();
      if (evicted !== undefined) this.#requests.delete(evicted);
    }
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#nonceExpiry) {
      if (expiresAt <= now) {
        this.#nonceExpiry.delete(key);
        this.#nonces.delete(key);
      }
    }
  }
}

export class LocalActionBrokerError extends Error {
  constructor(
    readonly code: "duplicate_request" | "replayed_nonce" | "replay_registry_full" | "queue_full" | "unknown_request" | "identity_mismatch" | "stale_identity" | "scope_widening" | "illegal_transition" | "invalid_request" | "invalid_result" | "provider_action_unavailable",
    readonly requestId: string,
  ) {
    super(`Local action ${requestId} failed: ${code}.`);
    this.name = "LocalActionBrokerError";
  }
}

export function digestLocalActionArguments(
  value: Readonly<Record<string, unknown>>,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function validateRequest(request: LocalActionRequest, now = Date.now()): void {
  if (!plainObject(request) || !plainObject(request.identity) || !plainObject(request.arguments) ||
    !exactObjectKeys(request, ["version", "id", "identity", "provider", "kind", "arguments", "argumentsDigest", "requestedScope", "createdAt", "expiresAt", "nonce"]) ||
    !exactObjectKeys(request.identity, ["userId", "deviceId", "machineId", "workspaceBindingId", "workspaceBindingGeneration", "agentSessionId", "processEpoch", "fencingGeneration"])) {
    throw new LocalActionBrokerError("invalid_request", typeof request?.id === "string" ? request.id : "unknown");
  }
  const encoded = canonicalJson(request.arguments);
  const actualDigest = digestLocalActionArguments(request.arguments);
  const expected = Buffer.from(request.argumentsDigest);
  const actual = Buffer.from(actualDigest);
  if (
    request.version !== LOCAL_ACTION_PROTOCOL_VERSION ||
    !IDENTIFIER.test(request.id) ||
    !IDENTIFIER.test(request.identity.userId) ||
    !IDENTIFIER.test(request.identity.deviceId) ||
    !IDENTIFIER.test(request.identity.machineId) ||
    (request.identity.workspaceBindingId !== null && !IDENTIFIER.test(request.identity.workspaceBindingId)) ||
    !IDENTIFIER.test(request.identity.agentSessionId) ||
    !IDENTIFIER.test(request.identity.processEpoch) ||
    !Number.isSafeInteger(request.identity.fencingGeneration) ||
    request.identity.fencingGeneration < 1 ||
    !IDENTIFIER.test(request.requestedScope) ||
    !IDENTIFIER.test(request.nonce) ||
    !Number.isSafeInteger(request.createdAt) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= request.createdAt ||
    request.expiresAt <= now ||
    request.createdAt > now + MAX_LOCAL_ACTION_FUTURE_SKEW_MS ||
    request.expiresAt - request.createdAt > MAX_LOCAL_ACTION_TTL_MS ||
    (request.identity.workspaceBindingId === null) !== (request.identity.workspaceBindingGeneration === null) ||
    (request.identity.workspaceBindingGeneration !== null &&
      (!Number.isSafeInteger(request.identity.workspaceBindingGeneration) || request.identity.workspaceBindingGeneration < 1)) ||
    Buffer.byteLength(encoded, "utf8") > MAX_LOCAL_ACTION_ARGUMENT_BYTES ||
    !DIGEST.test(request.argumentsDigest) ||
    expected.byteLength !== actual.byteLength ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new LocalActionBrokerError("invalid_request", request.id);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Local action arguments must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Local action arguments must be JSON values.");
}

function immutableCopy(request: LocalActionRequest): LocalActionRequest {
  const copy = structuredClone(request);
  return Object.freeze({
    ...copy,
    identity: Object.freeze({ ...copy.identity }),
    arguments: deepFreezeJson(copy.arguments),
  });
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function sameRequest(left: LocalActionRequest, right: LocalActionRequest): boolean {
  return left.id === right.id && left.kind === right.kind && left.provider === right.provider &&
    left.argumentsDigest === right.argumentsDigest && left.nonce === right.nonce &&
    left.requestedScope === right.requestedScope && left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt && sameLocalActionIdentity(left.identity, right.identity);
}

function identityKey(identity: LocalActionSessionIdentity): string {
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeSnapshot(
  request: LocalActionRequest,
  state: LocalActionState,
  decision?: PolicyDecision,
  result?: LocalActionResult,
): LocalActionSnapshot {
  return Object.freeze({ request, state, ...(decision === undefined ? {} : { decision }), ...(result === undefined ? {} : { result }) });
}
