import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { runtimeFailure } from "../runtime/errors.js";

export interface PipeProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface PipeProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface PipeProcessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  closeInput(): void;
  signal(signal: "interrupt" | "terminate"): boolean;
  wait(): Promise<PipeProcessExit>;
}

export interface ProcessAdapter {
  readonly kind: "pipe_process";
  readonly platform: NodeJS.Platform;
  spawn(request: PipeProcessRequest): PipeProcessHandle;
}

const SAFE_INHERITED_ENVIRONMENT = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "WINDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
]);

const FORBIDDEN_ENVIRONMENT_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION|CREDENTIAL|COOKIE)/iu;

export function createNodeProcessAdapter(): ProcessAdapter {
  return Object.freeze({
    kind: "pipe_process" as const,
    platform: process.platform,
    spawn(request: PipeProcessRequest): PipeProcessHandle {
      validateRequest(request);
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildEnvironment(request.environment),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      });
      return createHandle(child);
    },
  });
}

function createHandle(child: ChildProcessWithoutNullStreams): PipeProcessHandle {
  const wait = new Promise<PipeProcessExit>((resolve, reject) => {
    child.once("error", (cause) => reject(runtimeFailure("process_failed", "The local process could not be started.", { cause })));
    child.once("exit", (exitCode, signal) => resolve(Object.freeze({ exitCode, signal })));
  });
  return Object.freeze({
    pid: child.pid!,
    stdout: child.stdout,
    stderr: child.stderr,
    async write(data: Uint8Array): Promise<void> {
      if (child.stdin.destroyed || !child.stdin.writable) {
        throw runtimeFailure("process_failed", "The local process input stream is closed.");
      }
      if (child.stdin.write(data)) return;
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (cause: Error) => { cleanup(); reject(runtimeFailure("process_failed", "The local process input failed.", { cause })); };
        const cleanup = () => {
          child.stdin.off("drain", onDrain);
          child.stdin.off("error", onError);
        };
        child.stdin.once("drain", onDrain);
        child.stdin.once("error", onError);
      });
    },
    closeInput(): void {
      child.stdin.end();
    },
    signal(signal: "interrupt" | "terminate"): boolean {
      return child.kill(signal === "interrupt" ? "SIGINT" : "SIGTERM");
    },
    wait(): Promise<PipeProcessExit> {
      return wait;
    },
  });
}

function validateRequest(request: PipeProcessRequest): void {
  if (!path.isAbsolute(request.executable) || request.executable.length > 4096 || request.executable.includes("\0")) {
    throw runtimeFailure("process_invalid", "The process executable must be an absolute admitted path.");
  }
  if (request.args.length > 1024 || request.args.some((argument) => argument.length > 65_536 || argument.includes("\0"))) {
    throw runtimeFailure("process_invalid", "The process argument vector is outside supported bounds.");
  }
  if (request.cwd !== undefined && (!path.isAbsolute(request.cwd) || request.cwd.includes("\0"))) {
    throw runtimeFailure("process_invalid", "The process working directory must be an absolute local path.");
  }
  for (const [name, value] of Object.entries(request.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || FORBIDDEN_ENVIRONMENT_NAME.test(name) || value.includes("\0")) {
      throw runtimeFailure("process_invalid", "The process environment contains an unsafe entry.");
    }
  }
}

function buildEnvironment(additions: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && SAFE_INHERITED_ENVIRONMENT.has(name)) environment[name] = value;
  }
  for (const [name, value] of Object.entries(additions ?? {})) environment[name] = value;
  return environment;
}
