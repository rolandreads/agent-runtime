#!/bin/bash
# Activate the immutable agent-runtime Comfy worker with per-instance TLS and auth.

set -euo pipefail

BOOTSTRAP_LOG="/var/log/agent-runtime-comfy-bootstrap.log"
COMFYUI_ROOT="/opt/workspace-internal/ComfyUI"
CUSTOM_NODES="$COMFYUI_ROOT/custom_nodes"
PYTHON="/venv/main/bin/python"
CADDY="/usr/local/bin/caddy"
RUNTIME_TLS_DIR="/etc/agent-runtime/tls"
RUNTIME_CADDYFILE="/etc/agent-runtime/Caddyfile"
COMFY_PID_FILE="/run/agent-runtime-comfy.pid"
CADDY_PID_FILE="/run/agent-runtime-caddy.pid"
RUNTIME_COMFYUI_ARGS=(--disable-auto-launch --front-end-root /opt/agent-runtime-empty-ui --port 18188 --fp32-vae --cache-classic)

mkdir -p "$(dirname "$BOOTSTRAP_LOG")"

log() {
    local line
    line="[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] [comfy-bootstrap] $1"
    echo "$line"
    if { [ -f "$BOOTSTRAP_LOG" ] && [ -w "$BOOTSTRAP_LOG" ]; } || { [ ! -e "$BOOTSTRAP_LOG" ] && [ -w "$(dirname "$BOOTSTRAP_LOG")" ]; }; then
        printf '%s\n' "$line" >> "$BOOTSTRAP_LOG"
    fi
}

phase_start() {
    eval "_phase_${1}_start=$(date +%s%N)"
    log "START $1"
}

phase_end() {
    local start_var="_phase_${1}_start"
    log "END   $1 $(( ($(date +%s%N) - ${!start_var}) / 1000000 ))ms"
}

configure_runtime_tls() {
    phase_start runtime_tls
    mkdir -p "$RUNTIME_TLS_DIR"
    printf '%s' "$RUNTIME_CA_CERT_B64" | base64 -d > "$RUNTIME_TLS_DIR/ca.crt"
    printf '%s' "$RUNTIME_TLS_CERT_B64" | base64 -d > "$RUNTIME_TLS_DIR/worker.crt"
    printf '%s' "$RUNTIME_TLS_KEY_B64" | base64 -d > "$RUNTIME_TLS_DIR/worker.key"
    chmod 644 "$RUNTIME_TLS_DIR/ca.crt" "$RUNTIME_TLS_DIR/worker.crt"
    chmod 600 "$RUNTIME_TLS_DIR/worker.key"

    cat > "$RUNTIME_CADDYFILE" <<EOF
{
    auto_https off
}

:${RUNTIME_CADDY_PORT} {
    tls ${RUNTIME_TLS_DIR}/worker.crt ${RUNTIME_TLS_DIR}/worker.key

    @authorized header Authorization "Bearer ${RUNTIME_CADDY_AUTH_TOKEN}"
    handle @authorized {
        reverse_proxy 127.0.0.1:18188
    }

    respond "unauthorized" 401
}
EOF
    chmod 600 "$RUNTIME_CADDYFILE"
    phase_end runtime_tls
}

verify_network_lockdown() {
    phase_start network_lockdown
    local public_listeners
    public_listeners="$(ss -tlnp 2>/dev/null | awk -v caddy_port="$RUNTIME_CADDY_PORT" '($4 ~ /^(0\.0\.0\.0|\*|\[::\]|::):/) && ($4 !~ /:22$/) && ($4 !~ (":" caddy_port "$"))')"
    if [ -n "$public_listeners" ]; then
        log "FATAL: Non-SSH public listeners still present:"
        log "$public_listeners"
        return 1
    fi
    log "Lockdown OK"
    phase_end network_lockdown
}

verify_bundled_runtime() {
    for path in \
        "$COMFYUI_ROOT/main.py" \
        "$CUSTOM_NODES/ComfyUI-Impact-Pack" \
        "$CUSTOM_NODES/ComfyUI-Impact-Subpack" \
        "$CUSTOM_NODES/save_image_jpeg/__init__.py" \
        "$PYTHON" \
        "$CADDY"; do
        [ -e "$path" ] || { log "FATAL: Bundled runtime component is missing: $path"; return 1; }
    done
}

stop_pid_file() {
    local name="$1" pid_file="$2" executable="$3"
    [ -r "$pid_file" ] || return 0
    local pid
    pid="$(cat "$pid_file")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
        if [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" != "$(readlink -f "$executable")" ]; then
            log "Discarding stale $name pid file"
            rm -f "$pid_file"
            return 0
        fi
        kill "$pid"
        for _ in $(seq 1 20); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
        log "Stopped $name (pid $pid)"
    fi
    rm -f "$pid_file"
}

start_comfy() {
    mkdir -p /var/log/portal
    if [ -r "$COMFY_PID_FILE" ]; then
        local pid
        pid="$(cat "$COMFY_PID_FILE")"
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" = "$(readlink -f "$PYTHON")" ]; then
            log "Comfy already running (pid $pid)"
            return 0
        fi
        rm -f "$COMFY_PID_FILE"
    fi
    (
        cd "$COMFYUI_ROOT"
        exec "$PYTHON" main.py "${RUNTIME_COMFYUI_ARGS[@]}"
    ) >/var/log/portal/comfy-direct.log 2>&1 &
    printf '%s\n' "$!" > "$COMFY_PID_FILE"
}

start_runtime_proxy() {
    phase_start runtime_proxy
    mkdir -p /var/log/portal
    stop_pid_file Caddy "$CADDY_PID_FILE" "$CADDY"
    nohup "$CADDY" run --config "$RUNTIME_CADDYFILE" >/var/log/portal/caddy-direct.log 2>&1 &
    printf '%s\n' "$!" > "$CADDY_PID_FILE"

    for attempt in $(seq 1 120); do
        if curl -fsS --cacert "$RUNTIME_TLS_DIR/ca.crt" -H "Authorization: Bearer $RUNTIME_CADDY_AUTH_TOKEN" "https://127.0.0.1:${RUNTIME_CADDY_PORT}/system_stats" >/dev/null; then
            log "Authenticated HTTPS runtime ready"
            phase_end runtime_proxy
            return 0
        fi
        [ $((attempt % 10)) -eq 0 ] && log "Waiting for authenticated HTTPS runtime (${attempt}s elapsed)"
        sleep 1
    done

    log "FATAL: authenticated HTTPS runtime probe failed"
    return 1
}

if [ "${1:-}" = "start-comfy" ]; then
    verify_bundled_runtime
    phase_start comfy_start
    start_comfy
    phase_end comfy_start
    exit 0
fi

[ "$#" -eq 0 ] || { log "FATAL: unknown command: $1"; exit 1; }

for var in RUNTIME_CA_CERT_B64 RUNTIME_TLS_CERT_B64 RUNTIME_TLS_KEY_B64 RUNTIME_CADDY_AUTH_TOKEN RUNTIME_CADDY_PORT; do
    [ -n "${!var:-}" ] || { log "FATAL: $var is required"; exit 1; }
done

BOOTSTRAP_START="$(date +%s%N)"
log "=== Runtime bootstrap START ==="
verify_bundled_runtime
configure_runtime_tls
verify_network_lockdown
phase_start comfy_start
start_comfy
phase_end comfy_start
start_runtime_proxy
log "=== Runtime bootstrap COMPLETE in $(( ($(date +%s%N) - BOOTSTRAP_START) / 1000000 ))ms ==="
