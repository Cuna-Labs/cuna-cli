import { createHash } from "node:crypto";

export const OUTPUT_RETENTION_MS = 30_000;
export const MAX_REPLAY_BYTES = 1024 * 1024;
export const MAX_REPLAY_FRAMES = 4096;
export const MAX_TRACKED_INPUTS = 4096;

export interface AttachmentIdentity {
  readonly userId: string;
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string;
}

export interface AttachmentGrant extends AttachmentIdentity {
  readonly ownerClientId: string;
  readonly fencingGeneration: number;
}

export interface OutputRecord {
  readonly sequence: bigint;
  readonly observedAt: number;
  readonly payload: Uint8Array;
}

export interface ResumeResult {
  readonly attachmentRestored: boolean;
  readonly processSurvived: boolean;
  readonly outputContinuous: boolean;
  readonly earliestSequence: bigint | null;
  readonly fencingGeneration: number | null;
  readonly frames: readonly OutputRecord[];
  readonly classification: "resumed" | "discontinuous" | "terminated";
}

export interface InputAcceptance {
  readonly clientSequence: bigint;
  readonly duplicate: boolean;
  readonly acknowledgement: "durably_accepted_not_executed";
  readonly execution: "unknown";
}

export class AttachmentError extends Error {
  readonly code:
    | "attachment_conflict"
    | "stale_fence"
    | "sequence_conflict"
    | "sequence_regression"
    | "process_discontinuity"
    | "terminated"
    | "oversize_output";

  constructor(code: AttachmentError["code"], message: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

type AttachmentState = "detached" | "attached" | "terminated";

export class ExclusiveAttachmentSession {
  readonly identity: AttachmentIdentity;
  readonly #clock: () => number;
  #state: AttachmentState = "detached";
  #ownerClientId: string | undefined;
  #generation = 0;
  #outputSequence = 0n;
  #replayBytes = 0;
  #output: OutputRecord[] = [];
  readonly #inputs = new Map<bigint, string>();

  constructor(identity: AttachmentIdentity, clock: () => number = Date.now) {
    assertIdentity(identity);
    this.identity = Object.freeze({ ...identity });
    this.#clock = clock;
  }

  attach(ownerClientId: string): AttachmentGrant {
    this.#assertNotTerminated();
    assertIdentifier(ownerClientId);
    if (this.#state === "attached") {
      throw new AttachmentError("attachment_conflict", "The exclusive terminal session is already attached.");
    }
    this.#generation += 1;
    this.#ownerClientId = ownerClientId;
    this.#state = "attached";
    return this.#grant();
  }

  takeover(ownerClientId: string, ownerAuthorized: boolean): AttachmentGrant {
    this.#assertNotTerminated();
    if (!ownerAuthorized) throw new AttachmentError("attachment_conflict", "Terminal takeover was not owner-authorized.");
    assertIdentifier(ownerClientId);
    this.#generation += 1;
    this.#ownerClientId = ownerClientId;
    this.#state = "attached";
    return this.#grant();
  }

  detach(grant: AttachmentGrant): void {
    this.assertFence(grant);
    this.#state = "detached";
    this.#ownerClientId = undefined;
  }

  terminate(): void {
    this.#state = "terminated";
    this.#ownerClientId = undefined;
    this.#output = [];
    this.#replayBytes = 0;
    this.#inputs.clear();
  }

  assertFence(grant: AttachmentGrant): void {
    if (
      this.#state !== "attached" ||
      grant.fencingGeneration !== this.#generation ||
      grant.ownerClientId !== this.#ownerClientId ||
      !sameIdentity(grant, this.identity)
    ) {
      throw new AttachmentError("stale_fence", "The attachment fence is stale or targets another AgentSession generation.");
    }
  }

  acceptInput(grant: AttachmentGrant, clientSequence: bigint, payload: Uint8Array): InputAcceptance {
    this.assertFence(grant);
    if (clientSequence < 1n) throw new AttachmentError("sequence_regression", "Input sequence numbers start at one.");
    const digest = createHash("sha256").update(payload).digest("hex");
    const previous = this.#inputs.get(clientSequence);
    if (previous !== undefined) {
      if (previous !== digest) {
        throw new AttachmentError("sequence_conflict", "An input sequence was reused for different bytes.");
      }
      return acceptance(clientSequence, true);
    }
    const greatest = [...this.#inputs.keys()].at(-1);
    if (greatest !== undefined && clientSequence <= greatest) {
      throw new AttachmentError("sequence_regression", "A new input sequence must be strictly monotonic.");
    }
    this.#inputs.set(clientSequence, digest);
    if (this.#inputs.size > MAX_TRACKED_INPUTS) {
      const oldest = this.#inputs.keys().next().value as bigint | undefined;
      if (oldest !== undefined) this.#inputs.delete(oldest);
    }
    return acceptance(clientSequence, false);
  }

  appendOutput(payload: Uint8Array, observedAt: number = this.#clock()): OutputRecord {
    this.#assertNotTerminated();
    if (payload.byteLength > MAX_REPLAY_BYTES) {
      throw new AttachmentError("oversize_output", "One output frame exceeds the complete-frame replay limit.");
    }
    this.#outputSequence += 1n;
    const record: OutputRecord = Object.freeze({
      sequence: this.#outputSequence,
      observedAt,
      payload: payload.slice(),
    });
    this.#output.push(record);
    this.#replayBytes += record.payload.byteLength;
    this.#evict(observedAt);
    return record;
  }

  resume(input: {
    readonly ownerClientId: string;
    readonly processEpoch: string;
    readonly processAlive: boolean;
    readonly afterOutputSequence: bigint;
    readonly ownerAuthorizedTakeover?: boolean;
  }): ResumeResult {
    if (this.#state === "terminated") {
      return result(false, false, false, null, null, [], "terminated");
    }
    this.#evict(this.#clock());
    if (!input.processAlive || input.processEpoch !== this.identity.processEpoch) {
      return result(false, false, false, this.#output[0]?.sequence ?? null, null, [], "discontinuous");
    }
    const grant = this.#state === "attached"
      ? this.takeover(input.ownerClientId, input.ownerAuthorizedTakeover === true)
      : this.attach(input.ownerClientId);
    const earliestSequence = this.#output[0]?.sequence ?? null;
    const outputContinuous = earliestSequence === null || input.afterOutputSequence + 1n >= earliestSequence;
    const frames = this.#output.filter((frame) => frame.sequence > input.afterOutputSequence);
    return result(true, true, outputContinuous, earliestSequence, grant.fencingGeneration, frames, "resumed");
  }

  #evict(now: number): void {
    while (this.#output.length > 0) {
      const oldest = this.#output[0];
      if (oldest === undefined) break;
      if (
        this.#replayBytes <= MAX_REPLAY_BYTES &&
        this.#output.length <= MAX_REPLAY_FRAMES &&
        now - oldest.observedAt <= OUTPUT_RETENTION_MS
      ) break;
      this.#output.shift();
      this.#replayBytes -= oldest.payload.byteLength;
    }
  }

  #grant(): AttachmentGrant {
    return Object.freeze({
      ...this.identity,
      ownerClientId: this.#ownerClientId!,
      fencingGeneration: this.#generation,
    });
  }

  #assertNotTerminated(): void {
    if (this.#state === "terminated") throw new AttachmentError("terminated", "The terminal session is terminated.");
  }
}

function result(
  attachmentRestored: boolean,
  processSurvived: boolean,
  outputContinuous: boolean,
  earliestSequence: bigint | null,
  fencingGeneration: number | null,
  frames: readonly OutputRecord[],
  classification: ResumeResult["classification"],
): ResumeResult {
  return Object.freeze({
    attachmentRestored,
    processSurvived,
    outputContinuous,
    earliestSequence,
    fencingGeneration,
    frames: Object.freeze([...frames]),
    classification,
  });
}

function acceptance(clientSequence: bigint, duplicate: boolean): InputAcceptance {
  return Object.freeze({
    clientSequence,
    duplicate,
    acknowledgement: "durably_accepted_not_executed",
    execution: "unknown",
  });
}

function sameIdentity(left: AttachmentIdentity, right: AttachmentIdentity): boolean {
  return (
    left.userId === right.userId &&
    left.machineId === right.machineId &&
    left.agentSessionId === right.agentSessionId &&
    left.processEpoch === right.processEpoch
  );
}

function assertIdentity(identity: AttachmentIdentity): void {
  for (const value of [identity.userId, identity.machineId, identity.agentSessionId, identity.processEpoch]) assertIdentifier(value);
}

function assertIdentifier(value: string): void {
  if (value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new AttachmentError("process_discontinuity", "The attachment identity is invalid.");
  }
}
