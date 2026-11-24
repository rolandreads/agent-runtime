#!/usr/bin/env bash
set -euo pipefail

started_ns="$(date +%s%N)"

finish() {
  status=$?
  duration_ms=$(( ($(date +%s%N) - started_ns) / 1000000 ))
  if [[ "${status}" -eq 0 ]]; then
    outcome="passed"
  else
    outcome="failed"
  fi
  printf '{"type":"pipeline_timing","scope":"validation","phase":"total","event":"completed","status":"%s","durationMs":%d}\n' "${outcome}" "${duration_ms}"
}
trap finish EXIT

scripts/log-cicd-timing.sh validation commit_diff -- git show --check --format= HEAD

pids=()
status=0
scripts/log-cicd-timing.sh validation typecheck -- bun run typecheck & pids+=("$!")
scripts/log-cicd-timing.sh validation lint -- bun run lint & pids+=("$!")
scripts/log-cicd-timing.sh validation test -- bun test --parallel & pids+=("$!")
scripts/log-cicd-timing.sh validation build -- bun run build & pids+=("$!")
scripts/log-cicd-timing.sh validation secret_scan -- bun run secrets:scan & pids+=("$!")
scripts/log-cicd-timing.sh validation container_build_context -- scripts/verify-container-build-context-exclusions.sh & pids+=("$!")
scripts/log-cicd-timing.sh validation shell_syntax -- scripts/verify-shell-syntax.sh & pids+=("$!")
for pid in "${pids[@]}"; do
  wait "${pid}" || status=1
done
[[ "${status}" -eq 0 ]]
