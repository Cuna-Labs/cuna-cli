import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import {
  SensitiveAuthorityError,
  assertSensitiveAuthority,
  requireConsentOnce,
  throwIfAborted,
  validateSensitiveContext,
  type PerOperationConsent,
  type SensitiveOperationContext,
} from "./sensitive-consent.js";

export type DeviceClass = "serial" | "usb" | "camera" | "microphone";
export type DeviceMetadataField = "display_name" | "class" | "capabilities";

export interface DeviceSelectArgs {
  readonly deviceClass: DeviceClass;
  readonly purpose: string;
  readonly requestedMetadata: readonly DeviceMetadataField[];
}

export interface HumanSelectedDevice {
  /** Adapter-owned identity used only for revalidation and release; never returned remotely. */
  readonly localIdentityToken: string;
  readonly displayName: string;
  readonly deviceClass: DeviceClass;
  readonly capabilities: readonly string[];
}

export interface HumanDeviceSelector {
  selectDevice(args: Readonly<DeviceSelectArgs>, signal?: AbortSignal): Promise<HumanSelectedDevice | null>;
  isStillPresent(device: HumanSelectedDevice, signal?: AbortSignal): Promise<boolean>;
  release(device: HumanSelectedDevice): void | Promise<void>;
}

export interface DeviceSelectionResult {
  readonly opaqueDeviceId: string;
  readonly displayName: string;
  readonly deviceClass: DeviceClass;
  readonly capabilities: readonly string[];
}

export interface DeviceSelectionActionsOptions {
  readonly consent: PerOperationConsent;
  readonly selector: HumanDeviceSelector;
  readonly allowedCapabilities: Readonly<Record<DeviceClass, readonly string[]>>;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export class DeviceSelectionActions {
  readonly #options: DeviceSelectionActionsOptions;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #active = new Set<AbortController>();

  constructor(options: DeviceSelectionActionsOptions) {
    this.#options = options;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    validateAllowlist(options.allowedCapabilities);
  }

  revokeAll(): void {
    for (const controller of this.#active) controller.abort("device_selection_revoked");
    this.#active.clear();
  }

  async select(
    args: DeviceSelectArgs,
    context: SensitiveOperationContext,
    signal?: AbortSignal,
  ): Promise<DeviceSelectionResult | null> {
    validateArgs(args);
    validateSensitiveContext(context);
    const operationDigest = digest(Buffer.from(canonicalSelection(args), "utf8"));
    await requireConsentOnce(this.#options.consent, context, {
      action: "device.select",
      operationDigest,
      summary: `Select one ${args.deviceClass} device for ${args.purpose}`,
    }, signal).catch(normalizeAuthorityError);

    const controller = new AbortController();
    const detachAbort = forwardAbort(signal, controller);
    this.#active.add(controller);
    let selected: HumanSelectedDevice | null = null;
    try {
      throwIfAborted(controller.signal);
      selected = await this.#options.selector.selectDevice(freezeArgs(args), controller.signal);
      if (selected === null) return null;
      validateSelectedDevice(selected, args.deviceClass);
      await assertSensitiveAuthority(context, controller.signal).catch(normalizeAuthorityError);
      if (!await this.#options.selector.isStillPresent(selected, controller.signal)) throw new DeviceSelectionError("device_disappeared");
      await assertSensitiveAuthority(context, controller.signal).catch(normalizeAuthorityError);
      const requested = new Set(args.requestedMetadata);
      const allowed = new Set(this.#options.allowedCapabilities[args.deviceClass]);
      const capabilities = requested.has("capabilities")
        ? Object.freeze(selected.capabilities.filter((capability) => allowed.has(capability)))
        : Object.freeze([] as string[]);
      const opaqueDeviceId = createHash("sha256")
        .update(context.requestId, "utf8")
        .update("\0", "utf8")
        .update(context.identityFingerprint, "utf8")
        .update("\0", "utf8")
        .update(this.#randomBytes(32))
        .digest("hex");
      // There is deliberately no registry for opaqueDeviceId. It correlates this
      // terminal result only and cannot authorize a later device operation.
      return Object.freeze({
        opaqueDeviceId,
        displayName: requested.has("display_name") ? sanitizeDisplayName(selected.displayName) : "Selected device",
        deviceClass: args.deviceClass,
        capabilities,
      });
    } catch (error) {
      if (error instanceof SensitiveAuthorityError) throw new DeviceSelectionError(error.code, { cause: error });
      throw error;
    } finally {
      detachAbort();
      this.#active.delete(controller);
      controller.abort("selection_complete");
      if (selected !== null) await this.#options.selector.release(selected);
    }
  }
}

export class DeviceSelectionError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(`Cuna device selection failed: ${code}.`, options);
    this.name = "DeviceSelectionError";
  }
}

function validateArgs(args: DeviceSelectArgs): void {
  if (!["serial", "usb", "camera", "microphone"].includes(args.deviceClass) ||
    typeof args.purpose !== "string" || args.purpose.length < 1 || Buffer.byteLength(args.purpose, "utf8") > 160 ||
    args.purpose.includes("\0") || !Array.isArray(args.requestedMetadata) || args.requestedMetadata.length > 3 ||
    new Set(args.requestedMetadata).size !== args.requestedMetadata.length ||
    args.requestedMetadata.some((field) => !["display_name", "class", "capabilities"].includes(field))) {
    throw new DeviceSelectionError("request_invalid");
  }
}

function validateSelectedDevice(device: HumanSelectedDevice, expectedClass: DeviceClass): void {
  if (device.deviceClass !== expectedClass || typeof device.localIdentityToken !== "string" ||
    device.localIdentityToken.length < 1 || device.localIdentityToken.includes("\0") ||
    typeof device.displayName !== "string" || device.displayName.length < 1 || Buffer.byteLength(device.displayName, "utf8") > 4_096 ||
    !Array.isArray(device.capabilities) || device.capabilities.length > 32 ||
    device.capabilities.some((capability) => typeof capability !== "string" || capability.length < 1 ||
      Buffer.byteLength(capability, "utf8") > 128 || capability.includes("\0"))) {
    throw new DeviceSelectionError("device_descriptor_invalid");
  }
}

function validateAllowlist(value: Readonly<Record<DeviceClass, readonly string[]>>): void {
  for (const deviceClass of ["serial", "usb", "camera", "microphone"] as const) {
    const capabilities = value[deviceClass];
    if (!Array.isArray(capabilities) || capabilities.length > 32 || new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => typeof capability !== "string" || capability.length < 1 ||
        Buffer.byteLength(capability, "utf8") > 128 || capability.includes("\0"))) {
      throw new DeviceSelectionError("capability_allowlist_invalid");
    }
  }
}

function freezeArgs(args: DeviceSelectArgs): Readonly<DeviceSelectArgs> {
  return Object.freeze({ ...args, requestedMetadata: Object.freeze([...args.requestedMetadata]) });
}

function canonicalSelection(args: DeviceSelectArgs): string {
  return JSON.stringify({
    deviceClass: args.deviceClass,
    purpose: args.purpose,
    requestedMetadata: [...args.requestedMetadata].sort(),
  });
}

function sanitizeDisplayName(value: string): string {
  const sanitized = value.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  if (sanitized.length === 0) return "Selected device";
  if (Buffer.byteLength(sanitized, "utf8") <= 160) return sanitized;
  let output = "";
  for (const character of sanitized) {
    if (Buffer.byteLength(`${output}${character}...`, "utf8") > 160) break;
    output += character;
  }
  return `${output}...`;
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
  if (error instanceof SensitiveAuthorityError) throw new DeviceSelectionError(error.code, { cause: error });
  throw error;
}
