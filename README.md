# Ramclouds Cursor Proxy (OpenAI -> Claude-compatible)

Features:
- Cursor OpenAI `POST /v1/chat/completions` -> Ramclouds Claude-compatible `POST /v1/messages`
- Streams Claude SSE -> OpenAI SSE (Cursor-friendly), including tool_calls + reasoning_content
- Image support for Cursor `<image_files>...</image_files>` (reads local files, attaches base64)
- Context guard for Ramclouds 190k limit:
  - system sanitizer (drops verbose Cursor-only sections)
  - tools trimming (drops long descriptions)
  - auto-summarize old history into structured JSON before hitting limit
  - hard fallback: drop older messages

## Install
```powershell
npm i
```

## Run
```powershell
$env:PORT="8080"
$env:PROVIDER_BASE_URL="https://ramclouds.me/v1"   # with or without /v1
$env:PROVIDER_API_KEY="sk-...."
$env:THINKING_BUDGET="4096"

# context controls
$env:RAM_SOFT_LIMIT_TOKENS="185000"
$env:RAM_HARD_LIMIT_TOKENS="188000"
$env:KEEP_LAST_MESSAGES="12"
$env:SUMMARY_MAX_TOKENS="900"
$env:SANITIZE_SYSTEM="1"
$env:TRIM_TOOLS="1"

# optional model map
# $env:MODEL_MAP_JSON='{"claude-opus-4.6-thinking":"claude-opus-4.6-CL"}'

node run-clean.cjs
```

Cursor Base URL: `http://localhost:8080`

Health: `GET /healthz`

Test trên Cursor 2.5.22