#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-agent-runtime}"
APP_HOME="${APP_HOME:-/var/lib/${APP_USER}}"
ENV_FILE="${1:-${APP_HOME}/.config/agent-runtime/env}"
RULE_FILE="${RUNTIME_EGRESS_NFT_FILE:-/etc/nftables.d/agent-runtime.nft}"
STATUS_FILE="${RUNTIME_EGRESS_STATUS_FILE:-/run/agent-runtime/egress-status.env}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  echo "missing egress user: ${APP_USER}" >&2
  exit 1
fi

if [[ ! -r "${ENV_FILE}" ]]; then
  echo "missing env file: ${ENV_FILE}" >&2
  exit 1
fi

for tool in awk curl date getent jq nft sha256sum stat; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "missing required command: ${tool}" >&2
    exit 1
  fi
done

tmp="$(mktemp)"
status_tmp="$(mktemp)"
trap 'rm -f "${tmp}" "${status_tmp}"' EXIT

env \
  APP_USER="${APP_USER}" \
  RUNTIME_EGRESS_USER="${APP_USER}" \
  "${SCRIPT_DIR}/egress-nft-render.sh" "${ENV_FILE}" > "${tmp}"

if [[ ! -s "${tmp}" ]]; then
  echo "rendered nft ruleset is empty" >&2
  exit 1
fi

if ! grep -q "meta skuid \"${APP_USER}\"" "${tmp}"; then
  echo "rendered nft ruleset does not target ${APP_USER}" >&2
  exit 1
fi

APP_UID="$(id -u "${APP_USER}")"
if [[ -z "${APP_UID}" ]]; then
  echo "unable to resolve UID for ${APP_USER}" >&2
  exit 1
fi

nft -c -f "${tmp}"

rendered_hash="$(sha256sum "${tmp}" | awk '{print $1}')"
installed_hash=""
if [[ -f "${RULE_FILE}" ]]; then
  installed_hash="$(sha256sum "${RULE_FILE}" | awk '{print $1}')"
fi

if [[ "${rendered_hash}" == "${installed_hash}" ]] && nft list table inet runtime >/dev/null 2>&1; then
  apply_action="unchanged"
else
  install -D -m 0644 "${tmp}" "${RULE_FILE}"
  nft -f "${RULE_FILE}"
  apply_action="applied"
fi

cat > "${status_tmp}" <<EOF
APP_USER=${APP_USER}
APP_UID=${APP_UID}
RULE_FILE=${RULE_FILE}
RULE_SHA256=${rendered_hash}
APPLIED_AT_UNIX=$(date +%s)
EOF
install -D -o root -g root -m 0644 "${status_tmp}" "${STATUS_FILE}"

echo "${apply_action} agent-runtime egress nftables rules for ${APP_USER}: ${RULE_FILE}"
