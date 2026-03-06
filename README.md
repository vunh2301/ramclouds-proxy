# Ramclouds Cursor Proxy

## Proxy này dùng để làm gì
`ramclouds-proxy` là proxy cục bộ nhận request theo kiểu OpenAI/Cursor rồi chuyển tiếp sang endpoint Claude-compatible của Ramclouds. Mục tiêu của README này là giúp bạn cài đặt, cấu hình và chạy proxy mà không cần đọc mã nguồn.

## Yêu cầu
- Node.js `>= 18`
- Một API key hợp lệ cho upstream Claude-compatible

## Cài đặt
```powershell
npm install
```

## Cấu hình môi trường
Bạn có thể đặt biến môi trường trực tiếp trong PowerShell hoặc khai báo trong file `.env`.

### Biến bắt buộc
- `PORT`: cổng local của proxy. Nếu không đổi, ứng dụng sẽ chạy trên `8080`.
- `PROVIDER_BASE_URL`: base URL của endpoint Claude-compatible upstream.
- `PROVIDER_API_KEY`: API key dùng để gọi upstream.

Ví dụ tối thiểu an toàn trong PowerShell:
```powershell
$env:PORT="8080"
$env:PROVIDER_BASE_URL="https://example.com/v1"
$env:PROVIDER_API_KEY="sk-demo"
```

### Biến thường dùng
- `THINKING_BUDGET`: số token dành cho thinking.
- `RAM_SOFT_LIMIT_TOKENS`: ngưỡng mềm để bắt đầu tối ưu context.
- `RAM_HARD_LIMIT_TOKENS`: ngưỡng cứng để tránh vượt giới hạn context.
- `KEEP_LAST_MESSAGES`: số message gần nhất được ưu tiên giữ lại.
- `SUMMARY_MAX_TOKENS`: số token tối đa cho phần tóm tắt lịch sử cũ.
- `SANITIZE_SYSTEM`: bật hoặc tắt việc rút gọn system prompt trước khi gửi upstream.
- `TRIM_TOOLS`: bật hoặc tắt việc rút gọn mô tả tool trước khi gửi upstream.

Ví dụ cấu hình đầy đủ hơn:
```powershell
$env:PORT="8080"
$env:PROVIDER_BASE_URL="https://example.com/v1"
$env:PROVIDER_API_KEY="sk-demo"
$env:THINKING_BUDGET="4096"
$env:RAM_SOFT_LIMIT_TOKENS="185000"
$env:RAM_HARD_LIMIT_TOKENS="188000"
$env:KEEP_LAST_MESSAGES="12"
$env:SUMMARY_MAX_TOKENS="900"
$env:SANITIZE_SYSTEM="1"
$env:TRIM_TOOLS="1"
```

### Ánh xạ model tùy chọn
Nếu muốn ánh xạ model mà Cursor gửi lên sang model upstream khác, bạn có thể dùng `EXTRA_MODEL_MAP`.

Ví dụ:
```powershell
$env:EXTRA_MODEL_MAP='{"claude-opus-4.6-thinking":"claude-opus-4.6-CL"}'
```

Biến này là tùy chọn. Nếu không khai báo, proxy sẽ dùng model nhận từ client hoặc ánh xạ mặc định đã có trong mã nguồn.

Không đưa API key thật vào `README.md`, `.env` mẫu, ảnh chụp màn hình hoặc commit lên nơi công khai.

## Chạy ứng dụng
Sau khi cấu hình biến môi trường, chạy:

```powershell
npm start
```

Theo `package.json`, đây là cách khởi động chính thức của dự án và sẽ chạy `node run.cjs`.

Nếu giữ nguyên `PORT=8080`, proxy sẽ lắng nghe tại `http://localhost:8080`.

## Dùng với Cursor
### 1) Chạy Cloudflare để lấy URL HTTPS
Sau khi proxy đã chạy bằng `npm start`, mở thêm một terminal khác và chạy:

```powershell
cloudflared tunnel --url http://localhost:8080
```

Cloudflare sẽ trả về một URL dạng `https://xxxxx.trycloudflare.com`.

Hãy giữ terminal này chạy và copy đúng URL có `https` để dùng trong Cursor.

### 2) Add vào OpenAI API Key trên Cursor
Trong Cursor, vào phần cấu hình OpenAI hoặc OpenAI-compatible rồi nhập:
- OpenAI Base URL: dán URL HTTPS vừa lấy từ Cloudflare
- OpenAI API Key: nhập key bất kỳ cũng được

Ví dụ:
- Base URL: `https://xxxxx.trycloudflare.com`
- API Key: `abc123`

Proxy sẽ dùng `PROVIDER_API_KEY` ở phía server để gọi upstream, nên phần key trong Cursor chỉ cần có giá trị là được.

### 3) Chọn model để dùng
- Nếu muốn dùng **Opus 4.6 có thinking**: chọn `opus ram CL`
- Nếu muốn dùng **GPT-4.5**: chọn `gpt-4.5 ram`

## Kiểm tra nhanh
Sau khi ứng dụng chạy, bạn có thể kiểm tra endpoint sức khỏe:

```text
GET /healthz
```

Nếu chạy local mặc định, URL kiểm tra là `http://localhost:8080/healthz`.

Ví dụ kiểm tra nhanh trong PowerShell:
```powershell
Invoke-WebRequest http://localhost:8080/healthz
```

## Tóm tắt luồng sử dụng
1. Cài Node.js 18 trở lên.
2. Chạy `npm install`.
3. Khai báo `PORT`, `PROVIDER_BASE_URL`, `PROVIDER_API_KEY`.
4. Chạy `npm start`.
5. Chạy Cloudflare và lấy URL `https://...trycloudflare.com`.
6. Dán URL đó vào OpenAI Base URL trong Cursor, nhập API key bất kỳ.
7. Chọn model `opus ram CL` hoặc `gpt-4.5 ram` để dùng.
