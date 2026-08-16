import { EXIT_CODES } from "./errors.js";

/**
 * The documented exit-code contract, PROJECTED from `EXIT_CODES`.
 *
 * WHY THIS FILE EXISTS. The process exit code is the whole contract for a
 * caller that is not a human, and this build is usable almost exclusively as an
 * automation client. A script that cannot tell "your credential is wrong" (3)
 * from "the server is behind" (7) from "this deployment does not serve the
 * operation" (8) cannot choose between reauthenticating, waiting, and giving
 * up — three responses with nothing in common. Twenty-one commands were run
 * against production and six distinct codes came back; the README, the
 * changelog and `cuna --help` mentioned none of them.
 *
 * WHY IT IS A PROJECTION AND NOT A SECOND LIST. A namespace minted in one place
 * and described in another is the defect this repository has already closed
 * four times over: the two copies are compared by nobody, one side is edited,
 * and the documentation starts describing a build that no longer exists. So no
 * number is written here. Every number below is read out of `EXIT_CODES`, and
 * the prose is keyed by `keyof typeof EXIT_CODES`, which makes both failure
 * directions a COMPILE error rather than a silent drift:
 *
 *   - adding a code to `EXIT_CODES` without describing it here -> missing
 *     property on the `Record`;
 *   - describing a code that `EXIT_CODES` does not define -> excess property
 *     on the object literal.
 *
 * WHAT THIS FILE DOES NOT DO, stated because the omission is deliberate. It
 * cannot detect a code whose *meaning* changed while its number stayed put, and
 * it cannot detect the reverse — `operation_not_served` moved from 7 to 8 in
 * this repository and every derived artifact would have moved with it, silently.
 * Only a literal oracle catches that, which is why
 * `test/exit-code-contract.test.mjs` writes all nine numbers out by hand and
 * must never import them from here.
 *
 * The reachable path recorded against each code is one invocation, verified in
 * this tree, that actually produces it. It is deliberately ONE and not an
 * enumeration: a caller needs to know the code is real and how to see it, and a
 * list of every mint site would be stale within a release.
 */

export type ExitCodeName = keyof typeof EXIT_CODES;

export interface DocumentedExitCode {
  /** The name the source mints this code under, e.g. `unsupported`. */
  readonly name: ExitCodeName;
  /** The number the process exits with. Read from `EXIT_CODES`, never written here. */
  readonly code: number;
  /** What a caller may conclude when it sees this code. */
  readonly meaning: string;
  /** One invocation in this build that reaches it, and the code it mints. */
  readonly reachablePath: string;
}

type ExitCodeProse = Readonly<Record<ExitCodeName, {
  readonly meaning: string;
  readonly reachablePath: string;
}>>;

// `satisfies` rather than a type annotation, deliberately. An annotation is
// checked through `Object.freeze`'s return type, which permits EXTRA
// properties — so a code deleted from `EXIT_CODES` would leave its description
// behind and compile clean. `satisfies` applies excess-property checking to the
// literal itself, which is the direction an annotation misses.
const EXIT_CODE_PROSE = Object.freeze({
  success: Object.freeze({
    meaning: "The command completed and the record it printed is authoritative.",
    reachablePath: "`cuna self-test --offline` verifies the installed artifact without a network request and returns.",
  }),
  usage: Object.freeze({
    meaning: "The invocation or the resolved configuration is invalid.",
    reachablePath: "`cuna nonsense` fails the command preflight with `cuna.usage.invalid`. Nothing is sent to the server.",
  }),
  auth: Object.freeze({
    meaning: "No usable credential, a rejected credential, or an auth-mode conflict.",
    reachablePath: "`cuna whoami` while `CUNA_API_KEY` is set mints `cuna.auth.mode_conflict`. A credential the server refuses arrives as `cuna.auth.rejected` from HTTP 401.",
  }),
  policy: Object.freeze({
    meaning: "Understood and refused by policy, including a required confirmation.",
    reachablePath: "`cuna machines delete ID` without `--yes` mints `cuna.confirmation.required`. A server refusal arrives as `cuna.policy.denied` from HTTP 403.",
  }),
  network: Object.freeze({
    meaning: "No authoritative answer arrived: timeout, cancellation, 429, or 5xx.",
    reachablePath: "a request exceeding `--timeout-ms` mints `cuna.network.timeout`. HTTP 429 and 5xx arrive as `cuna.network.rate_limited` and `cuna.network.service_unavailable`.",
  }),
  conflict: Object.freeze({
    meaning: "Current state contradicts the change; repeating it unchanged repeats this.",
    reachablePath: "HTTP 409 mints `cuna.remote.conflict`. A foreground attach to a session already held mints `cuna.runtime.session_conflict`.",
  }),
  remote: Object.freeze({
    meaning: "The server answered, but not in a way the published contract allows.",
    reachablePath: "`cuna account show` against a deployment whose body fails contract decoding mints `cuna.remote.malformed_response`. A 404 that does carry a JSON body is an absent resource and lands here as `cuna.remote.not_found`.",
  }),
  unsupported: Object.freeze({
    meaning: "This deployment does not serve or does not advertise the capability.",
    reachablePath: "`cuna records list` against a deployment with no route for it mints `cuna.remote.operation_not_served`: HTTP 404 whose body is not JSON, which only a layer in front of the API writes.",
  }),
  internal: Object.freeze({
    meaning: "The CLI itself failed; no server outcome is implied.",
    reachablePath: "any throw that is not a `CunaError` reaching the top of `runCli` is normalized to `cuna.internal.unexpected`.",
  }),
} satisfies ExitCodeProse);

/**
 * Every code the program can return, ascending. Nine names, nine numbers, all
 * nine read from `EXIT_CODES`.
 */
export const DOCUMENTED_EXIT_CODES: readonly DocumentedExitCode[] = Object.freeze(
  (Object.keys(EXIT_CODE_PROSE) as readonly ExitCodeName[])
    .map((name) => Object.freeze({
      name,
      code: EXIT_CODES[name],
      meaning: EXIT_CODE_PROSE[name].meaning,
      reachablePath: EXIT_CODE_PROSE[name].reachablePath,
    }))
    .sort((left, right) => left.code - right.code),
);

/**
 * The README's exit-code table. The README carries the rendered output between
 * generated-region markers and a test asserts the two are identical, so the
 * published table cannot outlive the codes it describes.
 */
export function exitCodeMarkdownTable(): string {
  const rows = DOCUMENTED_EXIT_CODES.map(
    (entry) => `| \`${entry.code}\` | \`${entry.name}\` | ${entry.meaning} | ${entry.reachablePath} |`,
  );
  return [
    "| Exit code | Name | Meaning | One reachable path |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * The `cuna --help` exit-code block. Help is where most callers will meet this
 * contract, so it carries the meanings; the reachable paths stay in the README
 * because they are reference material, not a reminder.
 */
export function exitCodeHelpSection(): string {
  // Both column widths are measured, not chosen. A longer code or a longer name
  // must widen the column rather than run into the text beside it.
  const codeWidth = Math.max(...DOCUMENTED_EXIT_CODES.map((entry) => String(entry.code).length));
  const nameWidth = Math.max(...DOCUMENTED_EXIT_CODES.map((entry) => entry.name.length)) + 2;
  return DOCUMENTED_EXIT_CODES
    .map((entry) => `  ${String(entry.code).padStart(codeWidth, " ")}  ${entry.name.padEnd(nameWidth, " ")}${entry.meaning}`)
    .join("\n");
}
