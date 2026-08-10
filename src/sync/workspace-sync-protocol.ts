import { createHash } from "node:crypto";

import { EXIT_CODES, RunaError } from "../core/errors.js";
import { isObject } from "../core/validation.js";
import type { ManifestEntry, WorkspaceManifest } from "../workspace/manifest.js";

export const WORKSPACE_SYNC_PROTOCOL = Object.freeze({ minimum: 1, maximum: 2 });
export const WORKSPACE_SYNC_CAPABILITIES = Object.freeze([
  "atomic_generation_commit",
  "bounded_manifest_pages",
  "content_digest_verification",
  "explicit_reconciliation",
  "ordered_generation_changes",
  "policy_bound_admission",
] as const);
export const WORKSPACE_SYNC_LIMITS = Object.freeze({
  manifestPageBytes: 4 * 1024 * 1024,
  manifestPageEntries: 4_096,
  manifestPages: 256,
  chunkBytes: 8 * 1024 * 1024,
  concurrentChunkUploads: 8,
  changePageEntries: 1_000,
});

export interface WorkspaceSyncBeginRequest {
  readonly workspace_binding_id: string;
  readonly machine_id: string;
  readonly base_generation: number;
  readonly exclusion_policy_digest: string;
  readonly protocol: Readonly<{ readonly minimum: number; readonly maximum: number }>;
  readonly minimum_reader: number;
  readonly minimum_writer: number;
}

export interface WorkspaceSyncManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly byte_length: number;
  readonly executable: boolean;
  readonly chunks: readonly Readonly<{ readonly digest: string; readonly byte_length: number }>[];
  readonly link_target: string | null;
}

export interface WorkspaceSyncManifestPageRequest {
  readonly page_index: number;
  readonly is_last: boolean;
  readonly minimum_reader: number;
  readonly minimum_writer: number;
  readonly entries: readonly WorkspaceSyncManifestEntry[];
}

export interface WorkspaceSyncCommitRequest {
  readonly expected_generation: number;
  readonly exclusion_policy_digest: string;
  readonly manifest_root: string;
  readonly minimum_reader: number;
  readonly minimum_writer: number;
}

export interface WorkspaceSyncReconcileRequest {
  readonly workspace_binding_id: string;
  readonly machine_id: string;
  readonly observed_generation: number;
  readonly exclusion_policy_digest: string;
  readonly manifest_root: string;
  readonly protocol: Readonly<{ readonly minimum: number; readonly maximum: number }>;
}

export interface WorkspaceSyncSession {
  readonly id: string;
  readonly workspace_id: string;
  readonly machine_id: string;
  readonly base_generation: number;
  readonly exclusion_policy_digest: string;
  readonly selected_protocol: 1 | 2;
  readonly state: "staging" | "committed" | "conflicted" | "expired";
  readonly last_page_index?: number;
  readonly committed_generation?: number;
  readonly committed_manifest_root?: string;
  readonly expires_at: string;
}

export interface WorkspaceSyncManifestReceipt {
  readonly sync: WorkspaceSyncSession;
  readonly page_index: number;
  readonly page_digest: string;
  readonly missing_digests: readonly string[];
}

export interface WorkspaceSyncChunkReceipt {
  readonly selected_protocol: 1 | 2;
  readonly digest: string;
  readonly byte_length: number;
  readonly stored: boolean;
}

export interface WorkspaceSyncChunkContent {
  readonly selected_protocol: 1 | 2;
  readonly digest: string;
  readonly byte_length: number;
  readonly minimum_reader: number;
  readonly content_base64: string;
}

export interface WorkspaceSyncCommitReceipt {
  readonly selected_protocol: 1 | 2;
  readonly state: "committed";
  readonly generation: number;
  readonly manifest_root: string;
  readonly committed_at: string;
  readonly minimum_reader: number;
  readonly minimum_writer: number;
}

export interface WorkspaceSyncChangeItem {
  readonly generation: number;
  readonly operation: "revision" | "upsert" | "delete";
  readonly path: string | null;
  readonly entry: WorkspaceSyncManifestEntry | null;
  readonly manifest_root: string;
  readonly exclusion_policy_digest: string;
  readonly committed_at: string;
  readonly minimum_reader: number;
  readonly minimum_writer: number;
}

export interface WorkspaceSyncChangePage {
  readonly selected_protocol: 1 | 2;
  readonly items: readonly WorkspaceSyncChangeItem[];
  readonly next_cursor: string | null;
}

export interface WorkspaceSyncReconcileReceipt {
  readonly selected_protocol: 1 | 2;
  readonly status: "converged" | "reconciliation_required";
  readonly active_generation: number;
  readonly active_manifest_root: string;
  readonly exclusion_policy_digest: string;
}

export interface WorkspaceSyncEnvelope<T> {
  readonly request_id: string;
  readonly selected_protocol: 1 | 2;
  readonly capabilities: typeof WORKSPACE_SYNC_CAPABILITIES;
  readonly data: T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export function manifestEntryForPublicProtocol(entry: ManifestEntry): WorkspaceSyncManifestEntry {
  return Object.freeze({
    path: assertWirePath(entry.path),
    kind: entry.kind,
    byte_length: entry.kind === "symlink" ? 0 : entry.byteLength,
    executable: entry.executable,
    chunks: Object.freeze((entry.chunks ?? []).map((chunk) => Object.freeze({
      digest: assertDigest(chunk.digest, "manifest chunk digest"),
      byte_length: boundedInteger(chunk.byteLength, 0, WORKSPACE_SYNC_LIMITS.chunkBytes, "chunk length"),
    }))),
    link_target: entry.linkTarget ?? null,
  });
}

export function paginateWorkspaceManifest(
  manifest: WorkspaceManifest,
  maximumEntries = WORKSPACE_SYNC_LIMITS.manifestPageEntries,
): readonly WorkspaceSyncManifestPageRequest[] {
  return Object.freeze([...iterateWorkspaceManifestPages(manifest, maximumEntries)]);
}

export function* iterateWorkspaceManifestPages(
  manifest: WorkspaceManifest,
  maximumEntries = WORKSPACE_SYNC_LIMITS.manifestPageEntries,
): Generator<WorkspaceSyncManifestPageRequest> {
  boundedInteger(maximumEntries, 1, WORKSPACE_SYNC_LIMITS.manifestPageEntries, "manifest page limit");
  if (manifest.entries.length === 0) {
    yield Object.freeze({ page_index: 0, is_last: true, minimum_reader: 1, minimum_writer: 1, entries: Object.freeze([]) });
    return;
  }
  let pageIndex = 0;
  let buffered: WorkspaceSyncManifestEntry[] = [];
  for (const entry of manifest.entries) {
    const candidate = manifestEntryForPublicProtocol(entry);
    const next = [...buffered, candidate];
    if (next.length > maximumEntries || encodedManifestPageBytes(pageIndex, false, next) > WORKSPACE_SYNC_LIMITS.manifestPageBytes) {
      if (buffered.length === 0) throw protocolFailure("manifest_entry_too_large");
      if (pageIndex >= WORKSPACE_SYNC_LIMITS.manifestPages) throw protocolFailure("too_many_manifest_pages");
      yield freezeManifestPage(pageIndex, false, buffered);
      pageIndex += 1;
      buffered = [candidate];
      if (encodedManifestPageBytes(pageIndex, true, buffered) > WORKSPACE_SYNC_LIMITS.manifestPageBytes) throw protocolFailure("manifest_entry_too_large");
    } else {
      buffered = next;
    }
  }
  if (pageIndex >= WORKSPACE_SYNC_LIMITS.manifestPages) throw protocolFailure("too_many_manifest_pages");
  yield freezeManifestPage(pageIndex, true, buffered);
}

function freezeManifestPage(
  pageIndex: number,
  isLast: boolean,
  entries: readonly WorkspaceSyncManifestEntry[],
): WorkspaceSyncManifestPageRequest {
  return Object.freeze({
    page_index: pageIndex,
    is_last: isLast,
    minimum_reader: 1,
    minimum_writer: 1,
    entries: Object.freeze([...entries]),
  });
}

function encodedManifestPageBytes(
  pageIndex: number,
  isLast: boolean,
  entries: readonly WorkspaceSyncManifestEntry[],
): number {
  return Buffer.byteLength(JSON.stringify({
    page_index: pageIndex,
    is_last: isLast,
    minimum_reader: 1,
    minimum_writer: 1,
    entries,
  }), "utf8");
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeWorkspaceSyncSession(value: unknown): WorkspaceSyncSession {
  const source = exactObject(value, [
    "id", "workspace_id", "machine_id", "base_generation", "exclusion_policy_digest",
    "selected_protocol", "capabilities", "state", "manifest_entry_count", "manifest_encoded_bytes",
    "content_bytes", "last_page_index", "committed_generation", "committed_manifest_root",
    "expires_at", "created_at", "updated_at",
  ]);
  const result: WorkspaceSyncSession = Object.freeze({
    id: uuid(source.id, "sync ID"),
    workspace_id: uuid(source.workspace_id, "workspace ID"),
    machine_id: uuid(source.machine_id, "machine ID"),
    base_generation: nonnegative(source.base_generation, "base generation"),
    exclusion_policy_digest: assertDigest(source.exclusion_policy_digest, "policy digest"),
    selected_protocol: protocol(source.selected_protocol),
    state: enumValue(source.state, ["staging", "committed", "conflicted", "expired"] as const, "sync state"),
    ...(source.last_page_index === undefined ? {} : { last_page_index: nonnegative(source.last_page_index, "last page") }),
    ...(source.committed_generation === undefined ? {} : { committed_generation: positive(source.committed_generation, "committed generation") }),
    ...(source.committed_manifest_root === undefined ? {} : { committed_manifest_root: assertDigest(source.committed_manifest_root, "committed root") }),
    expires_at: dateTime(source.expires_at, "expiry"),
  });
  capabilities(source.capabilities);
  nonnegative(source.manifest_entry_count, "manifest entry count");
  nonnegative(source.manifest_encoded_bytes, "manifest encoded bytes");
  nonnegative(source.content_bytes, "content bytes");
  dateTime(source.created_at, "created time");
  dateTime(source.updated_at, "updated time");
  return result;
}

export function decodeManifestReceipt(value: unknown): WorkspaceSyncManifestReceipt {
  const source = exactObject(value, ["sync", "page_index", "page_digest", "missing_digests"]);
  if (!Array.isArray(source.missing_digests) || source.missing_digests.length > 1_000_000) throw protocolFailure("malformed_missing_digests");
  return Object.freeze({
    sync: decodeWorkspaceSyncSession(source.sync),
    page_index: nonnegative(source.page_index, "page index"),
    page_digest: assertDigest(source.page_digest, "page digest"),
    missing_digests: Object.freeze(source.missing_digests.map((item) => assertDigest(item, "missing digest"))),
  });
}

export function decodeChunkReceipt(value: unknown): WorkspaceSyncChunkReceipt {
  const source = exactObject(value, ["selected_protocol", "digest", "byte_length", "stored"]);
  if (typeof source.stored !== "boolean") throw protocolFailure("malformed_chunk_receipt");
  return Object.freeze({
    selected_protocol: protocol(source.selected_protocol),
    digest: assertDigest(source.digest, "chunk digest"),
    byte_length: boundedInteger(source.byte_length, 0, WORKSPACE_SYNC_LIMITS.chunkBytes, "chunk length"),
    stored: source.stored,
  });
}

export function decodeChunkContent(value: unknown): WorkspaceSyncChunkContent {
  const source = exactObject(value, [
    "selected_protocol", "digest", "byte_length", "minimum_reader", "content_base64",
  ]);
  if (
    typeof source.content_base64 !== "string" ||
    source.content_base64.length > 11_184_812 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.content_base64)
  ) throw protocolFailure("malformed_chunk_content");
  const bytes = Buffer.from(source.content_base64, "base64");
  const byteLength = boundedInteger(source.byte_length, 0, WORKSPACE_SYNC_LIMITS.chunkBytes, "chunk length");
  const digest = assertDigest(source.digest, "chunk digest");
  if (
    bytes.byteLength !== byteLength ||
    bytes.toString("base64") !== source.content_base64 ||
    sha256(bytes) !== digest
  ) throw protocolFailure("chunk_content_mismatch");
  return Object.freeze({
    selected_protocol: protocol(source.selected_protocol),
    digest,
    byte_length: byteLength,
    minimum_reader: boundedInteger(source.minimum_reader, 1, WORKSPACE_SYNC_PROTOCOL.maximum, "minimum reader"),
    content_base64: source.content_base64,
  });
}

export function decodeCommitReceipt(value: unknown): WorkspaceSyncCommitReceipt {
  const source = exactObject(value, ["selected_protocol", "state", "generation", "manifest_root", "committed_at", "minimum_reader", "minimum_writer"]);
  if (source.state !== "committed") throw protocolFailure("malformed_commit_receipt");
  return Object.freeze({
    selected_protocol: protocol(source.selected_protocol),
    state: "committed",
    generation: positive(source.generation, "generation"),
    manifest_root: assertDigest(source.manifest_root, "manifest root"),
    committed_at: dateTime(source.committed_at, "committed time"),
    minimum_reader: positive(source.minimum_reader, "minimum reader"),
    minimum_writer: positive(source.minimum_writer, "minimum writer"),
  });
}

export function decodeChangePage(value: unknown): WorkspaceSyncChangePage {
  const source = exactObject(value, ["selected_protocol", "items", "next_cursor"]);
  if (!Array.isArray(source.items) || source.items.length > WORKSPACE_SYNC_LIMITS.changePageEntries) throw protocolFailure("malformed_change_page");
  if (source.next_cursor !== null && (typeof source.next_cursor !== "string" || source.next_cursor.length > 1_024)) throw protocolFailure("malformed_change_cursor");
  return Object.freeze({
    selected_protocol: protocol(source.selected_protocol),
    items: Object.freeze(source.items.map(decodeChangeItem)),
    next_cursor: source.next_cursor,
  });
}

export function decodeReconcileReceipt(value: unknown): WorkspaceSyncReconcileReceipt {
  const source = exactObject(value, ["selected_protocol", "status", "active_generation", "active_manifest_root", "exclusion_policy_digest"]);
  return Object.freeze({
    selected_protocol: protocol(source.selected_protocol),
    status: enumValue(source.status, ["converged", "reconciliation_required"] as const, "reconcile status"),
    active_generation: nonnegative(source.active_generation, "active generation"),
    active_manifest_root: assertDigest(source.active_manifest_root, "active manifest root"),
    exclusion_policy_digest: assertDigest(source.exclusion_policy_digest, "policy digest"),
  });
}

export function decodeEnvelope<T>(value: unknown, decoder: (data: unknown) => T): WorkspaceSyncEnvelope<T> {
  const source = exactObject(value, ["request_id", "selected_protocol", "capabilities", "data"]);
  return Object.freeze({
    request_id: uuid(source.request_id, "request ID"),
    selected_protocol: protocol(source.selected_protocol),
    capabilities: capabilities(source.capabilities),
    data: decoder(source.data),
  });
}

function decodeChangeItem(value: unknown): WorkspaceSyncChangeItem {
  const source = exactObject(value, ["generation", "operation", "path", "entry", "manifest_root", "exclusion_policy_digest", "committed_at", "minimum_reader", "minimum_writer"]);
  const operation = enumValue(source.operation, ["revision", "upsert", "delete"] as const, "change operation");
  const path = source.path === null ? null : assertWirePath(source.path);
  const entry = source.entry === null ? null : decodeManifestEntry(source.entry);
  if ((operation === "revision" && (path !== null || entry !== null)) || (operation === "delete" && (path === null || entry !== null)) || (operation === "upsert" && (path === null || entry === null))) {
    throw protocolFailure("malformed_change_shape");
  }
  if (entry !== null && entry.path !== path) throw protocolFailure("change_path_mismatch");
  const minimumReader = positive(source.minimum_reader, "minimum reader");
  const minimumWriter = positive(source.minimum_writer, "minimum writer");
  if (minimumReader > WORKSPACE_SYNC_PROTOCOL.maximum) throw protocolFailure("reader_version_incompatible");
  return Object.freeze({
    generation: positive(source.generation, "change generation"), operation, path, entry,
    manifest_root: assertDigest(source.manifest_root, "change manifest root"),
    exclusion_policy_digest: assertDigest(source.exclusion_policy_digest, "policy digest"),
    committed_at: dateTime(source.committed_at, "committed time"),
    minimum_reader: minimumReader,
    minimum_writer: minimumWriter,
  });
}

function decodeManifestEntry(value: unknown): WorkspaceSyncManifestEntry {
  const source = exactObject(value, ["path", "kind", "byte_length", "executable", "chunks", "link_target"]);
  if (!Array.isArray(source.chunks) || typeof source.executable !== "boolean") throw protocolFailure("malformed_manifest_entry");
  const kind = enumValue(source.kind, ["directory", "file", "symlink"] as const, "entry kind");
  const chunks = Object.freeze(source.chunks.map((item) => {
    const chunk = exactObject(item, ["digest", "byte_length"]);
    return Object.freeze({ digest: assertDigest(chunk.digest, "chunk digest"), byte_length: boundedInteger(chunk.byte_length, 0, WORKSPACE_SYNC_LIMITS.chunkBytes, "chunk length") });
  }));
  if (source.link_target !== null && typeof source.link_target !== "string") throw protocolFailure("malformed_link_target");
  const byteLength = nonnegative(source.byte_length, "entry length");
  if (
    (kind === "directory" && (byteLength !== 0 || source.executable || chunks.length !== 0 || source.link_target !== null)) ||
    (kind === "symlink" && (byteLength !== 0 || source.executable || chunks.length !== 0 || source.link_target === null)) ||
    (kind === "file" && (source.link_target !== null || chunks.length === 0 || chunks.reduce((total, chunk) => total + chunk.byte_length, 0) !== byteLength))
  ) {
    throw protocolFailure("malformed_manifest_entry_shape");
  }
  if (kind === "symlink" && source.link_target !== null) assertSafeLinkTarget(source.path, source.link_target);
  return Object.freeze({
    path: assertWirePath(source.path), kind,
    byte_length: byteLength, executable: source.executable,
    chunks, link_target: source.link_target,
  });
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(value, key) && !["last_page_index", "committed_generation", "committed_manifest_root"].includes(key))) {
    throw protocolFailure("malformed_response");
  }
  return value;
}

function capabilities(value: unknown): typeof WORKSPACE_SYNC_CAPABILITIES {
  if (!Array.isArray(value) || value.length !== WORKSPACE_SYNC_CAPABILITIES.length || value.some((item, index) => item !== WORKSPACE_SYNC_CAPABILITIES[index])) throw protocolFailure("capability_vector_mismatch");
  return WORKSPACE_SYNC_CAPABILITIES;
}

function protocol(value: unknown): 1 | 2 {
  if (value !== 1 && value !== 2) throw protocolFailure("protocol_mismatch");
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw protocolFailure(`malformed_${label.replaceAll(" ", "_")}`);
  return value;
}

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw protocolFailure(`malformed_${label.replaceAll(" ", "_")}`);
  return value;
}

function assertWirePath(value: unknown): string {
  if (typeof value !== "string") throw protocolFailure("malformed_workspace_path");
  const components = value.split("/");
  const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  if (value.length < 1 || value.normalize("NFC") !== value || Buffer.byteLength(value, "utf8") > 4_096 || value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || /^[A-Za-z]:/u.test(value) || containsAsciiControl(value) || components.length > 256 || components.some((part) => part === "" || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") || Buffer.byteLength(part, "utf8") > 255 || windowsDevice.test(part))) {
    throw protocolFailure("malformed_workspace_path");
  }
  return value;
}

function assertSafeLinkTarget(path: unknown, target: string): void {
  const wirePath = assertWirePath(path);
  if (target.length === 0 || target.normalize("NFC") !== target || target.startsWith("/") || target.startsWith("\\") || target.includes("\\") || /^[A-Za-z]:/u.test(target) || containsAsciiControl(target) || Buffer.byteLength(target, "utf8") > 4_096) throw protocolFailure("malformed_link_target");
  const base = wirePath.split("/").slice(0, -1);
  for (const component of target.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (base.length === 0) throw protocolFailure("malformed_link_target");
      base.pop();
    } else {
      base.push(component);
    }
  }
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function positive(value: unknown, label: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label);
}

function nonnegative(value: unknown, label: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw protocolFailure(`malformed_${label.replaceAll(" ", "_")}`);
  return value;
}

function dateTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw protocolFailure(`malformed_${label.replaceAll(" ", "_")}`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw protocolFailure(`malformed_${label.replaceAll(" ", "_")}`);
  return value as T;
}

function protocolFailure(reason: string): RunaError {
  return new RunaError({
    code: "runa.workspace_sync.contract_mismatch",
    message: "Cuna returned workspace synchronization data that does not match the public contract.",
    exitCode: EXIT_CODES.remote,
    details: { reason },
  });
}
