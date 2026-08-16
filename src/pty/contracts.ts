export const LOCAL_PTY_PROTOCOL = "cuna.local-pty.v1" as const;

export type PtyEvidenceStatus = "verified" | "unverified" | "unavailable";

export interface PtyCapabilities {
  readonly rawInput: boolean;
  readonly resize: boolean;
  readonly signals: boolean;
  readonly utf8: boolean;
}

export interface PtyAdapterEvidence {
  readonly status: PtyEvidenceStatus;
  readonly adapterId: string;
  readonly protocol: typeof LOCAL_PTY_PROTOCOL;
  readonly platform: NodeJS.Platform;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly artifactDigest: string;
  readonly capabilities: PtyCapabilities;
  readonly reason?: string;
}

export interface PtySpawnRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly columns: number;
  readonly rows: number;
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface PtyHandle {
  readonly pid: number;
  readonly output: AsyncIterable<string>;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  signal(signal: "interrupt" | "terminate"): void;
  wait(): Promise<PtyExit>;
  close(): void;
}

export interface PtyAdapter {
  probe(signal?: AbortSignal): Promise<PtyAdapterEvidence>;
  spawn(request: PtySpawnRequest): PtyHandle;
}
