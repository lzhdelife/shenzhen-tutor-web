param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "clipboard_bridge\clipboard_collector.py"
$dist = Join-Path $repoRoot "dist\clipboard-bridge"
$work = Join-Path $repoRoot "build\clipboard-bridge"
$spec = Join-Path $repoRoot "build"

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
  $source

if ($LASTEXITCODE -ne 0) {
  throw "剪贴板桥接器打包失败"
}

Write-Host "EXE: $(Join-Path $dist 'ShenzhenTutorClipboardBridge.exe')"
