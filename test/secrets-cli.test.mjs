import assert from "node:assert/strict";
import test from "node:test";
import { createCunaApiClient, memoryStreams, runCli } from "../dist/index.js";

const machine = "22222222-2222-4222-8222-222222222222";
const secret = "11111111-1111-4111-8111-111111111111";
const payload = {
  revision: 7,
  secret_configuration: [{
    secret_id: secret,
    environment: [{ name: "SERVICE_KEY", value_template: "${credential}" }],
    egress_rules: [{ host_pattern: "api.example.com", path_pattern: null, action: "header", name: "Authorization", value_template: "Bearer ${credential}" },
      { host_pattern: "query.example.com", action: "query", name: "key", value_template: "" }],
    files: [{ path: ".config/service/auth", value_template: "first line\n${credential}\n" }],
  }],
};
const platform = { kind: "linux", paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" }, async readSafeConfig() { return { exists: false }; } };
const capability = { id: "authorizations.list", availability: "supported", interaction: "read_only", mutation_class: "none", surfaces: ["cli"], required_permissions: ["credentials:manage"] };

async function command(body, { human = false, caps = [capability] } = {}) {
  const requests = [];
  const streams = memoryStreams({ stdoutIsTTY: human, stderrIsTTY: human });
  const client = createCunaApiClient({ async request(request) {
    requests.push(request);
    if (request.path === "/v1/capabilities") return { schema_version: "1.0", subject_scope: "machine", subject_id: machine,
      observed_at: "2026-09-04T00:00:00Z", expires_at: "2026-09-04T00:00:30Z", etag: "fixture", capabilities: caps };
    assert.equal(request.path, `/v1/sessions/${machine}/authorizations`);
    return body;
  } });
  const code = await runCli(["authorizations", "list", "--machine", machine, ...(human ? [] : ["--json"])], {
    platform, streams: streams.streams, env: { CUNA_API_KEY: "cuna_sk_abcdefghijklmnop" },
    now: () => Date.parse("2026-09-04T00:00:00Z"), clientFactory: () => client,
  });
  return { code, requests, stdout: streams.stdout(), stderr: streams.stderr() };
}

test("authorizations CLI roundtrips revision and every inline injection kind using GET only", async () => {
  const result = await command(payload);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, { machine_id: machine, ...payload });
  assert.deepEqual(result.requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/v1/capabilities" }, { method: "GET", path: `/v1/sessions/${machine}/authorizations` },
  ]);
});

test("human authorizations names environment, egress and file configurations without raw multiline templates", async () => {
  const result = await command(payload, { human: true });
  assert.equal(result.code, 0, result.stderr);
  for (const term of ["SERVICE_KEY", "api.example.com", "query.example.com", ".config/service/auth", secret, "7"]) assert.ok(result.stdout.includes(term), term);
  assert.equal(result.stdout.includes("first line\n${credential}"), false);
  assert.doesNotMatch(result.stdout, /No .*authorizations|No .*configuration/u);
});

for (const [name, body] of [
  ["retired empty array", []], ["missing revision", { secret_configuration: [] }],
  ["zero revision", { revision: 0, secret_configuration: [] }], ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1, secret_configuration: [] }],
  ["missing configuration", { revision: 1 }], ["unknown field", { ...payload, future: true }],
  ["too many bindings", { revision: 1, secret_configuration: Array(65).fill(payload.secret_configuration[0]) }],
  ["too many environment entries", { revision: 1, secret_configuration: [{ ...payload.secret_configuration[0], environment: Array(65).fill(payload.secret_configuration[0].environment[0]) }] }],
  ["missing kind array", { revision: 1, secret_configuration: [{ secret_id: secret, environment: [], files: [] }] }],
  ["unknown action", { revision: 1, secret_configuration: [{ ...payload.secret_configuration[0], egress_rules: [{ ...payload.secret_configuration[0].egress_rules[0], action: "cookie" }] }] }],
  ["bad secret identity", { revision: 1, secret_configuration: [{ ...payload.secret_configuration[0], secret_id: "name-is-not-uuid" }] }],
  ["terminal escape", { revision: 1, secret_configuration: [{ ...payload.secret_configuration[0], files: [{ path: "safe\u001b[31m", value_template: "x" }] }] }],
]) {
  test(`authorizations rejects ${name}, never an empty-success display`, async () => {
    const result = await command(body);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "cuna.remote.malformed_response");
  });
}

for (const caps of [[], [{ ...capability, availability: "unsupported" }], [{ ...capability, availability: "unknown" }], [{ ...capability, surfaces: ["web"] }], [{ ...capability, interaction: "native" }]]) {
  test(`authorizations abstains before listing when capability is unusable: ${JSON.stringify(caps)}`, async () => {
    const result = await command(payload, { caps });
    assert.notEqual(result.code, 0);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].path, "/v1/capabilities");
  });
}

test("a confirmed empty configuration retains its revision", async () => {
  const result = await command({ revision: 9, secret_configuration: [] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, { machine_id: machine, revision: 9, secret_configuration: [] });
});
