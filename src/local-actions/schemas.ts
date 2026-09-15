import { createHash } from "node:crypto";

import { admitProviderAuthUrl } from "./browser-action.js";
import type { LocalActionArgument, LocalActionRequest, LocalActionResult, LocalActionSafeReason } from "./contracts.js";

const LOCAL_ACTION_SAFE_REASONS: ReadonlySet<string> = new Set([
  "unsupported",
  "denied_by_policy",
  "denied_by_user",
  "stale_identity",
  "cancelled_by_foreground",
  "foreground_stopped",
  "terminal_detached",
  "terminal_binding_changed",
  "user_interrupt",
  "execution_timeout",
  "request_expired",
  "adapter_failed",
  "browser_open_failed",
  "rate_limited",
  "local_client_unavailable",
  "outcome_unknown_nonretryable",
]);

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const EDITORS = new Set(["vscode", "cursor", "windsurf", "zed", "jetbrains-gateway"]);

export function validateLocalActionArguments(request: LocalActionRequest): void {
  const args = request.arguments;
  if (workspaceScoped(request.kind) &&
    (request.identity.workspaceBindingId === null || request.identity.workspaceBindingGeneration === null)) invalid();
  switch (request.kind) {
    case "browser.open":
      exactKeys(args, ["url"]);
      if (request.provider === "opencode") invalid();
      if (typeof args.url !== "string" || admitProviderAuthUrl(request.provider, args.url) === undefined) invalid();
      return;
    case "auth.device.present":
      if (request.provider === "codex") {
        exactKeys(args, ["verificationUri", "userCode"]);
        if (typeof args.verificationUri !== "string" ||
          admitProviderAuthUrl("codex", args.verificationUri) === undefined || !boundedString(args.userCode, 256)) invalid();
        return;
      }
      invalid();
      return;
    case "auth.callback.relay":
      exactKeys(args, ["provider", "localPath", "expectedStateDigest", "expectedNonceDigest", "exactLocalPort", "remoteLoopbackPort", "deadlineMs"]);
      if (args.provider !== "codex" || args.provider !== request.provider ||
        !exactPath(args.localPath) || !digest(args.expectedStateDigest) || !digest(args.expectedNonceDigest) ||
        !port(args.exactLocalPort, false) || !port(args.remoteLoopbackPort, false) || !deadline(args.deadlineMs, request)) invalid();
      return;
    case "auth.result.observe":
      exactKeys(args, []);
      return;
    case "clipboard.write":
      exactKeys(args, ["text"]);
      if (!boundedString(args.text, 65_536)) invalid();
      return;
    case "port.forward":
      exactKeys(args, ["remoteHost", "remotePort", "requestedLocalPort", "purpose", "deadlineMs"]);
      if ((args.remoteHost !== "127.0.0.1" && args.remoteHost !== "::1") || !port(args.remotePort, false) ||
        !port(args.requestedLocalPort, true) || !["preview", "provider_callback", "registered_service"].includes(String(args.purpose)) ||
        !deadline(args.deadlineMs, request)) invalid();
      return;
    case "file.select":
      exactKeys(args, ["purpose", "accept", "multiple", "maximumFiles", "maximumTotalBytes"]);
      if ((args.purpose !== "attachment" && args.purpose !== "workspace_import") || typeof args.multiple !== "boolean" ||
        !acceptFilters(args.accept) || !boundedInteger(args.maximumFiles, 1, 1_000) ||
        !boundedInteger(args.maximumTotalBytes, 1, 1_073_741_824)) invalid();
      return;
    case "attachment.import":
      exactKeys(args, ["opaqueId", "expectedSha256"]);
      if (!identifier(args.opaqueId) || !digest(args.expectedSha256)) invalid();
      return;
    case "artifact.save":
      exactKeys(args, ["remoteArtifactId", "expectedSha256", "suggestedName", "maximumBytes"]);
      if (!identifier(args.remoteArtifactId) || !digest(args.expectedSha256) || !fileName(args.suggestedName) ||
        !boundedInteger(args.maximumBytes, 1, 1_073_741_824)) invalid();
      return;
    case "preview.open":
      exactKeys(args, ["source", "mediaType"]);
      if (!previewSource(args.source) || !mediaType(args.mediaType)) invalid();
      return;
    case "diff.open":
      exactKeys(args, ["leftArtifactId", "rightArtifactId", "expectedDigests"]);
      if (!identifier(args.leftArtifactId) || !identifier(args.rightArtifactId) || !digestPair(args.expectedDigests)) invalid();
      return;
    case "editor.open":
      exactKeys(args, ["editor", "connectionDescriptorId", "workspaceBindingId", "workspaceBindingGeneration"]);
      if (typeof args.editor !== "string" || !EDITORS.has(args.editor) || !identifier(args.connectionDescriptorId) ||
        args.workspaceBindingId !== request.identity.workspaceBindingId ||
        args.workspaceBindingGeneration !== request.identity.workspaceBindingGeneration) invalid();
      return;
    case "notification.show":
      exactKeys(args, ["category", "title", "body", "focusRequestId"]);
      if (!["action_required", "task_complete", "task_failed"].includes(String(args.category)) ||
        !boundedString(args.title, 80) || !boundedString(args.body, 240) || !identifier(args.focusRequestId)) invalid();
      return;
    case "git.sign":
      exactKeys(args, ["objectType", "canonicalPayloadBase64url", "decodedLength", "payloadSha256", "keySelectorId"]);
      if ((args.objectType !== "commit" && args.objectType !== "tag") || !identifier(args.keySelectorId) ||
        !base64urlDigest(args.canonicalPayloadBase64url, args.decodedLength, args.payloadSha256, 65_536)) invalid();
      return;
    case "local_service.request":
      exactKeys(args, ["registrationId", "operationId", "bodyEncoding", "body", "decodedLength", "bodySha256"]);
      if (!identifier(args.registrationId) || !identifier(args.operationId) ||
        (args.bodyEncoding !== "canonical_json" && args.bodyEncoding !== "base64url") ||
        !encodedBody(args.bodyEncoding, args.body, args.decodedLength, args.bodySha256, 65_536)) invalid();
      return;
    case "device.select":
      exactKeys(args, ["deviceClass", "purpose", "requestedMetadata"]);
      if (!["serial", "usb", "camera", "microphone"].includes(String(args.deviceClass)) ||
        !boundedString(args.purpose, 160) || !enumArray(args.requestedMetadata, ["display_name", "class", "capabilities"], 3)) invalid();
      return;
  }
}

export function validateLocalActionResult(
  request: LocalActionRequest,
  status: LocalActionResult["status"],
  safeData?: LocalActionResult["safeData"],
  safeReason?: LocalActionSafeReason,
): void {
  if (safeReason !== undefined && !LOCAL_ACTION_SAFE_REASONS.has(safeReason)) invalid();
  if (status !== "succeeded") {
    if (safeData !== undefined) invalid();
    return;
  }
  if (safeData === undefined) invalid();
  switch (request.kind) {
    case "browser.open":
    case "auth.device.present":
    case "auth.callback.relay":
      exactKeys(safeData, ["awaitingProvider"]);
      if (safeData.awaitingProvider !== true) invalid();
      return;
    case "auth.result.observe":
      exactKeys(safeData, ["authenticated"]);
      if (typeof safeData.authenticated !== "boolean") invalid();
      return;
    case "clipboard.write":
      exactKeys(safeData, ["written"]);
      if (safeData.written !== true) invalid();
      return;
    case "port.forward":
      exactKeys(safeData, ["localHost", "localPort", "expiresAt", "streamId"]);
      if ((safeData.localHost !== "127.0.0.1" && safeData.localHost !== "::1") || !port(safeData.localPort, false) ||
        !Number.isSafeInteger(safeData.expiresAt) || !identifier(safeData.streamId)) invalid();
      return;
    case "file.select":
      exactKeys(safeData, ["selectionId", "count"]);
      if (!identifier(safeData.selectionId) || !Number.isSafeInteger(safeData.count) || Number(safeData.count) < 1 || Number(safeData.count) > 1_000) invalid();
      return;
    case "attachment.import":
      exactKeys(safeData, ["opaqueArtifactId", "digest"]);
      if (!identifier(safeData.opaqueArtifactId) || !digest(safeData.digest)) invalid();
      return;
    case "artifact.save":
    case "preview.open":
    case "diff.open":
    case "editor.open":
    case "notification.show":
      exactKeys(safeData, ["completed"]);
      if (safeData.completed !== true) invalid();
      return;
    case "git.sign":
      exactKeys(safeData, ["signatureBase64url", "decodedLength", "signatureSha256", "algorithm", "publicKeyFingerprint"]);
      if (!base64urlDigest(safeData.signatureBase64url, safeData.decodedLength, safeData.signatureSha256, 65_536) ||
        !boundedString(safeData.algorithm, 64) || !boundedString(safeData.publicKeyFingerprint, 256)) invalid();
      return;
    case "local_service.request":
      exactKeys(safeData, ["outcome", "bodyEncoding", "body", "decodedLength", "bodySha256"]);
      if (!["ok", "service_error", "timeout"].includes(String(safeData.outcome)) ||
        (safeData.bodyEncoding !== "canonical_json" && safeData.bodyEncoding !== "base64url") ||
        !encodedBody(safeData.bodyEncoding, safeData.body, safeData.decodedLength, safeData.bodySha256, 65_536)) invalid();
      return;
    case "device.select":
      exactKeys(safeData, ["opaqueDeviceId", "displayName", "deviceClass", "capabilities"]);
      if (!identifier(safeData.opaqueDeviceId) || !boundedString(safeData.displayName, 160) ||
        !["serial", "usb", "camera", "microphone"].includes(String(safeData.deviceClass)) ||
        !stringArray(safeData.capabilities, 32, 128)) invalid();
      return;
  }
}

function exactKeys(
  value: Readonly<Record<string, LocalActionArgument>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.has(key))) invalid();
}

function boundedString(value: LocalActionArgument | undefined, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && Buffer.byteLength(value, "utf8") <= maximum && !value.includes("\0");
}

function identifier(value: LocalActionArgument | undefined): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function digest(value: LocalActionArgument | undefined): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function port(value: LocalActionArgument | undefined, allowZero: boolean): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (allowZero ? 0 : 1) && Number(value) <= 65_535;
}

function stringArray(value: LocalActionArgument | undefined, maximumItems: number, maximumItemBytes: number): boolean {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => boundedString(item, maximumItemBytes));
}

function fileName(value: LocalActionArgument | undefined): value is string {
  return boundedString(value, 255) && !/[\\/:*?"<>|]/u.test(value) && value !== "." && value !== "..";
}

function exactPath(value: LocalActionArgument | undefined): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 2_048 &&
    !value.includes("\0") && !value.includes("?") && !value.includes("#") && !value.includes("\\") &&
    !value.split("/").some((part, index) => index > 0 && (part === "" || part === "." || part === ".."));
}

function boundedInteger(value: LocalActionArgument | undefined, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function deadline(value: LocalActionArgument | undefined, request: LocalActionRequest): value is number {
  return Number.isSafeInteger(value) && Number(value) > request.createdAt && Number(value) <= request.expiresAt;
}

function acceptFilters(value: LocalActionArgument | undefined): boolean {
  return Array.isArray(value) && value.length <= 32 && value.every((item) => {
    if (!record(item)) return false;
    exactKeys(item, [], ["extension", "mediaType"]);
    return (item.extension === undefined || (boundedString(item.extension, 32) && /^\.[A-Za-z0-9]+$/u.test(item.extension))) &&
      (item.mediaType === undefined || mediaType(item.mediaType)) &&
      (item.extension !== undefined || item.mediaType !== undefined);
  });
}

function previewSource(value: LocalActionArgument | undefined): boolean {
  if (!record(value)) return false;
  if (value.kind === "artifact") {
    exactKeys(value, ["kind", "opaqueId", "sha256"]);
    return identifier(value.opaqueId) && digest(value.sha256);
  }
  if (value.kind === "private_forward") {
    exactKeys(value, ["kind", "streamId"]);
    return identifier(value.streamId);
  }
  return false;
}

function digestPair(value: LocalActionArgument | undefined): boolean {
  return Array.isArray(value) && value.length === 2 && digest(value[0]) && digest(value[1]);
}

function mediaType(value: LocalActionArgument | undefined): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(value);
}

function enumArray(value: LocalActionArgument | undefined, allowed: readonly string[], maximum: number): boolean {
  return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length &&
    value.every((item) => typeof item === "string" && allowed.includes(item));
}

function base64urlDigest(
  encoded: LocalActionArgument | undefined,
  decodedLength: LocalActionArgument | undefined,
  expectedDigest: LocalActionArgument | undefined,
  maximumBytes: number,
): boolean {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]*$/u.test(encoded) || !boundedInteger(decodedLength, 0, maximumBytes) || !digest(expectedDigest)) return false;
  const bytes = Buffer.from(encoded, "base64url");
  return bytes.byteLength === decodedLength && bytes.toString("base64url") === encoded &&
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` === expectedDigest;
}

function encodedBody(
  encoding: LocalActionArgument | undefined,
  body: LocalActionArgument | undefined,
  decodedLength: LocalActionArgument | undefined,
  expectedDigest: LocalActionArgument | undefined,
  maximumBytes: number,
): boolean {
  if (encoding === "base64url") return base64urlDigest(body, decodedLength, expectedDigest, maximumBytes);
  if (encoding !== "canonical_json" || body === undefined || !boundedInteger(decodedLength, 0, maximumBytes) || !digest(expectedDigest)) return false;
  let bytes: Buffer;
  try { bytes = Buffer.from(canonicalJson(body), "utf8"); } catch { return false; }
  return bytes.byteLength === decodedLength && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === expectedDigest;
}

function canonicalJson(value: LocalActionArgument): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Readonly<Record<string, LocalActionArgument>>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

function workspaceScoped(kind: LocalActionRequest["kind"]): boolean {
  return new Set<LocalActionRequest["kind"]>([
    "attachment.import", "artifact.save", "preview.open", "diff.open", "editor.open", "git.sign",
  ]).has(kind);
}

function record(value: LocalActionArgument | undefined): value is Readonly<Record<string, LocalActionArgument>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new TypeError("Local action arguments do not match the closed schema for this action kind.");
}
