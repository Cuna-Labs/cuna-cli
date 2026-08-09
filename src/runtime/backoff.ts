import { runtimeFailure } from "./errors.js";

export interface ReconnectPolicy {
  readonly maximumAttempts: number;
  readonly maximumElapsedMs: number;
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly jitterRatio: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = Object.freeze({
  maximumAttempts: 5,
  maximumElapsedMs: 120_000,
  initialDelayMs: 250,
  maximumDelayMs: 30_000,
  jitterRatio: 0.2,
});

export function reconnectDelay(
  attempt: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
  random: () => number = Math.random,
): number {
  validatePolicy(policy);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > policy.maximumAttempts) {
    throw runtimeFailure("terminal_disconnected", "Automatic reconnect attempts are exhausted.");
  }
  const base = Math.min(policy.maximumDelayMs, policy.initialDelayMs * (2 ** (attempt - 1)));
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw runtimeFailure("terminal_protocol_error", "Reconnect jitter produced an invalid value.");
  }
  const jitter = (sample * 2 - 1) * policy.jitterRatio;
  return Math.max(0, Math.round(base * (1 + jitter)));
}

export async function waitForReconnectDelay(input: {
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly policy?: ReconnectPolicy;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
}): Promise<number> {
  const policy = input.policy ?? DEFAULT_RECONNECT_POLICY;
  const delay = reconnectDelay(input.attempt, policy, input.random);
  if (input.elapsedMs + delay > policy.maximumElapsedMs) {
    throw runtimeFailure("terminal_disconnected", "The bounded reconnect window is exhausted.");
  }
  await new Promise<void>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(runtimeFailure("terminal_disconnected", "Reconnect was cancelled."));
      return;
    }
    const timeout = setTimeout(() => { cleanup(); resolve(); }, delay);
    const abort = () => { cleanup(); reject(runtimeFailure("terminal_disconnected", "Reconnect was cancelled.")); };
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
  });
  return delay;
}

function validatePolicy(policy: ReconnectPolicy): void {
  if (
    !Number.isSafeInteger(policy.maximumAttempts) ||
    policy.maximumAttempts < 1 ||
    policy.maximumAttempts > 5 ||
    !Number.isSafeInteger(policy.maximumElapsedMs) ||
    policy.maximumElapsedMs < 1 ||
    policy.maximumElapsedMs > 120_000 ||
    !Number.isSafeInteger(policy.initialDelayMs) ||
    policy.initialDelayMs < 1 ||
    !Number.isSafeInteger(policy.maximumDelayMs) ||
    policy.maximumDelayMs < policy.initialDelayMs ||
    policy.maximumDelayMs > policy.maximumElapsedMs ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 0.5
  ) {
    throw runtimeFailure("terminal_protocol_error", "The reconnect policy is outside supported safety bounds.");
  }
}
