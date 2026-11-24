#!/usr/bin/env bash
set -uo pipefail

scope="${1:-}"
phase="${2:-}"
shift 2 || true
[[ "${1:-}" == "--" ]] && shift
[[ "${scope}" =~ ^[a-z0-9_]+$ && "${phase}" =~ ^[a-z0-9_]+$ && "$#" -gt 0 ]] \
  || { echo "usage: $0 <scope> <phase> -- <command> [args...]" >&2; exit 2; }

started_ns="$(date +%s%N)"
printf '{"type":"pipeline_timing","scope":"%s","phase":"%s","event":"started","startedAt":"%s"}\n' \
  "${scope}" "${phase}" "$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')"
"$@"
status=$?
outcome=passed
[[ "${status}" -eq 0 ]] || outcome=failed
printf '{"type":"pipeline_timing","scope":"%s","phase":"%s","event":"completed","status":"%s","durationMs":%d}\n' \
  "${scope}" "${phase}" "${outcome}" "$(( ($(date +%s%N) - started_ns) / 1000000 ))"
exit "${status}"
