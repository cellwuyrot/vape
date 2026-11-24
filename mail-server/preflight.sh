#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${MAIL_DOMAIN:-example.com}"
HOST="${MAIL_HOST:-mail.${DOMAIN}}"
IP="${MAIL_IP:-}"
DKIM_SELECTOR="${DKIM_SELECTOR:-mail}"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/etc/letsencrypt/live}"
PORTS=(25 465 587 993)
PREFLIGHT_FAILED=0

printf '=== VAPELAB mail preflight ===\n'
printf 'Host: %s\nDomain: %s\n' "$HOST" "$DOMAIN"
[[ -z "$IP" ]] || printf 'Expected IP: %s\n' "$IP"
printf '\n'

if ! command -v docker >/dev/null 2>&1; then
  echo '[FAIL] Docker not installed'; PREFLIGHT_FAILED=1
else
  docker --version
fi

if ! docker compose version >/dev/null 2>&1; then
  echo '[FAIL] Docker Compose plugin not installed'; PREFLIGHT_FAILED=1
else
  docker compose version
fi

if command -v dig >/dev/null 2>&1; then
  echo '=== DNS ==='
  A_RECORDS="$(dig +short A "$HOST" | tr -d '\r')"

  if [[ -n "$IP" ]]; then
    if grep -Fxq "$IP" <<<"$A_RECORDS"; then
      echo "[OK] A $HOST -> $IP"
    else
      echo "[FAIL] A $HOST expected $IP; got: ${A_RECORDS:-none}"
      PREFLIGHT_FAILED=1
    fi
  elif [[ -n "$A_RECORDS" ]]; then
    echo "[OK] A record exists: $A_RECORDS"
  else
    echo "[FAIL] A record missing for $HOST"
    PREFLIGHT_FAILED=1
  fi

  MX_RECORDS="$(dig +short MX "$DOMAIN" | tr -d '\r')"
  if awk -v host="$HOST" '$2 == host || $2 == host "." {found=1} END {exit !found}' <<<"$MX_RECORDS"; then
    echo "[OK] MX $DOMAIN -> $HOST"
  else
    echo "[FAIL] MX $DOMAIN not pointing at $HOST; got: ${MX_RECORDS:-none}"
    PREFLIGHT_FAILED=1
  fi

  if [[ -n "$IP" ]]; then
    PTR_RECORDS="$(dig +short -x "$IP" | sed 's/\.$//')"
    if grep -Fxq "$HOST" <<<"$PTR_RECORDS"; then
      echo "[OK] PTR $IP -> $HOST"
    else
      echo "[FAIL] PTR $IP expected $HOST; got: ${PTR_RECORDS:-none}"
      PREFLIGHT_FAILED=1
    fi
  else
    echo '[SKIP] PTR check: MAIL_IP is not set'
  fi

  SPF_RECORDS="$(dig +short TXT "$DOMAIN" | tr -d '"')"
  if grep -q '^v=spf1' <<<"$SPF_RECORDS"; then
    echo '[OK] SPF record exists'
  else
    echo '[WARN] SPF record missing; add/merge it before sending'
  fi

  DMARC_RECORDS="$(dig +short TXT "_dmarc.${DOMAIN}" | tr -d '"')"
  if grep -q '^v=DMARC1' <<<"$DMARC_RECORDS"; then
    echo '[OK] DMARC record exists'
  else
    echo '[WARN] DMARC record missing'
  fi

  DKIM_RECORDS="$(dig +short TXT "${DKIM_SELECTOR}._domainkey.${DOMAIN}" | tr -d '"')"
  if grep -q 'v=DKIM1' <<<"$DKIM_RECORDS"; then
    echo '[OK] DKIM record exists'
  else
    echo '[WARN] DKIM record missing; publish after generating the key'
  fi
else
  echo '[WARN] dig not installed; install dnsutils'
fi

if command -v ss >/dev/null 2>&1; then
  echo '=== Local port conflicts ==='
  for port in "${PORTS[@]}"; do
    if ss -lnt "( sport = :$port )" | grep -q LISTEN; then
      echo "[BUSY] TCP/$port already has a listener"
      PREFLIGHT_FAILED=1
    else
      echo "[FREE] TCP/$port"
    fi
  done
fi

if command -v nc >/dev/null 2>&1; then
  echo '=== Outbound SMTP port 25 ==='
  if timeout 8 nc -vz gmail-smtp-in.l.google.com 25; then
    echo '[OK] Outbound TCP/25 reachable'
  else
    echo '[BLOCKED] Outbound TCP/25 failed; ask hosting support or configure an authenticated relay'
    PREFLIGHT_FAILED=1
  fi
else
  echo '[WARN] nc not installed; install netcat-openbsd to test outbound TCP/25'
fi

if [[ -s "$LETSENCRYPT_DIR/$HOST/fullchain.pem" && -s "$LETSENCRYPT_DIR/$HOST/privkey.pem" ]]; then
  echo '[OK] TLS certificate files exist'
else
  echo "[FAIL] TLS certificate for $HOST is missing under $LETSENCRYPT_DIR/"
  PREFLIGHT_FAILED=1
fi

printf '\nPreflight checks this server only. It does not send a test message or validate external DNSBL status.\n'
if [[ "$PREFLIGHT_FAILED" -ne 0 ]]; then
  echo '[PREFLIGHT FAILED] Resolve required checks above before direct mail deployment.'
  exit 1
fi

echo '[PREFLIGHT OK] Confirm DNS, PTR and TLS readiness before deployment.'
