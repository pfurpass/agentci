#!/usr/bin/env bash
# agentci – installer for your work machine (the one your code lives on).
#
#   bash install.sh                 install and self-test
#   bash install.sh --dry-run       only show what would happen
#   bash install.sh --yes           no questions asked
#   bash install.sh --no-clis       do not install Claude/Codex
#   bash install.sh --gateway URL --token T   connect to a gateway right away
#   bash install.sh --uninstall     remove it again

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

WITH_CLIS=1
UNINSTALL=0
GATEWAY_URL=""
GATEWAY_TOKEN=""

usage() { print_header_comment "$0"; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --no-clis) WITH_CLIS=0 ;;
    --gateway) GATEWAY_URL="${2:-}"; shift ;;
    --token) GATEWAY_TOKEN="${2:-}"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [ "$UNINSTALL" = 1 ]; then
  step "Removing agentci"
  run npm uninstall -g agentci || sudo npm uninstall -g agentci
  say ""
  ok "Removed. Your projects and .agentci folders are untouched."
  say "${DIM}  Delete the gateway credentials too: rm ~/.config/agentci/gateway.json${RESET}"
  exit 0
fi

printf '\n%s◆ agentci%s – multi-agent AI coder\n' "$BOLD" "$RESET"
[ "$DRY_RUN" = 1 ] && warn "Dry run – nothing will be changed"

step "Checking prerequisites"
check_node

install_agentci "$ROOT"

if [ "$WITH_CLIS" = 1 ]; then
  step "AI command lines (they use your subscriptions)"
  install_cli claude "@anthropic-ai/claude-code" "Claude Code"
  install_cli codex "@openai/codex" "Codex CLI"
fi

if [ -n "$GATEWAY_URL" ]; then
  step "Connecting to the gateway"
  if [ -z "$GATEWAY_TOKEN" ]; then
    warn "No --token given – skipping"
  else
    run agentci gateway connect "$GATEWAY_URL" --token "$GATEWAY_TOKEN"
  fi
fi

if [ "$DRY_RUN" = 0 ]; then
  step "Self-test"
  agentci doctor || warn "doctor reports open points (see above)"
fi

cat <<EOF

${BOLD}Done.${RESET} Get started:

  ${BOLD}agentci demo${RESET}                     free offline demo, shows the whole pipeline
  ${BOLD}cd your-project && agentci ui${RESET}    web interface (http://localhost:4317)
  ${BOLD}agentci run "Build …"${RESET}            straight from the terminal

Not signed in yet?
  ${DIM}claude${RESET}        start it and run ${BOLD}/login${RESET}  ·  ${DIM}codex login${RESET}  for the ChatGPT subscription

No internet on this machine? Run ${BOLD}bash install-gateway.sh${RESET} on the machine
that has internet, then connect here:
  ${BOLD}agentci gateway connect http://<gateway>:4318 --token <token>${RESET}
EOF
