#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mapfile -d '' files < <(find infra scripts -type f -name '*.sh' -print0 | sort -z)
bash -n "${files[@]}"
