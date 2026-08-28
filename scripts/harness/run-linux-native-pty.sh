#!/usr/bin/env bash
set -euo pipefail

readonly node_version="v24.4.1"
readonly archive_name="node-${node_version}-linux-x64.tar.xz"
readonly expected_sha256="7e067b13cd0dc7ee8b239f4ebe1ae54f3bba3a6e904553fcb5f581530eb8306d"
readonly archive_path="/tmp/cuna-${archive_name}"
readonly runtime_path="/tmp/cuna-node-${node_version}-linux-x64"
readonly repository_path="$(pwd -P)"

command -v curl >/dev/null
command -v sha256sum >/dev/null
command -v tar >/dev/null
command -v script >/dev/null

if [[ ! -f "${archive_path}" ]]; then
  curl --fail --silent --show-error --location "https://nodejs.org/dist/${node_version}/${archive_name}" --output "${archive_path}"
fi
printf '%s  %s\n' "${expected_sha256}" "${archive_path}" | sha256sum --check --status

if [[ ! -x "${runtime_path}/bin/node" ]]; then
  stage_path="$(mktemp -d /tmp/cuna-linux-node.XXXXXX)"
  cleanup_stage() {
    case "${stage_path}" in
      /tmp/cuna-linux-node.*) rm -rf -- "${stage_path}" ;;
      *) printf 'unsafe temporary path: %s\n' "${stage_path}" >&2; exit 70 ;;
    esac
  }
  trap cleanup_stage EXIT
  tar --extract --xz --file "${archive_path}" --directory "${stage_path}"
  mv -- "${stage_path}/node-${node_version}-linux-x64" "${runtime_path}"
  cleanup_stage
  trap - EXIT
fi

readonly node_binary="${runtime_path}/bin/node"
test "$(od -An -tx1 -N4 "${node_binary}" | tr -d ' \n')" = "7f454c46"
readonly probe="${repository_path}/scripts/harness/linux-native-pty-probe.mjs"
readonly entrypoint="${repository_path}/dist/bin/cuna.js"
test -f "${probe}"
test -f "${entrypoint}"

script --quiet --return --command "${node_binary} ${probe} ${entrypoint}" /dev/null
