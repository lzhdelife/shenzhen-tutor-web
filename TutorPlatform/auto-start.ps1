$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Program Files\nodejs\node.exe'
$npx = 'C:\Program Files\nodejs\npx.cmd'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$urlFile = Join-Path $root 'PUBLIC-URL.txt'
$fixedUrlFile = Join-Path $root 'FIXED-ADDRESS-PAGE.txt'
$jsonFile = Join-Path $root 'public\latest-url.json'
$launchFile = Join-Path $root 'public\launch.html'
$addressJsonFile = Join-Path $root 'address-page\latest-url.json'
$addressPageDir = Join-Path $root 'address-page'
$outLog = Join-Path $env:TEMP 'tutor-platform-tunnel-out.log'
$errLog = Join-Path $env:TEMP 'tutor-platform-tunnel-error.log'
$deployOutLog = Join-Path $env:TEMP 'tutor-platform-address-page-deploy-out.log'
$deployErrLog = Join-Path $env:TEMP 'tutor-platform-address-page-deploy-error.log'

if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

if (-not (Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match 'localhost:8787'
})) {
  Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $cloudflared `
    -ArgumentList 'tunnel', '--url', 'http://localhost:8787', '--no-autoupdate' `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden
}

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  $logs = (Get-Content $outLog, $errLog -Raw -ErrorAction SilentlyContinue) -join "`n"
  $match = [regex]::Match($logs, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) {
    $now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    @(
      'Current public demo URL:'
      $match.Value
      ''
      "Updated at: $now"
      ''
      'This free temporary URL may change after a restart. This file updates automatically.'
    ) | Set-Content -LiteralPath $urlFile -Encoding UTF8
    @{
      url = $match.Value
      updatedAt = $now
    } | ConvertTo-Json | Set-Content -LiteralPath $jsonFile -Encoding UTF8
    @{
      url = $match.Value
      updatedAt = $now
    } | ConvertTo-Json | Set-Content -LiteralPath $addressJsonFile -Encoding UTF8
    @(
      'Fixed address page:'
      'https://tutor-platform-address.pages.dev'
      ''
      'Current platform URL:'
      $match.Value
      ''
      "Updated at: $now"
      ''
      'Teachers and agencies should bookmark the fixed address page.'
    ) | Set-Content -LiteralPath $fixedUrlFile -Encoding UTF8
    @"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>家教单平台最新地址</title>
  <style>
    body{margin:0;font-family:"Microsoft YaHei UI",Arial,sans-serif;background:#f6f7f9;color:#17202a}
    main{max-width:720px;margin:8vh auto;padding:28px;background:#fff;border:1px solid #dde3ea;border-radius:10px}
    h1{margin:0 0 10px;font-size:28px}p{color:#667085;line-height:1.7}
    a.button{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700}
    code{word-break:break-all;background:#f1f5f9;padding:4px 6px;border-radius:6px}
  </style>
</head>
<body>
  <main>
    <h1>家教单平台最新地址</h1>
    <p>当前平台地址已更新于：$now</p>
    <p><code>$($match.Value)</code></p>
    <a class="button" href="$($match.Value)">打开家教单平台</a>
    <p>提示：免费临时公网地址可能在电脑重启后变化，请以这个发布页或管理员提供的最新地址为准。</p>
  </main>
</body>
</html>
"@ | Set-Content -LiteralPath $launchFile -Encoding UTF8

    if (Test-Path $npx) {
      Start-Process -FilePath $npx `
        -ArgumentList @('--yes', 'wrangler', 'pages', 'deploy', $addressPageDir, '--project-name', 'tutor-platform-address', '--commit-dirty=true') `
        -WorkingDirectory $root `
        -RedirectStandardOutput $deployOutLog `
        -RedirectStandardError $deployErrLog `
        -WindowStyle Hidden `
        -Wait
    }
    break
  }
}
