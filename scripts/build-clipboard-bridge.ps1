param(
  [string]$Python = "python",
  [string]$BridgeToken = $env:SHENZHEN_TUTOR_BRIDGE_TOKEN
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "clipboard_bridge\clipboard_collector.py"
$dist = Join-Path $repoRoot "dist\clipboard-bridge"
$work = Join-Path $repoRoot "build\clipboard-bridge"
$spec = Join-Path $repoRoot "build"
$packSource = Join-Path $work "clipboard_collector_pack.py"

if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
  throw "请先设置 SHENZHEN_TUTOR_BRIDGE_TOKEN，再打包公网剪贴板桥接器"
}
$pythonToken = $BridgeToken | ConvertTo-Json -Compress
$sourceText = Get-Content -LiteralPath $source -Raw -Encoding utf8
$sourceText = $sourceText -replace '(?s)try:\r?\n    from runtime_config import BRIDGE_TOKEN\r?\nexcept ImportError:\r?\n    BRIDGE_TOKEN = os.getenv\("SHENZHEN_TUTOR_BRIDGE_TOKEN", ""\)', "BRIDGE_TOKEN = $pythonToken"
New-Item -ItemType Directory -Path $work -Force | Out-Null
Set-Content -LiteralPath $packSource -Value $sourceText -Encoding utf8

try {
  & $Python -m PyInstaller --version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "未安装 PyInstaller。请先运行：$Python -m pip install pyinstaller"
  }

  & $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name "ShenzhenTutorClipboardBridge" `
    --distpath $dist `
    --workpath $work `
    --specpath $spec `
    $packSource

  if ($LASTEXITCODE -ne 0) {
    throw "剪贴板桥接器打包失败"
  }
}
finally {
  Remove-Item -LiteralPath $packSource -Force -ErrorAction SilentlyContinue
}

Write-Host "EXE: $(Join-Path $dist 'ShenzhenTutorClipboardBridge.exe')"
