#!/bin/bash
# Start Comfy immediately, then expose only key-authenticated SSH for provisioning.

set -euo pipefail

SSH_PUBLIC_KEY_B64="${RUNTIME_SSH_PUBLIC_KEY_B64:-}"
SSH_PUBLIC_KEY_FILE="$(mktemp)"
trap 'rm -f "$SSH_PUBLIC_KEY_FILE"' EXIT

[ -n "$SSH_PUBLIC_KEY_B64" ] || { echo "RUNTIME_SSH_PUBLIC_KEY_B64 is required" >&2; exit 1; }
printf '%s' "$SSH_PUBLIC_KEY_B64" | base64 -d > "$SSH_PUBLIC_KEY_FILE"
[ "$(awk 'END { print NR }' "$SSH_PUBLIC_KEY_FILE")" -eq 1 ] || { echo "RUNTIME_SSH_PUBLIC_KEY_B64 must contain one public key" >&2; exit 1; }
ssh-keygen -l -f "$SSH_PUBLIC_KEY_FILE" >/dev/null

/usr/local/bin/agent-runtime-worker-start start-comfy

# Start downloading the request's assets the moment the container is up; the app's later
# sync over SSH waits on the per-asset locks and skips what already landed.
[ -z "${RUNTIME_ASSET_MANIFEST_B64:-}" ] || (nohup /usr/local/bin/agent-runtime-worker-assets >/var/log/portal/asset-sync-boot.log 2>&1 &)

install -d -m 0700 /root/.ssh
install -m 0600 "$SSH_PUBLIC_KEY_FILE" /root/.ssh/authorized_keys
passwd -d root >/dev/null
install -d -m 0755 /run/sshd /etc/ssh/sshd_config.d
ssh-keygen -A
cat > /etc/ssh/sshd_config.d/99-agent-runtime.conf <<'EOF'
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
UsePAM no
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
PermitTunnel no
PermitUserEnvironment no
X11Forwarding no
EOF
/usr/sbin/sshd -t
exec /usr/sbin/sshd -D -e
