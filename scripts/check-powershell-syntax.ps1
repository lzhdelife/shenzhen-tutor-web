$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$files = @(
    (Join-Path $root 'TutorOrderWatcher/TutorOrderWatcher.ps1'),
    (Join-Path $root 'TutorOrderWatcher/WindowsOcr.ps1'),
    (Join-Path $root 'TutorPlatform/auto-start.ps1')
)

$failed = $false
foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count) {
        $failed = $true
        foreach ($errorItem in $errors) {
            Write-Error "$file`:$($errorItem.Extent.StartLineNumber): $($errorItem.Message)"
        }
    } else {
        Write-Host "PASS PowerShell syntax: $file"
    }
}

if ($failed) { exit 1 }
