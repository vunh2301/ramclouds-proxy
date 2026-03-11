param(
  [string]$ApiKey = "",
  [string]$WorkspaceId = "ws-local",
  [string]$Provider = "amp",
  [int]$PollIntervalSec = 2,
  [int]$MaxPoll = 180,
  [int]$Port = 0,
  [switch]$StopServerWhenDone,
  [switch]$OpenBrowserFromScript
)

$ErrorActionPreference = "Stop"

function Get-EnvValueFromFile {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path $Path)) { return "" }

  foreach ($line in Get-Content -Path $Path) {
    $t = ($line -replace "\s+#.*$", "").Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    if ($t -match ("^" + [regex]::Escape($Name) + "=(.*)$")) {
      return $matches[1].Trim().Trim('"')
    }
  }

  return ""
}

function Wait-Healthz {
  param(
    [string]$BaseUrl,
    [int]$MaxSeconds = 40
  )

  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    try {
      $health = Invoke-RestMethod -Method GET -Uri "$BaseUrl/healthz" -TimeoutSec 3
      if ("$health" -eq "ok") { return $true }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  return $false
}

function Write-AmpSettingsFile {
  param(
    [string]$SettingsDir,
    [string]$ProxyUrl
  )

  try {
    $settingsPath = Join-Path $SettingsDir "settings.json"
    if (-not (Test-Path $SettingsDir)) {
      New-Item -ItemType Directory -Force -Path $SettingsDir | Out-Null
    }

    $obj = $null
    if (Test-Path $settingsPath) {
      try {
        $raw = Get-Content -Path $settingsPath -Raw
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
          $obj = $raw | ConvertFrom-Json
        }
      } catch {
        $obj = $null
      }
    }

    if ($null -eq $obj) {
      $obj = [pscustomobject]@{}
    }

    if (-not ($obj.PSObject.Properties.Name -contains "amp.url")) {
      $obj | Add-Member -NotePropertyName "amp.url" -NotePropertyValue $ProxyUrl
    } else {
      $obj."amp.url" = $ProxyUrl
    }

    $obj | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding UTF8
    Write-Host "Wrote AMP settings: $settingsPath -> amp.url=$ProxyUrl" -ForegroundColor DarkGray
  } catch {
    Write-Host "Could not write $SettingsDir\settings.json: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Set-AmpSettingsUrl {
  param(
    [string]$ProxyUrl
  )

  # Ghi ca APPDATA va ~/.config/amp/ de tuong thich AMP CLI moi + cu
  if ($env:APPDATA) {
    Write-AmpSettingsFile -SettingsDir (Join-Path $env:APPDATA "amp") -ProxyUrl $ProxyUrl
  }
  $xdgDir = Join-Path $HOME ".config\amp"
  Write-AmpSettingsFile -SettingsDir $xdgDir -ProxyUrl $ProxyUrl
}

function Copy-SecretsToken {
  param([string]$ProxyUrl)

  # amp login luu token duoi "apiKey@https://ampcode.com/"
  # amp CLI voi amp.url=http://localhost:PORT tim "apiKey@http://localhost:PORT/"
  # -> copy token sang key localhost
  $secretsDirs = @()
  if ($env:LOCALAPPDATA) { $secretsDirs += Join-Path $env:LOCALAPPDATA "amp" }
  if ($env:APPDATA) { $secretsDirs += Join-Path $env:APPDATA "amp" }
  $secretsDirs += Join-Path $HOME ".config\amp"

  $proxyKey = "apiKey@$($ProxyUrl.TrimEnd('/'))/"

  foreach ($dir in $secretsDirs) {
    $secretsPath = Join-Path $dir "secrets.json"
    if (-not (Test-Path $secretsPath)) { continue }

    try {
      $secrets = Get-Content -Path $secretsPath -Raw | ConvertFrom-Json
      $token = $null

      # Tim token tu ampcode.com
      foreach ($key in @("apiKey@https://ampcode.com/", "apiKey@https://ampcode.com")) {
        if ($secrets.PSObject.Properties.Name -contains $key -and $secrets.$key) {
          $token = $secrets.$key
          break
        }
      }

      # Fallback: tim bat ky apiKey@
      if (-not $token) {
        foreach ($prop in $secrets.PSObject.Properties) {
          if ($prop.Name.StartsWith("apiKey@") -and $prop.Value) {
            $token = $prop.Value
            break
          }
        }
      }

      if (-not $token) { continue }

      # Them key cho proxy URL
      if ($secrets.PSObject.Properties.Name -contains $proxyKey -and $secrets.$proxyKey -eq $token) { continue }

      if ($secrets.PSObject.Properties.Name -contains $proxyKey) {
        $secrets.$proxyKey = $token
      } else {
        $secrets | Add-Member -NotePropertyName $proxyKey -NotePropertyValue $token
      }

      $secrets | ConvertTo-Json -Depth 20 | Set-Content -Path $secretsPath -Encoding UTF8
      Write-Host "Copied token to $proxyKey in $secretsPath" -ForegroundColor DarkGray
    } catch {
      # best effort
    }
  }
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $repoRoot ".env"

if ($Port -le 0) {
  $rawPort = Read-Host "Nhap PORT de chay proxy (mac dinh 8080)"
  if ([string]::IsNullOrWhiteSpace($rawPort)) {
    $Port = 8080
  } elseif (-not [int]::TryParse($rawPort, [ref]$Port) -or $Port -le 0) {
    throw "PORT khong hop le"
  }
}

$baseUrl = "http://localhost:$Port"

# Kill process on port if occupied
try {
  $existingPid = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
  if ($existingPid) {
    Write-Host "Port $Port dang bi chiem boi PID=$existingPid. Dang kill..." -ForegroundColor Yellow
    $existingPid | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Write-Host "Da kill process tren port $Port." -ForegroundColor Green
  }
} catch {
  # best effort
}

if (-not $ApiKey) {
  $ApiKey = Get-EnvValueFromFile -Path $envFile -Name "AMP_ACCESS_TOKEN"
}
if (-not $ApiKey) {
  $ApiKey = Get-EnvValueFromFile -Path $envFile -Name "AMP_INBOUND_API_KEYS"
  if ($ApiKey -like "*,*") {
    $ApiKey = $ApiKey.Split(",")[0].Trim()
  }
}
if (-not $ApiKey) {
  throw "Missing API key. Pass -ApiKey or set AMP_ACCESS_TOKEN / AMP_INBOUND_API_KEYS in .env"
}

Write-Host "[info] Se set AMP_URL/AMP_API_KEY sau khi login thanh cong." -ForegroundColor DarkGray
Write-Host "[info] Se luu env vinh vien (setx) sau khi login thanh cong." -ForegroundColor DarkGray

# Logout session cu truoc khi login (unset env de tranh conflict)
Write-Host "[0/6] Logout session cu..." -ForegroundColor Cyan
$savedAmpUrl = $env:AMP_URL
$savedAmpApiKey = $env:AMP_API_KEY
try {
  $env:AMP_URL = $null
  $env:AMP_API_KEY = $null
  $logoutResult = & amp logout 2>&1
  Write-Host "Logout: $logoutResult" -ForegroundColor DarkGray
} catch {
  Write-Host "Logout skipped (amp chua cai hoac khong co session cu)" -ForegroundColor DarkGray
} finally {
  $env:AMP_URL = $savedAmpUrl
  $env:AMP_API_KEY = $savedAmpApiKey
}

Write-Host "[1/6] Khoi dong proxy server tren PORT=$Port ..." -ForegroundColor Cyan
$serverLogOut = Join-Path $repoRoot "amp-cli-e2e.server.out.log"
$serverLogErr = Join-Path $repoRoot "amp-cli-e2e.server.err.log"
$serverCmd = "Set-Location -LiteralPath '$repoRoot'; `$env:PORT='$Port'; npm start"

$serverProc = Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $serverCmd) -PassThru -RedirectStandardOutput $serverLogOut -RedirectStandardError $serverLogErr

$serverStarted = $false
try {
  if (-not (Wait-Healthz -BaseUrl $baseUrl -MaxSeconds 45)) {
    Write-Host "Server khong len duoc. Log loi:" -ForegroundColor Red
    if (Test-Path $serverLogErr) { Get-Content $serverLogErr -Tail 80 }
    if (Test-Path $serverLogOut) { Get-Content $serverLogOut -Tail 40 }
    throw "Proxy did not become healthy"
  }
  $serverStarted = $true

  Write-Host "[2/6] Kiem tra healthz..." -ForegroundColor Cyan
  $health = Invoke-RestMethod -Method GET -Uri "$baseUrl/healthz"
  Write-Host "healthz: $health" -ForegroundColor Green

  $headers = @{ "x-api-key" = $ApiKey }

  Write-Host "[3/6] Tao session login..." -ForegroundColor Cyan
  $configureBody = @{ workspace_id = $WorkspaceId; provider = $Provider } | ConvertTo-Json -Depth 5
  $cfg = Invoke-RestMethod -Method POST -Uri "$baseUrl/api/amp-cli/configure" -Headers $headers -ContentType "application/json" -Body $configureBody
  if (-not $cfg.session_id) {
    throw "configure did not return session_id"
  }

  $sessionId = $cfg.session_id
  Write-Host "session_id: $sessionId" -ForegroundColor Green
  Write-Host "state: $($cfg.state)" -ForegroundColor Yellow

  Write-Host "[4/6] Bat dau login..." -ForegroundColor Cyan
  $startBody = @{ session_id = $sessionId } | ConvertTo-Json
  $start = Invoke-RestMethod -Method POST -Uri "$baseUrl/api/amp-cli/start" -Headers $headers -ContentType "application/json" -Body $startBody
  Write-Host "start state: $($start.state)" -ForegroundColor Yellow

  Write-Host "[5/6] Theo doi trang thai..." -ForegroundColor Cyan
  Write-Host "Khi thay login_url, script se mo browser. Neu co auth_code thi copy code do paste vao trang login." -ForegroundColor DarkYellow
  $terminal = @("authenticated", "failed", "expired")
  $final = $null
  $openedLoginUrl = $false

  for ($i = 0; $i -lt $MaxPoll; $i++) {
    $st = Invoke-RestMethod -Method GET -Uri "$baseUrl/api/amp-cli/status?session_id=$sessionId" -Headers $headers
    $now = Get-Date -Format "HH:mm:ss"
    $line = "[$now] state=$($st.state) message=$($st.message)"

    if ($st.metadata -and $st.metadata.login_url) {
      $line = "$line login_url=$($st.metadata.login_url)"
      if (-not $openedLoginUrl) {
        $openedLoginUrl = $true
        if ($OpenBrowserFromScript) {
          try {
            Start-Process $st.metadata.login_url | Out-Null
            Write-Host "Opened browser URL: $($st.metadata.login_url)" -ForegroundColor Cyan
          } catch {
            Write-Host "Khong mo duoc browser tu dong. Mo tay URL: $($st.metadata.login_url)" -ForegroundColor Yellow
          }
        } else {
          Write-Host "Login URL: $($st.metadata.login_url)" -ForegroundColor Cyan
          Write-Host "Mo URL nay 1 lan duy nhat tren browser de tranh double-open." -ForegroundColor DarkYellow
        }
      }
    }

    if ($st.metadata -and $st.metadata.auth_code) {
      Write-Host "Authentication Code: $($st.metadata.auth_code)" -ForegroundColor Yellow
      try {
        Set-Clipboard -Value $st.metadata.auth_code
        Write-Host "Da copy auth code vao clipboard." -ForegroundColor DarkYellow
      } catch {
        # clipboard can fail in non-interactive hosts
      }
    }

    Write-Host $line -ForegroundColor Gray

    if ($terminal -contains $st.state) {
      $final = $st
      break
    }

    Start-Sleep -Seconds $PollIntervalSec
  }

  if (-not $final) {
    throw "Polling timed out after $MaxPoll checks"
  }

  Write-Host "[6/6] Hoan tat. Trang thai: $($final.state)" -ForegroundColor Green

  if ($final.state -eq "authenticated") {
    $env:AMP_URL = $baseUrl
    $env:AMP_API_KEY = $ApiKey
    Write-Host "Set local env: AMP_URL=$baseUrl" -ForegroundColor DarkGray
    Write-Host "Set local env: AMP_API_KEY=***" -ForegroundColor DarkGray

    Set-AmpSettingsUrl -ProxyUrl $baseUrl
    Copy-SecretsToken -ProxyUrl $baseUrl

    try {
      setx AMP_URL $baseUrl | Out-Null
      setx AMP_API_KEY $ApiKey | Out-Null
      Write-Host "Persisted user env with setx (effective for new terminals)." -ForegroundColor DarkGray
    } catch {
      Write-Host "Could not persist user env via setx: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  $final | ConvertTo-Json -Depth 10

  # Kill background server va chay lai foreground
  if ($final.state -eq "authenticated" -and $serverProc -and -not $serverProc.HasExited) {
    Write-Host "Dang tat server ngam (PID=$($serverProc.Id)) de chay lai foreground..." -ForegroundColor Cyan
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    $serverProc = $null  # skip finally cleanup
    Write-Host "Khoi dong proxy foreground: PORT=$Port npm start" -ForegroundColor Cyan
    Write-Host "Nhan Ctrl+C de dung proxy." -ForegroundColor Yellow
    Set-Location -LiteralPath $repoRoot
    $env:PORT = "$Port"
    npm start
  }
}
finally {
  if ($serverProc -and -not $serverProc.HasExited -and $StopServerWhenDone) {
    Write-Host "Stopping proxy server..." -ForegroundColor DarkGray
    Stop-Process -Id $serverProc.Id -Force
  }

  if ($serverStarted -and $serverProc -and -not $serverProc.HasExited -and -not $StopServerWhenDone) {
    Write-Host "Proxy server van dang chay (PID=$($serverProc.Id)). Dung Stop-Process -Id $($serverProc.Id) khi can dung." -ForegroundColor DarkGray
  }
}
