import { EXIT_CODES, RunaError, type ExitCode } from "../core/errors.js";

export type WorkspaceFailureClass = "conflict" | "integrity" | "policy" | "unsupported";

const EXIT_BY_CLASS: Readonly<Record<WorkspaceFailureClass, ExitCode>> = Object.freeze({
  conflict: EXIT_CODES.conflict,
  integrity: EXIT_CODES.internal,
  policy: EXIT_CODES.policy,
  unsupported: EXIT_CODES.unsupported,
});

export function workspaceError(
  code: string,
  message: string,
  failureClass: WorkspaceFailureClass,
  reason: string,
): RunaError {
  return new RunaError({
    code: `runa.workspace.${code}`,
    message,
    exitCode: EXIT_BY_CLASS[failureClass],
    details: { reason },
  });
}

