import { EXIT_CODES, CunaError } from "../core/errors.js";
import { assertCanonicalUuid, encodeCanonicalUuid } from "../core/validation.js";
import type { HttpTransport } from "../api/http.js";
import {
  WORKSPACE_SYNC_PROTOCOL,
  WORKSPACE_SYNC_LIMITS,
  decodeChangePage,
  decodeChunkContent,
  decodeChunkReceipt,
  decodeCommitReceipt,
  decodeEnvelope,
  decodeManifestReceipt,
  decodeReconcileReceipt,
  decodeWorkspaceSyncSession,
  sha256,
  type WorkspaceSyncBeginRequest,
  type WorkspaceSyncChangePage,
  type WorkspaceSyncChunkReceipt,
  type WorkspaceSyncChunkContent,
  type WorkspaceSyncCommitReceipt,
  type WorkspaceSyncCommitRequest,
  type WorkspaceSyncEnvelope,
  type WorkspaceSyncManifestPageRequest,
  type WorkspaceSyncManifestReceipt,
  type WorkspaceSyncReconcileReceipt,
  type WorkspaceSyncReconcileRequest,
  type WorkspaceSyncSession,
} from "./workspace-sync-protocol.js";

export interface WorkspaceSyncClient {
  begin(workspaceId: string, request: WorkspaceSyncBeginRequest, idempotencyKey: string, signal?: AbortSignal): Promise<WorkspaceSyncEnvelope<WorkspaceSyncSession>>;
  manifest(syncId: string, request: WorkspaceSyncManifestPageRequest, idempotencyKey: string, signal?: AbortSignal): Promise<WorkspaceSyncEnvelope<WorkspaceSyncManifestReceipt>>;
  chunk(syncId: string, digest: string, bytes: Uint8Array, idempotencyKey: string, signal?: AbortSignal): Promise<WorkspaceSyncEnvelope<WorkspaceSyncChunkReceipt>>;
  downloadChunk(syncId: string, digest: string, readerVersion: number, signal?: AbortSignal): Promise<WorkspaceSyncEnvelope<WorkspaceSyncChunkContent>>;
  commit(syncId: string, request: WorkspaceSyncCommitRequest, idempotencyKey: string, signal?: AbortSignal): Promise<WorkspaceSyncEnvelope<WorkspaceSyncCommitReceipt>>;
  changes(syncId: string, options: { readonly cursor?: string; readonly limit?: number; readonly readerVersion: number; readonly signal?: AbortSignal }): Promise<WorkspaceSyncEnvelope<WorkspaceSyncChangePage>>;
  reconcile(workspaceId: string, request: WorkspaceSyncReconcileRequest, idempotencyKey: string, signal?: AbortSignal): Promise<WorkspaceSyncEnvelope<WorkspaceSyncReconcileReceipt>>;
}

export function createWorkspaceSyncClient(transport: HttpTransport): WorkspaceSyncClient {
  const client: WorkspaceSyncClient = {
    async begin(workspaceId, request, idempotencyKey, signal) {
      const safeWorkspace = encodeCanonicalUuid(workspaceId, "workspace ID");
      assertCanonicalUuid(request.workspace_binding_id, "workspace binding ID");
      if (request.workspace_binding_id === workspaceId) throw invalidRequest("workspace_binding_id_domain");
      assertCanonicalUuid(request.machine_id, "machine ID");
      validateIdempotencyKey(idempotencyKey);
      const response = decodeEnvelope(await transport.request({
        method: "POST", path: `/v1/workspaces/${safeWorkspace}/sync-sessions`, body: request,
        idempotencyKey, ...(signal === undefined ? {} : { signal }),
      }), decodeWorkspaceSyncSession);
      if (response.data.workspace_id !== workspaceId || response.data.machine_id !== request.machine_id || response.data.base_generation !== request.base_generation || response.data.exclusion_policy_digest !== request.exclusion_policy_digest || response.selected_protocol !== response.data.selected_protocol || response.selected_protocol < request.protocol.minimum || response.selected_protocol > request.protocol.maximum) {
        throw scopeMismatch();
      }
      return response;
    },
    async manifest(syncId, request, idempotencyKey, signal) {
      const safeSync = encodeCanonicalUuid(syncId, "workspace sync ID");
      validateIdempotencyKey(idempotencyKey);
      const response = decodeEnvelope(await transport.request({
        method: "POST", path: `/v1/workspace-sync/${safeSync}/manifests`, body: request,
        idempotencyKey, ...(signal === undefined ? {} : { signal }),
      }), decodeManifestReceipt);
      if (response.data.sync.id !== syncId || response.data.page_index !== request.page_index || response.selected_protocol !== response.data.sync.selected_protocol) throw scopeMismatch();
      return response;
    },
    async chunk(syncId, digest, bytes, idempotencyKey, signal) {
      const safeSync = encodeCanonicalUuid(syncId, "workspace sync ID");
      validateDigest(digest);
      validateIdempotencyKey(idempotencyKey);
      if (bytes.byteLength > WORKSPACE_SYNC_LIMITS.chunkBytes || sha256(bytes) !== digest) {
        throw new CunaError({
          code: "cuna.workspace_sync.chunk_mismatch",
          message: "The workspace chunk does not match its declared digest and length.",
          exitCode: EXIT_CODES.policy,
        });
      }
      const response = decodeEnvelope(await transport.request({
        method: "PUT", path: `/v1/workspace-sync/${safeSync}/chunks/${digest}`,
        body: bytes, contentType: "application/octet-stream", idempotencyKey,
        ...(signal === undefined ? {} : { signal }),
      }), decodeChunkReceipt);
      if (response.data.digest !== digest || response.data.byte_length !== bytes.byteLength || response.selected_protocol !== response.data.selected_protocol) throw scopeMismatch();
      return response;
    },
    async downloadChunk(syncId, digest, readerVersion, signal) {
      const safeSync = encodeCanonicalUuid(syncId, "workspace sync ID");
      validateDigest(digest);
      if (!Number.isSafeInteger(readerVersion) || readerVersion < 1 || readerVersion > WORKSPACE_SYNC_PROTOCOL.maximum) {
        throw invalidRequest("reader_version");
      }
      const response = decodeEnvelope(await transport.request({
        method: "GET",
        path: `/v1/workspace-sync/${safeSync}/chunks/${digest}`,
        query: { reader_version: String(readerVersion) },
        ...(signal === undefined ? {} : { signal }),
      }), decodeChunkContent);
      if (
        response.data.digest !== digest ||
        response.data.selected_protocol !== response.selected_protocol ||
        response.data.minimum_reader > readerVersion
      ) throw scopeMismatch();
      return response;
    },
    async commit(syncId, request, idempotencyKey, signal) {
      const safeSync = encodeCanonicalUuid(syncId, "workspace sync ID");
      validateIdempotencyKey(idempotencyKey);
      const response = decodeEnvelope(await transport.request({
        method: "POST", path: `/v1/workspace-sync/${safeSync}/commit`, body: request,
        idempotencyKey, ...(signal === undefined ? {} : { signal }),
      }), decodeCommitReceipt);
      if (response.data.manifest_root !== request.manifest_root || response.selected_protocol !== response.data.selected_protocol) throw scopeMismatch();
      return response;
    },
    async changes(syncId, options) {
      const safeSync = encodeCanonicalUuid(syncId, "workspace sync ID");
      if (!Number.isSafeInteger(options.readerVersion) || options.readerVersion < 1) throw invalidRequest("reader_version");
      if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > WORKSPACE_SYNC_LIMITS.changePageEntries)) throw invalidRequest("limit");
      if (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 1_024 || containsAsciiControl(options.cursor))) throw invalidRequest("cursor");
      return decodeEnvelope(await transport.request({
        method: "GET", path: `/v1/workspace-sync/${safeSync}/changes`,
        query: {
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.limit === undefined ? {} : { limit: String(options.limit) }),
          reader_version: String(options.readerVersion),
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }), decodeChangePage);
    },
    async reconcile(workspaceId, request, idempotencyKey, signal) {
      const safeWorkspace = encodeCanonicalUuid(workspaceId, "workspace ID");
      assertCanonicalUuid(request.workspace_binding_id, "workspace binding ID");
      if (request.workspace_binding_id === workspaceId) throw invalidRequest("workspace_binding_id_domain");
      assertCanonicalUuid(request.machine_id, "machine ID");
      validateIdempotencyKey(idempotencyKey);
      const response = decodeEnvelope(await transport.request({
        method: "POST", path: `/v1/workspaces/${safeWorkspace}/reconcile`, body: request,
        idempotencyKey, ...(signal === undefined ? {} : { signal }),
      }), decodeReconcileReceipt);
      if (response.data.exclusion_policy_digest !== request.exclusion_policy_digest || response.selected_protocol < request.protocol.minimum || response.selected_protocol > request.protocol.maximum) throw scopeMismatch();
      return response;
    },
  };
  return Object.freeze(client);
}

function validateIdempotencyKey(value: string): void {
  const length = Buffer.byteLength(value, "utf8");
  if (length < 16 || length > 256 || containsAsciiControl(value)) throw invalidRequest("idempotency_key");
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw invalidRequest("digest");
}

function invalidRequest(reason: string): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.invalid_request",
    message: "The workspace synchronization request is malformed.",
    exitCode: EXIT_CODES.usage,
    details: { reason },
  });
}

function scopeMismatch(): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.scope_mismatch",
    message: "Cuna returned workspace synchronization authority for a different scope.",
    exitCode: EXIT_CODES.policy,
  });
}
