$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $repositoryRoot '.env.local'

Write-Host ''
Write-Host 'Shenzhen Tutor - Local Amap Setup' -ForegroundColor Cyan
Write-Host 'Paste the Amap Web Service Key. The input is hidden.'
$secureKey = Read-Host 'Amap Web Service Key' -AsSecureString

$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

if (-not $plainKey) {
    Write-Host 'No key entered. Configuration was not changed.' -ForegroundColor Yellow
    exit 1
}
if ($plainKey -match '[\r\n=]') {
    Write-Host 'Invalid key format. Configuration was not changed.' -ForegroundColor Red
    exit 1
}

$existing = if (Test-Path -LiteralPath $environmentPath) {
    @(Get-Content -LiteralPath $environmentPath -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*AMAP_WEB_SERVICE_KEY\s*=' })
} else {
    @()
}
$content = @($existing | Where-Object { $_ -ne '' }) + "AMAP_WEB_SERVICE_KEY=$plainKey"
[IO.File]::WriteAllLines($environmentPath, $content, [Text.UTF8Encoding]::new($false))

Write-Host ''
Write-Host 'Saved to the private local file .env.local.' -ForegroundColor Green
Write-Host 'Git ignores this file, so it will not be committed.'
Write-Host 'You can close this window now.'
