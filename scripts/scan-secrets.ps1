$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $tracked = @(git -c core.quotepath=false ls-files)
    if (-not $tracked.Count) { throw 'No tracked files found. Initialize Git before running this check.' }

    $forbiddenPaths = @(
        '^TutorPlatform/data/'
    )
    $textExtensions = @('.js', '.json', '.md', '.html', '.css', '.ps1', '.bat', '.txt', '.yml', '.yaml', '.env', '')
    $patterns = [ordered]@{
        'mainland phone literal' = '(?<!\d)1[3-9]\d{9}(?!\d)'
        '32-character hexadecimal credential' = '(?i)(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])'
        'cloud credential prefix' = '(?i)(?:AKID|sk-)[A-Za-z0-9_-]{12,}'
        'private key block' = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
    }

    $problems = New-Object System.Collections.Generic.List[string]
    foreach ($file in $tracked) {
        $normalized = $file -replace '\\', '/'
        foreach ($pattern in $forbiddenPaths) {
            if ($normalized -match $pattern) {
                $problems.Add("$normalized`: tracked runtime/private path")
            }
        }

        $full = Join-Path $root $file
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        if ((Get-Item -LiteralPath $full).Length -gt 2MB) { continue }
        $extension = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($textExtensions -notcontains $extension) { continue }
        $content = [System.IO.File]::ReadAllText($full)
        foreach ($entry in $patterns.GetEnumerator()) {
            foreach ($match in [regex]::Matches($content, $entry.Value)) {
                $prefix = $content.Substring(0, $match.Index)
                $line = 1 + ([regex]::Matches($prefix, "`n")).Count
                $problems.Add("$normalized`:$line`: $($entry.Key)")
            }
        }
    }

    if ($problems.Count) {
        $problems | Sort-Object -Unique | ForEach-Object { Write-Error $_ }
        throw "Secret/privacy scan failed with $($problems.Count) finding(s)."
    }
    Write-Host "PASS secret/privacy scan: $($tracked.Count) tracked files checked"
} finally {
    Pop-Location
}
