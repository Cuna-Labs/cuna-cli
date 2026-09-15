import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

import { assertLoopbackHost, assertPort, isLoopbackPeer, type LoopbackHost } from "./loopback.js";
import {
  SensitiveAuthorityError,
  assertSensitiveAuthority,
  identifier,
  requireConsentOnce,
  validateSensitiveContext,
  type PerOperationConsent,
  type SensitiveOperationContext,
} from "./sensitive-consent.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u;
const METHOD = /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/u;
const MAX_SERVICE_BODY_BYTES = 65_536;

export type LocalServiceBodyEncoding = "canonical_json" | "base64url";

export interface LocalServiceArgs {
  readonly registrationId: string;
  readonly operationId: string;
  readonly bodyEncoding: LocalServiceBodyEncoding;
  readonly body: unknown;
  readonly decodedLength: number;
  readonly bodySha256: `sha256:${string}`;
}

export interface LocalServiceResult {
  readonly outcome: "ok" | "service_error" | "timeout";
  readonly bodyEncoding: LocalServiceBodyEncoding;
  readonly body: unknown;
  readonly decodedLength: number;
  readonly bodySha256: `sha256:${string}`;
}

export interface LocalServiceOperationRegistration {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly requestEncoding: LocalServiceBodyEncoding;
  readonly responseEncoding: LocalServiceBodyEncoding;
  readonly requestContentType: string;
  readonly responseContentType: string;
  readonly requestSchemaId: string;
  readonly responseSchemaId: string;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly timeoutMs: number;
  readonly idempotent: boolean;
}

export interface LocalServiceRegistration {
  readonly registrationId: string;
  readonly host: LoopbackHost;
  readonly port: number;
  readonly maximumConcurrent: number;
  readonly operations: readonly LocalServiceOperationRegistration[];
}

export interface LocalServiceSchemaRegistry {
  validate(schemaId: string, value: unknown): boolean;
}

export interface LocalServiceTransportRequest {
  readonly host: LoopbackHost;
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly maximumResponseBytes: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface LocalServiceTransportResponse {
  readonly statusCode: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
  readonly remoteAddress: string;
  readonly redirected: boolean;
}

export interface LocalServiceTransport {
  request(input: LocalServiceTransportRequest): Promise<LocalServiceTransportResponse>;
}

export interface LocalServiceActionsOptions {
  readonly consent: PerOperationConsent;
  readonly schemas: LocalServiceSchemaRegistry;
  readonly transport: LocalServiceTransport;
}

interface StoredRegistration {
  readonly descriptor: LocalServiceRegistration;
  readonly operations: ReadonlyMap<string, LocalServiceOperationRegistration>;
  readonly controllers: Set<AbortController>;
}

export class LocalServiceActions {
  readonly #options: LocalServiceActionsOptions;
  readonly #registrations = new Map<string, StoredRegistration>();

  constructor(options: LocalServiceActionsOptions) {
    this.#options = options;
  }

  register(registration: LocalServiceRegistration): void {
    const stored = validateAndFreezeRegistration(registration);
    if (this.#registrations.has(stored.descriptor.registrationId)) throw new LocalServiceError("registration_exists");
    this.#registrations.set(stored.descriptor.registrationId, stored);
  }

  revoke(registrationId: string): void {
    const registration = this.#registrations.get(registrationId);
    if (registration === undefined) return;
    this.#registrations.delete(registrationId);
    for (const controller of registration.controllers) controller.abort("registration_revoked");
    registration.controllers.clear();
  }

  dispose(): void {
    for (const id of this.#registrations.keys()) this.revoke(id);
  }

  async request(
    args: LocalServiceArgs,
    context: SensitiveOperationContext,
    signal?: AbortSignal,
  ): Promise<LocalServiceResult> {
    validateSensitiveContext(context);
    if (!identifier(args.registrationId) || !identifier(args.operationId)) throw new LocalServiceError("request_invalid");
    const registration = this.#registrations.get(args.registrationId);
    const operation = registration?.operations.get(args.operationId);
    if (registration === undefined || operation === undefined) throw new LocalServiceError("operation_unregistered");
    if (registration.controllers.size >= registration.descriptor.maximumConcurrent) throw new LocalServiceError("service_busy");
    const prepared = decodeRequestBody(args, operation);
    if (!this.#options.schemas.validate(operation.requestSchemaId, prepared.schemaValue)) {
      throw new LocalServiceError("request_schema_invalid");
    }
    await requireConsentOnce(this.#options.consent, context, {
      action: "local_service.request",
      operationDigest: args.bodySha256,
      summary: `${operation.method} ${operation.path} via ${registration.descriptor.registrationId}`,
    }, signal).catch(normalizeAuthorityError);
    if (this.#registrations.get(args.registrationId) !== registration || registration.operations.get(args.operationId) !== operation) {
      throw new LocalServiceError("registration_changed");
    }
    const revalidated = decodeRequestBody(args, operation);
    if (digest(revalidated.bytes) !== digest(prepared.bytes)) throw new LocalServiceError("request_changed");
    await assertSensitiveAuthority(context, signal).catch(normalizeAuthorityError);

    const controller = new AbortController();
    const detachAbort = forwardAbort(signal, controller);
    registration.controllers.add(controller);
    try {
      let response: LocalServiceTransportResponse;
      try {
        response = await this.#options.transport.request(Object.freeze({
          host: registration.descriptor.host,
          port: registration.descriptor.port,
          method: operation.method,
          path: operation.path,
          contentType: operation.requestContentType,
          body: Buffer.from(revalidated.bytes),
          maximumResponseBytes: operation.maximumResponseBytes,
          timeoutMs: operation.timeoutMs,
          signal: controller.signal,
        }));
      } catch (error) {
        if (controller.signal.aborted || signal?.aborted === true) throw new LocalServiceError("cancelled", { cause: error });
        if (error instanceof LocalServiceTransportError && error.code === "timeout") return emptyTimeoutResult();
        throw new LocalServiceError("service_unavailable", { cause: error });
      }
      await assertSensitiveAuthority(context, signal).catch(normalizeAuthorityError);
      return validateServiceResponse(response, operation, this.#options.schemas);
    } finally {
      detachAbort();
      registration.controllers.delete(controller);
      controller.abort("operation_complete");
    }
  }
}

export function createNodeLoopbackServiceTransport(): LocalServiceTransport {
  return Object.freeze({
    request(input: LocalServiceTransportRequest): Promise<LocalServiceTransportResponse> {
      assertLoopbackHost(input.host, "service host");
      assertPort(input.port, "service port");
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          input.signal.removeEventListener("abort", onAbort);
          callback();
        };
        const request = httpRequest({
          host: input.host,
          port: input.port,
          method: input.method,
          path: input.path,
          agent: false,
          headers: {
            "content-type": input.contentType,
            "content-length": String(input.body.byteLength),
            "connection": "close",
          },
          lookup(_hostname, _options, callback) {
            callback(new LocalServiceTransportError("dns_forbidden"), "", 4);
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          const declaredLength = Number(response.headers["content-length"] ?? "0");
          if (Number.isFinite(declaredLength) && declaredLength > input.maximumResponseBytes) {
            request.destroy(new LocalServiceTransportError("response_too_large"));
            return;
          }
          response.on("data", (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > input.maximumResponseBytes) {
              request.destroy(new LocalServiceTransportError("response_too_large"));
              return;
            }
            chunks.push(bytes);
          });
          response.once("end", () => finish(() => resolve(Object.freeze({
            statusCode: response.statusCode ?? 0,
            contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
            body: Buffer.concat(chunks, total),
            remoteAddress: response.socket.remoteAddress ?? "",
            redirected: false,
          }))));
          response.once("aborted", () => finish(() => reject(new LocalServiceTransportError("response_aborted"))));
          response.once("error", (error) => finish(() => reject(error)));
        });
        const onAbort = (): void => { request.destroy(new LocalServiceTransportError("cancelled")); };
        input.signal.addEventListener("abort", onAbort, { once: true });
        request.setTimeout(input.timeoutMs, () => request.destroy(new LocalServiceTransportError("timeout")));
        request.once("error", (error) => finish(() => reject(error)));
        request.end(input.body);
      });
    },
  });
}

export class LocalServiceError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(`Cuna local service request failed: ${code}.`, options);
    this.name = "LocalServiceError";
  }
}

export class LocalServiceTransportError extends Error {
  constructor(readonly code: string) {
    super(`Cuna loopback transport failed: ${code}.`);
    this.name = "LocalServiceTransportError";
  }
}

function validateAndFreezeRegistration(registration: LocalServiceRegistration): StoredRegistration {
  exactKeys(registration as unknown as Record<string, unknown>, ["registrationId", "host", "port", "maximumConcurrent", "operations"]);
  if (!identifier(registration.registrationId)) throw new LocalServiceError("registration_invalid");
  assertLoopbackHost(registration.host, "service host");
  assertPort(registration.port, "service port");
  if (!boundedInteger(registration.maximumConcurrent, 1, 32) || !Array.isArray(registration.operations) ||
    registration.operations.length < 1 || registration.operations.length > 128) throw new LocalServiceError("registration_invalid");
  const operations = new Map<string, LocalServiceOperationRegistration>();
  const frozen = registration.operations.map((candidate) => {
    exactKeys(candidate as unknown as Record<string, unknown>, [
      "operationId", "method", "path", "requestEncoding", "responseEncoding", "requestContentType", "responseContentType",
      "requestSchemaId", "responseSchemaId", "maximumRequestBytes", "maximumResponseBytes", "timeoutMs", "idempotent",
    ]);
    if (!identifier(candidate.operationId) || !METHOD.test(candidate.method) || !exactPath(candidate.path) ||
      !bodyEncoding(candidate.requestEncoding) || !bodyEncoding(candidate.responseEncoding) ||
      !MEDIA_TYPE.test(candidate.requestContentType) || !MEDIA_TYPE.test(candidate.responseContentType) ||
      !identifier(candidate.requestSchemaId) || !identifier(candidate.responseSchemaId) ||
      !boundedInteger(candidate.maximumRequestBytes, 0, MAX_SERVICE_BODY_BYTES) ||
      !boundedInteger(candidate.maximumResponseBytes, 0, MAX_SERVICE_BODY_BYTES) ||
      !boundedInteger(candidate.timeoutMs, 1, 60_000) || typeof candidate.idempotent !== "boolean" ||
      operations.has(candidate.operationId)) throw new LocalServiceError("operation_invalid");
    const operation = Object.freeze({ ...candidate });
    operations.set(operation.operationId, operation);
    return operation;
  });
  const descriptor = Object.freeze({ ...registration, operations: Object.freeze(frozen) });
  return { descriptor, operations, controllers: new Set() };
}

function decodeRequestBody(
  args: LocalServiceArgs,
  operation: LocalServiceOperationRegistration,
): { readonly bytes: Buffer; readonly schemaValue: unknown } {
  if (args.bodyEncoding !== operation.requestEncoding || !Number.isSafeInteger(args.decodedLength) ||
    args.decodedLength < 0 || args.decodedLength > operation.maximumRequestBytes || !SHA256.test(args.bodySha256)) {
    throw new LocalServiceError("request_integrity_invalid");
  }
  const prepared = encodeBody(args.bodyEncoding, args.body, operation.maximumRequestBytes);
  if (prepared.bytes.byteLength !== args.decodedLength || digest(prepared.bytes) !== args.bodySha256) {
    throw new LocalServiceError("request_integrity_invalid");
  }
  return prepared;
}

function validateServiceResponse(
  response: LocalServiceTransportResponse,
  operation: LocalServiceOperationRegistration,
  schemas: LocalServiceSchemaRegistry,
): LocalServiceResult {
  if (!Number.isSafeInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599 ||
    response.redirected || (response.statusCode >= 300 && response.statusCode < 400)) throw new LocalServiceError("redirect_rejected");
  if (!isLoopbackPeer(response.remoteAddress)) throw new LocalServiceError("response_peer_not_loopback");
  if (response.body.byteLength > operation.maximumResponseBytes) throw new LocalServiceError("response_too_large");
  if (normalizeContentType(response.contentType) !== operation.responseContentType) throw new LocalServiceError("response_content_type_invalid");
  const prepared = decodeResponseBody(operation.responseEncoding, response.body);
  if (!schemas.validate(operation.responseSchemaId, prepared.schemaValue)) throw new LocalServiceError("response_schema_invalid");
  const stable = decodeResponseBody(operation.responseEncoding, response.body);
  return Object.freeze({
    outcome: response.statusCode >= 200 && response.statusCode < 300 ? "ok" : "service_error",
    bodyEncoding: operation.responseEncoding,
    body: stable.body,
    decodedLength: response.body.byteLength,
    bodySha256: digest(response.body),
  });
}

function encodeBody(encoding: LocalServiceBodyEncoding, body: unknown, maximumBytes: number): { readonly bytes: Buffer; readonly schemaValue: unknown } {
  if (encoding === "canonical_json") {
    const canonical = canonicalJson(body);
    const bytes = Buffer.from(canonical, "utf8");
    if (bytes.byteLength > maximumBytes) throw new LocalServiceError("body_too_large");
    return { bytes, schemaValue: body };
  }
  if (typeof body !== "string" || !/^[A-Za-z0-9_-]*$/u.test(body) || body.length > Math.ceil(maximumBytes * 4 / 3) + 2) {
    throw new LocalServiceError("body_encoding_invalid");
  }
  const bytes = Buffer.from(body, "base64url");
  if (bytes.byteLength > maximumBytes || bytes.toString("base64url") !== body) throw new LocalServiceError("body_encoding_invalid");
  return { bytes, schemaValue: bytes };
}

function decodeResponseBody(encoding: LocalServiceBodyEncoding, bytes: Uint8Array): { readonly body: unknown; readonly schemaValue: unknown } {
  if (encoding === "base64url") {
    const copy = Buffer.from(bytes);
    return { body: copy.toString("base64url"), schemaValue: copy };
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new LocalServiceError("response_encoding_invalid"); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new LocalServiceError("response_encoding_invalid"); }
  if (canonicalJson(value) !== text) throw new LocalServiceError("response_not_canonical");
  return { body: value, schemaValue: value };
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LocalServiceError("body_encoding_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new LocalServiceError("body_encoding_invalid");
    seen.add(value);
    const output = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return output;
  }
  if (typeof value !== "object" || value === undefined) throw new LocalServiceError("body_encoding_invalid");
  const record = value as Record<string, unknown>;
  if (seen.has(record) || Object.getPrototypeOf(record) !== Object.prototype) throw new LocalServiceError("body_encoding_invalid");
  seen.add(record);
  const keys = Object.keys(record).sort();
  if (keys.some((key) => record[key] === undefined)) throw new LocalServiceError("body_encoding_invalid");
  const output = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(",")}}`;
  seen.delete(record);
  return output;
}

function emptyTimeoutResult(): LocalServiceResult {
  const bytes = Buffer.alloc(0);
  return Object.freeze({ outcome: "timeout", bodyEncoding: "base64url", body: "", decodedLength: 0, bodySha256: digest(bytes) });
}

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function exactPath(value: string): boolean {
  return value.startsWith("/") && value.length <= 2_048 && !value.includes("\\") && !value.includes("\0") &&
    !value.includes("?") && !value.includes("#") && !value.split("/").some((part, index) => index > 0 && (part === "" || part === "." || part === ".."));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new LocalServiceError("descriptor_not_closed");
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function bodyEncoding(value: string): value is LocalServiceBodyEncoding {
  return value === "canonical_json" || value === "base64url";
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function normalizeAuthorityError(error: unknown): never {
  if (error instanceof SensitiveAuthorityError) throw new LocalServiceError(error.code, { cause: error });
  throw error;
}
