#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${MAIL_DOMAIN:-example.com}"
HOST="${MAIL_HOST:-mail.${DOMAIN}}"
IP="${MAIL_IP:-}"
DKIM_SELECTOR="${DKIM_SELECTOR:-mail}"
MAIL_CONTAINER="${MAIL_CONTAINER:-mailserver}"

check_tls() {
  local port="$1" label="$2" starttls="${3:-}" output
  echo "=== $label ($HOST:$port) ==="
  if [[ -n "$starttls" ]]; then
    output="$(timeout 8 openssl s_client -starttls "$starttls" -connect "$HOST:$port" -servername "$HOST" -verify_return_error -brief </dev/null 2>&1 || true)"
  else
    output="$(timeout 8 openssl s_client -connect "$HOST:$port" -servername "$HOST" -verify_return_error -brief </dev/null 2>&1 || true)"
  fi
  if grep -q 'Verification: OK' <<<"$output"; then
    grep -E 'Protocol version|Ciphersuite|Verification: OK' <<<"$output" || true
    echo '[TLS OK]'
  else
    grep -E 'error|Verification|CONNECTED|refused|timed out' <<<"$output" | tail -5 || true
    echo '[TLS FAILED]'
  fi
}

echo '=== DNS records ==='
dig +short A "$HOST"
dig +short MX "$DOMAIN"
[[ -z "$IP" ]] || dig +short -x "$IP"
dig +short TXT "$DOMAIN"
dig +short TXT "${DKIM_SELECTOR}._domainkey.${DOMAIN}"
dig +short TXT "_dmarc.${DOMAIN}"

check_tls 25 'Inbound SMTP STARTTLS' smtp
check_tls 465 'SMTP submission implicit TLS'
check_tls 587 'SMTP submission STARTTLS' smtp
check_tls 993 'IMAP implicit TLS'

echo '=== Server container ==='
docker ps --filter "name=${MAIL_CONTAINER}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo '=== DMS diagnostics ==='
docker exec "$MAIL_CONTAINER" setup debug fail2ban || true

echo 'NOTE: Run this script from another network too to verify public reachability.'
