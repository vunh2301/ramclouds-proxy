# Ramclouds Proxy

Proxy cục bộ nhận request từ Cursor và AMP CLI, chuyển tiếp sang endpoint Claude-compatible của Ramclouds. Hỗ trợ model mapping, fallback chain, và nhiều provider format (Anthropic Messages API, OpenAI Chat/Responses API).

## Yêu cầu
- Node.js >= 18
- API key hợp lệ cho upstream (Ramclouds)
- (Tuỳ chọn) AMP CLI (`@sourcegraph/amp`) để dùng với AMP

## Cài đặt

```bash
npm install
```

## Cấu hình môi trường

Tạo file `.env` (copy từ `.examble.env`) hoặc set biến môi trường trực tiếp.

### Biến bắt buộc

| Biến | Mô tả | Ví dụ |
|------|-------|-------|
| `PORT` | Cổng local | `8080` |
| `PROVIDER_BASE_URL` | Base URL upstream | `https://ramclouds.me/v1` |
| `PROVIDER_API_KEY` | API key upstream | `sk-...` |

### Biến thường dùng

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `THINKING_BUDGET` | `4096` | Token dành cho thinking |
| `RAM_SOFT_LIMIT_TOKENS` | `185000` | Ngưỡng mềm tối ưu context |
| `RAM_HARD_LIMIT_TOKENS` | `188000` | Ngưỡng cứng giới hạn context |
| `KEEP_LAST_MESSAGES` | `12` | Số message gần nhất giữ lại |
| `SUMMARY_MAX_TOKENS` | `900` | Token tối đa cho tóm tắt |
| `SANITIZE_SYSTEM` | `1` | Rút gọn system prompt |
| `TRIM_TOOLS` | `1` | Rút gọn tool description |
| `DEFAULT_MODEL` | `claude-opus-4-5` | Model mặc định khi không chỉ định |

### Ánh xạ model (Cursor)

```bash
# Map model alias -> model thật
EXTRA_MODEL_MAP='{"claude-opus-4.6-thinking":"claude-opus-4.6-CL","gpt-5.4":"gpt-5.4"}'

# Legacy map (merge với EXTRA_MODEL_MAP)
MODEL_MAP_JSON='{"claude-4.6-opus":"claude-opus-4.6-CL"}'
```

## Provider Mode (OpenAI Direct)

Proxy hỗ trợ gửi request trực tiếp đến OpenAI API thay vì qua ramclouds. Hữu ích khi bạn có API key OpenAI riêng và muốn dùng các tính năng native như web search.

### Cấu hình

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `PROVIDER_MODE` | `ramclouds` | Chế độ provider: `ramclouds` / `openai` / `auto` |
| `OPENAI_API_KEY` | | API key OpenAI (bắt buộc cho mode `openai` / `auto`) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL OpenAI API |
| `OPENAI_MODEL_MAP` | `{}` | Map model ramclouds → model OpenAI thật (JSON) |

### Các chế độ

| Mode | Mô tả |
|------|-------|
| `ramclouds` | Tất cả request qua ramclouds (mặc định, không cần `OPENAI_API_KEY`) |
| `openai` | Tất cả model gửi thẳng OpenAI API |
| `auto` | GPT models (`gpt-*`, `o1-*`, `chatgpt-*`) → OpenAI, còn lại → ramclouds |

### Luồng xử lý

```
Request từ AMP/Cursor
  │
  ├─ PROVIDER_MODE=ramclouds → ramclouds (web search: Brave/DDG)
  │
  └─ PROVIDER_MODE=openai|auto
       │
       ├─ Không có web_search → Chat Completions API (/v1/chat/completions)
       │
       ├─ Có web_search → Responses API (/v1/responses) + web_search_preview native
       │
       └─ OpenAI lỗi → fallback ramclouds (web search: Brave/DDG)
```

### Model mapping 2 tầng

Khi dùng mode `openai` hoặc `auto`, model đi qua 2 tầng mapping:

1. **AMP model map** (`amp-models.jsonc`): `claude-opus-4-6` → `gpt-5.4`
2. **OpenAI model map** (`OPENAI_MODEL_MAP`): `gpt-5.4` → `gpt-4o` (tuỳ chọn)

Nếu key OpenAI đã có quyền truy cập trực tiếp model (vd: `gpt-5.4`), không cần `OPENAI_MODEL_MAP`.

### Ví dụ cấu hình

```bash
# Gửi tất cả qua OpenAI, key có quyền truy cập gpt-5.4 trực tiếp
PROVIDER_MODE=openai
OPENAI_API_KEY=sk-proj-xxx

# Gửi qua OpenAI nhưng map model (key chỉ có gpt-4o)
PROVIDER_MODE=openai
OPENAI_API_KEY=sk-proj-xxx
OPENAI_MODEL_MAP={"gpt-5.4":"gpt-4o","gpt-5.2":"gpt-4o-mini"}

# Tự động: GPT → OpenAI, Claude → ramclouds
PROVIDER_MODE=auto
OPENAI_API_KEY=sk-proj-xxx
```

## Chạy proxy

```bash
npm start
```

Proxy lắng nghe tại `http://localhost:8080` (hoặc port đã cấu hình).

## Dùng với Cursor

1. Chạy proxy: `npm start`
2. (Tuỳ chọn) Chạy Cloudflare tunnel để có HTTPS:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
3. Trong Cursor, vào cấu hình OpenAI:
   - **Base URL**: `http://localhost:8080` hoặc URL Cloudflare
   - **API Key**: nhập giá trị bất kỳ (proxy dùng `PROVIDER_API_KEY` phía server)
4. Chọn model để dùng

## Dùng với AMP CLI

### 1) Cài đặt AMP CLI

```bash
npm install -g @sourcegraph/amp
```

### 2) Đăng nhập AMP

```bash
npm run amp-login
```

Script tự detect OS: chạy PowerShell trên Windows, bash trên Mac/Linux.

Hoặc chạy trực tiếp theo platform:

**Windows:**
```powershell
npm run amp-login:win
# hoặc
powershell -ExecutionPolicy Bypass -File .\amp-cli-e2e.ps1
```

**Mac/Linux:**
```bash
npm run amp-login:mac
# hoặc
bash ./amp-cli-e2e.sh
```

Script sẽ thực hiện:
1. **Logout** session cũ (unset `AMP_URL`, `AMP_API_KEY` trước khi logout)
2. Hỏi PORT (mặc định 8080)
3. Khởi động proxy server
4. Tạo session login qua API
5. Chạy `amp login`, mở browser để xác thực
6. Poll trạng thái, hiện auth code (tự copy vào clipboard)
7. Khi thành công: set `AMP_URL`, `AMP_API_KEY` vào env + `settings.json`

#### Tham số (Windows — PowerShell)

```powershell
.\amp-cli-e2e.ps1 -Port 8080 -ApiKey "your-key" -OpenBrowserFromScript -StopServerWhenDone
```

| Tham số | Mô tả |
|---------|-------|
| `-Port` | Port chạy proxy (mặc định hỏi khi chạy) |
| `-ApiKey` | Inbound API key (đọc từ .env nếu không truyền) |
| `-OpenBrowserFromScript` | Tự động mở browser |
| `-StopServerWhenDone` | Tắt proxy sau khi login xong |
| `-PollIntervalSec` | Khoảng cách poll (mặc định 2s) |
| `-MaxPoll` | Số lần poll tối đa (mặc định 180) |

#### Tham số (Mac/Linux — Bash)

```bash
bash ./amp-cli-e2e.sh [API_KEY] [WORKSPACE_ID] [PROVIDER] [--open-browser] [--stop-server]
```

| Tham số | Mô tả |
|---------|-------|
| `API_KEY` (arg 1) | Inbound API key (đọc từ .env nếu không truyền) |
| `WORKSPACE_ID` (arg 2) | Workspace ID (mặc định `ws-local`) |
| `PROVIDER` (arg 3) | Provider (mặc định `amp`) |
| `--open-browser` | Tự động mở browser |
| `--stop-server` | Tắt proxy sau khi login xong |

### 3) Cấu hình AMP CLI trỏ vào proxy

Tạo hoặc sửa file cấu hình AMP CLI:

- **Windows**: `%APPDATA%\amp\settings.json`
- **Mac**: `~/Library/Application Support/amp/settings.json`
- **Linux**: `~/.config/amp/settings.json`

```json
{
  "amp.url": "http://localhost:8080"
}
```

Hoặc dùng biến môi trường:

**Windows (PowerShell):**
```powershell
$env:AMP_URL = "http://localhost:8080"
# Lưu vĩnh viễn:
setx AMP_URL "http://localhost:8080"
```

**Mac/Linux (Bash):**
```bash
export AMP_URL="http://localhost:8080"
# Lưu vĩnh viễn (tự thêm vào ~/.zshrc hoặc ~/.bashrc):
echo 'export AMP_URL="http://localhost:8080"' >> ~/.zshrc
```

> Script `amp-login` tự động set `settings.json` và persist env sau khi login thành công (Windows: `setx`, Mac/Linux: `~/.zshrc` hoặc `~/.bashrc`).

### 4) Chạy AMP

```bash
amp
```

AMP CLI sẽ gửi request qua proxy, proxy chuyển tiếp sang Ramclouds với model mapping và fallback chain.

## AMP Model Mapping

### File cấu hình: `amp-models.jsonc`

> **Luu y:** AMP CLI route qua Responses API, yeu cau model tuong thich OpenAI (GPT). Model Anthropic (Claude) duoc convert tu dong nhung co the thieu event hoac khong ho tro day du tool calls. **Nen dung GPT lam primary model** de dam bao Oracle, Librarian va cac subagent hoat dong on dinh.

AMP CLI co model map rieng, doc lap voi Cursor. Cau hinh trong file `amp-models.jsonc` tai thu muc goc:

```jsonc
{
    // Format: "role/incoming_model": ["primary", "fallback1", "fallback2", ...]

    // Smart: agent chính
    "smart/claude-opus-4-6": ["gpt-5.4", "claude-opus-4.6-CL", "gpt-5.3-codex", "glm-5"],

    // Rush: agent nhanh
    "rush/claude-haiku-4-5-20251001": ["gpt-5.4", "claude-opus-4.6-CL", "gpt-5.3-codex", "glm-5"],

    // Deep: deep reasoning
    "deep/gpt-5.3-codex": ["gpt-5.4", "claude-opus-4.6-CL", "gpt-5.3-codex", "glm-5"],

    // Oracle: subagent phức tạp
    "oracle/gpt-5.4": ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2"],

    // Librarian: subagent nghiên cứu
    "librarian/claude-sonnet-4-6": ["gpt-5.4", "claude-opus-4.6-CL", "gpt-5.3-codex", "glm-5"]
}
```

**Giải thích format**:
- `role`: vai trò trong AMP (smart, rush, deep, oracle, librarian, search, review, ...)
- `incoming_model`: model name mà AMP CLI gửi lên
- Array: danh sách model thử lần lượt. Model đầu là primary, còn lại là fallback

### Fallback chain

Khi model primary bị lỗi (429/500/502/503/504), proxy tự động thử model tiếp theo trong chain:

```
Request → gpt-5.4 (429) → claude-opus-4.6-CL (200) OK
```

**Smart fallback**: Model bị lỗi được đánh dấu DOWN, các request tiếp theo skip model đó và gọi thẳng model đang hoạt động. Background probe chạy mỗi 30s để kiểm tra model đã hồi phục chưa.

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `AMP_MODEL_DOWN_TTL_MS` | `120000` | Thời gian model bị đánh dấu DOWN (2 phút) |
| `AMP_MODEL_PROBE_INTERVAL_MS` | `30000` | Khoảng cách giữa các lần probe (30s) |

### Banner thông báo fallback

Khi fallback xảy ra, proxy chèn 1 thông báo vào đầu response:

```
[smart] 🔴 ~~gpt-5.4~~ → 🟢 **claude-opus-4.6-CL** → ⚪ gpt-5.3-codex → ⚪ glm-5
```

- 🟢 **model** = model đang sử dụng (in đậm)
- 🔴 ~~model~~ = model bị lỗi (gạch ngang)
- ⚪ model = fallback chưa dùng

Banner chỉ hiện 1 lần khi fallback xảy ra, không lặp lại mỗi request.

## AMP Management Proxy

Proxy có thể thay thế `cliproxyapi` (Go proxy) để xử lý toàn bộ AMP CLI request.

### Biến cấu hình

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `AMP_PROXY_ENABLED` | `0` | Bật/tắt reverse proxy `/api/*` |
| `AMP_BASE_URL` | | Base URL upstream AMP (vd: `https://ampcode.com`) |
| `AMP_INBOUND_API_KEYS` | | Key client AMP CLI được phép gọi vào (phân tách dấu phẩy) |
| `AMP_REQUIRE_LOCALHOST` | `0` | Chỉ cho phép gọi từ localhost |
| `AMP_UPSTREAM_API_KEY` | | Key inject server-side khi forward lên AMP upstream |
| `AMP_TIMEOUT_MS` | `60000` | Timeout cho upstream request |

### Route được reverse-proxy

- `/api/auth`, `/api/user`, `/api/threads`, `/api/meta`, `/api/telemetry`
- `/api/provider/*` (model routing với AMP model map)
- `/threads`, `/auth`, `/docs`, `/settings` (root-level)

## AMP CLI Login Orchestrator

Ngoài `npm run amp-login` (chạy trực tiếp), proxy còn có HTTP API để điều phối login từ xa:

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `AMP_CLI_ENABLED` | `0` | Bật/tắt nhánh `/api/amp-cli/*` |
| `AMP_CLI_COMMAND` | `amp` | Lệnh CLI chạy login |
| `AMP_CLI_LOGIN_TIMEOUT_MS` | `480000` | Hard timeout (8 phút) |
| `AMP_CLI_MAX_CONCURRENT` | `1` | Số login đồng thời |

Flow:
1. `POST /api/amp-cli/configure` → tạo session, nhận `session_id`
2. `POST /api/amp-cli/start` với `session_id` → bắt đầu `amp login`
3. `GET /api/amp-cli/status?session_id=...` → poll trạng thái

## Web Search

Proxy hỗ trợ 2 chế độ web search tuỳ thuộc vào provider mode:

### Chế độ 1: OpenAI Native Search (khi `PROVIDER_MODE=openai|auto`)

Khi request có web search tool và đang dùng OpenAI direct mode:

1. Proxy gửi request qua **Responses API** (`/v1/responses`) với `web_search_preview` hosted tool
2. OpenAI tự thực hiện search server-side (native, chất lượng cao)
3. Model trả lời trực tiếp dựa trên kết quả search
4. **Không cần cấu hình API key search** — OpenAI xử lý hoàn toàn

> Nếu OpenAI trả lỗi → tự động fallback về chế độ 2 (proxy intercept).

### Chế độ 2: Proxy Intercept (khi `PROVIDER_MODE=ramclouds` hoặc fallback)

Proxy tự intercept `web_search` / `web_search_preview` tool calls, tìm kiếm qua các backend, inject kết quả lại cho model:

1. Client gửi request có `web_search_preview` tool
2. Proxy convert thành function tool, gửi lên upstream
3. Khi model gọi `web_search`, proxy intercept (không gửi về client)
4. Proxy tự search bằng backend khả dụng, inject kết quả vào conversation
5. Gửi follow-up request để model trả lời dựa trên kết quả thực

### Search backends (theo thứ tự ưu tiên)

| # | Backend | Biến môi trường | Miễn phí | Ghi chú |
|---|---------|----------------|----------|---------|
| 1 | **Brave Search** | `BRAVE_API_KEY` | 1000 query/tháng (cần thẻ) | Chất lượng cao nhất |
| 2 | **Tavily AI Search** | `TAVILY_API_KEY` | 1000 query/tháng (không cần thẻ) | Trả content sạch, AI-optimized |
| 3 | **Exa AI Search** | `EXA_API_KEY` | 1000 query/tháng (không cần thẻ) | Neural/semantic search |
| 4 | **Serper.dev** (Google) | `SERPER_API_KEY` | 2500 query (Google account) | Kết quả Google |
| 5 | **Google News RSS** | — | Không giới hạn | Tự động, không cần key, chỉ tin tức |
| 6 | **DuckDuckGo HTML** | — | Không giới hạn | Hay bị rate-limit |
| 7 | **Bing scrape** | — | Không giới hạn | Hay bị captcha |
| 8 | **DuckDuckGo Lite** | — | Không giới hạn | Hay bị block |
| 9 | **SearXNG** | `WEB_SEARCH_URL` | Tự host | Cần instance riêng |

Proxy tự động fallback: nếu backend chính fail, thử backend tiếp theo trong chain.

### Cấu hình

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `TAVILY_API_KEY` | | API key Tavily (khuyên dùng, free 1000/tháng, không cần thẻ) |
| `EXA_API_KEY` | | API key Exa (free 1000/tháng, neural search) |
| `SERPER_API_KEY` | | API key Serper.dev (free 2500 queries) |
| `BRAVE_API_KEY` | | API key Brave Search |
| `WEB_SEARCH_URL` | | URL instance SearXNG |
| `WEB_SEARCH_COUNT` | `5` | Số kết quả search (1-20) |

## Kiểm tra nhanh

```bash
curl http://localhost:8080/healthz
# => ok
```

## Tóm tắt luồng sử dụng

### Cursor
1. `npm install`
2. Cấu hình `.env` (PORT, PROVIDER_BASE_URL, PROVIDER_API_KEY)
3. `npm start`
4. Trỏ Cursor vào `http://localhost:8080`

### AMP CLI
1. `npm install`
2. Cấu hình `.env` (thêm AMP_PROXY_ENABLED=1, AMP_BASE_URL, AMP_INBOUND_API_KEYS)
3. `npm run amp-login` (đăng nhập AMP — tự logout cũ, login mới, set env)
4. Cấu hình `amp-models.jsonc` (model mapping + fallback)
5. `npm start`
6. Chạy `amp` trong terminal
