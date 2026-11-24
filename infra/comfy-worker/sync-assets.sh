#!/bin/bash
# SF:HUMAN Comfy asset sync.
#
# Downloads only the model assets listed in RUNTIME_ASSET_MANIFEST_B64.
# Existing files with the expected byte size are skipped.
# Missing or invalid files are downloaded to a temp file, size-checked,
# then atomically moved into the Comfy models directory.

set -euo pipefail

SYNC_LOG="/var/log/agent-runtime-comfy-asset-sync.log"
mkdir -p "$(dirname "$SYNC_LOG")"

log() {
    local now
    local line
    local log_dir
    now="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    line="[$now] [asset-sync] $1"
    log_dir="$(dirname "$SYNC_LOG")"
    echo "$line"
    if { [ -f "$SYNC_LOG" ] && [ -w "$SYNC_LOG" ]; } || { [ ! -e "$SYNC_LOG" ] && [ -w "$log_dir" ]; }; then
        printf '%s\n' "$line" >> "$SYNC_LOG"
    fi
}

fatal() {
    log "FATAL: $1"
    exit 1
}

SYNC_START="$(date +%s%N)"
# Tune both from the MB/s figures in the DONE and RESULT log lines, not by guess.
CONNECTIONS_PER_ASSET=16
ASSET_DOWNLOAD_JOBS=2

[ -z "${RUNTIME_ASSET_MANIFEST_B64:-}" ] && fatal "RUNTIME_ASSET_MANIFEST_B64 is required"
command -v flock >/dev/null 2>&1 || fatal "flock is required"

MODELS_ROOT="/opt/workspace-internal/ComfyUI/models"
[ -d "$MODELS_ROOT" ] || fatal "Comfy models directory not found: $MODELS_ROOT"

LORA_DIR="$MODELS_ROOT/loras"
DIFFUSION_DIR="$MODELS_ROOT/diffusion_models"
TE_DIR="$MODELS_ROOT/text_encoders"
VAE_DIR="$MODELS_ROOT/vae"
UPSCALE_DIR="$MODELS_ROOT/upscale_models"
LOCK_DIR="$MODELS_ROOT/.agent-runtime-asset-locks"
mkdir -p "$LORA_DIR" "$DIFFUSION_DIR" "$TE_DIR" "$VAE_DIR" "$UPSCALE_DIR" "$LOCK_DIR"

MANIFEST_JSON_FILE="$(mktemp)"
MANIFEST_FILE="$(mktemp)"
trap 'rm -f "$MANIFEST_JSON_FILE" "$MANIFEST_FILE"' EXIT
printf '%s' "$RUNTIME_ASSET_MANIFEST_B64" | base64 -d > "$MANIFEST_JSON_FILE" \
    || fatal "Failed to decode asset manifest"

resolve_manifest_dir() {
    case "$1" in
        checkpoints) echo "$MODELS_ROOT/checkpoints" ;;
        loras) echo "$LORA_DIR" ;;
        diffusion_models) echo "$DIFFUSION_DIR" ;;
        text_encoders) echo "$TE_DIR" ;;
        vae) echo "$VAE_DIR" ;;
        upscale_models) echo "$UPSCALE_DIR" ;;
        detailpass_bbox) echo "$MODELS_ROOT/ultralytics/bbox" ;;
        detailpass_sam) echo "$MODELS_ROOT/sams" ;;
        *) return 1 ;;
    esac
}

file_size() {
    stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0
}

asset_lock_name() {
    printf '%s__%s' "$1" "$2" | tr -c 'A-Za-z0-9._-' '_'
}

# Workers reuse a libcurl connection across 32MiB ranges, writing directly at each offset.
# A failed range retries on a fresh connection with the same four-second deadline.
download_to_temp_file() {
    /usr/bin/python3 - "$1" "$2" "$3" "$CONNECTIONS_PER_ASSET" <<'PY' | while IFS= read -r line; do log "$line"; done
import concurrent.futures
import math
import os
import pycurl
import sys
import threading
import time
from urllib.parse import urlsplit

dest, size, url, workers = sys.argv[1:]
size = int(size)
chunk_size = 32 * 1024 * 1024
# Allow 32 MiB chunks to finish on slower model hosts without discarding progress.
timeout_seconds = 30
asset_started = time.monotonic()
local = threading.local()
handles = []
headers = []
host = urlsplit(url).hostname or ''
token = os.environ.get('RUNTIME_HF_TOKEN')
if token and (host == 'huggingface.co' or host.endswith('.huggingface.co')):
    headers = [f'Authorization: Bearer {token}']

def create_connection():
    curl = pycurl.Curl()
    curl.setopt(pycurl.URL, url)
    curl.setopt(pycurl.USERAGENT, 'agent-runtime/1.0')
    curl.setopt(pycurl.NOSIGNAL, 1)
    curl.setopt(pycurl.FOLLOWLOCATION, 1)
    curl.setopt(pycurl.FAILONERROR, 1)
    curl.setopt(pycurl.TIMEOUT_MS, timeout_seconds * 1000)
    curl.setopt(pycurl.BUFFERSIZE, 1024 * 1024)
    curl.setopt(pycurl.HTTPHEADER, headers)
    local.curl = curl
    handles.append(curl)

def download_range(start):
    curl = local.curl
    end = min(start + chunk_size, size) - 1
    length = end - start + 1
    started = time.monotonic()
    wasted_bytes = timeouts = zero_byte_timeouts = new_connections = reused_transfers = 0
    attempt_ms = []
    for attempt in range(1, 5):
        downloaded = 0
        with open(dest, 'r+b', buffering=0) as output:
            output.seek(start)
            def write(data):
                nonlocal downloaded
                if downloaded + len(data) > length:
                    return 0
                output.write(data)
                downloaded += len(data)
                return len(data)
            curl.setopt(pycurl.WRITEFUNCTION, write)
            curl.setopt(pycurl.RANGE, f'{start}-{end}')
            curl.setopt(pycurl.MAXFILESIZE_LARGE, length)
            curl.setopt(pycurl.FRESH_CONNECT, int(attempt > 1))
            attempt_started = time.monotonic()
            code = 0
            try:
                curl.perform()
            except pycurl.error as error:
                code = error.args[0]
            elapsed_ms = (time.monotonic() - attempt_started) * 1000
        connects = curl.getinfo(pycurl.NUM_CONNECTS)
        status_code = curl.getinfo(pycurl.RESPONSE_CODE)
        done = code == 0 and downloaded == length and status_code in (200, 206)
        reused = done and connects == 0 and curl.getinfo(pycurl.REDIRECT_COUNT) == 0
        attempt_ms.append(elapsed_ms)
        timeouts += code == 28
        zero_byte_timeouts += code == 28 and downloaded == 0
        new_connections += connects
        reused_transfers += reused
        status = 'CHUNK' if done else 'RETRY' if attempt < 4 else 'ERROR'
        print(f'{status} {os.path.basename(dest)} range={start}-{end} attempt={attempt}/4 bytes={downloaded}/{length} elapsed_ms={elapsed_ms:.0f} mib_s={downloaded / 1048576 / max(elapsed_ms / 1000, 0.001):.2f} curl_exit={code} http_status={status_code} new_connections={connects} reused={int(reused)} ttfb_ms={curl.getinfo(pycurl.STARTTRANSFER_TIME) * 1000:.0f}', flush=True)
        if done:
            break
        wasted_bytes += downloaded
    return {'done': done, 'full': length == chunk_size, 'elapsed_ms': (time.monotonic() - started) * 1000, 'attempt_ms': attempt_ms, 'wasted_bytes': wasted_bytes, 'timeouts': timeouts, 'zero_byte_timeouts': zero_byte_timeouts, 'new_connections': new_connections, 'reused_transfers': reused_transfers}

try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(workers), initializer=create_connection) as pool:
        results = list(pool.map(download_range, range(0, size, chunk_size)))
finally:
    for curl in handles:
        curl.close()
full_ms = sorted(r['attempt_ms'][-1] for r in results if r['done'] and r['full'])
total_ms = sorted(r['elapsed_ms'] for r in results)
def percentile(values, fraction):
    return f'{values[max(0, math.ceil(len(values) * fraction) - 1)]:.0f}' if values else 'na'
average = f'{sum(full_ms) / len(full_ms):.0f}' if full_ms else 'na'
elapsed = time.monotonic() - asset_started
speed = f'{size / 1048576 / max(elapsed, 0.001):.2f}' if all(r['done'] for r in results) else 'na'
print(f'CHUNK_SUMMARY {os.path.basename(dest)} chunks={len(results)} failed={sum(not r["done"] for r in results)} attempts={sum(len(r["attempt_ms"]) for r in results)} retry_bytes={sum(r["wasted_bytes"] for r in results)} retries={sum(len(r["attempt_ms"]) - 1 for r in results)} timeouts={sum(r["timeouts"] for r in results)} zero_byte_timeouts={sum(r["zero_byte_timeouts"] for r in results)} chunk_mib={chunk_size // 1048576} timeout_s={timeout_seconds} new_connections={sum(r["new_connections"] for r in results)} reused_transfers={sum(r["reused_transfers"] for r in results)} elapsed_ms={elapsed * 1000:.0f} effective_mib_s={speed} full_success_chunks={len(full_ms)} full_success_avg_ms={average} full_success_p95_ms={percentile(full_ms, 0.95)} full_success_max_ms={percentile(full_ms, 1)} chunk_with_retries_p95_ms={percentile(total_ms, 0.95)} chunk_with_retries_max_ms={percentile(total_ms, 1)}', flush=True)
sys.exit(0 if all(r['done'] for r in results) else 1)
PY
}

normalize_manifest() {
    python3 - "$MANIFEST_JSON_FILE" "$MANIFEST_FILE" <<'PY'
import json
import sys

manifest_json_path, manifest_tsv_path = sys.argv[1], sys.argv[2]
with open(manifest_json_path, "r", encoding="utf-8") as handle:
    entries = json.load(handle)
with open(manifest_tsv_path, "w", encoding="utf-8") as output:
    for entry in entries:
        output.write(f"{entry['group']}\t{entry['filename']}\t{entry['sizeBytes']}\t{entry['url']}\n")
PY
}

download_plan() {
    local group="" filename="" expected_size="" url="" bytes=0 count=0 skipped=0
    local dest_dir dest actual_size
    while IFS=$'\t' read -r group filename expected_size url || [ -n "${group}${filename}${expected_size}${url}" ]; do
        [ -z "$group" ] && continue
        dest_dir="$(resolve_manifest_dir "$group")"
        dest="$dest_dir/$filename"
        if [ -f "$dest" ]; then
            actual_size="$(file_size "$dest")"
            if [ "$actual_size" -eq "$expected_size" ]; then
                skipped=$((skipped + 1))
                continue
            fi
        fi
        bytes=$((bytes + expected_size))
        count=$((count + 1))
    done < "$MANIFEST_FILE"
    echo "$bytes $count $skipped"
}

check_disk_space() {
    local bytes_needed="$1"
    [ "$bytes_needed" -eq 0 ] && return 0

    local avail_kb avail_bytes headroom_bytes
    avail_kb="$(df -Pk "$MODELS_ROOT" 2>/dev/null | tail -1 | awk '{print $4}')"
    avail_bytes=$((avail_kb * 1024))
    headroom_bytes=$((2 * 1024 * 1024 * 1024))

    log "Disk: need $((bytes_needed / 1048576))MB plus 2048MB headroom; free $((avail_bytes / 1048576))MB"
    if [ "$avail_bytes" -lt $((bytes_needed + headroom_bytes)) ]; then
        fatal "Not enough disk space"
    fi
}

DOWNLOADED_BYTES=0
DOWNLOADED_COUNT=0
SKIPPED_COUNT=0

download_asset_locked() {
    local group="$1" filename="$2" expected_size="$3" url="$4"
    local dest_dir dest actual_size tmp start_ns elapsed_ms size_mb

    dest_dir="$(resolve_manifest_dir "$group")"
    dest="$dest_dir/$filename"

    if [ -f "$dest" ]; then
        actual_size="$(file_size "$dest")"
        if [ "$actual_size" -eq "$expected_size" ]; then
            log "SKIP $group/$filename"
            return 0
        fi
        log "REDOWNLOAD $group/$filename (have $actual_size, want $expected_size)"
    else
        log "DOWNLOAD $group/$filename"
    fi

    start_ns="$(date +%s%N)"
    tmp="$(mktemp "$dest_dir/.${filename}.part.XXXXXX")"
    if ! download_to_temp_file "$tmp" "$expected_size" "$url"; then
        rm -f "$tmp"
        log "ERROR: Download failed for $group/$filename"
        return 1
    fi

    actual_size="$(file_size "$tmp")"
    if [ "$actual_size" -ne "$expected_size" ]; then
        rm -f "$tmp"
        log "ERROR: Size mismatch for $group/$filename: expected $expected_size, got $actual_size"
        return 1
    fi

    chmod 644 "$tmp"
    mv -f "$tmp" "$dest"

    elapsed_ms=$(( ($(date +%s%N) - start_ns) / 1000000 ))
    size_mb=$((expected_size / 1048576))
    log "DONE $group/$filename ${size_mb}MB in ${elapsed_ms}ms ($((size_mb * 1000 / (elapsed_ms > 0 ? elapsed_ms : 1)))MB/s)"
}

download_asset() {
    local group="$1" filename="$2" expected_size="$3" url="$4"
    local dest_dir lock_path rc

    dest_dir="$(resolve_manifest_dir "$group")"
    lock_path="$LOCK_DIR/$(asset_lock_name "$group" "$filename").lock"

    exec 9>"$lock_path"
    flock 9
    if download_asset_locked "$group" "$filename" "$expected_size" "$url"; then
        rc=0
    else
        rc=$?
    fi
    flock -u 9
    return "$rc"
}

sync_assets() {
    local group="" filename="" expected_size="" url="" fail=0 running=0
    while IFS=$'\t' read -r group filename expected_size url || [ -n "${group}${filename}${expected_size}${url}" ]; do
        [ -z "$group" ] && continue
        download_asset "$group" "$filename" "$expected_size" "$url" &
        running=$((running + 1))
        if [ "$running" -ge "$ASSET_DOWNLOAD_JOBS" ]; then
            wait -n || fail=1
            running=$((running - 1))
        fi
    done < "$MANIFEST_FILE"
    while [ "$running" -gt 0 ]; do
        wait -n || fail=1
        running=$((running - 1))
    done
    return "$fail"
}

log "=== Asset sync START ==="
normalize_manifest || fatal "Invalid asset manifest"
read -r DOWNLOADED_BYTES DOWNLOADED_COUNT SKIPPED_COUNT < <(download_plan)
check_disk_space "$DOWNLOADED_BYTES"
sync_assets || fatal "One or more asset downloads failed"

TOTAL_ELAPSED_NS=$(( $(date +%s%N) - SYNC_START ))
TOTAL_ELAPSED_MS=$(( TOTAL_ELAPSED_NS / 1000000 ))
log "RESULT downloaded_bytes=${DOWNLOADED_BYTES} object_count=${DOWNLOADED_COUNT} skipped_count=${SKIPPED_COUNT} elapsed_ms=${TOTAL_ELAPSED_MS} mb_per_s=$((DOWNLOADED_BYTES / 1048576 * 1000 / (TOTAL_ELAPSED_MS > 0 ? TOTAL_ELAPSED_MS : 1)))"
log "=== Asset sync COMPLETE in ${TOTAL_ELAPSED_MS}ms ==="
