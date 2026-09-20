#!/usr/bin/env bash
# agentci gateway – installer for the machine WITH internet (Claude and Codex run there).
#
#   bash install-gateway.sh                  install, create a token, show the start command
#   bash install-gateway.sh --service        also install it as a service (autostart)
#   bash install-gateway.sh --port 4318      choose the port
#   bash install-gateway.sh --host 127.0.0.1 listen locally only (default: all addresses)
#   bash install-gateway.sh --token T        set your own token
#   bash install-gateway.sh --dry-run        only show what would happen
#   bash install-gateway.sh --uninstall      remove the service

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

PORT=4318
HOST=0.0.0.0
TOKEN=""
SERVICE=0
UNINSTALL=0
GW_HOME="${AGENTCI_GATEWAY_HOME:-$HOME/.agentci-gateway}"

usage() { print_header_comment "$0"; exit 0; }

# Always drive the CLI from this checkout – a globally installed agentci may be older.
agentci_cli() { node "$ROOT/bin/agentci.js" "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift ;;
    --host) HOST="${2:-}"; shift ;;
    --token) TOKEN="${2:-}"; shift ;;
    --service) SERVICE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [ "$UNINSTALL" = 1 ]; then
  step "Removing the service"
  run agentci_cli gateway service remove || true
  ok "Service removed. The token stays in $GW_HOME/token."
  say "${DIM}  Remove agentci itself: bash install.sh --uninstall${RESET}"
  exit 0
fi

printf '\n%s◆ agentci gateway%s – AI for machines without internet\n' "$BOLD" "$RESET"
[ "$DRY_RUN" = 1 ] && warn "Dry run – nothing will be changed"

step "Checking prerequisites"
check_node
have curl || warn "curl missing – not required, but handy for testing"

install_agentci "$ROOT"

step "Claude and Codex (the subscriptions live on THIS machine)"
install_cli claude "@anthropic-ai/claude-code" "Claude Code"
install_cli codex "@openai/codex" "Codex CLI"

step "Checking sign-in"
if [ "$DRY_RUN" = 0 ] && have claude; then
  if claude auth status 2>&1 | grep -q '"loggedIn": true'; then
    ok "Claude is signed in"
  else
    warn "Claude is not signed in – run ${BOLD}claude${RESET} once and sign in with /login"
  fi
fi
if [ "$DRY_RUN" = 0 ] && have codex; then
  # codex prints its status on stderr, so both streams have to be checked.
  if codex login status 2>&1 | grep -qi "logged in"; then
    ok "Codex is signed in"
  else
    warn "Codex is not signed in – run ${BOLD}codex login${RESET}"
  fi
fi

step "Token"
run mkdir -p "$GW_HOME"
if [ -n "$TOKEN" ]; then
  [ ${#TOKEN} -ge 16 ] || die "the token must be at least 16 characters"
  if [ "$DRY_RUN" = 0 ]; then
    printf '%s\n' "$TOKEN" > "$GW_HOME/token"
    chmod 600 "$GW_HOME/token"
  fi
  ok "Your own token saved"
elif [ -f "$GW_HOME/token" ]; then
  TOKEN="$(cat "$GW_HOME/token")"
  ok "Reusing the existing token"
else
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  if [ "$DRY_RUN" = 0 ]; then
    printf '%s\n' "$TOKEN" > "$GW_HOME/token"
    chmod 600 "$GW_HOME/token"
  fi
  ok "New token created"
fi

if [ "$SERVICE" = 1 ]; then
  step "Installing as a service (autostart)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry run]%s agentci gateway service install --port %s --host %s\n' "$DIM" "$RESET" "$PORT" "$HOST"
    agentci_cli gateway service install --port "$PORT" --host "$HOST" --dry-run | sed 's/^/      /' || true
  else
    agentci_cli gateway service install --port "$PORT" --host "$HOST" || warn "could not install the service (see above)"
  fi
fi

IP="$(lan_ip)"
cat <<EOF

${BOLD}Done.${RESET}

  Start the gateway   ${BOLD}agentci gateway --port $PORT --host $HOST${RESET}$([ "$SERVICE" = 1 ] && [ "$DRY_RUN" = 0 ] && printf '   (already running as a service)')
  Monitor             ${BOLD}http://$IP:$PORT/?token=$TOKEN${RESET}
  Token               ${BOLD}$TOKEN${RESET}

On the machine without internet:
  ${BOLD}agentci gateway connect http://$IP:$PORT --token $TOKEN${RESET}

${DIM}Firewall (if needed):  $(firewall_hint "$PORT")
Without TLS your code travels unencrypted – on untrusted networks use --cert/--key
or an SSH tunnel:  ssh -L $PORT:localhost:$PORT $USER@$IP
Anyone with the token can start agents with file access here.${RESET}
EOF
