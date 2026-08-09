import { usageError } from "./errors.js";

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,127}$/u;

export function assertPublicId(value: string, label: string): string {
  if (!PUBLIC_ID.test(value)) {
    throw usageError(`Invalid ${label}.`, `${label} must be an opaque public Runa identifier.`);
  }
  return value;
}

export function encodePublicId(value: string, label: string): string {
  return encodeURIComponent(assertPublicId(value, label));
}

export function safeReasonCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Malformed field: ${key}`);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`Malformed field: ${key}`);
  return value;
}

export function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Malformed field: ${key}`);
  }
  return value;
}
