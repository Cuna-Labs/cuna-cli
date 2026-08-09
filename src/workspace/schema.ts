import { workspaceError } from "./errors.js";

export interface DurableSchemaEnvelope {
  readonly schemaVersion: number;
  readonly minimumReaderVersion: number;
  readonly minimumWriterVersion: number;
}

export interface SchemaSupport {
  readonly readerVersion: number;
  readonly writerVersion: number;
  readonly readableSchemaVersions: readonly number[];
  readonly writableSchemaVersions: readonly number[];
}

export const LOCAL_SCHEMA_SUPPORT: SchemaSupport = Object.freeze({
  readerVersion: 2,
  writerVersion: 2,
  readableSchemaVersions: Object.freeze([1, 2]),
  writableSchemaVersions: Object.freeze([2]),
});

export function assertReadableSchema(
  envelope: DurableSchemaEnvelope,
  support: SchemaSupport = LOCAL_SCHEMA_SUPPORT,
): void {
  assertSchemaNumbers(envelope);
  if (
    !support.readableSchemaVersions.includes(envelope.schemaVersion) ||
    envelope.minimumReaderVersion > support.readerVersion
  ) {
    throw workspaceError(
      "schema_incompatible",
      "The local workspace record requires an unsupported reader.",
      "unsupported",
      "reader_version_incompatible",
    );
  }
}

export function assertWritableSchema(
  envelope: DurableSchemaEnvelope,
  support: SchemaSupport = LOCAL_SCHEMA_SUPPORT,
): void {
  assertReadableSchema(envelope, support);
  if (
    !support.writableSchemaVersions.includes(envelope.schemaVersion) ||
    envelope.minimumWriterVersion > support.writerVersion
  ) {
    throw workspaceError(
      "schema_incompatible",
      "The local workspace record cannot be safely mutated by this writer.",
      "unsupported",
      "writer_version_incompatible",
    );
  }
}

function assertSchemaNumbers(envelope: DurableSchemaEnvelope): void {
  for (const value of [
    envelope.schemaVersion,
    envelope.minimumReaderVersion,
    envelope.minimumWriterVersion,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw workspaceError(
        "schema_malformed",
        "The local workspace record has malformed schema metadata.",
        "integrity",
        "invalid_schema_version",
      );
    }
  }
}

