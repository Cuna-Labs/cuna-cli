import {
  type LocalActionKind,
  type LocalActionRequest,
  type LocalActionResult,
  type LocalActionSafeReason,
  type LocalActionSessionIdentity,
  type LocalActionSnapshot,
  sameLocalActionIdentity,
} from "./contracts.js";
import { validateRequest } from "./broker.js";
import { providerAllowsLocalAction } from "./providers.js";
import { validateLocalActionArguments, validateLocalActionResult } from "./schemas.js";

const SAFE_REASON = /^[a-z0-9_.:-]{1,128}$/u;

export interface LocalActionExecutionAuthority {
  get(requestId: string): LocalActionSnapshot | undefined;
  awaitingRemoteCompletion(requestId: string): LocalActionSnapshot;
  complete(
    requestId: string,
    identity: LocalActionSessionIdentity,
    status: "succeeded" | "failed" | "cancelled",
    safeData?: LocalActionResult["safeData"],
    safeReason?: LocalActionSafeReason,
  ): LocalActionSnapshot;
  cancelBinding(identity: LocalActionSessionIdentity, reason?: LocalActionSafeReason): readonly LocalActionSnapshot[];
  expire(): readonly LocalActionSnapshot[];
}

export interface LocalActionAdapterContext<K extends LocalActionKind = LocalActionKind> {
  readonly request: LocalActionRequest<K>;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  registerCleanup(cleanup: () => void | Promise<void>): void;
  markAwaitingRemoteCompletion(): void;
}

export interface LocalActionAdapterOutcome {
  readonly status: "succeeded" | "failed";
  readonly safeData?: LocalActionResult["safeData"];
  readonly safeReason?: LocalActionSafeReason;
  /** Keep registered cleanup alive after the single result until cancel/deadline/dispose. */
  readonly cleanupLifetime?: "operation" | "request";
}

export interface LocalActionAdapter<K extends LocalActionKind = LocalActionKind> {
  readonly kind: K;
  execute(context: LocalActionAdapterContext<K>): Promise<LocalActionAdapterOutcome>;
}

export type LocalActionAdapterRegistration = LocalActionAdapter<LocalActionKind>;

export interface LocalActionExecutorOptions {
  readonly authority: LocalActionExecutionAuthority;
  readonly adapters: readonly LocalActionAdapterRegistration[];
  readonly isIdentityLive: (identity: LocalActionSessionIdentity) => boolean;
  readonly now?: () => number;
  readonly maximumExecutionMs?: number;
  readonly onCleanupError?: (error: unknown, requestId: string) => void;
}

interface ActiveExecution {
  readonly request: LocalActionRequest;
  readonly controller: AbortController;
  readonly cleanups: Array<() => void | Promise<void>>;
  readonly result: Promise<LocalActionResult>;
  readonly resolve: (result: LocalActionResult) => void;
  readonly reject: (error: Error) => void;
  timeout: NodeJS.Timeout | undefined;
  awaitingMarked: boolean;
  resultEmitted: boolean;
  cleanup: Promise<void> | undefined;
  retainCleanup: boolean;
  termination: { readonly kind: "cancelled" | "timeout" | "expired"; readonly reason: LocalActionSafeReason } | undefined;
}

export class LocalActionExecutorError extends Error {
  public constructor(
    public readonly code: "invalid_registration" | "not_executing" | "authority_mismatch" | "already_active" | "result_unavailable",
    public readonly requestId: string,
  ) {
    super(`Local action executor ${requestId} failed: ${code}.`);
    this.name = "LocalActionExecutorError";
  }
}

export class LocalActionExecutor {
  readonly #authority: LocalActionExecutionAuthority;
  readonly #adapters: ReadonlyMap<LocalActionKind, LocalActionAdapterRegistration>;
  readonly #isIdentityLive: (identity: LocalActionSessionIdentity) => boolean;
  readonly #now: () => number;
  readonly #maximumExecutionMs: number;
  readonly #onCleanupError: ((error: unknown, requestId: string) => void) | undefined;
  readonly #active = new Map<string, ActiveExecution>();
  #disposed = false;

  public constructor(options: LocalActionExecutorOptions) {
    const maximum = options.maximumExecutionMs ?? 5 * 60 * 1_000;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 5 * 60 * 1_000) {
      throw new RangeError("Local action execution timeout must be between 1 ms and 5 minutes.");
    }
    const adapters = new Map<LocalActionKind, LocalActionAdapterRegistration>();
    for (const adapter of options.adapters) {
      if (!knownKind(adapter.kind) || adapters.has(adapter.kind) || typeof adapter.execute !== "function") {
        throw new LocalActionExecutorError("invalid_registration", String(adapter.kind));
      }
      adapters.set(adapter.kind, Object.freeze({ kind: adapter.kind, execute: adapter.execute.bind(adapter) }));
    }
    this.#authority = options.authority;
    this.#adapters = adapters;
    this.#isIdentityLive = options.isIdentityLive;
    this.#now = options.now ?? Date.now;
    this.#maximumExecutionMs = maximum;
    this.#onCleanupError = options.onCleanupError;
  }

  public execute(snapshot: LocalActionSnapshot): Promise<LocalActionResult> {
    if (this.#disposed) return Promise.reject(new LocalActionExecutorError("not_executing", snapshot.request.id));
    const current = this.#assertApprovedCurrent(snapshot);
    const existing = this.#active.get(current.request.id);
    if (existing !== undefined) {
      if (!sameRequestAuthority(existing.request, current.request)) {
        return Promise.reject(new LocalActionExecutorError("already_active", current.request.id));
      }
      return existing.result;
    }

    let resolve!: (result: LocalActionResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<LocalActionResult>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const active: ActiveExecution = {
      request: current.request,
      controller: new AbortController(),
      cleanups: [],
      result,
      resolve,
      reject,
      timeout: undefined,
      awaitingMarked: false,
      resultEmitted: false,
      cleanup: undefined,
      retainCleanup: false,
      termination: undefined,
    };
    this.#active.set(current.request.id, active);
    const deadline = Math.min(current.request.expiresAt, this.#now() + this.#maximumExecutionMs);
    active.timeout = setTimeout(() => { void this.#timeout(active, deadline === current.request.expiresAt); }, Math.max(1, deadline - this.#now()));
    active.timeout.unref();
    queueMicrotask(() => { void this.#run(active, deadline); });
    return result;
  }

  public async cancel(requestId: string, reason: LocalActionSafeReason = "cancelled_by_foreground"): Promise<void> {
    if (!SAFE_REASON.test(reason)) throw new TypeError("Cancellation reason must be a bounded safe reason.");
    const active = this.#active.get(requestId);
    if (active === undefined) return;
    active.termination ??= Object.freeze({ kind: "cancelled", reason });
    active.controller.abort(new Error(reason));
    await this.#cleanup(active);
    if (!active.resultEmitted) this.#emitTermination(active);
    this.#finishActive(active);
  }

  public async cancelBinding(identity: LocalActionSessionIdentity, reason: LocalActionSafeReason = "terminal_binding_changed"): Promise<void> {
    const matches = [...this.#active.values()].filter((active) => sameLocalActionIdentity(active.request.identity, identity));
    await Promise.all(matches.map(async (active) => this.cancel(active.request.id, reason)));
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.all([...this.#active.keys()].map(async (requestId) => this.cancel(requestId, "foreground_stopped")));
  }

  #assertApprovedCurrent(snapshot: LocalActionSnapshot): LocalActionSnapshot {
    if (snapshot.state !== "executing" ||
      (snapshot.decision?.decision !== "allow_once" && snapshot.decision?.decision !== "allow_scoped")) {
      throw new LocalActionExecutorError("not_executing", snapshot.request.id);
    }
    validateRequest(snapshot.request, this.#now());
    validateLocalActionArguments(snapshot.request);
    const current = this.#authority.get(snapshot.request.id);
    if (current === undefined || current.state !== "executing" || !sameRequestAuthority(current.request, snapshot.request) ||
      current.decision?.decision !== snapshot.decision.decision) {
      throw new LocalActionExecutorError("authority_mismatch", snapshot.request.id);
    }
    if (!this.#isIdentityLive(current.request.identity)) {
      this.#authority.cancelBinding(current.request.identity, "stale_identity");
      throw new LocalActionExecutorError("not_executing", snapshot.request.id);
    }
    return current;
  }

  async #run(active: ActiveExecution, deadline: number): Promise<void> {
    if (active.controller.signal.aborted) {
      if (!active.resultEmitted) this.#emitTermination(active);
      this.#finishActive(active);
      return;
    }
    const adapter = providerAllowsLocalAction(active.request.provider, active.request.kind)
      ? this.#adapters.get(active.request.kind)
      : undefined;
    if (adapter === undefined) {
      this.#emit(active, "failed", undefined, "unsupported");
      await this.#cleanup(active);
      this.#finishActive(active);
      return;
    }
    const context: LocalActionAdapterContext = Object.freeze({
      request: active.request,
      signal: active.controller.signal,
      deadlineMs: deadline,
      registerCleanup: (cleanup: () => void | Promise<void>): void => {
        if (active.cleanup !== undefined || active.controller.signal.aborted) throw new Error("Local action cleanup registration is closed.");
        active.cleanups.push(cleanup);
      },
      markAwaitingRemoteCompletion: (): void => {
        if (active.resultEmitted || active.controller.signal.aborted || active.awaitingMarked) return;
        const current = this.#authority.get(active.request.id);
        if (current?.state !== "executing" || !sameRequestAuthority(current.request, active.request) ||
          !this.#isIdentityLive(active.request.identity)) throw new LocalActionExecutorError("authority_mismatch", active.request.id);
        this.#authority.awaitingRemoteCompletion(active.request.id);
        active.awaitingMarked = true;
      },
    });
    try {
      const outcome = await adapter.execute(context);
      if (active.resultEmitted) return;
      if (active.controller.signal.aborted) {
        this.#emitTermination(active);
        return;
      }
      if (!this.#identityStillLive(active)) {
        this.#authority.cancelBinding(active.request.identity, "stale_identity");
        this.#resolveFromAuthority(active);
        return;
      }
      validateOutcome(outcome);
      active.retainCleanup = outcome.cleanupLifetime === "request";
      if (!active.retainCleanup) await this.#cleanup(active);
      this.#emit(active, outcome.status, outcome.safeData, outcome.safeReason);
    } catch (error) {
      if (!active.resultEmitted) {
        if (active.controller.signal.aborted) this.#emitTermination(active);
        else if (!this.#identityStillLive(active)) {
          this.#authority.cancelBinding(active.request.identity, "stale_identity");
          this.#resolveFromAuthority(active);
        } else this.#emit(active, "failed", undefined, "adapter_failed");
      }
      if (!active.retainCleanup) await this.#cleanup(active);
      if (error instanceof LocalActionExecutorError && !active.resultEmitted) active.reject(error);
    } finally {
      if (!active.retainCleanup) this.#finishActive(active);
    }
  }

  async #timeout(active: ActiveExecution, requestExpired: boolean): Promise<void> {
    if (active.cleanup !== undefined && active.resultEmitted) return;
    active.termination ??= Object.freeze({
      kind: requestExpired ? "expired" : "timeout",
      reason: requestExpired ? "request_expired" : "execution_timeout",
    });
    active.controller.abort(new Error(active.termination.reason));
    await this.#cleanup(active);
    if (!active.resultEmitted) this.#emitTermination(active);
    this.#finishActive(active);
  }

  #identityStillLive(active: ActiveExecution): boolean {
    const current = this.#authority.get(active.request.id);
    return current !== undefined && (current.state === "executing" || current.state === "awaiting_remote_completion") &&
      sameRequestAuthority(current.request, active.request) && this.#isIdentityLive(active.request.identity);
  }

  #emit(
    active: ActiveExecution,
    status: "succeeded" | "failed" | "cancelled",
    safeData?: LocalActionResult["safeData"],
    safeReason?: LocalActionSafeReason,
  ): void {
    if (active.resultEmitted) return;
    try {
      validateLocalActionResult(active.request, status, safeData, safeReason);
    } catch {
      if (status === "failed" && safeData === undefined && safeReason === "adapter_failed") {
        active.reject(new LocalActionExecutorError("result_unavailable", active.request.id));
        return;
      }
      this.#emit(active, "failed", undefined, "adapter_failed");
      return;
    }
    try {
      const snapshot = this.#authority.complete(
        active.request.id,
        active.request.identity,
        status,
        safeData,
        safeReason,
      );
      if (snapshot.result === undefined) throw new LocalActionExecutorError("result_unavailable", active.request.id);
      active.resultEmitted = true;
      active.resolve(snapshot.result);
    } catch (error) {
      const committed = this.#authority.get(active.request.id)?.result;
      if (committed !== undefined) {
        active.resultEmitted = true;
        active.resolve(committed);
      } else active.reject(error instanceof Error ? error : new Error("Local action result could not be committed."));
    }
  }

  #emitTermination(active: ActiveExecution): void {
    if (active.resultEmitted) return;
    const termination = active.termination ?? Object.freeze({ kind: "cancelled" as const, reason: "cancelled_by_foreground" as const });
    if (termination.kind === "expired") {
      this.#authority.expire();
      this.#resolveFromAuthority(active);
    } else if (termination.kind === "timeout") {
      this.#emit(active, "failed", undefined, termination.reason);
    } else if (this.#isIdentityLive(active.request.identity)) {
      this.#emit(active, "cancelled", undefined, termination.reason);
    } else {
      this.#authority.cancelBinding(active.request.identity, termination.reason);
      this.#resolveFromAuthority(active);
    }
  }

  #resolveFromAuthority(active: ActiveExecution): void {
    if (active.resultEmitted) return;
    active.resultEmitted = true;
    const result = this.#authority.get(active.request.id)?.result;
    if (result === undefined) active.reject(new LocalActionExecutorError("result_unavailable", active.request.id));
    else active.resolve(result);
  }

  async #cleanup(active: ActiveExecution): Promise<void> {
    if (active.cleanup !== undefined) return active.cleanup;
    active.cleanup = (async () => {
      for (const cleanup of active.cleanups.reverse()) {
        try { await cleanup(); } catch (error) {
          try { this.#onCleanupError?.(error, active.request.id); } catch { /* observer owns no cleanup state */ }
        }
      }
      active.cleanups.length = 0;
    })();
    return active.cleanup;
  }

  #finishActive(active: ActiveExecution): void {
    if (active.timeout !== undefined) clearTimeout(active.timeout);
    active.timeout = undefined;
    if (this.#active.get(active.request.id) === active) this.#active.delete(active.request.id);
  }
}

function validateOutcome(outcome: LocalActionAdapterOutcome): void {
  const keys = Object.keys(outcome);
  if (keys.some((key) => !["status", "safeData", "safeReason", "cleanupLifetime"].includes(key)) ||
    (outcome.status !== "succeeded" && outcome.status !== "failed") ||
    (outcome.status === "failed" && outcome.safeData !== undefined) ||
    (outcome.cleanupLifetime !== undefined && outcome.cleanupLifetime !== "operation" && outcome.cleanupLifetime !== "request") ||
    (outcome.safeReason !== undefined && !SAFE_REASON.test(outcome.safeReason))) {
    throw new TypeError("Local action adapter returned an invalid outcome.");
  }
}

function sameRequestAuthority(left: LocalActionRequest, right: LocalActionRequest): boolean {
  return left.id === right.id && left.provider === right.provider && left.kind === right.kind &&
    left.argumentsDigest === right.argumentsDigest && left.nonce === right.nonce &&
    left.requestedScope === right.requestedScope && left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt && sameLocalActionIdentity(left.identity, right.identity);
}

function knownKind(value: string): value is LocalActionKind {
  return new Set<LocalActionKind>([
    "browser.open", "auth.device.present", "auth.callback.relay", "auth.result.observe", "clipboard.write",
    "port.forward", "file.select", "attachment.import", "artifact.save", "preview.open", "diff.open",
    "editor.open", "notification.show", "git.sign", "local_service.request", "device.select",
  ]).has(value as LocalActionKind);
}
