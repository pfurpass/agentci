#!/usr/bin/env bash
# Shared helpers for install.sh and install-gateway.sh.

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""; }

DRY_RUN=0
ASSUME_YES=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# Runs a command, or only prints it in dry-run mode.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry run]%s %s\n' "$DIM" "$RESET" "$*"
    return 0
  fi
  "$@"
}

ask() {
  # ask "question" -> 0 = yes. Non-interactive or --yes always answers yes.
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 0
  printf '  %s [Y/n] ' "$1"
  read -r reply </dev/tty || return 0
  case "$reply" in n|N|no) return 1 ;; *) return 0 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# Prints the comment block at the top of a script as its --help text.
print_header_comment() {
  awk 'NR==1 && /^#!/ { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$1"
}

# Distro-specific hint, because "dnf install nodejs" still gives Node 16 on RHEL/Oracle 9.
node_install_hint() {
  if have dnf; then
    if grep -qiE "oracle|red hat|rocky|almalinux|centos" /etc/os-release 2>/dev/null; then
      echo "sudo dnf module enable -y nodejs:22 && sudo dnf install -y nodejs npm"
    else
      echo "sudo dnf install -y nodejs npm"
    fi
  elif have apt-get; then echo "sudo apt install -y nodejs npm  (or use https://nodejs.org)"
  elif have pacman; then echo "sudo pacman -S nodejs npm"
  elif have zypper; then echo "sudo zypper install nodejs22 npm22"
  elif have brew; then echo "brew install node"
  else echo "https://nodejs.org"
  fi
}

# Firewall hint that matches the system (firewalld on Fedora/Oracle, ufw on Debian/Ubuntu).
firewall_hint() {
  port="$1"
  if have firewall-cmd; then echo "sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload"
  elif have ufw; then echo "sudo ufw allow ${port}/tcp"
  else echo "open port ${port}/tcp in your firewall"
  fi
}

check_node() {
  have node || die "Node.js missing. Install Node 20 or newer: $(node_install_hint)"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node $(node -v) is too old – agentci needs Node 20 or newer. $(node_install_hint)"
  have npm || die "npm missing – install it together with Node."
  ok "Node $(node -v)"
}

# Installs this checkout globally, so `agentci` works in every directory.
install_agentci() {
  local root="$1"
  step "Installing agentci"
  if [ "$DRY_RUN" = 0 ] && ! npm install -g "$root" >/dev/null 2>&1; then
    warn "Global install failed (missing permissions?) – retrying with sudo"
    if have sudo; then
      sudo npm install -g "$root" >/dev/null || die "Install failed. Alternative: npm config set prefix ~/.npm-global && PATH=\$PATH:~/.npm-global/bin"
    else
      die "Install failed. Alternative: npm config set prefix ~/.npm-global && PATH=\$PATH:~/.npm-global/bin"
    fi
  else
    run npm install -g "$root"
  fi
  if [ "$DRY_RUN" = 0 ]; then
    have agentci || die "agentci is not in PATH after installing. Check: npm prefix -g"
    ok "agentci $(agentci --help >/dev/null 2>&1 && echo installed)"
  fi
}

# Claude Code / Codex CLI – the subscriptions agentci drives.
install_cli() {
  local bin="$1" pkg="$2" label="$3"
  if have "$bin"; then
    ok "$label present ($("$bin" --version 2>/dev/null | head -1))"
    return 0
  fi
  if ask "$label is not installed – install it with npm now?"; then
    run npm install -g "$pkg" || warn "could not install $label – later: npm i -g $pkg"
  else
    warn "$label skipped"
  fi
}

lan_ip() {
  node -e 'const os=require("os");const a=Object.values(os.networkInterfaces()).flat().filter(n=>n&&n.family==="IPv4"&&!n.internal).map(n=>n.address);console.log(a[0]||"THIS-MACHINE")' 2>/dev/null || echo "THIS-MACHINE"
}
