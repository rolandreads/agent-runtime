#!/usr/bin/env bash
set -euo pipefail

required_exclusions=(
  data
  .env
  '*.env'
  'secrets.*'
  '*.key'
  '*.pem'
  '*.db'
  '*.db-shm'
  '*.db-wal'
  '*.sqlite'
  '*.sqlite3'
  '*.dump'
  '*.bak'
  id_rsa
  id_ed25519
)

for exclusion in "${required_exclusions[@]}"; do
  grep --fixed-strings --line-regexp --quiet "${exclusion}" .dockerignore \
    || { echo ".dockerignore must exclude ${exclusion}" >&2; exit 1; }
done
