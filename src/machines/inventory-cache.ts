import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { PlatformAdapter } from "../platform/adapter.js";

/**
 * The last Machines list this profile saw, kept only so the next `cuna` can
 * paint something before the network answers (PRD cuna-cli-feel R2). It is a
 * picture, never an authority: the explorer draws it as "last known", accepts
 * no action on it, and replaces it with the live list. Minimal on purpose —
 * names, states and a session count; no session ids, cwd or credentials.
 */
export interface CachedMachine {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  /** Absent when the live session read had not answered or failed. */
  readonly sessionCount?: number;
}

export interface MachineInventorySnapshot {
  readonly savedAt: number;
  readonly machines: readonly CachedMachine[];
}

export interface MachineInventoryCache {
  /** `undefined` for absent, unreadable or malformed bytes; never throws. */
  read(): Promise<MachineInventorySnapshot | undefined>;
  /** Best effort; a failed write only means no picture next time. */
  write(snapshot: MachineInventorySnapshot): Promise<void>;
  clear(): Promise<void>;
}

const DIRECTORY = "machines-cache-v1";
const MAXIMUM_BYTES = 64 * 1024;
const MAXIMUM_MACHINES = 200;

/**
 * One file per (API origin, profile). Signing in or out of the profile clears
 * it, so a picture from one account is not shown under another.
 */
export function machineInventoryCache(
  platform: PlatformAdapter,
  scope: Readonly<{ readonly baseUrl: string; readonly profile: string }>,
): MachineInventoryCache {
  const digest = createHash("sha256").update(`${scope.baseUrl}\0${scope.profile}`, "utf8").digest("hex").slice(0, 32);
  const path = join(platform.paths.stateDirectory, DIRECTORY, `${digest}.json`);
  return Object.freeze({
    async read() {
      try {
        const saved = await platform.readSafeConfig(path, MAXIMUM_BYTES);
        return saved.exists && saved.text !== undefined ? parseMachineInventorySnapshot(saved.text) : undefined;
      } catch {
        return undefined;
      }
    },
    async write(snapshot: MachineInventorySnapshot) {
      if (snapshot.machines.length > MAXIMUM_MACHINES) return;
      try {
        await platform.writeSafeConfig(path, `${JSON.stringify(snapshot)}\n`, MAXIMUM_BYTES);
      } catch {
        // No picture next time; the live list is unaffected.
      }
    },
    async clear() {
      try {
        const metadata = await lstat(path);
        if (metadata.isFile() && !metadata.isSymbolicLink()) await unlink(path);
      } catch {
        // Absent is the goal; anything else leaves a picture that is still only a picture.
      }
    },
  });
}

export function parseMachineInventorySnapshot(text: string): MachineInventorySnapshot | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "machines,savedAt") return undefined;
  if (!Number.isSafeInteger(value.savedAt) || (value.savedAt as number) < 0 || !Array.isArray(value.machines)) return undefined;
  if (value.machines.length > MAXIMUM_MACHINES) return undefined;
  const machines: CachedMachine[] = [];
  for (const candidate of value.machines) {
    if (!isRecord(candidate)) return undefined;
    const keys = Object.keys(candidate).sort().join(",");
    if (keys !== "id,name,state" && keys !== "id,name,sessionCount,state") return undefined;
    const { id, name, state, sessionCount } = candidate;
    if (typeof id !== "string" || id.length < 1 || id.length > 64) return undefined;
    if (typeof name !== "string" || name.length < 1 || name.length > 200) return undefined;
    if (typeof state !== "string" || !/^[a-z_-]{1,32}$/u.test(state)) return undefined;
    if (sessionCount !== undefined && (!Number.isSafeInteger(sessionCount) || (sessionCount as number) < 0 || (sessionCount as number) > 10_000)) return undefined;
    machines.push(Object.freeze({ id, name, state, ...(sessionCount === undefined ? {} : { sessionCount: sessionCount as number }) }));
  }
  return Object.freeze({ savedAt: value.savedAt as number, machines: Object.freeze(machines) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
