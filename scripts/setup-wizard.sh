#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD="$(tput bold)"
  DIM="$(tput dim)"
  GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"
  BLUE="$(tput setaf 4)"
  RED="$(tput setaf 1)"
  RESET="$(tput sgr0)"
else
  BOLD=""
  DIM=""
  GREEN=""
  YELLOW=""
  BLUE=""
  RED=""
  RESET=""
fi

FLOW="quickstart"
CONFIG_ACTION="configure"
TAILSCALE_IP=""
BRIDGE_HOST=""
BRIDGE_PORT=""
EXPO_MODE="mobile"
AUTO_START="true"
TARGET_PLATFORM="mobile"
BRIDGE_PID=""
EXPO_PID=""
BRIDGE_LOG="$ROOT_DIR/.bridge.log"
EXPO_LOG="$ROOT_DIR/.expo.log"
BRIDGE_PID_FILE="$ROOT_DIR/.bridge.pid"
EXPO_PID_FILE="$ROOT_DIR/.expo.pid"
KEEP_SERVICES_RUNNING="false"
SECURE_ENV_FILE="$ROOT_DIR/.env.secure"
MENU_RESULT=""
SECTION_COUNT=0
RAIL_GLYPH="${DIM}│${RESET}"
RAIL_BRANCH="${DIM}├─${RESET}"
RAIL_CHILD="${DIM}│${RESET}"
OS_NAME="$(uname -s)"
EXPO_STOP_PATTERN="$ROOT_DIR/.*/expo start|$ROOT_DIR/node_modules/.bin/expo start"
BRIDGE_STOP_PATTERN="$ROOT_DIR/services/rust-bridge|codex-rust-bridge|@codex/rust-bridge"

rail_echo() { printf "%s %s\n" "$RAIL_GLYPH" "$1"; }
rail_blank() { printf "%s\n" "$RAIL_GLYPH"; }
info() { rail_echo "${BLUE}$*${RESET}"; }
warn() { rail_echo "${YELLOW}$*${RESET}"; }
ok() { rail_echo "${GREEN}$*${RESET}"; }
fail() { printf "%s ${RED}%s${RESET}\n" "$RAIL_GLYPH" "$*" >&2; }
SETUP_VERBOSE_INSTALLS="${CLAWDEX_SETUP_VERBOSE:-false}"

run_quiet_command() {
  local label="$1"
  shift
  local log_file=""

  if [[ "$SETUP_VERBOSE_INSTALLS" == "true" ]]; then
    "$@"
    return $?
  fi

  log_file="$(mktemp "${TMPDIR:-/tmp}/clawdex-onboarding.XXXXXX.log")"
  if "$@" >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 0
  fi

  fail "$label failed."
  warn "Showing last 40 lines from installer output:"
  while IFS= read -r line; do
    rail_echo "${DIM}$line${RESET}"
  done < <(tail -n 40 "$log_file")
  warn "Full installer log: $log_file"
  return 1
}

list_matching_pids() {
  local pattern="$1"
  pgrep -f "$pattern" 2>/dev/null || true
}

stop_process_group_by_pattern() {
  local label="$1"
  local pattern="$2"
  local pids=""
  local remaining=""
  local pid=""

  pids="$(list_matching_pids "$pattern")"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  info "Stopping $label process group: $pids"
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill -TERM "$pid" >/dev/null 2>&1 || true
  done <<<"$pids"

  sleep 1

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      remaining+="$pid "
      kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
  done <<<"$pids"

  if [[ -n "${remaining// }" ]]; then
    warn "Force-stopped $label processes: $remaining"
  fi

  return 0
}

print_usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --no-start               Configure everything but do not start bridge/Expo
  --platform <name>        Auto-start platform: mobile|ios|android (default: mobile)
  -h, --help               Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --no-start)
        AUTO_START="false"
        shift
        ;;
      --platform)
        if [[ $# -lt 2 ]]; then
          echo "error: --platform requires a value" >&2
          print_usage >&2
          exit 1
        fi
        TARGET_PLATFORM="$2"
        shift 2
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      *)
        echo "error: unknown option '$1'" >&2
        print_usage >&2
        exit 1
        ;;
    esac
  done

  case "$TARGET_PLATFORM" in
    mobile|ios|android)
      ;;
    *)
      echo "error: invalid --platform '$TARGET_PLATFORM' (expected mobile|ios|android)" >&2
      exit 1
      ;;
  esac
}

run_with_privilege() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
    return $?
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return $?
  fi

  fail "This step needs elevated privileges (sudo), but sudo is not available."
  return 1
}

install_git_cli() {
  case "$OS_NAME" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        fail "Homebrew is required to auto-install git on macOS."
        return 1
      fi
      brew install git
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y git
      elif command -v dnf >/dev/null 2>&1; then
        run_with_privilege dnf install -y git
      elif command -v yum >/dev/null 2>&1; then
        run_with_privilege yum install -y git
      elif command -v apk >/dev/null 2>&1; then
        run_with_privilege apk add git
      else
        fail "Unsupported Linux package manager. Install git manually."
        return 1
      fi
      ;;
    *)
      fail "Unsupported OS for auto-installing git."
      return 1
      ;;
  esac
}

install_curl_cli() {
  case "$OS_NAME" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        fail "Homebrew is required to auto-install curl on macOS."
        return 1
      fi
      brew install curl
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y curl
      elif command -v dnf >/dev/null 2>&1; then
        run_with_privilege dnf install -y curl
      elif command -v yum >/dev/null 2>&1; then
        run_with_privilege yum install -y curl
      elif command -v apk >/dev/null 2>&1; then
        run_with_privilege apk add curl
      else
        fail "Unsupported Linux package manager. Install curl manually."
        return 1
      fi
      ;;
    *)
      fail "Unsupported OS for auto-installing curl."
      return 1
      ;;
  esac
}

install_openssl_cli() {
  case "$OS_NAME" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        fail "Homebrew is required to auto-install openssl on macOS."
        return 1
      fi
      brew install openssl
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y openssl
      elif command -v dnf >/dev/null 2>&1; then
        run_with_privilege dnf install -y openssl
      elif command -v yum >/dev/null 2>&1; then
        run_with_privilege yum install -y openssl
      elif command -v apk >/dev/null 2>&1; then
        run_with_privilege apk add openssl
      else
        fail "Unsupported Linux package manager. Install openssl manually."
        return 1
      fi
      ;;
    *)
      fail "Unsupported OS for auto-installing openssl."
      return 1
      ;;
  esac
}

install_c_toolchain_cli() {
  case "$OS_NAME" in
    Darwin)
      if command -v xcode-select >/dev/null 2>&1; then
        xcode-select --install >/dev/null 2>&1 || true
      fi
      fail "Install Xcode Command Line Tools, then rerun setup: xcode-select --install"
      return 1
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y build-essential
      elif command -v dnf >/dev/null 2>&1; then
        run_with_privilege dnf install -y gcc gcc-c++ make
      elif command -v yum >/dev/null 2>&1; then
        run_with_privilege yum install -y gcc gcc-c++ make
      elif command -v apk >/dev/null 2>&1; then
        run_with_privilege apk add build-base
      else
        fail "Unsupported Linux package manager. Install a C compiler manually."
        return 1
      fi
      ;;
    *)
      fail "Unsupported OS for auto-installing C toolchain."
      return 1
      ;;
  esac
}

install_rust_toolchain() {
  if ! command -v curl >/dev/null 2>&1; then
    fail "curl is required to install Rust toolchain."
    return 1
  fi

  if ! run_quiet_command "Rust toolchain installation" bash -lc "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"; then
    return 1
  fi
  # shellcheck disable=SC1090
  if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  hash -r
}

install_tailscale_cli() {
  case "$OS_NAME" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        fail "Homebrew is required to auto-install Tailscale on macOS."
        return 1
      fi
      brew install --cask tailscale
      ;;
    Linux)
      if ! command -v curl >/dev/null 2>&1; then
        fail "curl is required to auto-install Tailscale."
        return 1
      fi
      run_with_privilege bash -lc "curl -fsSL https://tailscale.com/install.sh | sh"
      ;;
    *)
      fail "Unsupported OS for auto-installing Tailscale."
      return 1
      ;;
  esac
}

ensure_or_install_command() {
  local cmd="$1"
  local pretty="$2"
  local installer="$3"
  local default_answer="${4:-Y}"

  if command -v "$cmd" >/dev/null 2>&1; then
    ok "Found $pretty: $(command -v "$cmd")"
    return 0
  fi

  warn "$pretty is not installed."
  if ! confirm_prompt "Install $pretty now?" "$default_answer"; then
    return 1
  fi

  if ! "$installer"; then
    fail "Failed to install $pretty."
    return 1
  fi

  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "$pretty still not found after install attempt."
    return 1
  fi

  ok "Installed $pretty: $(command -v "$cmd")"
  return 0
}

section() {
  if (( SECTION_COUNT > 0 )); then
    rail_blank
  fi
  printf "%s %s ${GREEN}◆${RESET} ${BOLD}%s${RESET}\n" "$RAIL_GLYPH" "$RAIL_BRANCH" "$1"
  SECTION_COUNT=$((SECTION_COUNT + 1))
}

print_note_box() {
  local title="$1"
  local body="$2"
  local cols=100
  local width=76
  local inner_width=$((width - 4))
  local rule=""
  local raw_line=""
  local wrapped_line=""
  local prefix=""

  if command -v tput >/dev/null 2>&1; then
    cols="$(tput cols 2>/dev/null || echo 100)"
  fi
  width=$((cols - 10))
  if (( width > 76 )); then
    width=76
  fi
  if (( width < 56 )); then
    width=56
  fi
  inner_width=$((width - 4))
  prefix="$RAIL_GLYPH $RAIL_CHILD "

  rule="$(printf '%*s' "$((width - 2))" '' | tr ' ' '-')"

  printf "%s %s ${BOLD}%s${RESET}\n" "$RAIL_GLYPH" "$RAIL_BRANCH" "$title"
  echo "${prefix}+$rule+"

  while IFS= read -r raw_line; do
    if [[ -z "$raw_line" ]]; then
      printf "${prefix}| %-*s |\n" "$inner_width" ""
      continue
    fi

    while IFS= read -r wrapped_line; do
      printf "${prefix}| %-*s |\n" "$inner_width" "$wrapped_line"
    done < <(printf '%s\n' "$raw_line" | fold -s -w "$inner_width")
  done <<<"$body"

  echo "${prefix}+$rule+"
}

abort_wizard() {
  tput cnorm >/dev/null 2>&1 || true
  echo ""
  fail "${1:-Aborted.}"
  exit 1
}

menu_select() {
  local prompt="$1"
  shift
  local -a options=("$@")
  local option_count="${#options[@]}"
  local selected=0
  local lines_to_render=$((option_count + 2))
  local i=0
  local key=""
  local key_rest=""
  local rail="$RAIL_GLYPH"
  local branch="$RAIL_BRANCH"
  local child="$RAIL_CHILD"

  if (( option_count == 0 )); then
    abort_wizard "menu_select requires at least one option."
  fi

  tput civis >/dev/null 2>&1 || true

  while true; do
    printf "\r\033[2K%s\n" "$rail"
    printf "\r\033[2K%s %s %s\n" "$rail" "$branch" "$prompt"
    for ((i = 0; i < option_count; i++)); do
      if (( i == selected )); then
        printf "\r\033[2K%s %s ${GREEN}◆${RESET} %s\n" "$rail" "$child" "${options[$i]}"
      else
        printf "\r\033[2K%s %s ${DIM}◇${RESET} %s\n" "$rail" "$child" "${options[$i]}"
      fi
    done

    IFS= read -rsn1 key || abort_wizard

    if [[ "$key" == $'\x03' ]]; then
      abort_wizard
    fi

    if [[ "$key" == $'\x1b' ]]; then
      key_rest=""
      IFS= read -rsn2 key_rest || true
      key+="$key_rest"
    fi

    case "$key" in
      "")
        MENU_RESULT="${options[$selected]}"
        break
        ;;
      $'\x1b[A'|k|K)
        selected=$(((selected - 1 + option_count) % option_count))
        ;;
      $'\x1b[B'|j|J)
        selected=$(((selected + 1) % option_count))
        ;;
      q|Q)
        abort_wizard
        ;;
      *)
        ;;
    esac

    printf "\033[%dA" "$lines_to_render"
  done

  tput cnorm >/dev/null 2>&1 || true
  printf "\033[%dA" "$lines_to_render"
  for ((i = 0; i < lines_to_render; i++)); do
    printf "\r\033[2K\n"
  done
  printf "\033[%dA" "$lines_to_render"
  printf "\r\033[2K%s %s %s: %s\n" "$rail" "$branch" "$prompt" "$MENU_RESULT"
}

confirm_prompt() {
  local prompt="$1"
  local default="${2:-N}"

  if [[ "$default" == "Y" ]]; then
    menu_select "$prompt" "Yes" "No"
  else
    menu_select "$prompt" "No" "Yes"
  fi

  [[ "$MENU_RESULT" == "Yes" ]]
}

press_enter_to_continue() {
  printf "${DIM}│${RESET} Press Enter to continue..."
  read -r
}

is_ipv4() {
  local ip="$1"
  local part=""
  local -a octets=()

  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS='.' read -r -a octets <<<"$ip"
  if [[ "${#octets[@]}" -ne 4 ]]; then
    return 1
  fi

  for part in "${octets[@]}"; do
    if (( part < 0 || part > 255 )); then
      return 1
    fi
  done

  return 0
}

current_tailscale_ip() {
  local candidate=""
  while IFS= read -r candidate; do
    candidate="$(printf '%s' "$candidate" | tr -d '[:space:]')"
    if is_ipv4 "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done < <(tailscale ip -4 2>/dev/null || true)
}

extract_env_value() {
  local file="$1"
  local key="$2"

  if [[ ! -f "$file" ]]; then
    return 0
  fi

  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=")+1); exit }' "$file"
}

open_tailscale_app() {
  if ! command -v open >/dev/null 2>&1; then
    return 1
  fi

  open -a Tailscale >/dev/null 2>&1 || true
  return 0
}

open_tailscale_login_flow() {
  local tailscale_output=""
  local login_url=""

  info "Starting Tailscale login flow..."
  open_tailscale_app || true

  tailscale_output="$(tailscale up 2>&1 || true)"
  if [[ -n "$tailscale_output" ]]; then
    echo "$tailscale_output"
  fi

  login_url="$(printf '%s\n' "$tailscale_output" | awk 'match($0, /https?:\/\/[^ ]+/) { print substr($0, RSTART, RLENGTH); exit }')"
  if [[ -z "$login_url" ]]; then
    login_url="https://login.tailscale.com/start"
  fi

  if command -v open >/dev/null 2>&1; then
    info "Opening browser: $login_url"
    open "$login_url" || true
  else
    rail_echo "Open this URL to login: $login_url"
  fi
}

open_url() {
  local url="$1"

  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
    return 0
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
    return 0
  fi

  rail_echo "Open this URL: $url"
}

print_existing_setup_summary() {
  local host=""
  local port=""
  local token=""
  local source_path=""

  if [[ ! -f "$SECURE_ENV_FILE" ]]; then
    return 1
  fi

  host="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_HOST")"
  port="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_PORT")"
  token="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_AUTH_TOKEN")"

  if [[ -z "$host" ]] && [[ -z "$port" ]] && [[ -z "$token" ]]; then
    return 1
  fi

  source_path="$SECURE_ENV_FILE"
  if [[ -n "${HOME:-}" ]]; then
    source_path="${source_path/#$HOME/~}"
  fi

  echo "bridge.host: $host"
  echo "bridge.port: $port"
  if [[ -n "$token" ]]; then
    echo "bridge.token: present"
  fi
  echo "source: $source_path"
}

require_security_ack() {
  print_note_box "Security" "Security warning - please read.

Clawdex is still evolving. Expect sharp edges.
The bridge can execute terminal commands and git actions.
A bad prompt could trick it into unsafe operations.

If you are not comfortable with security and access control, do not expose this bridge.
Use trusted networks only and keep auth enabled.

Recommended baseline:
- Pairing/allowlists and mention gating.
- Least-privilege tools.
- Keep secrets out of reachable workspace paths."

  if ! confirm_prompt "I understand this is powerful and inherently risky. Continue?" "N"; then
    abort_wizard "Aborted at security checkpoint."
  fi
}

choose_flow() {
  menu_select "Onboarding mode" "QuickStart" "Manual"
  if [[ "$MENU_RESULT" == "QuickStart" ]]; then
    FLOW="quickstart"
    info "QuickStart selected. You can re-run this wizard later with Manual mode."
  else
    FLOW="manual"
    info "Manual mode selected."
  fi
}

choose_config_action() {
  local summary=""

  summary="$(print_existing_setup_summary || true)"
  if [[ -z "$summary" ]]; then
    CONFIG_ACTION="configure"
    return 0
  fi

  print_note_box "Existing config detected" "$summary"

  menu_select "Config handling" "Use existing values" "Update values" "Reset + reconfigure"
  case "$MENU_RESULT" in
    "Use existing values")
      CONFIG_ACTION="keep"
      ;;
    "Update values")
      CONFIG_ACTION="configure"
      ;;
    "Reset + reconfigure")
      CONFIG_ACTION="reset"
      ;;
    *)
      abort_wizard "Unexpected config action."
      ;;
  esac
}

ensure_core_tools() {
  local required_cmd=""
  for required_cmd in node npm; do
    if ! command -v "$required_cmd" >/dev/null 2>&1; then
      fail "error: '$required_cmd' is not installed."
      fail "Install it and rerun: npm run setup:wizard"
      exit 1
    fi
  done

  ok "Node: $(node --version 2>/dev/null || echo "detected")"
  ok "npm:  $(npm --version 2>/dev/null || echo "detected")"

  if ! ensure_or_install_command "git" "git" install_git_cli "Y"; then
    fail "git is required."
    exit 1
  fi

  if ! ensure_or_install_command "curl" "curl" install_curl_cli "Y"; then
    fail "curl is required."
    exit 1
  fi

  if ! ensure_or_install_command "openssl" "openssl" install_openssl_cli "Y"; then
    fail "openssl is required."
    exit 1
  fi

  if ! ensure_or_install_command "cc" "C compiler/linker (cc)" install_c_toolchain_cli "Y"; then
    fail "C compiler/linker is required for Rust crate builds."
    exit 1
  fi
}

ensure_codex_cli() {
  while ! command -v codex >/dev/null 2>&1; do
    warn "Codex CLI not found in PATH."
    if confirm_prompt "Try installing Codex CLI via npm now?" "Y"; then
      if npm install -g @openai/codex; then
        hash -r
      else
        warn "Automatic install failed."
      fi
    fi

    if ! command -v codex >/dev/null 2>&1 && command -v open >/dev/null 2>&1; then
      if confirm_prompt "Open Codex docs in browser now?" "Y"; then
        open "https://developers.openai.com/codex" || true
      fi
    fi

    if ! command -v codex >/dev/null 2>&1 && ! confirm_prompt "Retry Codex CLI check?" "Y"; then
      abort_wizard "Install Codex CLI and rerun: npm run setup:wizard"
    fi
  done

  ok "Found codex: $(command -v codex)"
  if codex --version >/dev/null 2>&1; then
    info "codex version: $(codex --version 2>/dev/null | head -n1)"
  fi
}

ensure_tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then
    ok "Found tailscale: $(command -v tailscale)"
    open_tailscale_app || true
    return 0
  fi

  if ! ensure_or_install_command "tailscale" "Tailscale CLI" install_tailscale_cli "Y"; then
    fail "Tailscale is required for secure setup."
    exit 1
  fi

  open_tailscale_app || true
}

resolve_tailscale_ip_quickstart() {
  local ip=""
  ip="$(current_tailscale_ip)"

  while [[ -z "$ip" ]]; do
    warn "No active Tailscale IPv4 detected."
    if confirm_prompt "Open Tailscale login flow now?" "Y"; then
      open_tailscale_login_flow
      press_enter_to_continue
    fi

    if ! confirm_prompt "Retry Tailscale connectivity check?" "Y"; then
      abort_wizard "Connect Tailscale, then rerun: npm run setup:wizard"
    fi
    ip="$(current_tailscale_ip)"
  done

  printf '%s' "$ip"
}

resolve_tailscale_ip_manual() {
  local ip=""
  ip="$(current_tailscale_ip)"

  while [[ -z "$ip" ]]; do
    warn "No active Tailscale IPv4 detected."
    menu_select "Tailscale action" "Open login flow" "Retry check" "Show tailscale status" "Abort"

    case "$MENU_RESULT" in
      "Open login flow")
        open_tailscale_login_flow
        press_enter_to_continue
        ;;
      "Retry check")
        ;;
      "Show tailscale status")
        tailscale status || true
        press_enter_to_continue
        ;;
      "Abort")
        abort_wizard "Connect Tailscale, then rerun: npm run setup:wizard"
        ;;
      *)
        ;;
    esac

    ip="$(current_tailscale_ip)"
  done

  printf '%s' "$ip"
}

resolve_tailscale_ip() {
  if [[ "$FLOW" == "quickstart" ]]; then
    resolve_tailscale_ip_quickstart
    return 0
  fi

  resolve_tailscale_ip_manual
}

print_phone_tailscale_note() {
  print_note_box "Phone setup (Tailscale)" "Install Tailscale on your phone and sign in to the same Tailscale account as this machine.

Steps:
- Install Tailscale on phone:
  iOS: https://apps.apple.com/app/tailscale/id1475387142
  Android: https://play.google.com/store/apps/details?id=com.tailscale.ipn
- Open the Tailscale app on phone and log in.
- Confirm your phone and this machine both appear in the same Tailscale network.
- Keep Tailscale connected while using Clawdex."
}

confirm_phone_tailscale_quickstart() {
  local note_shown="false"

  while true; do
    if [[ "$note_shown" == "false" ]]; then
      print_phone_tailscale_note
      note_shown="true"
    fi

    if confirm_prompt "Is your phone now connected to this same Tailscale network?" "Y"; then
      return 0
    fi

    if confirm_prompt "Open Tailscale download page on this computer?" "Y"; then
      open_url "https://tailscale.com/download"
    fi

    warn "Complete phone app install/login, then continue."
    if ! confirm_prompt "Retry phone readiness check?" "Y"; then
      abort_wizard "Set up Tailscale on your phone, then rerun: npm run setup:wizard"
    fi
  done
}

confirm_phone_tailscale_manual() {
  local show_note="true"

  while true; do
    if [[ "$show_note" == "true" ]]; then
      print_phone_tailscale_note
      show_note="false"
    fi

    menu_select "Phone Tailscale status" \
      "Phone is ready (installed + logged in)" \
      "Show instructions again" \
      "Open Tailscale downloads" \
      "Show local tailscale status" \
      "Abort"

    case "$MENU_RESULT" in
      "Phone is ready (installed + logged in)")
        return 0
        ;;
      "Show instructions again")
        show_note="true"
        ;;
      "Open Tailscale downloads")
        open_url "https://tailscale.com/download"
        ;;
      "Show local tailscale status")
        tailscale status || true
        press_enter_to_continue
        ;;
      "Abort")
        abort_wizard "Set up Tailscale on your phone, then rerun: npm run setup:wizard"
        ;;
      *)
        ;;
    esac
  done
}

confirm_phone_tailscale_ready() {
  if ! command -v tailscale >/dev/null 2>&1; then
    warn "Tailscale CLI is not available for host-side verification."
    print_phone_tailscale_note
    if ! confirm_prompt "Continue after finishing phone Tailscale setup?" "N"; then
      abort_wizard "Install/login Tailscale on phone first, then rerun: npm run setup:wizard"
    fi
    return 0
  fi

  if [[ "$FLOW" == "quickstart" ]]; then
    confirm_phone_tailscale_quickstart
    return 0
  fi

  confirm_phone_tailscale_manual
}

has_mobile_react_native_runtime() {
  local root_touchable="$ROOT_DIR/node_modules/react-native/Libraries/Components/Touchable/BoundingDimensions.js"
  local workspace_touchable="$ROOT_DIR/apps/mobile/node_modules/react-native/Libraries/Components/Touchable/BoundingDimensions.js"
  local root_devtools="$ROOT_DIR/node_modules/react-native/src/private/devsupport/rndevtools/specs/NativeReactDevToolsRuntimeSettingsModule.js"
  local workspace_devtools="$ROOT_DIR/apps/mobile/node_modules/react-native/src/private/devsupport/rndevtools/specs/NativeReactDevToolsRuntimeSettingsModule.js"

  local touchable_ok="false"
  local devtools_ok="false"

  if [[ -f "$root_touchable" ]] || [[ -f "$workspace_touchable" ]]; then
    touchable_ok="true"
  fi
  if [[ -f "$root_devtools" ]] || [[ -f "$workspace_devtools" ]]; then
    devtools_ok="true"
  fi

  [[ "$touchable_ok" == "true" ]] && [[ "$devtools_ok" == "true" ]]
}

repair_mobile_runtime_dependencies() {
  info "Repairing mobile runtime dependencies (React Native + Expo toolchain)..."
  run_quiet_command "React Native dependency repair" bash -lc "cd \"$ROOT_DIR\" && npm install --include=dev --force && npm install --include=dev --force -w apps/mobile && npm dedupe"
}

install_project_dependencies() {
  local should_install="false"
  local need_install="false"

  if [[ ! -d "$ROOT_DIR/node_modules" ]] || [[ ! -d "$ROOT_DIR/node_modules/expo" ]]; then
    need_install="true"
  fi

  if [[ "$need_install" == "true" ]]; then
    if [[ "$AUTO_START" == "true" ]]; then
      info "Project dependencies are missing. Installing automatically for one-stop onboarding..."
      should_install="true"
    else
      if confirm_prompt "Install project npm dependencies now? (required for full onboarding)" "Y"; then
        should_install="true"
      else
        if [[ "$AUTO_START" == "true" ]]; then
          abort_wizard "Dependencies are required for auto-start. Re-run with --no-start or allow install."
        fi
      fi
    fi
  else
    if [[ "$FLOW" == "manual" ]] && confirm_prompt "Refresh npm dependencies now?" "N"; then
      should_install="true"
    fi
  fi

  if [[ "$should_install" == "true" ]]; then
    info "Installing npm dependencies (including dev tooling; this can take a few minutes)..."
    run_quiet_command "Project dependency install" bash -lc "cd \"$ROOT_DIR\" && npm install --include=dev && npm dedupe"
    ok "Dependencies installed."
  fi

  # Expo may prompt to install TypeScript if dev deps were skipped in prior installs.
  # Ensure mobile workspace tooling is present before auto-start.
  if [[ "$AUTO_START" == "true" ]]; then
    if ! node -e "require.resolve('typescript/package.json', { paths: ['$ROOT_DIR/apps/mobile', '$ROOT_DIR'] })" >/dev/null 2>&1; then
      info "Installing missing mobile TypeScript tooling..."
      run_quiet_command "Mobile TypeScript tooling install" bash -lc "cd \"$ROOT_DIR\" && npm install --include=dev -w apps/mobile && npm dedupe"
      ok "Mobile TypeScript tooling installed."
    fi
  fi

  if [[ "$AUTO_START" == "true" ]] && ! has_mobile_react_native_runtime; then
    warn "React Native runtime appears incomplete (missing core runtime files)."
    if [[ "$FLOW" == "quickstart" ]]; then
      info "Running automatic dependency repair for QuickStart..."
      repair_mobile_runtime_dependencies
    elif confirm_prompt "Attempt dependency repair now?" "Y"; then
      repair_mobile_runtime_dependencies
    else
      abort_wizard "Cannot auto-start Expo with incomplete React Native deps. Re-run setup and allow dependency repair."
    fi
  fi

  if [[ "$AUTO_START" == "true" ]] && [[ ! -d "$ROOT_DIR/node_modules/expo" ]]; then
    abort_wizard "Expo dependency not found after installation step."
  fi

  if [[ "$AUTO_START" == "true" ]] && ! has_mobile_react_native_runtime; then
    abort_wizard "React Native runtime is still incomplete after repair. Run: npm install --include=dev --force && npm install --include=dev --force -w apps/mobile"
  fi
}

cleanup_bridge() {
  if [[ "$KEEP_SERVICES_RUNNING" == "true" ]]; then
    return
  fi

  stop_process_group_by_pattern "Expo" "$EXPO_STOP_PATTERN"
  stop_process_group_by_pattern "Rust bridge" "$BRIDGE_STOP_PATTERN"

  rm -f "$BRIDGE_PID_FILE" "$EXPO_PID_FILE"
}

wait_for_bridge_health() {
  local host="$1"
  local port="$2"
  local max_wait_secs="${BRIDGE_HEALTH_WAIT_SECS:-300}"
  local elapsed=0

  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  while true; do
    if curl --max-time 1 -fsS "http://$host:$port/health" >/dev/null 2>&1; then
      return 0
    fi

    if [[ -n "$BRIDGE_PID" ]] && ! kill -0 "$BRIDGE_PID" >/dev/null 2>&1; then
      return 1
    fi

    sleep 1
    elapsed=$((elapsed + 1))
    if (( elapsed % 5 == 0 )); then
      info "Waiting for bridge health... ${elapsed}s elapsed"
    fi

    if (( elapsed >= max_wait_secs )); then
      return 2
    fi
  done
}

stream_expo_output_until_enter() {
  local tail_pid=""
  local _user_input=""
  local waited=0
  local max_wait_secs="${EXPO_OUTPUT_WAIT_SECS:-90}"
  local -a spinner_frames=("-" "\\" "|" "/")
  local frame="-"

  rail_echo "Expo output is live below."
  rail_echo "Press Enter to exit onboarding and keep Expo + bridge running (Ctrl+D also detaches)."
  echo ""

  if [[ ! -s "$EXPO_LOG" ]]; then
    while true; do
      if [[ -s "$EXPO_LOG" ]]; then
        printf "\r\033[2K%s Expo output started.\n" "$RAIL_GLYPH"
        break
      fi

      if [[ -n "$EXPO_PID" ]] && ! kill -0 "$EXPO_PID" >/dev/null 2>&1; then
        printf "\r\033[2K%s Expo process exited before output appeared.\n" "$RAIL_GLYPH"
        return 1
      fi

      if (( waited >= max_wait_secs )); then
        printf "\r\033[2K%s Still waiting for Expo output...\n" "$RAIL_GLYPH"
        break
      fi

      frame="${spinner_frames[$((waited % ${#spinner_frames[@]}))]}"
      printf "\r\033[2K%s Waiting for Expo output %s %ss" "$RAIL_GLYPH" "$frame" "$waited"
      sleep 1
      waited=$((waited + 1))
    done
  fi

  tail -n +1 -f "$EXPO_LOG" &
  tail_pid="$!"
  if ! IFS= read -r _user_input 2>/dev/null; then
    rail_echo "Input stream closed; detaching onboarding."
  fi
  kill -TERM "$tail_pid" >/dev/null 2>&1 || true
  wait "$tail_pid" 2>/dev/null || true
  return 0
}

start_expo_process_background() {
  local log_file="$1"

  if command -v script >/dev/null 2>&1; then
    if [[ "$OS_NAME" == "Darwin" ]]; then
      # Feed script from a never-ending pipe to avoid EOF-triggered Expo shutdown.
      nohup bash -lc "cd \"$ROOT_DIR\" && tail -f /dev/null | script -q \"$log_file\" npm run \"$EXPO_MODE\"" >/dev/null 2>&1 &
      EXPO_PID="$!"
      return 0
    fi

    # util-linux script uses -c for command mode.
    nohup bash -lc "cd \"$ROOT_DIR\" && tail -f /dev/null | script -q -f -c \"npm run $EXPO_MODE\" \"$log_file\"" >/dev/null 2>&1 &
    EXPO_PID="$!"
    return 0
  fi

  nohup bash -lc "cd \"$ROOT_DIR\" && npm run \"$EXPO_MODE\"" >"$log_file" 2>&1 </dev/null &
  EXPO_PID="$!"
}

start_expo_background() {
  info "Starting Expo ($EXPO_MODE) in background..."
  : >"$EXPO_LOG"
  start_expo_process_background "$EXPO_LOG"
  echo "$EXPO_PID" > "$EXPO_PID_FILE"

  sleep 1
  if ! kill -0 "$EXPO_PID" >/dev/null 2>&1; then
    fail "Expo failed to start. Recent logs:"
    tail -n 80 "$EXPO_LOG" || true
    exit 1
  fi

  KEEP_SERVICES_RUNNING="true"
  ok "Bridge + Expo are running in background."
  rail_echo "Bridge logs: $BRIDGE_LOG"
  rail_echo "Expo logs: $EXPO_LOG"
  rail_echo "To stop later:"
  rail_echo "pkill -TERM -f '$EXPO_STOP_PATTERN'; pkill -TERM -f '$BRIDGE_STOP_PATTERN'"
  stream_expo_output_until_enter
}

start_bridge_and_expo() {
  trap cleanup_bridge EXIT INT TERM

  info "Starting bridge in background..."
  (
    cd "$ROOT_DIR"
    npm run secure:bridge
  ) >"$BRIDGE_LOG" 2>&1 &
  BRIDGE_PID="$!"

  sleep 1
  if ! kill -0 "$BRIDGE_PID" >/dev/null 2>&1; then
    fail "Bridge failed to start. Recent logs:"
    tail -n 80 "$BRIDGE_LOG" || true
    exit 1
  fi

  echo "$BRIDGE_PID" > "$BRIDGE_PID_FILE"

  if [[ -n "$BRIDGE_HOST" ]] && [[ -n "$BRIDGE_PORT" ]]; then
    local health_status=0
    while true; do
      if wait_for_bridge_health "$BRIDGE_HOST" "$BRIDGE_PORT"; then
        ok "Bridge health check passed."
        break
      fi

      health_status=$?
      if [[ "$health_status" -eq 1 ]]; then
        fail "Bridge process exited before becoming healthy. Recent logs:"
        tail -n 80 "$BRIDGE_LOG" || true
        exit 1
      fi

      warn "Bridge health check has not passed yet (timeout reached)."
      warn "Initial Rust compile on fresh hosts can take several minutes."
      if confirm_prompt "Keep waiting for bridge health before starting Expo?" "Y"; then
        continue
      fi

      warn "Continuing to Expo before bridge is healthy."
      warn "If app requests fail, wait for bridge compile to finish and retry."
      break
    done
  fi

  ok "Bridge is running in background (pid $BRIDGE_PID)."
  info "Bridge logs: $BRIDGE_LOG"
  echo ""
  start_expo_background
  return 0
}

parse_args "$@"

if [[ ! -t 0 ]]; then
  echo "error: setup wizard is interactive. Run it in a terminal." >&2
  exit 1
fi

echo "${BOLD}Clawdex onboarding${RESET}"
rail_echo "Guided setup for secure bridge + mobile launch."
rail_echo "Project root: $ROOT_DIR"
rail_echo "${DIM}Use Up/Down (or j/k) and Enter to select.${RESET}"

section "Security checkpoint"
require_security_ack

section "Onboarding mode"
choose_flow

section "Prerequisites"
ensure_core_tools
if ! ensure_or_install_command "cargo" "Rust/Cargo toolchain" install_rust_toolchain "Y"; then
  fail "Rust/Cargo is required for the rust bridge."
  exit 1
fi
ensure_codex_cli
install_project_dependencies

section "Config handling"
choose_config_action

if [[ "$CONFIG_ACTION" == "reset" ]]; then
  rm -f "$SECURE_ENV_FILE"
  ok "Previous secure config removed: $SECURE_ENV_FILE"
fi

if [[ "$CONFIG_ACTION" != "keep" ]]; then
  section "Tailscale connectivity"
  ensure_tailscale_cli
  TAILSCALE_IP="$(resolve_tailscale_ip)"
  ok "Tailscale IPv4 detected: $TAILSCALE_IP"

  section "Write secure config"
  BRIDGE_HOST_OVERRIDE="$TAILSCALE_IP" "$SCRIPT_DIR/setup-secure-dev.sh"
else
  ok "Keeping existing secure config."
fi

section "Phone pairing"
confirm_phone_tailscale_ready
ok "Phone Tailscale readiness confirmed."

if [[ ! -f "$SECURE_ENV_FILE" ]]; then
  fail "error: $SECURE_ENV_FILE not found."
  fail "Run setup again and choose reconfigure."
  exit 1
fi

BRIDGE_HOST="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_HOST")"
BRIDGE_PORT="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_PORT")"
BRIDGE_HOST="${BRIDGE_HOST:-${TAILSCALE_IP:-127.0.0.1}}"
BRIDGE_PORT="${BRIDGE_PORT:-8787}"

section "Summary"
rail_echo "Bridge endpoint: http://$BRIDGE_HOST:$BRIDGE_PORT"
rail_echo "Secure env: $SECURE_ENV_FILE"
rail_echo "Bridge logs: $BRIDGE_LOG"
if [[ "$FLOW" == "quickstart" ]]; then
  rail_echo "${DIM}Tip: re-run with Manual mode for full control at each step.${RESET}"
fi

section "Hatch"
if [[ "$AUTO_START" == "true" ]]; then
  EXPO_MODE="$TARGET_PLATFORM"
  rail_echo "Auto-start enabled."
  rail_echo "Launching bridge + Expo ($EXPO_MODE)..."
  start_bridge_and_expo
  exit $?
else
  rail_echo "Auto-start disabled by --no-start."
  rail_echo "Skipping bridge/Expo launch."
fi

section "Next steps"
rail_echo "1) cd $ROOT_DIR && npm run secure:bridge"
rail_echo "2) cd $ROOT_DIR && npm run mobile"
rail_echo "3) Optional: npm run ios   (or)   npm run android"
rail_blank
rail_echo "${DIM}You can rerun this anytime: npm run setup:wizard${RESET}"
