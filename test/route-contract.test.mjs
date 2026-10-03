// The mechanism behind D1: a routed leaf declares the operations it sends, and
// the vendored contract decides whether help may call it available and whether
// the preflight lets it send anything.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { renderFullHelp } from "../dist/cli/help.js";
import { CLI_ROUTE_REGISTRY, ROUTE_OPERATION_KEYS } from "../dist/cli/parser.js";
import {
  VENDORED_CONTRACT_OPERATIONS,
  isRouteServedByContract,
  missingContractOperations,
} from "../dist/cli/route-contract.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const contract = JSON.parse(readFileSync(new URL("../contracts/infra/cuna-api.openapi.json", import.meta.url), "utf8"));
const identity = JSON.parse(readFileSync(new URL("../contracts/infra/cuna-api.openapi.identity.json", import.meta.url), "utf8"));
const declared = new Set(CLI_ROUTE_REGISTRY.flatMap((route) => route.operations));

test("the vendored contract is the deployed producer's, and the compiled operation list is read from it", () => {
  // Live Edge C4.15 (Fly v248), /healthz contract sha256 at 2026-10-03 20:54Z.
  assert.equal(identity.producer_revision, "3dfa1d12cdc66cc63447ceee7f3c97ae8dc8c5c3");
  assert.equal(identity.infra_openapi_canonical_sha256, "7a950c6ffab805f4a04e5b32c69726affa54f39d0d6e7ba9d5e53099feb78af5");
  assert.equal(identity.producer_content_state, "committed");
  const fromArtifact = Object.entries(contract.paths).flatMap(([path, row]) =>
    Object.keys(row).filter((method) => ["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`)).sort();
  assert.deepEqual([...VENDORED_CONTRACT_OPERATIONS].sort(), fromArtifact);
});

test("every declared operation is a real operation of this contract, except exactly the three it dropped", () => {
  for (const operation of declared) assert.match(operation, /^(GET|PUT|POST|DELETE|PATCH) \/v1\/\S+$/u, operation);
  const missing = [...declared].filter((operation) => !VENDORED_CONTRACT_OPERATIONS.has(operation)).sort();
  assert.deepEqual(missing, [
    "GET /v1/sessions/{id}/supervisor/live-update/{operationId}",
    "POST /v1/collaboration/2/agent-sessions/{id}/audience-state",
    "POST /v1/sessions/{id}/supervisor/live-update",
  ]);
  // The commands those operations belong to, which is the whole of what the
  // move to the deployed producer took away.
  const unserved = CLI_ROUTE_REGISTRY.filter((route) => route.dispatch === "routed" && !isRouteServedByContract(route))
    .map((route) => route.key).sort();
  assert.deepEqual(unserved, ["machines live-update-status", "machines live-update-supervisor", "share"]);
});

test("no operation declaration names a leaf the registry does not route", () => {
  const routed = new Set(CLI_ROUTE_REGISTRY.filter((route) => route.dispatch === "routed").map((route) => route.key));
  assert.deepEqual(ROUTE_OPERATION_KEYS.filter((key) => !routed.has(key)), []);
});

test("a contract lacking one operation moves exactly the leaves that send it, in help and in dispatch", async () => {
  const withoutRecords = new Set([...declared].filter((operation) => operation !== "GET /v1/records"));
  const everything = new Set(declared);
  const records = CLI_ROUTE_REGISTRY.find((route) => route.key === "records list");
  assert.deepEqual(missingContractOperations(records, withoutRecords), ["GET /v1/records"]);

  const full = renderFullHelp(everything);
  assert.doesNotMatch(full, /^Not served by this Cuna API version/mu, "nothing is unserved when every operation exists");
  assert.match(full, /^ {2}records list {10,}/mu);
  const lacking = renderFullHelp(withoutRecords);
  const available = lacking.slice(lacking.indexOf("Available now:"), lacking.indexOf("Not served by this Cuna API version"));
  assert.doesNotMatch(available, /^ {2}records list/mu, "records list is still listed as available");
  assert.match(lacking, /^Not served by this Cuna API version[^\n]*\n[^\n]*\n {2}records list/mu);
  assert.match(lacking, /^ {2}\[unserved\] records list :: /mu);
  assert.match(lacking, /^ {2}\[routed\] account show :: /mu, "a leaf that sends other operations is untouched");

  const run = async (served) => {
    let requests = 0;
    const streams = memoryStreams();
    const exit = await runCli(["records", "list", "--json"], {
      streams: streams.streams,
      platform: PLATFORM,
      env: { CUNA_API_KEY: "cuna_sk_abcdefghijklmnop" },
      contractOperations: served,
      fetch: async () => { requests += 1; return new Response("{}", { status: 503 }); },
    });
    return { exit, requests, stderr: streams.stderr() };
  };
  const refused = await run(withoutRecords);
  assert.equal(refused.requests, 0);
  assert.equal(refused.exit, EXIT_CODES.unsupported);
  assert.match(refused.stderr, /cuna\.contract\.operation_not_served/u);
  // Control: the same command with its operation present reaches the network.
  const sent = await run(everything);
  assert.ok(sent.requests > 0, "a served command must still send");
  assert.doesNotMatch(sent.stderr, /operation_not_served/u);
});
