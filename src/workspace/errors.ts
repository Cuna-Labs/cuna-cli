import { EXIT_CODES, CunaError, type ExitCode } from "../core/errors.js";

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
): CunaError {
  return new CunaError({
    code: `cuna.workspace.${code}`,
    message,
    exitCode: EXIT_BY_CLASS[failureClass],
    ...(code === "secret_blocked" ? {
      hint: "Remove sensitive files from the synchronization scope, then retry from the intended project folder.",
    } : {}),
    details: { reason },
  });
}
