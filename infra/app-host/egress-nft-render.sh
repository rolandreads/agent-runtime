#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"

EGRESS_USER="${RUNTIME_EGRESS_USER:-${APP_USER:-agent-runtime}}"

read_env_value() {
  local key="$1"
  if [[ -z "${ENV_FILE}" || ! -r "${ENV_FILE}" ]]; then
    return 0
  fi

  awk -v key="${key}" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/^export[[:space:]]+/, "", line)
      eq = index(line, "=")
      if (eq == 0) { next }
      name = substr(line, 1, eq - 1)
      gsub(/[[:space:]]/, "", name)
      if (name != key) { next }
      value = substr(line, eq + 1)
      sub(/^[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "'"'"'" && substr(value, length(value), 1) == "'"'"'")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "${ENV_FILE}"
}

R2_ENDPOINT="${R2_ENDPOINT:-$(read_env_value R2_ENDPOINT)}"
VAST_API_KEY="${VAST_API_KEY:-$(read_env_value VAST_API_KEY)}"

resolve_ipv4() {
  local host="$1"
  getent ahostsv4 "${host}" 2>/dev/null | awk '{print $1}' | sort -u
}

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

resolve_host_or_ipv4() {
  local host="$1"
  if is_ipv4 "${host}"; then
    printf '%s\n' "${host}"
    return
  fi
  resolve_ipv4 "${host}"
}

host_from_url() {
  local url="$1"
  url="${url#http://}"
  url="${url#https://}"
  url="${url%%/*}"
  printf '%s\n' "${url%%:*}"
}

read_dns_resolvers() {
  cat <<DNS
127.0.0.53
9.9.9.9
149.112.112.112
DNS
}

render_ipv4_set() {
  local -n values="$1"
  local rendered='' ip suffix line_break
  for i in "${!values[@]}"; do
    ip="${values[$i]}"
    suffix=','
    line_break=$'\n'
    if [[ "$i" -eq $((${#values[@]} - 1)) ]]; then
      suffix=''
      line_break=''
    fi
    rendered+="        ${ip}${suffix}${line_break}"
  done
  printf '%s' "${rendered}"
}

allowed_https_hosts=(
  discord.com
  gateway.discord.gg
  cdn.discordapp.com
  media.discordapp.net
  api.anthropic.com
  openrouter.ai
  auth.x.ai
  api.x.ai
  vidgen.x.ai
  console.vast.ai
)

if [[ -n "${R2_ENDPOINT:-}" ]]; then
  allowed_https_hosts+=("$(host_from_url "${R2_ENDPOINT}")")
fi

dns_ipv4=()
while IFS= read -r ip; do
  [[ -n "${ip}" ]] || continue
  is_ipv4 "${ip}" || continue
  dns_ipv4+=("${ip}")
done < <(read_dns_resolvers | sort -u)

https_ipv4=()
while IFS= read -r ip; do
  [[ -n "${ip}" ]] || continue
  https_ipv4+=("${ip}")
done < <(
  for host in "${allowed_https_hosts[@]}"; do
    resolve_ipv4 "${host}"
  done | sort -u
)

vast_worker_rules=''
if [[ -n "${VAST_API_KEY:-}" ]]; then
  if ! vast_json="$(curl -fsSL \
    -H "Authorization: Bearer ${VAST_API_KEY}" \
    --get \
    --data-urlencode 'select_cols=["id","machine_id","public_ipaddr","ports"]' \
    'https://console.vast.ai/api/v1/instances/')"; then
    echo "failed to fetch Vast instances for egress allowlist" >&2
    exit 1
  fi

  if [[ -n "${vast_json}" ]]; then
    while IFS=$'\t' read -r host port; do
      [[ -n "${host}" && -n "${port}" ]] || continue
      [[ "${port}" =~ ^[0-9]+$ && "${port}" -ge 1 && "${port}" -le 65535 ]] || continue
      while IFS= read -r ip; do
        [[ -n "${ip}" ]] || continue
        vast_worker_rules+="    meta skuid \"${EGRESS_USER}\" ip daddr ${ip} tcp dport ${port} accept"$'\n'
      done < <(resolve_host_or_ipv4 "${host}")
    done < <(
      jq -r '
        .instances[]? |
        [
          if (.ports["22/tcp"][0].HostPort? != null and .public_ipaddr? != null) then
            [.public_ipaddr, .ports["22/tcp"][0].HostPort]
          else empty end,
          if (.ports["8443/tcp"][0].HostPort? != null and .public_ipaddr? != null) then
            [.public_ipaddr, .ports["8443/tcp"][0].HostPort]
          else empty end
        ] | .[] | @tsv
      ' <<<"${vast_json}"
    )
  fi
fi

tunnel_set=''
tunnel_rules=''
if id -u cloudflared >/dev/null 2>&1; then
  tunnel_ipv4=()
  while IFS= read -r ip; do
    [[ -n "${ip}" ]] && tunnel_ipv4+=("${ip}")
  done < <(for host in region1.v2.argotunnel.com region2.v2.argotunnel.com; do resolve_ipv4 "${host}"; done | sort -u)
  tunnel_set='  set runtime_tunnel_v4 { type ipv4_addr; }'
  if [[ "${#tunnel_ipv4[@]}" -gt 0 ]]; then
    tunnel_set="  set runtime_tunnel_v4 { type ipv4_addr; elements = { $(render_ipv4_set tunnel_ipv4) }; }"
  else
    echo 'warning: callback tunnel DNS lookup failed; emitting an empty tunnel set' >&2
  fi
  tunnel_rules='    meta skuid "cloudflared" ct state established,related accept
    meta skuid "cloudflared" ip daddr @runtime_dns_v4 udp dport 53 accept
    meta skuid "cloudflared" ip daddr @runtime_dns_v4 tcp dport 53 accept
    meta skuid "cloudflared" ip daddr @runtime_tunnel_v4 tcp dport 7844 accept
    meta skuid "cloudflared" ip daddr 127.0.0.1 tcp dport 9465 accept
    meta skuid "cloudflared" counter reject with icmpx type admin-prohibited'
fi

dns_set="$(render_ipv4_set dns_ipv4)"
https_set="$(render_ipv4_set https_ipv4)"

cat <<EOF
destroy table inet runtime

table inet runtime {
  set runtime_dns_v4 {
    type ipv4_addr
    elements = {
${dns_set}
    }
  }

  set runtime_https_v4 {
    type ipv4_addr
    elements = {
${https_set}
    }
  }

${tunnel_set}

  chain output {
    type filter hook output priority 0; policy accept;
${tunnel_rules}
    meta skuid "${EGRESS_USER}" ct state established,related accept
    meta skuid "${EGRESS_USER}" ip daddr @runtime_dns_v4 udp dport 53 accept
    meta skuid "${EGRESS_USER}" ip daddr @runtime_dns_v4 tcp dport 53 accept
    meta skuid "${EGRESS_USER}" ip daddr @runtime_https_v4 tcp dport 443 accept
${vast_worker_rules}    meta skuid "${EGRESS_USER}" limit rate 30/minute burst 10 packets counter log prefix "agent-runtime-egress-deny " level warn
    meta skuid "${EGRESS_USER}" counter reject with icmpx type admin-prohibited
  }
}
EOF
