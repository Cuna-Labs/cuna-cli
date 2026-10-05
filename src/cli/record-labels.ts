/**
 * What a person reads for one activity record.
 *
 * The stored kinds predate the Machine/AgentSession split: every `session.*`
 * kind on `/v1/records` is about a Machine (the row's `session_id` is a Machine
 * id), and the database derives its `summary` from the kind alone, so a Machine
 * create was printed "Session started" (BL-3, record 875ad4c2, 2026-09-29). The
 * kind stays as stored data; this map is the one place this CLI turns it into
 * words, and the noun comes from the resource the record names, never from the
 * kind's prefix.
 */
export type RecordResource = "machine" | "agent_session";

const NOUN: Readonly<Record<RecordResource, string>> = Object.freeze({
  machine: "Machine",
  agent_session: "Session",
});

/**
 * Events of the resource the record names; the noun is prepended. Maps, not
 * object literals: the kind is the server's string, and `toString` must not
 * find a label on a prototype.
 */
const RESOURCE_EVENTS: ReadonlyMap<string, string> = new Map(Object.entries({
  "session.reserve": "reservation accepted",
  "session.create": "created",
  "session.error": "provisioning failed",
  "session.pause": "paused",
  "session.resume": "resumed",
  "session.stop": "stopped",
  "session.start": "started",
  "session.delete": "deleted",
  "session.exec": "command completed",
  "session.checkpoint": "checkpoint created",
  "session.reconcile": "state reconciled",
  "session.reservation_recovered": "reservation recovered",
  // What the database stores for any kind outside its allowlist.
  "session.operation": "operation recorded",
  "metering.close": "usage span closed",
  "proxy.request": "route requested",
  "proxy.upgrade": "stream requested",
}));

/** Account-level events: about neither a Machine nor an AgentSession. */
const ACCOUNT_EVENTS: ReadonlyMap<string, string> = new Map(Object.entries({
  "metering.reconcile": "Usage aggregate reconciled",
  "credential.set": "Credential write requested",
  "credential.delete": "Credential deletion requested",
  "credential_rule.create": "Credential rule creation requested",
  "credential_rule.delete": "Credential rule deletion requested",
}));

export function recordLabel(kind: string, resource: RecordResource): string {
  return ACCOUNT_EVENTS.get(kind) ?? `${NOUN[resource]} ${RESOURCE_EVENTS.get(kind) ?? "activity"}`;
}
