import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const installerTemplate = await readFile(
  path.join(repositoryRoot, "packaging", "templates", "install.sh.template"),
  "utf8",
);

const payload100 = "a".repeat(64);
const payload110 = "b".repeat(64);
const payload110ActivationFailure = "c".repeat(64);
const payload110ActivationHold = "d".repeat(64);
const payloadBadIdentity = "e".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(version, payload, mode = "normal") {
  return `VERSION='${version}'\nPAYLOAD='${payload}'\nMODE='${mode}'\n`;
}

function renderInstaller({ version, tarballSha256, payloadSha256 }) {
  const replacements = new Map([
    ["@@VERSION@@", version],
    ["@@TARBALL_URL@@", `https://fixture.invalid/cuna-cli-${version}.tgz`],
    ["@@TARBALL_SHA256@@", tarballSha256],
    ["@@PAYLOAD_SHA256@@", payloadSha256],
  ]);
  let rendered = installerTemplate.replace(/\r\n?/g, "\n");
  for (const [marker, replacement] of replacements) rendered = rendered.replaceAll(marker, replacement);
  assert.doesNotMatch(rendered, /@@[A-Z0-9_]+@@/);
  return rendered;
}

function base64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const artifact100 = artifact("1.0.0", payload100);
const artifact110 = artifact("1.1.0", payload110);
const artifact110ActivationFailure = artifact("1.1.0", payload110ActivationFailure, "fail-activation");
const artifact110ActivationHold = artifact("1.1.0", payload110ActivationHold, "hold-activation");
const artifactBadIdentity = artifact("1.2.0", payloadBadIdentity, "bad-identity");
const installer100 = renderInstaller({
  version: "1.0.0",
  tarballSha256: sha256(artifact100),
  payloadSha256: payload100,
});
const installer110 = renderInstaller({
  version: "1.1.0",
  tarballSha256: sha256(artifact110),
  payloadSha256: payload110,
});
const installer110BadDigest = renderInstaller({
  version: "1.1.0",
  tarballSha256: "0".repeat(64),
  payloadSha256: payload110,
});
const installer110ActivationFailure = renderInstaller({
  version: "1.1.0",
  tarballSha256: sha256(artifact110ActivationFailure),
  payloadSha256: payload110ActivationFailure,
});
const installer110ActivationHold = renderInstaller({
  version: "1.1.0",
  tarballSha256: sha256(artifact110ActivationHold),
  payloadSha256: payload110ActivationHold,
});
const installerBadIdentity = renderInstaller({
  version: "1.2.0",
  tarballSha256: sha256(artifactBadIdentity),
  payloadSha256: payloadBadIdentity,
});

function buildHarness() {
  return `#!/bin/sh
set -eu

ROOT="$(mktemp -d "\${TMPDIR:-/tmp}/cuna-installer-transactions.XXXXXX")"
background_pid=''
cleanup_harness() {
  if [ -n "$background_pid" ]; then
    kill "$background_pid" 2>/dev/null || true
    wait "$background_pid" 2>/dev/null || true
  fi
  case "$ROOT" in
    "\${TMPDIR:-/tmp}"/cuna-installer-transactions.*) rm -rf -- "$ROOT" ;;
    *) printf '%s\n' "unsafe harness root: $ROOT" >&2 ;;
  esac
}
trap cleanup_harness EXIT HUP INT TERM

fail() {
  printf '%s\n' "FAIL|$*" >&2
  exit 1
}

pass() {
  printf '%s\n' "PASS|$1"
}

assert_exists() {
  [ -e "$1" ] || [ -L "$1" ] || fail "expected path to exist: $1"
}

assert_absent() {
  [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected path to be absent: $1"
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected [$2], observed [$1]"
}

assert_contains() {
  grep -F -- "$2" "$1" >/dev/null 2>&1 || fail "expected $1 to contain: $2"
}

decode_file() {
  encoded="$1"
  output="$2"
  if printf '%s' "$encoded" | base64 --decode >"$output" 2>/dev/null; then
    :
  elif printf '%s' "$encoded" | base64 -D >"$output" 2>/dev/null; then
    :
  else
    fail 'a working base64 decoder is required by the isolated test harness'
  fi
}

FAKE_BIN="$ROOT/fake-bin"
FIXTURES="$ROOT/fixtures"
INSTALLERS="$ROOT/installers"
mkdir -p "$FAKE_BIN" "$FIXTURES" "$INSTALLERS"

decode_file ${shellQuote(base64(artifact100))} "$FIXTURES/1.0.0.tgz"
decode_file ${shellQuote(base64(artifact110))} "$FIXTURES/1.1.0.tgz"
decode_file ${shellQuote(base64(artifact110ActivationFailure))} "$FIXTURES/1.1.0-activation-failure.tgz"
decode_file ${shellQuote(base64(artifact110ActivationHold))} "$FIXTURES/1.1.0-activation-hold.tgz"
decode_file ${shellQuote(base64(artifactBadIdentity))} "$FIXTURES/1.2.0-bad-identity.tgz"
decode_file ${shellQuote(base64(installer100))} "$INSTALLERS/install-1.0.0.sh"
decode_file ${shellQuote(base64(installer110))} "$INSTALLERS/install-1.1.0.sh"
decode_file ${shellQuote(base64(installer110BadDigest))} "$INSTALLERS/install-1.1.0-bad-digest.sh"
decode_file ${shellQuote(base64(installer110ActivationFailure))} "$INSTALLERS/install-1.1.0-activation-failure.sh"
decode_file ${shellQuote(base64(installer110ActivationHold))} "$INSTALLERS/install-1.1.0-activation-hold.sh"
decode_file ${shellQuote(base64(installerBadIdentity))} "$INSTALLERS/install-1.2.0-bad-identity.sh"
chmod +x "$INSTALLERS"/*.sh

cat >"$FAKE_BIN/curl" <<'FAKE_CURL'
#!/bin/sh
set -eu
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] || exit 64
      output="$2"
      shift 2
      ;;
    --proto|--tlsv1.2)
      if [ "$1" = '--proto' ]; then shift 2; else shift; fi
      ;;
    --fail|--location|--show-error)
      shift
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$output" ] || exit 64
[ -f "\${CUNA_TARBALL_SOURCE:?}" ] || exit 66
if [ "\${CUNA_HOLD_CURL:-0}" = '1' ]; then
  : >"\${CUNA_HOLD_READY:?}"
  attempts=0
  while [ ! -e "\${CUNA_HOLD_RELEASE:?}" ] && [ "$attempts" -lt 100 ]; do
    sleep 0.05
    attempts=$((attempts + 1))
  done
  [ -e "$CUNA_HOLD_RELEASE" ] || exit 75
fi
cp "$CUNA_TARBALL_SOURCE" "$output"
FAKE_CURL

cat >"$FAKE_BIN/node" <<'FAKE_NODE'
#!/bin/sh
set -eu
[ "\${1:-}" = '-e' ] || exit 64
verifier="\${2:-}"
[ -n "$verifier" ] || exit 64
for required_check in \
  'record.schema_version !== "1"' \
  'record.type !== "result"' \
  'record.command !== "version"' \
  'data.version !== process.env.EXPECTED_VERSION' \
  'data.buildDigest !== process.env.EXPECTED_PAYLOAD_SHA256' \
  'data.platform !== process.platform' \
  'data.architecture !== process.arch' \
  'data.artifactChannel !== "npm"' \
  'data.protocolRange.minimum !== "1"' \
  'data.protocolRange.maximum !== "1"'
do
  printf '%s' "$verifier" | grep -F "$required_check" >/dev/null || {
    printf '%s\n' "fixture verifier omitted required check: $required_check" >&2
    exit 1
  }
done
input="$(cat)"
case "$(uname -s)" in
  Linux) expected_platform='linux' ;;
  Darwin) expected_platform='darwin' ;;
  *) exit 65 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) expected_architecture='x64' ;;
  arm64|aarch64) expected_architecture='arm64' ;;
  *) expected_architecture="$(uname -m)" ;;
esac
version_pattern='"version":"'"\${EXPECTED_VERSION:?}"'"'
digest_pattern='"buildDigest":"'"\${EXPECTED_PAYLOAD_SHA256:?}"'"'
printf '%s' "$input" | grep -F "$version_pattern" >/dev/null || {
  printf '%s\n' "fixture identity version mismatch: $input" >&2
  exit 1
}
printf '%s' "$input" | grep -F "$digest_pattern" >/dev/null || {
  printf '%s\n' "fixture identity digest mismatch: $input" >&2
  exit 1
}
printf '%s' "$input" | grep -F '"artifactChannel":"npm"' >/dev/null || {
  printf '%s\n' "fixture identity channel mismatch: $input" >&2
  exit 1
}
printf '%s' "$input" | grep -F '"schema_version":"1"' >/dev/null || exit 1
printf '%s' "$input" | grep -F '"type":"result"' >/dev/null || exit 1
printf '%s' "$input" | grep -F '"command":"version"' >/dev/null || exit 1
printf '%s' "$input" | grep -F '"platform":"'"$expected_platform"'"' >/dev/null || exit 1
printf '%s' "$input" | grep -F '"architecture":"'"$expected_architecture"'"' >/dev/null || exit 1
printf '%s' "$input" | grep -F '"protocolRange":{"minimum":"1","maximum":"1"}' >/dev/null || exit 1
FAKE_NODE

cat >"$FAKE_BIN/npm" <<'FAKE_NPM'
#!/bin/sh
set -eu
prefix=''
tarball=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      [ "$#" -ge 2 ] || exit 64
      prefix="$2"
      shift 2
      ;;
    --global|--ignore-scripts|--offline|--no-audit|--no-fund|install)
      shift
      ;;
    *)
      tarball="$1"
      shift
      ;;
  esac
done
[ -n "$prefix" ] && [ -f "$tarball" ] || exit 64
. "$tarball"
mkdir -p "$prefix/bin"
{
printf '%s\n' '#!/bin/sh' 'set -eu'
printf "fixture_version='%s'\\n" "$VERSION"
printf "fixture_payload='%s'\\n" "$PAYLOAD"
printf "fixture_mode='%s'\\n" "$MODE"
cat <<'FAKE_CUNA_BODY'
case "\${1:-}" in
  self-test)
    if [ "$fixture_mode" = 'fail-activation' ] || [ "$fixture_mode" = 'hold-activation' ]; then
      count_file="\${CUNA_FAKE_STATE:?}/self-test-$fixture_version"
      if [ -e "$count_file" ]; then
        if [ "$fixture_mode" = 'fail-activation' ]; then
          exit 70
        fi
        : >"\${CUNA_ACTIVATION_READY:?}"
        attempts=0
        while [ ! -e "\${CUNA_ACTIVATION_RELEASE:?}" ] && [ "$attempts" -lt 200 ]; do
          sleep 0.05
          attempts=$((attempts + 1))
        done
        [ -e "$CUNA_ACTIVATION_RELEASE" ] || exit 75
      fi
      : >"$count_file"
    fi
    printf '%s\n' '{"ok":true,"data":{"selfTest":"PASS"}}'
    ;;
  version)
    case "$(uname -s)" in
      Linux) fixture_platform='linux' ;;
      Darwin) fixture_platform='darwin' ;;
      *) exit 65 ;;
    esac
    case "$(uname -m)" in
      x86_64|amd64) fixture_architecture='x64' ;;
      arm64|aarch64) fixture_architecture='arm64' ;;
      *) fixture_architecture="$(uname -m)" ;;
    esac
    if [ "$fixture_mode" = 'bad-identity' ]; then
      printf '{"schema_version":"1","type":"result","command":"version","data":{"version":"%s","buildDigest":"%s","platform":"%s","architecture":"%s","artifactChannel":"npm"}}\\n' "$fixture_version" "$fixture_payload" "$fixture_platform" "$fixture_architecture"
    else
      printf '{"schema_version":"1","type":"result","command":"version","data":{"version":"%s","buildDigest":"%s","platform":"%s","architecture":"%s","artifactChannel":"npm","protocolRange":{"minimum":"1","maximum":"1"}}}\\n' "$fixture_version" "$fixture_payload" "$fixture_platform" "$fixture_architecture"
    fi
    ;;
  *)
    exit 64
    ;;
esac
FAKE_CUNA_BODY
} >"$prefix/bin/cuna"
chmod +x "$prefix/bin/cuna"
FAKE_NPM

CUNA_REAL_RM="$(command -v rm)"
CUNA_REAL_MV="$(command -v mv)"
export CUNA_REAL_RM CUNA_REAL_MV
cat >"$FAKE_BIN/rm" <<'FAKE_RM'
#!/bin/sh
set -eu
hold=0
if [ -n "\${CUNA_FAIL_CLEANUP_MATCH:-}" ]; then
  for argument in "$@"; do
    case "$argument" in
      *"$CUNA_FAIL_CLEANUP_MATCH"*)
        printf '%s\n' "injected cleanup failure: $argument" >&2
        exit 74
        ;;
    esac
  done
fi
if [ -n "\${CUNA_HOLD_RM_MATCH:-}" ]; then
  for argument in "$@"; do
    case "$argument" in *"$CUNA_HOLD_RM_MATCH"*) hold=1 ;; esac
  done
fi
"\${CUNA_REAL_RM:?}" "$@"
if [ "$hold" -eq 1 ]; then
  : >"\${CUNA_HOLD_READY:?}"
  attempts=0
  while [ ! -e "\${CUNA_HOLD_RELEASE:?}" ] && [ "$attempts" -lt 200 ]; do
    sleep 0.05
    attempts=$((attempts + 1))
  done
  [ -e "$CUNA_HOLD_RELEASE" ] || exit 75
fi
FAKE_RM

cat >"$FAKE_BIN/mv" <<'FAKE_MV'
#!/bin/sh
set -eu
hold=0
if [ -n "\${CUNA_HOLD_MV_MATCH:-}" ]; then
  for argument in "$@"; do
    case "$argument" in *"$CUNA_HOLD_MV_MATCH"*) hold=1 ;; esac
  done
fi
"\${CUNA_REAL_MV:?}" "$@"
if [ "$hold" -eq 1 ]; then
  : >"\${CUNA_HOLD_READY:?}"
  attempts=0
  while [ ! -e "\${CUNA_HOLD_RELEASE:?}" ] && [ "$attempts" -lt 200 ]; do
    sleep 0.05
    attempts=$((attempts + 1))
  done
  [ -e "$CUNA_HOLD_RELEASE" ] || exit 75
fi
FAKE_MV

chmod +x "$FAKE_BIN/curl" "$FAKE_BIN/node" "$FAKE_BIN/npm" "$FAKE_BIN/rm" "$FAKE_BIN/mv"
ORIGINAL_PATH="$PATH"
PATH="$FAKE_BIN:$ORIGINAL_PATH"
export PATH

new_environment() {
  name="$1"
  SCENARIO="$ROOT/scenarios/$name"
  HOME="$SCENARIO/home"
  XDG_DATA_HOME="$SCENARIO/data"
  XDG_BIN_HOME="$SCENARIO/bin"
  XDG_CONFIG_HOME="$SCENARIO/config"
  CUNA_FAKE_STATE="$SCENARIO/fake-state"
  mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_BIN_HOME" "$XDG_CONFIG_HOME" "$CUNA_FAKE_STATE"
  export HOME XDG_DATA_HOME XDG_BIN_HOME XDG_CONFIG_HOME CUNA_FAKE_STATE
}

run_success() {
  installer="$1"
  log="$2"
  shift 2
  "$installer" "$@" >"$log" 2>&1 || {
    sed -n '1,160p' "$log" >&2
    fail "installer unexpectedly failed: $installer"
  }
}

run_failure() {
  installer="$1"
  log="$2"
  shift 2
  if "$installer" "$@" >"$log" 2>&1; then
    fail "installer unexpectedly succeeded: $installer"
  fi
}

wait_for_file() {
  awaited_file="$1"
  attempts=0
  while [ ! -e "$awaited_file" ] && [ "$attempts" -lt 200 ]; do
    sleep 0.05
    attempts=$((attempts + 1))
  done
  assert_exists "$awaited_file"
}

recover_stale_lock_explicitly() {
  stale_lock="$XDG_BIN_HOME/.cuna-install.lock"
  [ -f "$stale_lock" ] && [ ! -L "$stale_lock" ] || fail 'expected a safe stale lock file'
  stale_pid="$(cat "$stale_lock")"
  case "$stale_pid" in ''|*[!0-9]*) fail 'stale lock owner PID is invalid' ;; esac
  if kill -0 "$stale_pid" 2>/dev/null; then
    fail "refusing test-only recovery of live lock owner $stale_pid"
  fi
  "$CUNA_REAL_RM" -f -- "$stale_lock"
}

new_environment initial-install
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
PATH="$XDG_BIN_HOME:$FAKE_BIN:$ORIGINAL_PATH"
export PATH
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
[ -L "$XDG_BIN_HOME/cuna" ] || fail 'initial install did not create a symbolic launcher'
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$XDG_DATA_HOME/cuna/versions/1.0.0/bin/cuna"
assert_contains "$SCENARIO/install.log" '"version":"1.0.0"'
assert_contains "$SCENARIO/install.log" 'Cuna CLI is available on PATH'
assert_equal "$(command -v cuna)" "$XDG_BIN_HOME/cuna"
cuna version --json >/dev/null || fail 'the public cuna command did not execute from PATH'
assert_absent "$XDG_BIN_HOME/.cuna-install.lock"
assert_exists "$XDG_BIN_HOME/.cuna-launcher-owner-v1"
PATH="$FAKE_BIN:$ORIGINAL_PATH"
export PATH
pass initial-install

new_environment idempotent-reinstall
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/first.log"
first_target="$(readlink "$XDG_BIN_HOME/cuna")"
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/second.log"
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$first_target"
directory_count=0
for version_entry in "$XDG_DATA_HOME/cuna/versions"/*; do
  [ -e "$version_entry" ] || [ -L "$version_entry" ] || continue
  if [ -d "$version_entry" ] && [ ! -L "$version_entry" ]; then
    directory_count=$((directory_count + 1))
  fi
done
assert_equal "$directory_count" '1'
[ -z "$(find "$XDG_DATA_HOME/cuna" -name '.download.*' -o -name '.staging-*')" ] || fail 'idempotent reinstall left temporary state'
pass idempotent-reinstall

new_environment version-upgrade
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/1.0.0.log"
CUNA_TARBALL_SOURCE="$FIXTURES/1.1.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.1.0.sh" "$SCENARIO/1.1.0.log"
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$XDG_DATA_HOME/cuna/versions/1.1.0/bin/cuna"
assert_exists "$XDG_DATA_HOME/cuna/versions/1.0.0/bin/cuna"
assert_exists "$XDG_DATA_HOME/cuna/versions/1.1.0/bin/cuna"
assert_contains "$SCENARIO/1.1.0.log" '"version":"1.1.0"'
pass version-upgrade

new_environment digest-failure-before-activation
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/1.0.0.log"
previous_target="$(readlink "$XDG_BIN_HOME/cuna")"
CUNA_TARBALL_SOURCE="$FIXTURES/1.1.0.tgz"
export CUNA_TARBALL_SOURCE
run_failure "$INSTALLERS/install-1.1.0-bad-digest.sh" "$SCENARIO/bad-digest.log"
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$previous_target"
assert_absent "$XDG_DATA_HOME/cuna/versions/1.1.0"
[ -z "$(find "$XDG_DATA_HOME/cuna" -name '.download.*' -o -name '.staging-*')" ] || fail 'digest failure left temporary state'
run_success "$INSTALLERS/install-1.1.0.sh" "$SCENARIO/good-digest.log"
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$XDG_DATA_HOME/cuna/versions/1.1.0/bin/cuna"
pass digest-failure-before-activation

new_environment activation-failure-restores-previous-version
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/1.0.0.log"
previous_target="$(readlink "$XDG_BIN_HOME/cuna")"
CUNA_TARBALL_SOURCE="$FIXTURES/1.1.0-activation-failure.tgz"
export CUNA_TARBALL_SOURCE
run_failure "$INSTALLERS/install-1.1.0-activation-failure.sh" "$SCENARIO/activation-failure.log"
assert_contains "$SCENARIO/activation-failure.log" 'Activation verification failed; the previous launcher was restored.'
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$previous_target"
"$XDG_BIN_HOME/cuna" self-test --offline --json >/dev/null || fail 'restored launcher is not healthy'
assert_absent "$XDG_BIN_HOME/.cuna-install.lock"
pass activation-failure-restores-previous-version

new_environment shared-bin-lock-contention-across-data-roots
first_data_home="$XDG_DATA_HOME"
shared_bin_home="$XDG_BIN_HOME"
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
CUNA_HOLD_CURL=1
CUNA_HOLD_READY="$SCENARIO/curl-ready"
CUNA_HOLD_RELEASE="$SCENARIO/curl-release"
export CUNA_TARBALL_SOURCE CUNA_HOLD_CURL CUNA_HOLD_READY CUNA_HOLD_RELEASE
"$INSTALLERS/install-1.0.0.sh" >"$SCENARIO/first.log" 2>&1 &
background_pid=$!
attempts=0
while [ ! -e "$CUNA_HOLD_READY" ] && [ "$attempts" -lt 100 ]; do
  sleep 0.05
  attempts=$((attempts + 1))
done
assert_exists "$CUNA_HOLD_READY"
XDG_DATA_HOME="$SCENARIO/alternate-data"
CUNA_FAKE_STATE="$SCENARIO/alternate-fake-state"
mkdir -p "$XDG_DATA_HOME" "$CUNA_FAKE_STATE"
export XDG_DATA_HOME CUNA_FAKE_STATE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/contender.log"
assert_contains "$SCENARIO/contender.log" 'Another Cuna install or uninstall operation is active.'
assert_equal "$XDG_BIN_HOME" "$shared_bin_home"
: >"$CUNA_HOLD_RELEASE"
wait "$background_pid" || {
  sed -n '1,160p' "$SCENARIO/first.log" >&2
  fail 'lock holder failed after contention was released'
}
background_pid=''
unset CUNA_HOLD_CURL CUNA_HOLD_READY CUNA_HOLD_RELEASE
XDG_DATA_HOME="$first_data_home"
CUNA_FAKE_STATE="$SCENARIO/fake-state"
export XDG_DATA_HOME CUNA_FAKE_STATE
assert_exists "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_BIN_HOME/.cuna-install.lock"
pass shared-bin-lock-contention-across-data-roots

new_environment killed-lock-owner-is-fail-closed-then-recovered
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
CUNA_HOLD_CURL=1
CUNA_HOLD_READY="$SCENARIO/killed-curl-ready"
CUNA_HOLD_RELEASE="$SCENARIO/killed-curl-release"
export CUNA_TARBALL_SOURCE CUNA_HOLD_CURL CUNA_HOLD_READY CUNA_HOLD_RELEASE
"$INSTALLERS/install-1.0.0.sh" >"$SCENARIO/killed-owner.log" 2>&1 &
background_pid=$!
attempts=0
while [ ! -e "$CUNA_HOLD_READY" ] && [ "$attempts" -lt 100 ]; do
  sleep 0.05
  attempts=$((attempts + 1))
done
assert_exists "$CUNA_HOLD_READY"
assert_exists "$XDG_BIN_HOME/.cuna-install.lock"
kill -9 "$background_pid"
wait "$background_pid" 2>/dev/null || true
background_pid=''
: >"$CUNA_HOLD_RELEASE"
unset CUNA_HOLD_CURL CUNA_HOLD_READY CUNA_HOLD_RELEASE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/stale-lock.log"
assert_contains "$SCENARIO/stale-lock.log" 'stale Cuna lifecycle lock requires explicit recovery'
recover_stale_lock_explicitly
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/recovered.log"
assert_exists "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_BIN_HOME/.cuna-install.lock"
assert_contains "$SCENARIO/recovered.log" '"version":"1.0.0"'
for stale_download in "$XDG_DATA_HOME/cuna"/.download.*; do
  [ -e "$stale_download" ] || [ -L "$stale_download" ] || continue
  fail "stale download workspace survived recovery: $stale_download"
done
pass killed-lock-owner-is-fail-closed-then-recovered

new_environment malformed-lock-owner-is-fail-closed
printf '%s\n' 'not-a-pid' >"$XDG_BIN_HOME/.cuna-install.lock"
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/empty-owner.log"
assert_contains "$SCENARIO/empty-owner.log" 'lock has no valid owner; recovery is fail-closed'
assert_absent "$XDG_BIN_HOME/cuna"
assert_exists "$XDG_BIN_HOME/.cuna-install.lock"
"$CUNA_REAL_RM" -f -- "$XDG_BIN_HOME/.cuna-install.lock"
pass malformed-lock-owner-is-fail-closed

new_environment first-install-failure-rolls-back-owned-state
CUNA_TARBALL_SOURCE="$FIXTURES/1.1.0.tgz"
export CUNA_TARBALL_SOURCE
run_failure "$INSTALLERS/install-1.1.0-bad-digest.sh" "$SCENARIO/bad-digest.log"
assert_absent "$XDG_DATA_HOME/cuna"
assert_absent "$XDG_BIN_HOME/cuna"
pass first-install-failure-rolls-back-owned-state

new_environment stale-workspace-bound-is-fail-closed
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
stale_index=1
while [ "$stale_index" -le 33 ]; do
  mkdir "$XDG_DATA_HOME/cuna/.download.stale-$stale_index"
  stale_index=$((stale_index + 1))
done
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/bounded.log"
assert_contains "$SCENARIO/bounded.log" 'Too many stale installer workspaces require manual inspection.'
assert_exists "$XDG_DATA_HOME/cuna/.download.stale-1"
assert_exists "$XDG_DATA_HOME/cuna/.download.stale-33"
"$CUNA_REAL_RM" -rf -- "$XDG_DATA_HOME/cuna"/.download.stale-*
pass stale-workspace-bound-is-fail-closed

new_environment killed-post-activation-restores-last-verified
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/1.0.0.log"
verified_target="$(readlink "$XDG_BIN_HOME/cuna")"
CUNA_TARBALL_SOURCE="$FIXTURES/1.1.0-activation-hold.tgz"
CUNA_ACTIVATION_READY="$SCENARIO/activation-ready"
CUNA_ACTIVATION_RELEASE="$SCENARIO/activation-release"
export CUNA_TARBALL_SOURCE CUNA_ACTIVATION_READY CUNA_ACTIVATION_RELEASE
"$INSTALLERS/install-1.1.0-activation-hold.sh" >"$SCENARIO/interrupted.log" 2>&1 &
background_pid=$!
attempts=0
while [ ! -e "$CUNA_ACTIVATION_READY" ] && [ "$attempts" -lt 100 ]; do
  sleep 0.05
  attempts=$((attempts + 1))
done
assert_exists "$CUNA_ACTIVATION_READY"
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$XDG_DATA_HOME/cuna/versions/1.1.0/bin/cuna"
assert_exists "$XDG_BIN_HOME/.cuna-activation-transaction-v1"
assert_contains "$XDG_BIN_HOME/.cuna-launcher-owner-v1" "target=$verified_target"
kill -9 "$background_pid"
wait "$background_pid" 2>/dev/null || true
background_pid=''
: >"$CUNA_ACTIVATION_RELEASE"
unset CUNA_ACTIVATION_READY CUNA_ACTIVATION_RELEASE
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/stale-lock.log"
assert_contains "$SCENARIO/stale-lock.log" 'stale Cuna lifecycle lock requires explicit recovery'
recover_stale_lock_explicitly
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/recovery.log"
assert_contains "$SCENARIO/recovery.log" 'restored the last verified launcher after an interrupted activation.'
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$verified_target"
assert_absent "$XDG_BIN_HOME/.cuna-activation-transaction-v1"
assert_absent "$XDG_BIN_HOME/.cuna-install.lock"
pass killed-post-activation-restores-last-verified

new_environment traversal-launcher-is-rejected
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
mkdir -p "$XDG_DATA_HOME/outside/bin"
cp "$XDG_DATA_HOME/cuna/versions/1.0.0/bin/cuna" "$XDG_DATA_HOME/outside/bin/cuna"
traversal_target="$XDG_DATA_HOME/cuna/versions/1.0.0/../../../outside/bin/cuna"
rm -f -- "$XDG_BIN_HOME/cuna"
ln -s "$traversal_target" "$XDG_BIN_HOME/cuna"
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/traversal.log"
assert_contains "$SCENARIO/traversal.log" 'Refusing to replace a launcher without canonical Cuna ownership evidence.'
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$traversal_target"
pass traversal-launcher-is-rejected

new_environment symlinked-runtime-bin-is-rejected
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
"$CUNA_REAL_MV" "$XDG_DATA_HOME/cuna/versions/1.0.0/bin" "$XDG_DATA_HOME/cuna/versions/1.0.0/bin-real"
ln -s "$XDG_DATA_HOME/cuna/versions/1.0.0/bin-real" "$XDG_DATA_HOME/cuna/versions/1.0.0/bin"
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/refusal.log"
assert_contains "$SCENARIO/refusal.log" 'Refusing to replace a launcher without canonical Cuna ownership evidence.'
assert_exists "$XDG_BIN_HOME/cuna"
pass symlinked-runtime-bin-is-rejected

new_environment control-character-owner-record-is-rejected
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
owner_target="$(readlink "$XDG_BIN_HOME/cuna")"
{
  printf '%s\n' 'schema=cuna-cli-launcher-owner-v1'
  printf 'target=%s\r\n' "$owner_target"
  printf 'data_root=%s\n' "$XDG_DATA_HOME/cuna"
  printf '%s\n' 'version=1.0.0'
  printf 'payload_sha256=%s\n' '${payload100}'
  printf '%s\n' 'verified=1'
} >"$XDG_BIN_HOME/.cuna-launcher-owner-v1"
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/uninstall.log" --uninstall
assert_contains "$SCENARIO/uninstall.log" 'without canonical Cuna ownership evidence'
assert_exists "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_BIN_HOME/.cuna-uninstall-transaction-v1"
pass control-character-owner-record-is-rejected

new_environment cleanup-fault-is-not-success
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
CUNA_FAIL_CLEANUP_MATCH='.download.'
export CUNA_TARBALL_SOURCE CUNA_FAIL_CLEANUP_MATCH
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/cleanup-fault.log"
assert_contains "$SCENARIO/cleanup-fault.log" 'Could not remove the verified download workspace.'
assert_contains "$SCENARIO/cleanup-fault.log" 'cleanup failed; inspect the Cuna install directories before retrying.'
assert_absent "$XDG_BIN_HOME/cuna"
unset CUNA_FAIL_CLEANUP_MATCH
for leftover in "$XDG_DATA_HOME/cuna"/.download.*; do
  [ -e "$leftover" ] || continue
  "$CUNA_REAL_RM" -rf -- "$leftover"
done
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/retry.log"
assert_exists "$XDG_BIN_HOME/cuna"
pass cleanup-fault-is-not-success

new_environment incomplete-runtime-identity-is-rejected
CUNA_TARBALL_SOURCE="$FIXTURES/1.2.0-bad-identity.tgz"
export CUNA_TARBALL_SOURCE
run_failure "$INSTALLERS/install-1.2.0-bad-identity.sh" "$SCENARIO/bad-identity.log"
assert_contains "$SCENARIO/bad-identity.log" 'Staged runtime identity differs from the candidate-bound release.'
assert_absent "$XDG_BIN_HOME/cuna"
pass incomplete-runtime-identity-is-rejected

new_environment non-cuna-launcher-refusal
printf '%s\n' 'foreign launcher sentinel' >"$XDG_BIN_HOME/cuna"
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/refusal.log"
assert_contains "$SCENARIO/refusal.log" 'Refusing to replace a non-Cuna launcher.'
[ ! -L "$XDG_BIN_HOME/cuna" ] || fail 'foreign launcher was replaced by a symlink'
assert_equal "$(cat "$XDG_BIN_HOME/cuna")" 'foreign launcher sentinel'
rm -f -- "$XDG_BIN_HOME/cuna"
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/retry.log"
[ -L "$XDG_BIN_HOME/cuna" ] || fail 'negative-control retry did not activate Cuna'
pass non-cuna-launcher-refusal

new_environment pristine-uninstall-is-no-op
printf '%s\n' 'neighbor data' >"$XDG_DATA_HOME/neighbor"
printf '%s\n' 'neighbor bin' >"$XDG_BIN_HOME/neighbor"
before_snapshot="$(find "$SCENARIO" -type f -print | LC_ALL=C sort)"
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/uninstall.log" --uninstall
after_snapshot="$(find "$SCENARIO" -type f ! -name uninstall.log -print | LC_ALL=C sort)"
expected_snapshot="$(printf '%s\n' "$before_snapshot" | grep -v '/uninstall.log$' || true)"
assert_equal "$after_snapshot" "$expected_snapshot"
assert_absent "$XDG_DATA_HOME/cuna"
assert_contains "$SCENARIO/uninstall.log" 'already absent; no files were changed'
pass pristine-uninstall-is-no-op

new_environment alternate-root-uninstall-does-not-mutate
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
original_root="$XDG_DATA_HOME"
original_target="$(readlink "$XDG_BIN_HOME/cuna")"
XDG_DATA_HOME="$SCENARIO/alternate-data"
export XDG_DATA_HOME
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/alternate-uninstall.log" --uninstall
assert_contains "$SCENARIO/alternate-uninstall.log" 'does not own the active Cuna launcher'
assert_absent "$XDG_DATA_HOME/cuna"
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$original_target"
XDG_DATA_HOME="$original_root"
export XDG_DATA_HOME
pass alternate-root-uninstall-does-not-mutate

new_environment uninstall-inventory-fails-before-mutation
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
target_before="$(readlink "$XDG_BIN_HOME/cuna")"
printf '%s\n' 'unknown state' >"$XDG_DATA_HOME/cuna/unknown-user-file"
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/uninstall.log" --uninstall
assert_contains "$SCENARIO/uninstall.log" 'contains unknown entries; uninstall made no changes'
assert_equal "$(readlink "$XDG_BIN_HOME/cuna")" "$target_before"
assert_exists "$XDG_BIN_HOME/.cuna-launcher-owner-v1"
assert_absent "$XDG_BIN_HOME/.cuna-uninstall-transaction-v1"
pass uninstall-inventory-fails-before-mutation

new_environment uninstall-does-not-execute-runtime-or-node
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
NO_NODE_BIN="$SCENARIO/no-node-bin"
mkdir -p "$NO_NODE_BIN"
cat >"$NO_NODE_BIN/node" <<'NO_NODE'
#!/bin/sh
printf '%s\n' 'node must not run during uninstall' >&2
exit 99
NO_NODE
chmod +x "$NO_NODE_BIN/node"
PATH="$NO_NODE_BIN:$FAKE_BIN:$ORIGINAL_PATH"
export PATH
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/uninstall.log" --uninstall
assert_absent "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_DATA_HOME/cuna"
PATH="$FAKE_BIN:$ORIGINAL_PATH"
export PATH
pass uninstall-does-not-execute-runtime-or-node

new_environment path-shadowing-is-reported
SHADOW_BIN="$SCENARIO/shadow-bin"
mkdir -p "$SHADOW_BIN"
cat >"$SHADOW_BIN/cuna" <<'SHADOW_CUNA'
#!/bin/sh
exit 88
SHADOW_CUNA
chmod +x "$SHADOW_BIN/cuna"
PATH="$SHADOW_BIN:$XDG_BIN_HOME:$FAKE_BIN:$ORIGINAL_PATH"
export PATH
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
assert_contains "$SCENARIO/install.log" "does not resolve to $XDG_BIN_HOME/cuna on PATH"
assert_equal "$(command -v cuna)" "$SHADOW_BIN/cuna"
PATH="$FAKE_BIN:$ORIGINAL_PATH"
export PATH
pass path-shadowing-is-reported

new_environment uninstall-recovers-after-launcher-detach-kill
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
CUNA_HOLD_MV_MATCH='.cuna-uninstall-launcher-v1'
CUNA_HOLD_READY="$SCENARIO/uninstall-launcher-ready"
CUNA_HOLD_RELEASE="$SCENARIO/uninstall-launcher-release"
export CUNA_HOLD_MV_MATCH CUNA_HOLD_READY CUNA_HOLD_RELEASE
"$INSTALLERS/install-1.0.0.sh" --uninstall >"$SCENARIO/interrupted.log" 2>&1 &
background_pid=$!
wait_for_file "$CUNA_HOLD_READY"
kill -9 "$background_pid"
wait "$background_pid" 2>/dev/null || true
background_pid=''
: >"$CUNA_HOLD_RELEASE"
  sleep 0.1
  unset CUNA_HOLD_MV_MATCH CUNA_HOLD_READY CUNA_HOLD_RELEASE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/stale-lock.log" --uninstall
assert_contains "$SCENARIO/stale-lock.log" 'stale Cuna lifecycle lock requires explicit recovery'
recover_stale_lock_explicitly
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/recovery.log" --uninstall
assert_absent "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_DATA_HOME/cuna"
assert_absent "$XDG_BIN_HOME/.cuna-uninstall-transaction-v1"
pass uninstall-recovers-after-launcher-detach-kill

new_environment uninstall-recovers-after-owner-detach-kill
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
CUNA_HOLD_MV_MATCH='.cuna-uninstall-owner-v1'
CUNA_HOLD_READY="$SCENARIO/uninstall-owner-ready"
CUNA_HOLD_RELEASE="$SCENARIO/uninstall-owner-release"
export CUNA_HOLD_MV_MATCH CUNA_HOLD_READY CUNA_HOLD_RELEASE
"$INSTALLERS/install-1.0.0.sh" --uninstall >"$SCENARIO/interrupted.log" 2>&1 &
background_pid=$!
wait_for_file "$CUNA_HOLD_READY"
kill -9 "$background_pid"
wait "$background_pid" 2>/dev/null || true
background_pid=''
: >"$CUNA_HOLD_RELEASE"
sleep 0.1
unset CUNA_HOLD_MV_MATCH CUNA_HOLD_READY CUNA_HOLD_RELEASE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/stale-lock.log" --uninstall
assert_contains "$SCENARIO/stale-lock.log" 'stale Cuna lifecycle lock requires explicit recovery'
recover_stale_lock_explicitly
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/recovery.log" --uninstall
assert_absent "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_DATA_HOME/cuna"
pass uninstall-recovers-after-owner-detach-kill

new_environment uninstall-recovers-after-data-delete-kill
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
CUNA_HOLD_RM_MATCH='/versions'
CUNA_HOLD_READY="$SCENARIO/uninstall-data-ready"
CUNA_HOLD_RELEASE="$SCENARIO/uninstall-data-release"
export CUNA_HOLD_RM_MATCH CUNA_HOLD_READY CUNA_HOLD_RELEASE
"$INSTALLERS/install-1.0.0.sh" --uninstall >"$SCENARIO/interrupted.log" 2>&1 &
background_pid=$!
wait_for_file "$CUNA_HOLD_READY"
kill -9 "$background_pid"
wait "$background_pid" 2>/dev/null || true
background_pid=''
: >"$CUNA_HOLD_RELEASE"
sleep 0.1
unset CUNA_HOLD_RM_MATCH CUNA_HOLD_READY CUNA_HOLD_RELEASE
run_failure "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/stale-lock.log" --uninstall
assert_contains "$SCENARIO/stale-lock.log" 'stale Cuna lifecycle lock requires explicit recovery'
recover_stale_lock_explicitly
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/recovery.log" --uninstall
assert_absent "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_DATA_HOME/cuna"
pass uninstall-recovers-after-data-delete-kill

new_environment uninstall-preserves-user-state
mkdir -p "$XDG_CONFIG_HOME/cuna"
printf '%s\n' 'user configuration sentinel' >"$XDG_CONFIG_HOME/cuna/config.json"
printf '%s\n' 'neighbor data sentinel' >"$XDG_DATA_HOME/neighbor.txt"
printf '%s\n' 'neighbor bin sentinel' >"$XDG_BIN_HOME/neighbor"
CUNA_TARBALL_SOURCE="$FIXTURES/1.0.0.tgz"
export CUNA_TARBALL_SOURCE
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/install.log"
run_success "$INSTALLERS/install-1.0.0.sh" "$SCENARIO/reinstall.log"
"$INSTALLERS/install-1.0.0.sh" --uninstall >"$SCENARIO/uninstall.log" 2>&1 || {
  sed -n '1,160p' "$SCENARIO/uninstall.log" >&2
  fail 'uninstall unexpectedly failed'
}
assert_absent "$XDG_BIN_HOME/cuna"
assert_absent "$XDG_DATA_HOME/cuna"
assert_contains "$XDG_CONFIG_HOME/cuna/config.json" 'user configuration sentinel'
assert_contains "$XDG_DATA_HOME/neighbor.txt" 'neighbor data sentinel'
assert_contains "$XDG_BIN_HOME/neighbor" 'neighbor bin sentinel'
assert_contains "$SCENARIO/uninstall.log" 'user configuration was preserved'
pass uninstall-preserves-user-state
`;
}

/**
 * WSL2 stops its utility VM after roughly a minute of idle, and no other test
 * in this suite touches WSL, so this test almost always pays a cold boot.
 * Measured on this host: cold boot 3.8-6.0 s on an idle machine, warm probe
 * 0.29 s, harness 16.3 s.
 *
 * The previous budgets were 20 s (probe), 45 s (harness) and a 60 s test
 * timeout, which produced two distinct defects.
 *
 * First, 20 + 45 = 65 > 60. Both inner budgets could be respected while the
 * outer timeout still failed the test, so the arithmetic -- not the machine --
 * made a false red reachable.
 *
 * Second, and worse: a probe that merely ran slowly was reported as
 * `WSL POSIX shell is unavailable`, so the test skipped and the suite stayed
 * green while every assertion below silently did not run. Slowness and absence
 * are different conditions; collapsing them into one outcome turns a loaded
 * machine into missing coverage that nothing reports.
 *
 * So: budgets wide enough that only a genuinely broken shell exceeds them, one
 * retry so the first attempt pays the cold boot and the second meets a warm VM,
 * an outer timeout strictly greater than the sum of the inner ones, and a
 * timeout that fails loudly instead of skipping quietly. Absence still skips --
 * a host without WSL cannot run this and should say so.
 */
const PROBE_BUDGET_MS = 60_000;
const PROBE_ATTEMPTS = 2;
const HARNESS_BUDGET_MS = 180_000;
const SHELL_TEST_TIMEOUT_MS = PROBE_BUDGET_MS * PROBE_ATTEMPTS + HARNESS_BUDGET_MS + 30_000;
const HARNESS_TIMEOUT_CODE = "posix_harness_timeout";

function runProcess(command, args, input, timeoutMs = HARNESS_BUDGET_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const maximumOutputBytes = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const timeout = new Error(`POSIX harness exceeded its ${timeoutMs}ms budget`);
      // Classified so the caller can tell a slow shell from an absent one.
      timeout.code = HARNESS_TIMEOUT_CODE;
      finish(timeout);
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }

    function collect(chunk, stream) {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error("POSIX harness exceeded its 4 MiB output budget"));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    }

    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => finish(undefined, { code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * Resolves a probe into exactly one of four conditions, so that no two of them
 * can be mistaken for each other downstream:
 *
 *   ready    -- the shell answered with its marker
 *   absent   -- the interpreter could not be spawned at all (no WSL installed)
 *   timedOut -- the interpreter exists but never answered inside its budget
 *   failed   -- the interpreter answered, but not with the expected marker
 */
async function probeShell(command, args, input, marker) {
  let lastTimeout;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    try {
      const probe = await runProcess(command, args, input, PROBE_BUDGET_MS);
      if (probe.code === 0 && probe.stdout.includes(marker)) return { ready: true };
      return { failed: probe.stderr || probe.stdout || `exit ${probe.code}` };
    } catch (error) {
      if (error?.code === HARNESS_TIMEOUT_CODE) {
        lastTimeout = error;
        continue;
      }
      return { absent: error.message };
    }
  }
  return { timedOut: lastTimeout.message };
}

async function selectShell() {
  if (process.platform === "win32") {
    const probe = await probeShell(
      "wsl.exe",
      ["--exec", "sh", "-s"],
      "command -v sh >/dev/null 2>&1 || exit 127\nprintf 'WSL_POSIX_READY\\n'\n",
      "WSL_POSIX_READY",
    );
    if (probe.ready) return { command: "wsl.exe", args: ["--exec", "sh", "-s"], identity: "WSL POSIX sh" };
    if (probe.absent) return { unavailable: `WSL is not installed on this host: ${probe.absent}` };
    if (probe.timedOut) {
      return {
        unusable: `WSL is installed but presented no POSIX shell within ${PROBE_BUDGET_MS} ms across ${PROBE_ATTEMPTS} attempts, so installer atomicity went unverified: ${probe.timedOut}`,
      };
    }
    return { unavailable: `WSL exists but its POSIX shell probe failed: ${probe.failed}` };
  }

  const probe = await probeShell("/bin/sh", ["-s"], "printf 'NATIVE_POSIX_READY\\n'\n", "NATIVE_POSIX_READY");
  if (probe.ready) return { command: "/bin/sh", args: ["-s"], identity: "native /bin/sh" };
  if (probe.absent) return { unavailable: `native POSIX shell is not installed on this host: ${probe.absent}` };
  if (probe.timedOut) {
    return {
      unusable: `native /bin/sh did not answer within ${PROBE_BUDGET_MS} ms across ${PROBE_ATTEMPTS} attempts, so installer atomicity went unverified: ${probe.timedOut}`,
    };
  }
  return { unavailable: `native POSIX shell probe failed: ${probe.failed}` };
}

test("curl installer preserves atomicity, ownership, idempotency, and recovery in a real POSIX shell", { timeout: SHELL_TEST_TIMEOUT_MS }, async (t) => {
  const shell = await selectShell();
  // A host with no POSIX shell genuinely cannot run this. A host whose shell
  // exists but never answered is a silent hole in the installer's coverage, and
  // must be reported as a failure rather than absorbed as a skip.
  if (shell.unusable) assert.fail(shell.unusable);
  if (shell.unavailable) {
    t.skip(shell.unavailable);
    return;
  }

  const result = await runProcess(shell.command, shell.args, buildHarness(), HARNESS_BUDGET_MS);
  assert.equal(
    result.code,
    0,
    `${shell.identity} transaction harness failed${result.signal ? ` with signal ${result.signal}` : ""}:\n${result.stdout}\n${result.stderr}`,
  );
  assert.equal(result.signal, null);
  const passes = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("PASS|"))
    .map((line) => line.slice("PASS|".length));
  assert.deepEqual(passes, [
    "initial-install",
    "idempotent-reinstall",
    "version-upgrade",
    "digest-failure-before-activation",
    "activation-failure-restores-previous-version",
    "shared-bin-lock-contention-across-data-roots",
    "killed-lock-owner-is-fail-closed-then-recovered",
    "malformed-lock-owner-is-fail-closed",
    "first-install-failure-rolls-back-owned-state",
    "stale-workspace-bound-is-fail-closed",
    "killed-post-activation-restores-last-verified",
    "traversal-launcher-is-rejected",
    "symlinked-runtime-bin-is-rejected",
    "control-character-owner-record-is-rejected",
    "cleanup-fault-is-not-success",
    "incomplete-runtime-identity-is-rejected",
    "non-cuna-launcher-refusal",
    "pristine-uninstall-is-no-op",
    "alternate-root-uninstall-does-not-mutate",
    "uninstall-inventory-fails-before-mutation",
    "uninstall-does-not-execute-runtime-or-node",
    "path-shadowing-is-reported",
    "uninstall-recovers-after-launcher-detach-kill",
    "uninstall-recovers-after-owner-detach-kill",
    "uninstall-recovers-after-data-delete-kill",
    "uninstall-preserves-user-state",
  ]);
  assert.doesNotMatch(result.stdout, /^FAIL\|/m);
  assert.doesNotMatch(result.stderr, /^FAIL\|/m);
});
