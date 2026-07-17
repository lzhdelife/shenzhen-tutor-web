$Script:WindowsOcrReady = $false
$Script:WindowsOcrEngine = $null
$Script:WindowsOcrAsTaskGeneric = $null

function Initialize-WindowsOcr {
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
        $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
        $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
        $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
        $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]

        $language = New-Object Windows.Globalization.Language("zh-Hans-CN")
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
        if (-not $engine) { return $false }

        $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
            Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
            Select-Object -First 1
        if (-not $method) { return $false }

        $Script:WindowsOcrEngine = $engine
        $Script:WindowsOcrAsTaskGeneric = $method
        $Script:WindowsOcrReady = $true
        return $true
    } catch {
        $Script:WindowsOcrReady = $false
        return $false
    }
}

function Wait-WindowsOcrOperation($operation, [Type]$resultType) {
    $asTask = $Script:WindowsOcrAsTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($operation))
    $task.Wait()
    return $task.Result
}

function Invoke-WindowsOcrText([string]$imagePath) {
    if (-not $Script:WindowsOcrReady -and -not (Initialize-WindowsOcr)) { return "" }
    $resolved = (Resolve-Path -LiteralPath $imagePath -ErrorAction Stop).Path
    $file = Wait-WindowsOcrOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved)) ([Windows.Storage.StorageFile])
    $stream = Wait-WindowsOcrOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Wait-WindowsOcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Wait-WindowsOcrOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $result = Wait-WindowsOcrOperation ($Script:WindowsOcrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @($result.Lines | ForEach-Object { [string]$_.Text } | Where-Object { $_.Trim() })
            if ($lines.Count) { return ($lines -join "`n") }
            return [string]$result.Text
        } finally {
            if ($bitmap -is [System.IDisposable]) { $bitmap.Dispose() }
        }
    } finally {
        if ($stream -is [System.IDisposable]) { $stream.Dispose() }
    }
}
