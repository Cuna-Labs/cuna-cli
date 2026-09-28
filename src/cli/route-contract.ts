import { INFRA_OPENAPI_CONTRACT_IDENTITY, INFRA_OPENAPI_OPERATIONS } from "../config/infra-contract-witness.js";
import { CunaError, EXIT_CODES } from "../core/errors.js";
import type { CliRouteDefinition } from "./parser.js";

/**
 * WHAT THIS BUILD MAY CALL AVAILABLE.
 *
 * `[routed]` says this build dispatches a leaf; it never said the API this
 * build speaks has the operations the leaf sends. On 2026-09-28 `cuna help
 * --all` listed `machines live-update-supervisor` and `live-update-status`
 * under "Available now" while the deployed Edge (`d3d3d3c`) answered their
 * route with 404 `operation_not_served`: the build vendored a contract from an
 * unmerged producer branch. The vendored contract is now the deployed one, and
 * this module makes it the authority for the claim: a routed leaf whose
 * declared operation (`CliRouteDefinition.operations`) the vendored contract
 * lacks is unserved. Help stops listing it as available, and the preflight
 * refuses it before any configuration, credential or network work.
 *
 * It is not a live answer. A served operation can still be refused by the
 * server at runtime; `cuna capabilities` is the live question.
 */
export const VENDORED_CONTRACT_OPERATIONS: ReadonlySet<string> = new Set(INFRA_OPENAPI_OPERATIONS);

/** The declared operations of `route` that `served` does not contain. */
export function missingContractOperations(
  route: Pick<CliRouteDefinition, "operations">,
  served: ReadonlySet<string> = VENDORED_CONTRACT_OPERATIONS,
): readonly string[] {
  return route.operations.filter((operation) => !served.has(operation));
}

export function isRouteServedByContract(
  route: Pick<CliRouteDefinition, "operations" | "dispatch">,
  served: ReadonlySet<string> = VENDORED_CONTRACT_OPERATIONS,
): boolean {
  return route.dispatch === "routed" && missingContractOperations(route, served).length === 0;
}

function contractProducerRevision(): string {
  const identity = INFRA_OPENAPI_CONTRACT_IDENTITY as Readonly<Record<string, unknown>>;
  const revision = identity["producer_revision"] ?? identity["producer_base_revision"];
  return typeof revision === "string" ? revision : "unknown";
}

/** Refuse, before anything is sent, a leaf this build's API contract cannot serve. */
export function assertRouteServedByContract(
  route: CliRouteDefinition,
  served: ReadonlySet<string> = VENDORED_CONTRACT_OPERATIONS,
): void {
  if (route.dispatch !== "routed") return;
  const missing = missingContractOperations(route, served);
  if (missing.length === 0) return;
  const revision = contractProducerRevision();
  throw new CunaError({
    code: "cuna.contract.operation_not_served",
    message: `\`cuna ${route.key}\` is not served by this Cuna API version.`,
    exitCode: EXIT_CODES.unsupported,
    hint: `This build speaks the Cuna API contract of producer ${revision.slice(0, 12)}, which has no ` +
      `${missing.join(", ")}. Nothing was sent.`,
    retryable: false,
    details: {
      command: route.key,
      missing_operations: missing,
      contract_producer_revision: revision,
      contract_canonical_sha256: INFRA_OPENAPI_CONTRACT_IDENTITY.infra_openapi_canonical_sha256,
    },
  });
}
