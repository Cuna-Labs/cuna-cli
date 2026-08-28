import { isIP } from "node:net";

export type LoopbackHost = "127.0.0.1" | "::1";

export function assertLoopbackHost(value: string, label: string): asserts value is LoopbackHost {
  if ((value !== "127.0.0.1" && value !== "::1") || isIP(value) === 0) {
    throw new TypeError(`${label} must be the literal loopback address 127.0.0.1 or ::1.`);
  }
}

export function assertPort(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 65_535) {
    throw new TypeError(`${label} must be an integer port in the allowed range.`);
  }
}

export function isLoopbackPeer(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
