import { credentialFailure } from "./errors.js";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class SecretMaterial implements Disposable {
  #bytes: Uint8Array;
  #disposed = false;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  static fromBytes(bytes: Uint8Array): SecretMaterial {
    if (bytes.byteLength < 1 || bytes.byteLength > 32_768) {
      throw credentialFailure("credential_corrupt", "Credential material has an invalid size.");
    }
    return new SecretMaterial(Uint8Array.from(bytes));
  }

  static fromUtf8(value: string): SecretMaterial {
    return SecretMaterial.fromBytes(new TextEncoder().encode(value));
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  withBytes<T>(operation: (bytes: Uint8Array) => T): T {
    if (this.#disposed) {
      throw credentialFailure("credential_missing", "Credential material is no longer available.");
    }
    return operation(this.#bytes);
  }

  copyBytes(): Uint8Array {
    return this.withBytes((bytes) => Uint8Array.from(bytes));
  }

  dispose(): void {
    if (!this.#disposed) {
      this.#bytes.fill(0);
      this.#disposed = true;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [INSPECT](): string {
    return "SecretMaterial([REDACTED])";
  }
}
