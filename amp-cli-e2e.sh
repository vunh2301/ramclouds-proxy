#!/usr/bin/env bash
set -euo pipefail

# --- Config ---
API_KEY="${1:-}"
WORKSPACE_ID="${2:-ws-local}"
PROVIDER="${3:-amp}"
POLL_INTERVAL=2
MAX_POLL=180
PORT=0
STOP_SERVER_WHEN_DONE=false
OPEN_BROWSER=false

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --stop-server) STOP_SERVER_WHEN_DONE=true ;;
    --open-browser) OPEN_BROWSER=true ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"

# --- Helpers ---
get_env_value() {
  local file="$1" name="$2"
  if [[ ! -f "$file" ]]; then echo ""; return; fi
  local val
  val=$(grep -E "^${name}=" "$file" 2>/dev/null | head -1 | sed "s/^${name}=//" | sed 's/^"//;s/"$//' | tr -d '\r' | xargs) || true
  echo "$val"
}

wait_healthz() {
  local base_url="$1" max_seconds="${2:-45}"
  for ((i=0; i<max_seconds; i++)); do
    if curl -sf --max-time 3 "$base_url/healthz" 2>/dev/null | grep -q "ok"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# curl wrapper: returns body, shows error on failure
api_call() {
  local method="$1" url="$2"
  shift 2
  local http_code body tmpfile
  tmpfile=$(mktemp)
  http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" -X "$method" "$url" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    "$@") || {
    echo -e "\033[31mCurl error: khong ket noi duoc toi $url\033[0m" >&2
    rm -f "$tmpfile"
    return 1
  }
  body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  if [[ "$http_code" -ge 400 ]]; then
    echo -e "\033[31mHTTP $http_code tu $url\033[0m" >&2
    echo -e "\033[31mResponse: $body\033[0m" >&2
    return 1
  fi
  echo "$body"
}

# Parse JSON field with python3
json_get() {
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except:
    print('')
    sys.exit(0)
keys = sys.argv[1].split('.')
for k in keys:
    if isinstance(d, dict):
        d = d.get(k, '')
    else:
        d = ''
        break
print(d if d is not None else '')
" "$1"
}

copy_secrets_token() {
  # amp login luu token duoi key "apiKey@https://ampcode.com/"
  # nhung amp CLI voi amp.url=http://localhost:PORT tim "apiKey@http://localhost:PORT/"
  # -> copy token sang key localhost
  local proxy_url="$1"
  local secrets_dirs=()

  if [[ "$(uname)" == "Darwin" ]]; then
    secrets_dirs=("${XDG_CONFIG_HOME:-$HOME/.config}/amp" "$HOME/Library/Application Support/amp" "$HOME/.local/share/amp")
  else
    secrets_dirs=("${XDG_CONFIG_HOME:-$HOME/.config}/amp" "$HOME/.local/share/amp")
  fi

  for dir in "${secrets_dirs[@]}"; do
    local secrets_path="$dir/secrets.json"
    if [[ ! -f "$secrets_path" ]]; then continue; fi

    python3 -c "
import sys, json, os
path = sys.argv[1]
proxy_url = sys.argv[2]

try:
    with open(path) as f:
        secrets = json.load(f)
except:
    sys.exit(0)

# Tim token tu ampcode.com
token = ''
for key in ['apiKey@https://ampcode.com/', 'apiKey@https://ampcode.com']:
    if key in secrets and secrets[key]:
        token = secrets[key]
        break

if not token:
    # Tim bat ky apiKey@ nao co gia tri
    for k, v in secrets.items():
        if k.startswith('apiKey@') and v:
            token = v
            break

if not token:
    sys.exit(0)

# Them key cho proxy URL
proxy_key = 'apiKey@' + proxy_url.rstrip('/') + '/'
if secrets.get(proxy_key) == token:
    sys.exit(0)

secrets[proxy_key] = token
with open(path, 'w') as f:
    json.dump(secrets, f, indent=2)

print(f'Copied token to {proxy_key} in {path}')
" "$secrets_path" "$proxy_url" 2>/dev/null && continue || true
  done
}

write_settings_file() {
  local settings_dir="$1" proxy_url="$2"
  local settings_path="$settings_dir/settings.json"
  mkdir -p "$settings_dir"

  local obj="{}"
  if [[ -f "$settings_path" ]]; then
    obj=$(cat "$settings_path" 2>/dev/null || echo "{}")
    if ! echo "$obj" | python3 -m json.tool >/dev/null 2>&1; then
      obj="{}"
    fi
  fi

  obj=$(echo "$obj" | python3 -c "
import sys, json
obj = json.load(sys.stdin)
obj['amp.url'] = sys.argv[1]
print(json.dumps(obj, indent=2))
" "$proxy_url")
  echo "$obj" > "$settings_path"
  echo -e "\033[90mWrote AMP settings: $settings_path -> amp.url=$proxy_url\033[0m"
}

set_amp_settings_url() {
  local proxy_url="$1"

  if [[ "$(uname)" == "Darwin" ]]; then
    # AMP CLI moi dung ~/.config/amp/, cu dung ~/Library/Application Support/amp/
    # Ghi ca hai de dam bao tuong thich
    write_settings_file "${XDG_CONFIG_HOME:-$HOME/.config}/amp" "$proxy_url"
    write_settings_file "$HOME/Library/Application Support/amp" "$proxy_url"
  else
    write_settings_file "${XDG_CONFIG_HOME:-$HOME/.config}/amp" "$proxy_url"
  fi
}

persist_env_var() {
  local name="$1" value="$2"
  local shell_rc

  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
    shell_rc="$HOME/.zshrc"
  else
    shell_rc="$HOME/.bashrc"
  fi

  # Remove old entry if exists, then append
  if [[ -f "$shell_rc" ]]; then
    grep -v "^export ${name}=" "$shell_rc" > "$shell_rc.tmp" || true
    mv "$shell_rc.tmp" "$shell_rc"
  fi
  echo "export ${name}=\"${value}\"" >> "$shell_rc"
}

cleanup() {
  # Skip nếu đã exec npm start (replace process)
  if [[ "${SKIP_CLEANUP:-}" == "1" ]]; then return; fi
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    if $STOP_SERVER_WHEN_DONE; then
      echo -e "\033[90mStopping proxy server (PID=$SERVER_PID)...\033[0m"
      kill "$SERVER_PID" 2>/dev/null || true
    else
      echo -e "\033[90mProxy server van dang chay (PID=$SERVER_PID). Dung 'kill $SERVER_PID' khi can dung.\033[0m"
    fi
  fi
}
trap cleanup EXIT

# --- Main ---

# Check .env has AMP_CLI_ENABLED
amp_cli_enabled=$(get_env_value "$ENV_FILE" "AMP_CLI_ENABLED")
if [[ "$amp_cli_enabled" != "1" ]]; then
  echo -e "\033[31m[ERROR] AMP_CLI_ENABLED khong duoc bat trong .env\033[0m"
  echo -e "\033[33mThem dong sau vao file .env roi chay lai:\033[0m"
  echo -e "\033[33m  echo 'AMP_CLI_ENABLED=1' >> .env\033[0m"
  exit 1
fi

# Get port
if [[ $PORT -le 0 ]]; then
  read -rp "Nhap PORT de chay proxy (mac dinh 8080): " raw_port
  PORT="${raw_port:-8080}"
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -le 0 ]]; then
    echo "PORT khong hop le" >&2; exit 1
  fi
fi

BASE_URL="http://localhost:$PORT"

# Kill process on port if occupied
existing_pid=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [[ -n "$existing_pid" ]]; then
  echo -e "\033[33mPort $PORT dang bi chiem boi PID=$existing_pid. Dang kill...\033[0m"
  kill -9 $existing_pid 2>/dev/null || true
  sleep 1
  echo -e "\033[32mDa kill process tren port $PORT.\033[0m"
fi

# Get API key
if [[ -z "$API_KEY" ]]; then
  API_KEY=$(get_env_value "$ENV_FILE" "AMP_ACCESS_TOKEN")
fi
if [[ -z "$API_KEY" ]]; then
  API_KEY=$(get_env_value "$ENV_FILE" "AMP_INBOUND_API_KEYS")
  API_KEY="${API_KEY%%,*}"  # take first key
fi
if [[ -z "$API_KEY" ]]; then
  echo "Missing API key. Pass as arg or set AMP_ACCESS_TOKEN / AMP_INBOUND_API_KEYS in .env" >&2
  exit 1
fi

echo -e "\033[90m[info] Se set AMP_URL/AMP_API_KEY sau khi login thanh cong.\033[0m"
echo -e "\033[90m[info] Se luu env vinh vien (~/.zshrc hoac ~/.bashrc) sau khi login thanh cong.\033[0m"

# [0/6] Logout old session
echo -e "\033[36m[0/6] Logout session cu...\033[0m"
saved_amp_url="${AMP_URL:-}"
saved_amp_api_key="${AMP_API_KEY:-}"
unset AMP_URL AMP_API_KEY 2>/dev/null || true
if command -v amp &>/dev/null; then
  amp logout 2>&1 || echo -e "\033[90mLogout skipped (khong co session cu)\033[0m"
else
  echo -e "\033[90mLogout skipped (amp chua cai dat)\033[0m"
fi
export AMP_URL="$saved_amp_url"
export AMP_API_KEY="$saved_amp_api_key"

# [1/6] Start proxy server
echo -e "\033[36m[1/6] Khoi dong proxy server tren PORT=$PORT ...\033[0m"
SERVER_LOG_OUT="$REPO_ROOT/amp-cli-e2e.server.out.log"
SERVER_LOG_ERR="$REPO_ROOT/amp-cli-e2e.server.err.log"

cd "$REPO_ROOT"
PORT=$PORT npm start > "$SERVER_LOG_OUT" 2> "$SERVER_LOG_ERR" &
SERVER_PID=$!

if ! wait_healthz "$BASE_URL" 45; then
  echo -e "\033[31mServer khong len duoc. Log loi:\033[0m"
  tail -80 "$SERVER_LOG_ERR" 2>/dev/null || true
  tail -40 "$SERVER_LOG_OUT" 2>/dev/null || true
  exit 1
fi

# [2/6] Health check
echo -e "\033[36m[2/6] Kiem tra healthz...\033[0m"
health=$(curl -sf "$BASE_URL/healthz" || echo "FAIL")
if [[ "$health" != "ok" ]]; then
  echo -e "\033[31mhealthz failed: $health\033[0m"
  exit 1
fi
echo -e "\033[32mhealthz: $health\033[0m"

# [3/6] Create login session
echo -e "\033[36m[3/6] Tao session login...\033[0m"
cfg=$(api_call POST "$BASE_URL/api/amp-cli/configure" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"provider\":\"$PROVIDER\"}")

session_id=$(echo "$cfg" | json_get "session_id")
if [[ -z "$session_id" ]]; then
  echo -e "\033[31mconfigure did not return session_id\033[0m" >&2
  echo -e "\033[31mResponse: $cfg\033[0m" >&2
  exit 1
fi

state=$(echo "$cfg" | json_get "state")
echo -e "\033[32msession_id: $session_id\033[0m"
echo -e "\033[33mstate: $state\033[0m"

# [4/6] Start login
echo -e "\033[36m[4/6] Bat dau login...\033[0m"
start_resp=$(api_call POST "$BASE_URL/api/amp-cli/start" \
  -d "{\"session_id\":\"$session_id\"}")
start_state=$(echo "$start_resp" | json_get "state")
echo -e "\033[33mstart state: $start_state\033[0m"

# [5/6] Poll status
echo -e "\033[36m[5/6] Theo doi trang thai...\033[0m"
echo -e "\033[33mKhi thay login_url, script se mo browser. Neu co auth_code thi copy code do paste vao trang login.\033[0m"

opened_login_url=false
final_state=""
last_st=""

for ((i=0; i<MAX_POLL; i++)); do
  st=$(api_call GET "$BASE_URL/api/amp-cli/status?session_id=$session_id" 2>/dev/null) || {
    sleep $POLL_INTERVAL
    continue
  }
  last_st="$st"
  now=$(date +%H:%M:%S)
  state=$(echo "$st" | json_get "state")
  message=$(echo "$st" | json_get "message")
  login_url=$(echo "$st" | json_get "metadata.login_url")
  auth_code=$(echo "$st" | json_get "metadata.auth_code")

  line="[$now] state=$state message=$message"

  if [[ -n "$login_url" ]]; then
    line="$line login_url=$login_url"
    if ! $opened_login_url; then
      opened_login_url=true
      if $OPEN_BROWSER; then
        if [[ "$(uname)" == "Darwin" ]]; then
          open "$login_url" 2>/dev/null && echo -e "\033[36mOpened browser URL: $login_url\033[0m" || true
        else
          xdg-open "$login_url" 2>/dev/null && echo -e "\033[36mOpened browser URL: $login_url\033[0m" || true
        fi
      else
        echo -e "\033[36mLogin URL: $login_url\033[0m"
        echo -e "\033[33mMo URL nay 1 lan duy nhat tren browser de tranh double-open.\033[0m"
      fi
    fi
  fi

  # Auto-submit auth code if detected from CLI output
  if [[ -n "$auth_code" ]] && [[ "${submitted_code:-}" != "$auth_code" ]]; then
    echo -e "\033[33mAuth code detected from CLI, submitting...\033[0m"
    api_call POST "$BASE_URL/api/amp-cli/submit-code" \
      -d "{\"session_id\":\"$session_id\",\"code\":\"$auth_code\"}" 2>/dev/null && \
      echo -e "\033[32mAuth code submitted.\033[0m" || true
    submitted_code="$auth_code"
  fi

  # If awaiting_user and no auth_code from CLI, prompt user to paste from browser
  if [[ "$state" == "awaiting_user" ]] && [[ -z "$auth_code" ]] && [[ "${prompted_code:-}" != "yes" ]]; then
    echo ""
    echo -e "\033[33m╔══════════════════════════════════════════════════════════════╗\033[0m"
    echo -e "\033[33m║  Browser hien Authentication Code.                          ║\033[0m"
    echo -e "\033[33m║  Copy code tu browser roi paste vao day:                    ║\033[0m"
    echo -e "\033[33m╚══════════════════════════════════════════════════════════════╝\033[0m"
    echo -n -e "\033[36mPaste auth code: \033[0m"
    read -r user_code </dev/tty
    if [[ -n "$user_code" ]]; then
      echo -e "\033[33mSubmitting auth code (${#user_code} chars)...\033[0m"
      api_call POST "$BASE_URL/api/amp-cli/submit-code" \
        -d "{\"session_id\":\"$session_id\",\"code\":\"$user_code\"}" 2>/dev/null && \
        echo -e "\033[32mAuth code submitted.\033[0m" || \
        echo -e "\033[31mFailed to submit code.\033[0m"
    fi
    prompted_code="yes"
  fi

  echo -e "\033[90m$line\033[0m"

  case "$state" in
    authenticated|failed|expired)
      final_state="$state"
      break
      ;;
  esac

  sleep $POLL_INTERVAL
done

if [[ -z "$final_state" ]]; then
  echo "Polling timed out after $MAX_POLL checks" >&2; exit 1
fi

# [6/6] Done
echo -e "\033[32m[6/6] Hoan tat. Trang thai: $final_state\033[0m"

if [[ "$final_state" == "authenticated" ]]; then
  export AMP_URL="$BASE_URL"
  export AMP_API_KEY="$API_KEY"
  echo -e "\033[90mSet local env: AMP_URL=$BASE_URL\033[0m"
  echo -e "\033[90mSet local env: AMP_API_KEY=***\033[0m"

  set_amp_settings_url "$BASE_URL"

  persist_env_var "AMP_URL" "$BASE_URL"
  persist_env_var "AMP_API_KEY" "$API_KEY"
  echo -e "\033[90mPersisted env to shell rc (effective for new terminals).\033[0m"

  # Copy token tu apiKey@ampcode.com sang apiKey@localhost de amp CLI tim thay
  copy_secrets_token "$BASE_URL"
fi

if [[ -n "$last_st" ]]; then
  echo "$last_st" | python3 -m json.tool 2>/dev/null || echo "$last_st"
fi

# Kill background server va chay lai foreground de user thay log
if [[ "$final_state" == "authenticated" ]]; then
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "\033[36mDang tat server ngam (PID=$SERVER_PID) de chay lai foreground...\033[0m"
    SKIP_CLEANUP=1  # skip cleanup trap
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # Kill moi process con chiem port (bao gom child processes)
  for attempt in 1 2 3; do
    port_pid=$(lsof -ti :"$PORT" 2>/dev/null || true)
    if [[ -z "$port_pid" ]]; then break; fi
    echo -e "\033[33mPort $PORT van bi chiem (PID=$port_pid), dang kill (lan $attempt)...\033[0m"
    kill -9 $port_pid 2>/dev/null || true
    sleep 1
  done
  echo -e "\033[36mKhoi dong proxy foreground: PORT=$PORT npm start\033[0m"
  echo -e "\033[33mNhan Ctrl+C de dung proxy.\033[0m"
  cd "$REPO_ROOT"
  PORT=$PORT exec npm start
fi
