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
$runtimeConfig = Join-Path $repoRoot "clipboard_bridge\runtime_config.py"

if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
  throw "请先设置 SHENZHEN_TUTOR_BRIDGE_TOKEN，再打包公网剪贴板桥接器"
}
$pythonToken = $BridgeToken | ConvertTo-Json -Compress
Set-Content -LiteralPath $runtimeConfig -Value "BRIDGE_TOKEN = $pythonToken" -Encoding utf8

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
    --hidden-import "runtime_config" `
    --name "ShenzhenTutorClipboardBridge" `
    --distpath $dist `
    --workpath $work `
    --specpath $spec `
    $source

  if ($LASTEXITCODE -ne 0) {
    throw "剪贴板桥接器打包失败"
  }
}
finally {
  Remove-Item -LiteralPath $runtimeConfig -Force -ErrorAction SilentlyContinue
}

Write-Host "EXE: $(Join-Path $dist 'ShenzhenTutorClipboardBridge.exe')"
