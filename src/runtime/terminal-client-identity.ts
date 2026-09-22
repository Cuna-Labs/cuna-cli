import { createHash, randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSession } from "../api/contracts.js";
import { assertCanonicalUuid } from "../core/validation.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { tryAcquireProcessLock, type ProcessLock } from "../platform/process-lock.js";

/**
 * THE TERMINAL CLIENT THIS COMPUTER IS, PER (PROFILE, AGENTSESSION).
 *
 * WHY. The writer seat is held by a client instance id, and nothing releases
 * it on detach: through migration 0221 the database clears
 * `writer_client_instance_id` only when the attachment becomes
 * `owner_unrecoverable`, and neither the wire nor the HTTP contract has a
 * release. Every CLI process used to mint a fresh `cli:<uuid>`, so a clean
 * detach followed by a re-attach from the same computer met
 * `terminal_writer_held` and had to transfer (R12: epoch 2 -> 3 -> 4).
 * Re-using the id makes that re-attach the SAME client, and the seat resumes.
 *
 * WHY THAT KEEPS ONE WRITER. The database grants a writer to the client that
 * already holds the seat without moving it (0106,
 * `acquire_agent_session_terminal_writer`), and the supervisor, where input
 * reaches the PTY, lets a writer with the same client id and a newer
 * attachment generation REPLACE its own earlier binding and drops the old one
 * (`bind_attachment` in `edge/assets/agent-session-supervisor.py`, infra
 * 9ccb7f8 lines 7753-7862); a different client is refused
 * `attachment.writer_held`. So at the PTY there is never a second writer. The
 * Edge's per-keystroke fence checks only (client id, writer epoch), so it is
 * the supervisor, not the Edge, that separates two connections of one id.
 *
 * WHY THE LOCK. Two processes on this computer must never be the same client
 * at the same time: each would replace the other's binding on every
 * reconnect. The id is used only by the process holding an OS-held lock for
 * that (profile, AgentSession) for the whole attachment; any other process
 * mints a fresh id, as before, and is told so in one line.
 */

/**
 * How long an unused record is kept. The journey stops treating a session as
 * recent after the same 30 days (`journey/api-effects.ts`), and a record older
 * than that belongs to a session nobody here has attached to in that window.
 * It is a garbage bound, not a safety one: the lock, not the age, keeps an id
 * to one process.
 */
export const TERMINAL_CLIENT_RECORD_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;

export const TERMINAL_CLIENT_BUSY_NOTICE =
  "Another Cuna process here is attached to this AgentSession · this one attaches as a new client and may have to take control";

const LOCK_SCOPE = "terminal-client";
const RECORD_MAXIMUM_BYTES = 4_096;
const CLIENT_INSTANCE_ID = /^cli:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface TerminalClientScope {
  readonly platform: Pick<PlatformAdapter, "paths" | "readSafeConfig" | "writeSafeConfig">;
  readonly profile: string;
}

export interface TerminalClientIdentity {
  readonly clientInstanceId: string;
  /** `reused`: the recorded id; `minted`: a new recorded id; `busy`: a new id another process's lock kept unrecorded. */
  readonly source: "reused" | "minted" | "busy";
  /** Present only for `busy`: the one line the person is shown. */
  readonly notice?: string;
  /** The AgentSession is gone: remove its record so the id is never offered again. */
  forget(): Promise<void>;
  /** End the attachment's hold on the id. The record stays for the next attach. */
  release(): Promise<void>;
}

interface TerminalClientRecord {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly agentSessionId: string;
  readonly sessionCreatedAt: string;
  readonly clientInstanceId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

/** A typed terminal state: the session cannot come back, so neither can its seat. */
export function isAgentSessionGone(
  session: Pick<AgentSession, "desiredState" | "requestState" | "processState">,
): boolean {
  return session.desiredState === "terminated" ||
    session.requestState === "terminal" || session.requestState === "failed" ||
    session.processState === "exited" || session.processState === "failed" || session.processState === "terminated";
}

export async function claimTerminalClientIdentity(
  scope: TerminalClientScope,
  session: Pick<AgentSession, "id" | "createdAt">,
  options: {
    readonly now?: () => number;
    readonly mint?: () => string;
    readonly lock?: (key: string) => Promise<ProcessLock | undefined>;
  } = {},
): Promise<TerminalClientIdentity> {
  const now = options.now ?? Date.now;
  const mint = options.mint ?? ((): string => `cli:${randomUUID()}`);
  const agentSessionId = assertCanonicalUuid(session.id, "AgentSession ID");
  const lock = await (options.lock ?? ((key) => tryAcquireProcessLock(LOCK_SCOPE, key)))(lockKey(scope.profile, agentSessionId));
  if (lock === undefined) {
    return Object.freeze({
      clientInstanceId: mint(),
      source: "busy",
      notice: TERMINAL_CLIENT_BUSY_NOTICE,
      forget: async () => undefined,
      release: async () => undefined,
    });
  }
  const path = recordPath(scope, agentSessionId);
  try {
    const recorded = await readRecord(scope, path);
    const stamp = new Date(now()).toISOString();
    const reusable = recorded !== undefined &&
      recorded.profile === scope.profile &&
      recorded.agentSessionId === agentSessionId &&
      recorded.sessionCreatedAt === session.createdAt &&
      now() - Date.parse(recorded.lastUsedAt) <= TERMINAL_CLIENT_RECORD_IDLE_MS;
    const record: TerminalClientRecord = reusable
      ? { ...recorded, lastUsedAt: stamp }
      : {
          schemaVersion: 1,
          profile: scope.profile,
          agentSessionId,
          sessionCreatedAt: session.createdAt,
          clientInstanceId: mint(),
          createdAt: stamp,
          lastUsedAt: stamp,
        };
    await scope.platform.writeSafeConfig(path, `${JSON.stringify(record)}\n`, RECORD_MAXIMUM_BYTES);
    await sweepIdleRecords(scope, agentSessionId, now, options.lock);
    return Object.freeze({
      clientInstanceId: record.clientInstanceId,
      source: reusable ? "reused" : "minted",
      forget: async () => { await removeRecord(path); },
      release: () => lock.release(),
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** Remove a session's record without holding its lock: a gone session has no attachment to protect. */
export async function forgetTerminalClientIdentity(scope: TerminalClientScope, agentSessionId: string): Promise<void> {
  await removeRecord(recordPath(scope, assertCanonicalUuid(agentSessionId, "AgentSession ID")));
}

function lockKey(profile: string, agentSessionId: string): string {
  return `${profile}\0${agentSessionId}`;
}

function profileDirectory(scope: TerminalClientScope): string {
  // A profile name is the person's own text; the directory is its digest.
  const digest = createHash("sha256").update("cuna-terminal-client-profile-v1\0").update(scope.profile).digest("hex");
  return join(scope.platform.paths.stateDirectory, "terminal-clients", digest.slice(0, 32));
}

function recordPath(scope: TerminalClientScope, agentSessionId: string): string {
  return join(profileDirectory(scope), `${agentSessionId}.json`);
}

async function readRecord(scope: TerminalClientScope, path: string): Promise<TerminalClientRecord | undefined> {
  const snapshot = await scope.platform.readSafeConfig(path, RECORD_MAXIMUM_BYTES);
  if (!snapshot.exists || snapshot.text === undefined) return undefined;
  try {
    const value = JSON.parse(snapshot.text) as Partial<TerminalClientRecord>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.profile !== "string" ||
      typeof value.agentSessionId !== "string" ||
      typeof value.sessionCreatedAt !== "string" ||
      typeof value.clientInstanceId !== "string" || !CLIENT_INSTANCE_ID.test(value.clientInstanceId) ||
      typeof value.createdAt !== "string" ||
      typeof value.lastUsedAt !== "string" || !Number.isFinite(Date.parse(value.lastUsedAt))
    ) return undefined;
    return value as TerminalClientRecord;
  } catch {
    // Unreadable bytes name no client; the record is rewritten below.
    return undefined;
  }
}

/**
 * Delete this profile's records unused for longer than the idle bound, each
 * only while its own lock can be taken, so a record an attachment is using is
 * never removed from under it.
 */
async function sweepIdleRecords(
  scope: TerminalClientScope,
  claimedAgentSessionId: string,
  now: () => number,
  lock: ((key: string) => Promise<ProcessLock | undefined>) | undefined,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(profileDirectory(scope));
  } catch {
    return;
  }
  for (const name of names) {
    const agentSessionId = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (agentSessionId === claimedAgentSessionId || !/^[0-9a-f-]{36}$/u.test(agentSessionId)) continue;
    const path = recordPath(scope, agentSessionId);
    let recorded: TerminalClientRecord | undefined;
    try {
      recorded = await readRecord(scope, path);
    } catch {
      continue;
    }
    if (recorded !== undefined && now() - Date.parse(recorded.lastUsedAt) <= TERMINAL_CLIENT_RECORD_IDLE_MS) continue;
    const held = await (lock ?? ((key) => tryAcquireProcessLock(LOCK_SCOPE, key)))(lockKey(scope.profile, agentSessionId));
    if (held === undefined) continue;
    try {
      await removeRecord(path);
    } finally {
      await held.release();
    }
  }
}

async function removeRecord(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
