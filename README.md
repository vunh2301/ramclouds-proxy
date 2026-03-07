# Ramclouds Proxy

Proxy cuc bo nhan request tu Cursor va AMP CLI, chuyen tiep sang endpoint Claude-compatible cua Ramclouds. Ho tro model mapping, fallback chain, va nhieu provider format (Anthropic Messages API, OpenAI Chat/Responses API).

## Yeu cau
- Node.js >= 18
- API key hop le cho upstream (Ramclouds)
- (Tuy chon) AMP CLI (`@anthropic-ai/amp`) de dung voi AMP

## Cai dat

```bash
npm install
```

## Cau hinh moi truong

Tao file `.env` (copy tu `.examble.env`) hoac set bien moi truong truc tiep.

### Bien bat buoc

| Bien | Mo ta | Vi du |
|------|-------|-------|
| `PORT` | Cong local | `8080` |
| `PROVIDER_BASE_URL` | Base URL upstream | `https://ramclouds.me/v1` |
| `PROVIDER_API_KEY` | API key upstream | `sk-...` |

### Bien thuong dung

| Bien | Mac dinh | Mo ta |
|------|----------|-------|
| `THINKING_BUDGET` | `4096` | Token danh cho thinking |
| `RAM_SOFT_LIMIT_TOKENS` | `185000` | Nguong mem toi uu context |
| `RAM_HARD_LIMIT_TOKENS` | `188000` | Nguong cung gioi han context |
| `KEEP_LAST_MESSAGES` | `12` | So message gan nhat giu lai |
| `SUMMARY_MAX_TOKENS` | `900` | Token toi da cho tom tat |
| `SANITIZE_SYSTEM` | `1` | Rut gon system prompt |
| `TRIM_TOOLS` | `1` | Rut gon tool description |
| `DEFAULT_MODEL` | `claude-opus-4-5` | Model mac dinh khi khong chi dinh |

### Anh xa model (Cursor)

```bash
# Map model alias -> model that
EXTRA_MODEL_MAP='{"claude-opus-4.6-thinking":"claude-opus-4.6-CL","gpt-5.4":"gpt-5.4"}'

# Legacy map (merge voi EXTRA_MODEL_MAP)
MODEL_MAP_JSON='{"claude-4.6-opus":"claude-opus-4.6-CL"}'
```

## Chay proxy

```bash
npm start
```

Proxy lang nghe tai `http://localhost:8080` (hoac port da cau hinh).

## Dung voi Cursor

1. Chay proxy: `npm start`
2. (Tuy chon) Chay Cloudflare tunnel de co HTTPS:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
3. Trong Cursor, vao cau hinh OpenAI:
   - **Base URL**: `http://localhost:8080` hoac URL Cloudflare
   - **API Key**: nhap gia tri bat ky (proxy dung `PROVIDER_API_KEY` phia server)
4. Chon model de dung

## Dung voi AMP CLI

### 1) Cai dat AMP CLI

```bash
npm install -g @anthropic-ai/amp
```

### 2) Dang nhap AMP

```bash
npm run amp-login
```

Lenh nay se:
- Logout session cu (neu co)
- Chay `amp login` tro den `ampcode.com`
- Mo browser de xac thuc
- Luu credentials vao file secrets local

Sau khi login thanh cong, proxy tu dong doc credentials tu file secrets.

### 3) Cau hinh AMP CLI tro vao proxy

Tao hoac sua file cau hinh AMP CLI:

**Windows**: `%APPDATA%\amp\settings.json`
**Linux/Mac**: `~/.config/amp/settings.json`

```json
{
  "provider": {
    "name": "custom",
    "baseUrl": "http://localhost:8080/api"
  }
}
```

Hoac dung bien moi truong:

```bash
export AMP_API_URL=http://localhost:8080/api
```

### 4) Chay AMP

```bash
amp
```

AMP CLI se gui request qua proxy, proxy chuyen tiep sang Ramclouds voi model mapping va fallback chain.

## AMP Model Mapping

### File cau hinh: `amp-models.jsonc`

AMP CLI co model map rieng, doc lap voi Cursor. Cau hinh trong file `amp-models.jsonc` tai thu muc goc:

```jsonc
{
    // Format: "role/incoming_model": ["primary", "fallback1", "fallback2", ...]

    // Smart: agent chinh
    "smart/claude-opus-4-6": ["claude-opus-4.6-CL", "gpt-5.4", "gpt-5.3-codex", "glm-5"],

    // Rush: agent nhanh
    "rush/claude-haiku-4-5-20251001": ["claude-opus-4.6-CL", "gpt-5.4", "gpt-5.3-codex", "glm-5"],

    // Deep: deep reasoning
    "deep/gpt-5.3-codex": ["claude-opus-4.6-CL", "gpt-5.4", "gpt-5.3-codex", "glm-5"],

    // Oracle: subagent phuc tap
    "oracle/gpt-5.4": ["claude-opus-4.6-CL", "gpt-5.4", "gpt-5.3-codex", "glm-5"],

    // Librarian: subagent nghien cuu
    "librarian/claude-sonnet-4-6": ["claude-opus-4.6-CL", "gpt-5.4", "gpt-5.3-codex", "glm-5"]
}
```

**Giai thich format**:
- `role`: vai tro trong AMP (smart, rush, deep, oracle, librarian, search, review, ...)
- `incoming_model`: model name AMP CLI gui len
- Array: danh sach model thu lan luot. Model dau la primary, con lai la fallback

### Fallback chain

Khi model primary bi loi (429/500/502/503/504), proxy tu dong thu model tiep theo trong chain:

```
Request -> claude-opus-4.6-CL (429) -> gpt-5.4 (200) OK
```

**Smart fallback**: Model bi loi duoc danh dau DOWN, cac request tiep theo skip model do va goi thang model dang hoat dong. Background probe chay moi 30s de kiem tra model da hoi phuc chua.

Bien cau hinh fallback:

| Bien | Mac dinh | Mo ta |
|------|----------|-------|
| `AMP_MODEL_DOWN_TTL_MS` | `120000` | Thoi gian model bi danh dau DOWN (2 phut) |
| `AMP_MODEL_PROBE_INTERVAL_MS` | `30000` | Khoang cach giua cac lan probe (30s) |

### Banner thong bao fallback

Khi fallback xay ra, proxy chen 1 thong bao vao dau response:

```
[smart] 🔴 ~~claude-opus-4.6-CL~~ → 🟢 **gpt-5.4** → ⚪ gpt-5.3-codex → ⚪ glm-5
```

- 🟢 **model** = model dang su dung (in dam)
- 🔴 ~~model~~ = model bi loi (gach ngang)
- ⚪ model = fallback chua dung

Banner chi hien 1 lan khi fallback xay ra, khong lap lai moi request.

## AMP Management Proxy

Proxy co the thay the `cliproxyapi` (Go proxy) de xu ly toan bo AMP CLI request.

### Bien cau hinh

| Bien | Mac dinh | Mo ta |
|------|----------|-------|
| `AMP_PROXY_ENABLED` | `0` | Bat/tat reverse proxy `/api/*` |
| `AMP_BASE_URL` | | Base URL upstream AMP (vd: `https://ampcode.com`) |
| `AMP_INBOUND_API_KEYS` | | Key client AMP CLI duoc phep goi vao (phan tach dau phay) |
| `AMP_REQUIRE_LOCALHOST` | `0` | Chi cho phep goi tu localhost |
| `AMP_UPSTREAM_API_KEY` | | Key inject server-side khi forward len AMP upstream |
| `AMP_TIMEOUT_MS` | `60000` | Timeout cho upstream request |

### Route duoc reverse-proxy

- `/api/auth`, `/api/user`, `/api/threads`, `/api/meta`, `/api/telemetry`
- `/api/provider/*` (model routing voi AMP model map)
- `/threads`, `/auth`, `/docs`, `/settings` (root-level)

## AMP CLI Login Orchestrator

Ngoai `npm run amp-login` (chay truc tiep), proxy con co HTTP API de dieu phoi login tu xa:

| Bien | Mac dinh | Mo ta |
|------|----------|-------|
| `AMP_CLI_ENABLED` | `0` | Bat/tat nhanh `/api/amp-cli/*` |
| `AMP_CLI_COMMAND` | `amp` | Lenh CLI chay login |
| `AMP_CLI_LOGIN_TIMEOUT_MS` | `480000` | Hard timeout (8 phut) |
| `AMP_CLI_MAX_CONCURRENT` | `1` | So login dong thoi |

Flow:
1. `POST /api/amp-cli/configure` → tao session, nhan `session_id`
2. `POST /api/amp-cli/start` voi `session_id` → bat dau `amp login`
3. `GET /api/amp-cli/status?session_id=...` → poll trang thai

## Kiem tra nhanh

```bash
curl http://localhost:8080/healthz
# => ok
```

## Tom tat luong su dung

### Cursor
1. `npm install`
2. Cau hinh `.env` (PORT, PROVIDER_BASE_URL, PROVIDER_API_KEY)
3. `npm start`
4. Tro Cursor vao `http://localhost:8080`

### AMP CLI
1. `npm install`
2. Cau hinh `.env` (them AMP_PROXY_ENABLED=1, AMP_BASE_URL, AMP_INBOUND_API_KEYS)
3. `npm run amp-login` (dang nhap AMP)
4. Cau hinh `amp-models.jsonc` (model mapping + fallback)
5. Cau hinh AMP CLI settings tro vao `http://localhost:8080/api`
6. `npm start`
7. Chay `amp` trong terminal
