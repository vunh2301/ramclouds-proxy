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

AMP CLI có model map riêng, độc lập với Cursor. Cấu hình trong file `amp-models.jsonc` tại thư mục gốc:

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
    "oracle/gpt-5.4": ["gpt-5.4", "claude-opus-4.6-CL", "gpt-5.3-codex", "glm-5"],

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
