$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct POINT {
    public int X;
    public int Y;
}
[StructLayout(LayoutKind.Sequential)]
public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}
public static class NativeDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
    public static void Scroll(int delta) { mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero); }
    public static void LeftClick() {
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
}
"@
try {
    [NativeDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
} catch {
    try {
        [NativeDpi]::SetProcessDpiAwareness(2) | Out-Null
    } catch {
        try { [NativeDpi]::SetProcessDPIAware() | Out-Null } catch { }
    }
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$Script:AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script:DataDir = Join-Path $Script:AppDir "data"
$Script:ExportDir = Join-Path $Script:AppDir "exports"
$Script:TempDir = Join-Path $Script:AppDir "temp"
$Script:TessDataDir = Join-Path $Script:AppDir "tessdata"
$Script:ConfigPath = Join-Path $Script:DataDir "config.json"
$Script:OrdersPath = Join-Path $Script:DataDir "orders.csv"
$Script:GeoCachePath = Join-Path $Script:DataDir "geocache.json"
$Script:LastCapturePath = Join-Path $Script:DataDir "last_capture.png"
$Script:LastOcrPath = Join-Path $Script:DataDir "last_ocr.txt"
$Script:ReadGroupsPath = Join-Path $Script:DataDir "read_groups.json"
New-Item -ItemType Directory -Force -Path $Script:DataDir, $Script:ExportDir, $Script:TempDir | Out-Null

$windowsOcrModule = Join-Path $Script:AppDir "WindowsOcr.ps1"
if (Test-Path $windowsOcrModule) { . $windowsOcrModule }
if (Get-Command Initialize-WindowsOcr -ErrorAction SilentlyContinue) { Initialize-WindowsOcr | Out-Null }

function Find-Tesseract {
    $cmd = Get-Command tesseract.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $paths = @(
        "C:\Program Files\Tesseract-OCR\tesseract.exe",
        "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"
    )
    foreach ($p in $paths) { if (Test-Path $p) { return $p } }
    return $null
}

$Script:TesseractPath = Find-Tesseract

$DefaultConfig = [ordered]@{
    Home = "深圳宝安西乡"
    PreferredSubjects = "数学,物理"
    PreferredGrades = "初中,高中,初一,初二,初三,高一,高二,高三"
    PreferredDistricts = "宝安,南山"
    MinPrice = 150
    AmapKey = ""
    City = "深圳"
    MaxBikeKm = 12
    AlertScore = 80
    IntervalSeconds = 8
    CaptureRect = $null
    PlatformUrl = "http://localhost:8787"
    AgencyName = "微信自动采集"
    AgencyPhone = ""
    WeChatGroups = ""
    GroupSearchLimit = 20
    PagesPerGroup = 3
    AutoSwitchGroups = $false
    AutoScroll = $true
    AutoUpload = $true
}

function Load-Config {
    if (Test-Path $Script:ConfigPath) {
        try {
            $loaded = Get-Content $Script:ConfigPath -Raw | ConvertFrom-Json
            foreach ($k in $DefaultConfig.Keys) {
                if (-not ($loaded.PSObject.Properties.Name -contains $k)) {
                    $loaded | Add-Member -NotePropertyName $k -NotePropertyValue $DefaultConfig[$k]
                }
            }
            return $loaded
        } catch { }
    }
    return [pscustomobject]$DefaultConfig
}

function Save-Config {
    $cfg = [ordered]@{
        Home = $txtHome.Text
        PreferredSubjects = $txtSubjects.Text
        PreferredGrades = $txtGrades.Text
        PreferredDistricts = $txtDistricts.Text
        MinPrice = [int]$numMinPrice.Value
        AmapKey = $txtAmapKey.Text.Trim()
        City = $txtCity.Text.Trim()
        MaxBikeKm = [int]$numMaxBikeKm.Value
        AlertScore = [int]$numAlert.Value
        IntervalSeconds = [int]$numInterval.Value
        CaptureRect = $Script:CaptureRect
        PlatformUrl = $txtPlatformUrl.Text.Trim()
        AgencyName = $txtAgencyName.Text.Trim()
        AgencyPhone = $txtAgencyPhone.Text.Trim()
        WeChatGroups = $txtWeChatGroups.Text.Trim()
        GroupSearchLimit = [int]$numGroupSearchLimit.Value
        PagesPerGroup = [int]$numPagesPerGroup.Value
        AutoSwitchGroups = $chkAutoSwitch.Checked
        AutoScroll = $chkAutoScroll.Checked
        AutoUpload = $chkAutoUpload.Checked
    }
    $cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $Script:ConfigPath -Encoding UTF8
}

function New-Hash([string]$text) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text.Trim())
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").Substring(0, 16)
}

$Script:PlatformToken = ""
$Script:GroupIndex = 0
$Script:GroupPageIndex = 0
$Script:ReadGroups = @{}
$Script:CurrentGroupName = ""
$Script:LastOpenedGroupName = ""
$Script:StopRequested = $false
$Script:AutoRunning = $false
$Script:LastScanText = ""
$Script:LastScanImageData = ""

function Test-StopRequested {
    if ($Script:StopRequested) { throw "自动搬运已停止。" }
}

function Wait-Responsive([int]$milliseconds) {
    $end = (Get-Date).AddMilliseconds($milliseconds)
    while ((Get-Date) -lt $end) {
        [System.Windows.Forms.Application]::DoEvents()
        Test-StopRequested
        Start-Sleep -Milliseconds 50
    }
}

function Normalize-WeChatGroupName([string]$name) {
    if (-not $name) { return "" }
    $cleaned = [regex]::Replace($name, "[\p{Cf}\p{Cc}]", " ")
    $cleaned = ($cleaned -replace "\s+", " ").Trim()
    $cleaned = $cleaned -replace "\s+[—\-一]\s*[口□]\s*[xX×]\s*$", ""
    return $cleaned.Trim(" `t`r`n-|｜")
}

function Test-UsefulWeChatGroupName([string]$name) {
    $cleaned = Normalize-WeChatGroupName $name
    if ($cleaned.Length -lt 2 -or $cleaned.Length -gt 60) { return $false }
    if ($cleaned -match "聊天记录|开始搬运|网站地址|连接网站|识别并上传|微信家教订单搬运助手|查看截图|查看识别文字") { return $false }
    if ($cleaned -match "^[家教群]+\s*匹配群\s*#\d+$") { return $true }
    $chineseCount = ([regex]::Matches($cleaned, "[\u4e00-\u9fff]")).Count
    if ($chineseCount -lt 2) { return $false }
    if ($cleaned -match "家教|辅导|老师|教育|学习|兼职|小学|初中|高中|大学") { return $true }
    $latinWordCount = ([regex]::Matches($cleaned, "[A-Za-z]{2,}")).Count
    return $chineseCount -ge 3 -and $latinWordCount -le 1
}

function Load-ReadGroups {
    $Script:ReadGroups = @{}
    if (Test-Path $Script:ReadGroupsPath) {
        try {
            $saved = Get-Content $Script:ReadGroupsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $removedInvalid = $false
            foreach ($property in $saved.PSObject.Properties) {
                $name = Normalize-WeChatGroupName $property.Name
                if (-not (Test-UsefulWeChatGroupName $name)) {
                    $removedInvalid = $true
                    continue
                }
                $Script:ReadGroups[$name] = $property.Value
                if ($name -ne $property.Name) { $removedInvalid = $true }
            }
            if ($removedInvalid) { Save-ReadGroups }
        } catch { $Script:ReadGroups = @{} }
    }
}

function Save-ReadGroups {
    $saved = [ordered]@{}
    foreach ($name in $Script:ReadGroups.Keys) { $saved[$name] = $Script:ReadGroups[$name] }
    $saved | ConvertTo-Json -Depth 4 | Set-Content -Path $Script:ReadGroupsPath -Encoding UTF8
}

function Get-PlatformUrl {
    $base = $txtPlatformUrl.Text.Trim().TrimEnd("/")
    if (-not $base) { return "http://localhost:8787" }
    return $base
}

function Connect-Platform {
    $name = $txtAgencyName.Text.Trim()
    $phone = $txtAgencyPhone.Text.Trim()
    $password = $txtAgencyPassword.Text
    if (-not $name -or -not $phone -or $password.Length -lt 6) {
        throw "请填写采集账号名称、联系方式和至少6位密码。首次使用会自动创建这个中介采集账号。"
    }
    $body = @{ role="agency"; name=$name; phone=$phone; password=$password } | ConvertTo-Json
    $result = Invoke-RestMethod -Method Post -Uri ((Get-PlatformUrl) + "/api/login") -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
    $Script:PlatformToken = [string]$result.token
    return $result
}

function Send-ToPlatform([string]$text, [string[]]$images = @(), [object[]]$pages = @()) {
    if (-not $chkAutoUpload.Checked -or $text.Trim().Length -lt 10) { return $null }
    if (-not $Script:PlatformToken) { Connect-Platform | Out-Null }
    $headers = @{ Authorization = "Bearer $($Script:PlatformToken)" }
    $body = @{
        text = $text
        images = @($images | Where-Object { $_ })
        pages = @($pages | Where-Object { $_ })
    } | ConvertTo-Json -Depth 7
    try {
        return Invoke-RestMethod -Method Post -Uri ((Get-PlatformUrl) + "/api/import") -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
            $Script:PlatformToken = ""
            Connect-Platform | Out-Null
            $headers.Authorization = "Bearer $($Script:PlatformToken)"
            return Invoke-RestMethod -Method Post -Uri ((Get-PlatformUrl) + "/api/import") -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
        }
        throw
    }
}

function Repair-OcrLine([string]$line) {
    $s = $line.Trim()
    if (-not $s) { return "" }
    $s = $s -replace "(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", ""
    $s = $s -replace "(?<=\d)\s+(?=\d)", ""
    $s = $s -replace "(?<=[\u4e00-\u9fff])\s+(?=[A-Za-z0-9])", ""
    $s = $s -replace "(?<=[A-Za-z0-9])\s+(?=[\u4e00-\u9fff])", ""
    $s = $s -replace "\s+([，。；：、）】〕〗])", '$1'
    $s = $s -replace "([（【〖])\s+", '$1'
    $s = $s -replace "([，。；：、])\s+", '$1'
    $s = $s -replace "(?<=[\u4e00-\u9fff])\s*[．·]\s*(?=[\u4e00-\u9fff])", "·"
    $s = $s -replace "\s*[/／]\s*", "/"
    $s = $s -replace "(?<=\d)\s*[一—~～]\s*(?=\d)", "-"
    $s = $s -replace "BY(\d{6,})\s*[．.]\s*(\d+)\b", 'BY$1-$2'
    $s = $s -replace "(\d{2,})\s*[．.]\s*(\d{2,})(?=\s*(?:/|元|次))", '$1-$2'
    $s = $s -replace "一次\s*(\d+)\s*[．.]\s*(\d+)\s*[，,]\s*(\d+)\s*h", '一次$1-$2.$3h'
    $s = $s -replace "^[（(〖〔]\s*([^〕〗）)]{2,100})\s*[〕〗）)]$", '【$1】'
    $s = $s -replace "^[（(〖〔]\s*(年级科目|年级性别|辅导地点|辅导地址|学员地址|上课地址|地址|地点|科目内容|辅导科目|科目|课时报酬|课费报酬|课费薪酬|课酬报酬|课时价格|学生情况|学员情况|情况|时间次数|时间安排|时间|次数|老师要求|教师要求|教员要求|教员|学生|学员|薪酬|薪资|课酬|要求)\s*[〕〗）)]", '【$1】'
    $s = $s -replace "深圳线下\s*[」J]\s*Z(?=\d{6,})", "深圳线下JZ"
    $s = $s -replace "深圳\s*[|｜ⅠI]\s*(?=BY\d)", "深圳"
    $s = $s -replace "^[#＃]{1,3}\s*襄田(?=侨香)", "福田"
    $s = $s -replace "襄田(?=侨香)", "福田"
    $s = $s -replace "孑子岭|子子岭", "孖岭"
    $s = $s -replace "京基白纳", "京基百纳"
    $s = $s -replace "龙[离寓]楼", "龙宫楼"
    $s = $s -replace "伊墩酒店", "伊敦酒店"
    $s = $s -replace "口讠吾", "口语"
    $s = $s -replace "校夕卜", "校外"
    $s = $s -replace "南山一伊敦酒店", "南山-伊敦酒店"
    $s = $s -replace "纟屯正", "纯正"
    $s = $s -replace "(【科目】|科目[:：])\s*数子", '$1数学'
    $s = $s -replace "娄攵学央讠吾|娄攵学英讠吾", "数学英语"
    $s = $s -replace "高俄1", "高一俄语"
    $s = $s -replace "准高(?=语文|数学|英语|物理|化学|生物|政治|历史|地理)", "准高一"
    $s = $s -replace "幼丿[Ll]?园", "幼儿园"
    $s = $s -replace "幼丿[Ll]", "幼儿"
    $s = $s -replace "(\d)\s*[,，]\s*(\d)(?=\s*(?:小时|h))", '$1.$2'
    $s = $s -replace "((?:每次)?时?长[:：])\s*巧\s*小时", '$1 1.5小时'
    $s = $s -replace "(?<=点)\s*一\s*(?=\d)", "-"
    $s = $s -replace "^[0O囗\s]+(?=今日新单)", ""
    $s = $s -replace "^[#＃]{1,3}(?=罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏)", ""
    $s = $s -replace "^[【\[]\s*([^】\]：:]{1,12})\s*[：:]\s*[】\]]", '【$1】'
    $s = $s -replace "^\[\s*([^】\]]{1,12})\s*】", '【$1】'
    $s = $s -replace "^【\s*([^】\]]{1,12})\s*\]", '【$1】'
    $s = $s -replace "^【[zZ2](?=深圳市)", "【Z"
    $s = $s -replace "[｜|]{2,}", "|"
    $s = $s -replace "^[~·`'""\-\s_=|]+$", ""
    $s = $s -replace "(?<=\d)\s*/\s*[Kk](?=\s|$)", "/天"
    $s = $s -replace "(?<=\d)\s*[Kk]\s*(?=[,，、；; ]|$)", "次"
    $s = $s -replace "(?<=\d)\s*/\s*[Rr]\b", "/次"
    $s = $s -replace "(?<=\d)\s*[Rr]\b", "次"
    $s = $s -replace "\bIR\b", "次"
    $s = $s -replace "\bSee\s*\|\s*YY\s*WT\b", ""
    $s = $s -replace "\bBARK\s*[:：]?", "老师要求："
    $s = $s -replace "\bBAR\s*[:：]?", "老师要求："
    $s = $s -replace "\bBR\s*[:：]?", "老师要求："
    $s = $s -replace "^RBM\s*[:：]\s*", "家教薪酬："
    $s = $s -replace "^RAGAN\s*[:：]\s*(?=\d{2,4})", "家教薪酬："
    $s = $s -replace "(?<=\d)\s*巾(?=\s*(?:[，,。；;]|$))", "/h"
    $s = $s -replace "大国海", "大粤海"
    $s = $s -replace "(?<=\d)分钅中", "分钟"
    $s = $s -replace "\s*和?\d{2,4}[^\s，。]{0,2}新消息.*$", ""
    $s = $s -replace "^学生成绩当一$", "学生成绩当前不是"
    $s = $s -replace "语广", "语文"
    $s = $s -replace "深圳线下仿(?=GJP)", "深圳线下"
    $s = $s -replace "([一二三四五六日天])\s*IR", '$1次'
    $s = $s -replace "周二五", "周二、周五"
    $s = $s -replace "读小学后", "读小学后"
    $s = $s -replace "恨好", "很好"
    $s = $s -replace "有了耐心", "有耐心"
    $s = $s -replace "有而心", "有耐心"
    $s = $s -replace "夕\s*卜教", "外教"
    $s = $s -replace "^语好$", "口语好"
    $s = $s -replace "^次\s*(\d+(?:\.\d+)?)\s*h", '一次$1h'
    $s = $s -replace "^(情况|要求|时间|科目|地址|薪酬|薪资|课酬|年级学科)\s*[，,]\s*", '$1：'
    $s = $s -replace "(?<![A-Za-z])[0o]\s+r(?![A-Za-z])", "or"
    $s = $s -replace "男[下防]", "男孩"
    $s = $s -replace "男女\s*[千于干]\s*可", "男女皆可"
    $s = $s -replace "[署团哮嗜]假", "暑假"
    $s = $s -replace "(\d+)\s*h[yv]\s*/\s*次", '$1h/次'
    $s = $s -replace "(\d+)\s+(\d+)\s*次", '$1-$2次'
    $s = $s -replace "一周\s*(\d+)\s+(\d+)", '一周$1-$2次'
    $s = $s -replace "(\d+)\s*h\s*/\s*次", '$1h/次'
    $s = $s -replace "\s{2,}", " "
    return $s.Trim()
}

function Test-UsefulOcrLine([string]$line) {
    $s = $line.Trim()
    if ($s.Length -lt 2) { return $s -match "^(时|次|元|月|天|节|岁|男|女)$" }
    if ($s -match "^\d{1,2}[：:]\d{2}$") { return $false }
    if ($s -match "^\d{1,2}[：:]\d{1,2}$") { return $false }
    if ($s -match "^\d+(?:[.,，]\d+)?\s*h(?:\s*/\s*次)?$") { return $true }
    if ($s -match "^(?:\d+[、.．)]\s*)?\d{2,5}(?:\s*[-~～]\s*\d{2,5})?\s*(?:元|/\s*(?:\d+(?:\.\d+)?\s*)?(?:h|小时|时|次|节))$") { return $true }
    if ($s -match "^[0-9A-Za-z_\- |~·`'""=]{1,18}$") { return $false }
    if ($s -match "^[~·`'""\-\s_=|]+$") { return $false }
    if ($s -match "禁言|你的好友|群聊|群\d+|家教群.*[（(]\d+[）)]|一群禁|条新.{0,5}息|\\[\\d+条\\]|\\d{1,2}[：:]\\d{2}.*\\.\\.\\.|wghAAABBB") { return $false }
    if ($s -match "肖老师接单|接单\s*\+?\s*[vV]|喜报喜报|招肖肖老师发单|动动手指|拿提成|扫码.*家教群|招小代理|招代理") { return $false }
    if ($s -match "家教.*老师.*(?:换群|招小助).*共\s*\d+\s*条") { return $false }
    if ($s -match "^今日新单\s*[&＆].*(?:上门|专职|大学生)\s*$") { return $false }
    if ($s -match "^[目刂刁〈〉《》\s]+是?$") { return $false }
    if ($s -match "^新单\s*[!！0\s]*$") { return $false }
    $garbageCount = ([regex]::Matches($s, "[丷丿亇卜刭朩氵讠丨囗刀丫]" )).Count
    if ($garbageCount -ge 3 -and $s -notmatch "地址|地点|科目|时间|薪酬|薪资|要求|学生|学员") { return $false }
    if ($garbageCount -ge 1 -and $s -match "[A-Za-z]" -and $s -notmatch "地址|地点|科目|时间|薪酬|薪资|要求|学生|学员") { return $false }
    if ($s -match "^(?:家教内容|年级学科|年级科目|科目内容|辅导科目)\s*[:：]\s*(?<value>.*)$") {
        $value = $Matches["value"]
        $asciiWords = ([regex]::Matches($value, "[A-Za-z]{2,}")).Count
        $valueChinese = ([regex]::Matches($value, "[\u4e00-\u9fff]")).Count
        $knownEnglish = $value -match "(?i)english|math|physics|chemistry|biology|phonics|p5\.js|python|java|c\+\+|amc"
        if ($asciiWords -ge 2 -and $valueChinese -le 1 -and -not $knownEnglish) { return $false }
    }
    $chineseCount = ([regex]::Matches($s, "[\u4e00-\u9fff]")).Count
    if ($chineseCount -eq 0 -and $s.Length -lt 12) { return $false }
    if ($s -match "^(gh|wx|微信号|出示学信网)$") { return $false }
    return $true
}

function Clean-OcrText([string]$ocrText) {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($raw in ($ocrText -split "`r?`n")) {
        $line = Repair-OcrLine $raw
        if (-not (Test-UsefulOcrLine $line)) { continue }
        if ($lines.Count -gt 0) {
            $currentKey = (($line.ToLowerInvariant()) -replace "[^\p{L}\p{Nd}]", "")
            $previousKey = (($lines[$lines.Count - 1].ToLowerInvariant()) -replace "[^\p{L}\p{Nd}]", "")
            if ($currentKey -and $currentKey -eq $previousKey) { continue }
        }
        $lines.Add($line)
    }
    $joined = ($lines -join "`n").Trim()
    $joined = $joined -replace "(?m)^[（(〖〔]\s*([gGlLzZ][^`n〕〗）)]{4,90})`n[一—\-]?\s*([^`n〕〗）)]{1,50})\s*[〕〗）)]$", '【$1$2】'
    $joined = $joined -replace "(?m)(\d+(?:[.,，]\d+)?小)`n时\b", '$1时'
    $joined = $joined -replace "(?mi)(h|小时|/)`n次\b", '$1次'
    $joined = $joined -replace "(\d)\s*[,，]\s*(\d)(?=\s*小时)", '$1.$2'
    $joined = $joined -replace "课时价格[:：]?\s*(\d{2,4})\s*元\s*/\s*小时", '课时价格：$1元/小时'
    $joined = $joined -replace "老师要求[:：]?\s*", "老师要求："
    $joined = $joined -replace "时间次数[:：]?\s*", "时间次数："
    $joined = $joined -replace "科目内容[:：]?\s*", "科目内容："
    $joined = $joined -replace "年级性别[:：]?\s*", "年级性别："
    $joined = $joined -replace "辅导地址[:：]?\s*", "辅导地址："
    $joined = $joined -replace "【([^】]{1,12})：】", '【$1】'
    $joined = $joined -replace "(?m)^(【[^】]+】)\s+", '$1'
    return $joined
}

function ConvertTo-OcrComparableText([string]$text) {
    if (-not $text) { return "" }
    return (($text.ToLowerInvariant()) -replace "[^\p{L}\p{Nd}]", "")
}

function Get-OcrTextSimilarity([string]$left, [string]$right) {
    $a = ConvertTo-OcrComparableText $left
    $b = ConvertTo-OcrComparableText $right
    if (-not $a -or -not $b) { return 0.0 }
    if ($a -eq $b) { return 1.0 }

    $minLength = [Math]::Min($a.Length, $b.Length)
    $maxLength = [Math]::Max($a.Length, $b.Length)
    if ($minLength -lt 2) { return 0.0 }
    if ($a.Contains($b) -or $b.Contains($a)) {
        return [double]$minLength / [double]$maxLength
    }

    $leftPairs = @{}
    $rightPairs = @{}
    for ($i = 0; $i -lt ($a.Length - 1); $i++) { $leftPairs[$a.Substring($i, 2)] = $true }
    for ($i = 0; $i -lt ($b.Length - 1); $i++) { $rightPairs[$b.Substring($i, 2)] = $true }
    if ($leftPairs.Count -eq 0 -or $rightPairs.Count -eq 0) { return 0.0 }
    $common = 0
    foreach ($pair in $leftPairs.Keys) {
        if ($rightPairs.ContainsKey($pair)) { $common++ }
    }
    return (2.0 * $common) / ($leftPairs.Count + $rightPairs.Count)
}

function Merge-OcrPagePair([string]$olderText, [string]$newerText) {
    $olderLines = @($olderText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $newerLines = @($newerText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($olderLines.Count -eq 0) { return ($newerLines -join "`n") }
    if ($newerLines.Count -eq 0) { return ($olderLines -join "`n") }

    $maxOlder = [Math]::Min(18, $olderLines.Count)
    $maxNewer = [Math]::Min(18, $newerLines.Count)
    $bestNewerCount = 0
    $bestMetric = 0.0

    for ($olderCount = 1; $olderCount -le $maxOlder; $olderCount++) {
        $olderStart = $olderLines.Count - $olderCount
        $olderPart = ($olderLines[$olderStart..($olderLines.Count - 1)] -join " ")
        $olderComparable = ConvertTo-OcrComparableText $olderPart
        if ($olderComparable.Length -lt 16) { continue }

        for ($newerCount = 1; $newerCount -le $maxNewer; $newerCount++) {
            $newerPart = ($newerLines[0..($newerCount - 1)] -join " ")
            $newerComparable = ConvertTo-OcrComparableText $newerPart
            $shortLength = [Math]::Min($olderComparable.Length, $newerComparable.Length)
            $longLength = [Math]::Max($olderComparable.Length, $newerComparable.Length)
            if ($shortLength -lt 16 -or ([double]$shortLength / [double]$longLength) -lt 0.58) { continue }

            $similarity = Get-OcrTextSimilarity $olderPart $newerPart
            if ($similarity -lt 0.70) { continue }
            $metric = $similarity * $shortLength
            if ($metric -gt $bestMetric) {
                $bestMetric = $metric
                $bestNewerCount = $newerCount
            }
        }
    }

    $merged = New-Object System.Collections.Generic.List[string]
    foreach ($line in $olderLines) { $merged.Add($line) }
    for ($i = $bestNewerCount; $i -lt $newerLines.Count; $i++) { $merged.Add($newerLines[$i]) }
    return ($merged -join "`n").Trim()
}

function Merge-OcrPages([string[]]$pageTexts) {
    $valid = New-Object System.Collections.Generic.List[string]
    foreach ($pageText in @($pageTexts)) {
        if ($pageText -and $pageText.Trim().Length -gt 0) { $valid.Add($pageText.Trim()) }
    }
    if ($valid.Count -eq 0) { return "" }

    # The first capture is the newest screen. Scrolling upward produces older
    # screens. Keep every page in chronological order and let the website
    # deduplicate complete orders. This deliberately avoids deleting a real
    # order when two template-heavy messages look like the same overlap.
    $ordered = New-Object System.Collections.Generic.List[string]
    for ($i = $valid.Count - 1; $i -ge 0; $i--) {
        $candidate = $valid[$i].Trim()
        if ($ordered.Count -gt 0) {
            $previous = $ordered[$ordered.Count - 1]
            $lengthRatio = [double][Math]::Min($previous.Length, $candidate.Length) / [Math]::Max($previous.Length, $candidate.Length)
            if ($lengthRatio -ge 0.97 -and (Get-OcrTextSimilarity $previous $candidate) -ge 0.98) { continue }
        }
        $ordered.Add($candidate)
    }
    return ($ordered -join "`n`n").Trim()
}

function Test-LooksLikeWrongScreen([string]$text) {
    $s = ($text -replace "\s+", " ").Trim()
    if (-not $s) { return $true }
    $wrongSignals = @(
        "微信家教订单搬运助手",
        "家教订单自动采集助手",
        "网站中介账号",
        "中介账号密码",
        "自动定位读取",
        "自动定位并查看截图",
        "识别并上传一次",
        "开始自动搬运",
        "停止自动搬运",
        "localhost:8787",
        "alhost:8787",
        "问题反馈",
        "申请接单",
        "复制原文",
        "搜索 视频 问一问",
        "扫码立即进入家教群",
        "群聊满了",
        "二维码过期"
    )
    foreach ($signal in $wrongSignals) {
        if ($s -like "*$signal*") { return $true }
    }
    $hasOrderSignal = $s -match "学员地址|辅导地址|上课地址|辅导科目|科目内容|学员情况|年级性别|时间安排|时间次数|老师薪水|课时价格|老师要求|课酬|薪酬|一周|每周|每次|小时|元/小时|元\s*/\s*小时"
    $hasSubject = $s -match "语文|数学|英语|物理|化学|生物|全科"
    $hasPlace = $s -match "宝安|南山|福田|罗湖|龙华|龙岗|光明|坪山|盐田|深圳"
    $hasPrice = $s -match "\d{2,4}\s*元\s*/?\s*(小时|h|H)|\d{2,4}\s*/\s*(小时|h|H)"
    $hasGrade = $s -match "小学|一年级|二年级|三年级|四年级|五年级|六年级|初一|初二|初三|初中|新初|高一|高二|高三|新高|八年级|七年级|九年级"
    return -not (($hasOrderSignal -and ($hasSubject -or $hasPlace)) -or ($hasSubject -and $hasPlace -and ($hasPrice -or $hasGrade)))
}

function Test-WeChatMainProcessName([string]$processName) {
    return [bool]($processName -match '^(?i:WeChat|Weixin)$')
}

function Get-WeChatProcess {
    $candidates = @()
    foreach ($process in (Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne 0 -and (Test-WeChatMainProcessName $_.ProcessName)
    })) {
        $nativeRect = New-Object RECT
        if ([NativeDpi]::GetWindowRect($process.MainWindowHandle, [ref]$nativeRect)) {
            $width = $nativeRect.Right - $nativeRect.Left
            $height = $nativeRect.Bottom - $nativeRect.Top
            if ($width -ge 500 -and $height -ge 400) {
                $candidates += [pscustomobject]@{
                    Process = $process
                    Area = $width * $height
                }
            }
        }
    }
    return ($candidates | Sort-Object Area -Descending | Select-Object -First 1).Process
}

function Activate-WeChatWindow {
    $wechat = Get-WeChatProcess
    if (-not $wechat) { throw "没有找到电脑版微信窗口，请先打开并登录微信。" }
    # Restore a minimized WeChat window before sending search keys. SetForegroundWindow
    # alone does not restore it, so the keys could otherwise go to the helper itself.
    [NativeDpi]::ShowWindow($wechat.MainWindowHandle, 9) | Out-Null
    Wait-Responsive 180
    [NativeDpi]::SetForegroundWindow($wechat.MainWindowHandle) | Out-Null
    Wait-Responsive 350
    return $wechat
}

function Get-WeChatWindowRect {
    $wechat = Get-WeChatProcess
    if (-not $wechat) { return $null }
    [NativeDpi]::ShowWindow($wechat.MainWindowHandle, 9) | Out-Null
    Wait-Responsive 250
    $nativeRect = New-Object RECT
    if (-not [NativeDpi]::GetWindowRect($wechat.MainWindowHandle, [ref]$nativeRect)) { return $null }
    $width = $nativeRect.Right - $nativeRect.Left
    $height = $nativeRect.Bottom - $nativeRect.Top
    if ($width -lt 500 -or $height -lt 400) { return $null }
    return [System.Drawing.Rectangle]::new($nativeRect.Left, $nativeRect.Top, $width, $height)
}

function Get-WeChatChatBodyRect([System.Drawing.Rectangle]$window) {
    if ($window.Width -lt 500 -or $window.Height -lt 400) {
        throw "微信窗口尺寸太小，无法可靠定位聊天正文。"
    }
    # These ratios are based on the DPI-aware physical window rectangle, so
    # they remain accurate when Windows display scaling is set to 200%.
    $x = $window.X + [int]($window.Width * 0.48)
    $y = $window.Y + [int]($window.Height * 0.07)
    $width = [int]($window.Width * 0.50)
    $height = [int]($window.Height * 0.76)
    return [System.Drawing.Rectangle]::new($x, $y, $width, $height)
}

function Get-WeChatScrollPoint([System.Drawing.Rectangle]$captureRect) {
    $rightMargin = [int][Math]::Max(28, [Math]::Min(48, $captureRect.Width * 0.05))
    return [System.Drawing.Point]::new(
        $captureRect.Right - $rightMargin,
        $captureRect.Y + [int]($captureRect.Height * 0.45)
    )
}

function Set-CaptureRectFromWeChat {
    $window = Get-WeChatWindowRect
    if (-not $window) { throw "没有找到可见的电脑版微信主窗口，请先打开微信并保持窗口正常显示。" }
    $chatBody = Get-WeChatChatBodyRect $window
    $x = $chatBody.X
    $y = $chatBody.Y
    $width = $chatBody.Width
    $height = $chatBody.Height
    $Script:CaptureRect = [ordered]@{ X=$x; Y=$y; Width=$width; Height=$height }
    if ($lblRect) { $lblRect.Text = "微信读取范围：X=$x, Y=$y, W=$width, H=$height（只截右侧对话框）" }
    Save-Config
    return [System.Drawing.Rectangle]::new($x, $y, $width, $height)
}

function Test-CaptureRectInsideWeChat {
    if (-not $Script:CaptureRect) { return $false }
    $window = Get-WeChatWindowRect
    if (-not $window) { return $false }
    $capture = [System.Drawing.Rectangle]::new([int]$Script:CaptureRect.X, [int]$Script:CaptureRect.Y, [int]$Script:CaptureRect.Width, [int]$Script:CaptureRect.Height)
    $intersection = [System.Drawing.Rectangle]::Intersect($window, $capture)
    if ($capture.Width -le 0 -or $capture.Height -le 0) { return $false }
    $coverage = ($intersection.Width * $intersection.Height) / [double]($capture.Width * $capture.Height)
    return $coverage -ge 0.85
}

function Ensure-WeChatCaptureRect {
    Set-CaptureRectFromWeChat | Out-Null
    Write-TransferLog "已按当前微信窗口重新定位读取范围。"
}

function Mark-OcrStale([string]$message) {
    $message | Set-Content -Path $Script:LastOcrPath -Encoding UTF8
}

function Capture-WeChatPreview {
    Set-CaptureRectFromWeChat | Out-Null
    $wechat = Activate-WeChatWindow
    Wait-Responsive 300
    $rect = [System.Drawing.Rectangle]::new([int]$Script:CaptureRect.X, [int]$Script:CaptureRect.Y, [int]$Script:CaptureRect.Width, [int]$Script:CaptureRect.Height)
    $img = Join-Path $Script:TempDir ("preview_" + (Get-Date -Format "yyyyMMdd_HHmmss_fff") + ".png")
    Capture-RectImage $rect $img
    [System.IO.File]::Copy($img, $Script:LastCapturePath, $true)
    Mark-OcrStale "截图已更新，但还没有重新识别文字。请点击 [识别并上传一次]，识别文字才会变成这张截图的内容。"
    Remove-Item $img -Force -ErrorAction SilentlyContinue
    return $rect
}

function Open-WeChatGroup([string]$groupName) {
    $wechat = Activate-WeChatWindow
    $oldClipboard = $null
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $oldClipboard = [System.Windows.Forms.Clipboard]::GetText() }
    [System.Windows.Forms.Clipboard]::SetText($groupName)
    [System.Windows.Forms.SendKeys]::SendWait("^f")
    Wait-Responsive 450
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Wait-Responsive 700
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Wait-Responsive 900
    if ($null -ne $oldClipboard) { [System.Windows.Forms.Clipboard]::SetText($oldClipboard) }
}

function Get-WeChatRootElement {
    $wechat = Get-WeChatProcess
    if (-not $wechat) { throw "没有找到电脑版微信窗口，请先打开并登录微信。" }
    return [System.Windows.Automation.AutomationElement]::FromHandle($wechat.MainWindowHandle)
}

function Get-WeChatKeywordItems([string]$keyword) {
    $window = Get-WeChatWindowRect
    $root = Get-WeChatRootElement
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $items = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $all.Count; $i++) {
        $e = $all.Item($i)
        if ($e.Current.ControlType.ProgrammaticName -ne "ControlType.ListItem") { continue }
        $name = [string]$e.Current.Name
        if (-not $name -or $name -notlike "*$keyword*") { continue }
        $r = $e.Current.BoundingRectangle
        if ($r.Width -lt 180 -or $r.Height -lt 40) { continue }
        if ($window -and ($r.X -gt ($window.X + ($window.Width * 0.55)))) { continue }
        $firstLine = (($name -split "`r?`n") | Select-Object -First 1).Trim()
        $normalized = (($firstLine -replace "[\p{Cf}\p{Cc}]", "") -replace "[^\p{L}\p{Nd}]", "").ToLowerInvariant()
        if (-not $normalized) { continue }
        [void]$items.Add([pscustomobject]@{ Element=$e; Name=$firstLine; Key=$normalized; X=[int]$r.X; Y=[int]$r.Y; W=[int]$r.Width; H=[int]$r.Height })
    }
    return @($items | Sort-Object Y)
}

function Reset-WeChatResultListTop([string]$keyword) {
    $window = Get-WeChatWindowRect
    if (-not $window) { return }
    $items = Get-WeChatKeywordItems $keyword
    $anchor = $items | Select-Object -First 1
    if ($anchor) {
        $scrollX = [int]($anchor.X + [Math]::Max(80, [Math]::Min(180, $anchor.W * 0.25)))
        $scrollY = [int]($anchor.Y + [Math]::Max(30, [Math]::Min(70, $anchor.H * 0.45)))
    } else {
        $scrollX = [int]($window.X + [Math]::Max(260, $window.Width * 0.20))
        $scrollY = [int]($window.Y + [Math]::Min($window.Height - 160, [Math]::Max(420, $window.Height * 0.58)))
    }
    [NativeDpi]::SetCursorPos($scrollX, $scrollY) | Out-Null
    Wait-Responsive 80
    for ($s = 0; $s -lt 18; $s++) {
        [NativeDpi]::Scroll(240)
        Wait-Responsive 25
    }
    Wait-Responsive 550
}

function Invoke-WeChatListItem($item) {
    if (-not $item) { return $false }
    # WeChat exposes Invoke/Selection patterns for search rows, but invoking them can
    # leave the previous chat open. A real click on the UIA-reported row is reliable.
    $cx = [int]($item.X + [Math]::Min(210, [Math]::Max(70, $item.W * 0.28)))
    $cy = [int]($item.Y + ($item.H / 2))
    [NativeDpi]::SetCursorPos($cx, $cy) | Out-Null
    Wait-Responsive 80
    [NativeDpi]::LeftClick()
    Wait-Responsive 1200
    return $true
}

function Open-WeChatKeywordItemByUi([string]$keyword, [int]$resultIndex) {
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $window = Get-WeChatWindowRect
    for ($round = 0; $round -lt 12; $round++) {
        Test-StopRequested
        $items = Get-WeChatKeywordItems $keyword
        foreach ($item in $items) {
            $key = $item.Key
            if (-not $key) { continue }
            if ($seen.Contains($key)) { continue }
            if ($seen.Count -eq $resultIndex) {
                $displayName = Normalize-WeChatGroupName ([string]$item.Name)
                if (Test-UsefulWeChatGroupName $displayName) { $Script:LastOpenedGroupName = $displayName }
                Write-TransferLog "正在打开匹配群：$($Script:LastOpenedGroupName)"
                return (Invoke-WeChatListItem $item)
            }
            [void]$seen.Add($key)
        }
        if ($window) {
            $scrollX = [int]($window.X + [Math]::Max(260, $window.Width * 0.20))
            $scrollY = [int]($window.Y + [Math]::Min($window.Height - 120, $window.Height * 0.72))
            [NativeDpi]::SetCursorPos($scrollX, $scrollY) | Out-Null
            Wait-Responsive 80
            for ($s = 0; $s -lt 8; $s++) {
                [NativeDpi]::Scroll(-240)
                Wait-Responsive 40
            }
            Wait-Responsive 500
        }
    }
    throw "没有在微信搜索结果里找到第 $($resultIndex + 1) 个包含 [$keyword] 的群。"
}

function Open-WeChatKeywordResult([string]$keyword, [int]$resultIndex) {
    $Script:LastOpenedGroupName = ""
    $wechat = Activate-WeChatWindow
    $window = Get-WeChatWindowRect
    $oldClipboard = $null
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $oldClipboard = [System.Windows.Forms.Clipboard]::GetText() }
    [System.Windows.Forms.Clipboard]::SetText($keyword)
    [System.Windows.Forms.SendKeys]::SendWait("^f")
    Wait-Responsive 450
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Wait-Responsive 1000
    if ($window) {
        # WeChat first shows only a short search preview. Click "查看全部" first,
        # then choose from the full result list so later groups are reachable.
        try {
            $root = Get-WeChatRootElement
            $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $all.Count; $i++) {
                $e = $all.Item($i)
                if ([string]$e.Current.Name -match "查看全部") {
                    $r = $e.Current.BoundingRectangle
                    if ($r.Width -gt 20 -and $r.Height -gt 10) {
                        [NativeDpi]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) | Out-Null
                        Wait-Responsive 100
                        [NativeDpi]::LeftClick()
                        break
                    }
                }
            }
        } catch {
            $viewAllX = [int]($window.X + [Math]::Max(170, $window.Width * 0.10))
            $viewAllY = [int]($window.Y + [Math]::Min($window.Height - 170, [Math]::Max(520, $window.Height * 0.63)))
            [NativeDpi]::SetCursorPos($viewAllX, $viewAllY) | Out-Null
            Wait-Responsive 120
            [NativeDpi]::LeftClick()
        }
        Wait-Responsive 900
        Reset-WeChatResultListTop $keyword
        Open-WeChatKeywordItemByUi $keyword $resultIndex | Out-Null
    } else {
        for ($i = 0; $i -lt $resultIndex; $i++) { [System.Windows.Forms.SendKeys]::SendWait("{DOWN}") }
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    }
    Wait-Responsive 1000
    if ($null -ne $oldClipboard) { [System.Windows.Forms.Clipboard]::SetText($oldClipboard) }
}

function Get-CurrentChatName([string]$fallbackName) {
    $selectedName = Normalize-WeChatGroupName $Script:LastOpenedGroupName
    if (Test-UsefulWeChatGroupName $selectedName) { return $selectedName }
    if (-not $Script:CaptureRect) { return $fallbackName }
    $headerY = [Math]::Max(0, [int]$Script:CaptureRect.Y - 90)
    $headerHeight = [Math]::Min(80, [int]$Script:CaptureRect.Y)
    if ($headerHeight -lt 20) { return $fallbackName }
    $headerPath = Join-Path $Script:TempDir ("header_" + [Guid]::NewGuid().ToString("N") + ".png")
    try {
        $headerWidth = [Math]::Max(260, [Math]::Min([int]$Script:CaptureRect.Width - 120, [int]($Script:CaptureRect.Width * 0.72)))
        $headerRect = [System.Drawing.Rectangle]::new([int]$Script:CaptureRect.X, $headerY, $headerWidth, $headerHeight)
        Capture-RectImage $headerRect $headerPath
        $candidates = New-Object System.Collections.Generic.List[string]
        if ((Get-Command Invoke-WindowsOcrText -ErrorAction SilentlyContinue) -and $Script:WindowsOcrReady) {
            $candidates.Add((Invoke-WindowsOcrText $headerPath -replace "[\r\n]+", " "))
        }
        $candidates.Add((Invoke-TesseractText $headerPath "7" -replace "[\r\n]+", " "))
        foreach ($candidate in $candidates) {
            $name = Normalize-WeChatGroupName $candidate
            if (Test-UsefulWeChatGroupName $name) { return $name }
        }
    } catch { } finally { Remove-Item $headerPath -Force -ErrorAction SilentlyContinue }
    return $fallbackName
}

function Refresh-GroupStatus {
    if (-not $lstGroupStatus) { return }
    $lstGroupStatus.Items.Clear()
    foreach ($name in @($Script:ReadGroups.Keys | Sort-Object)) {
        $item = New-Object System.Windows.Forms.ListViewItem("● 已读取")
        $item.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#17803D")
        [void]$item.SubItems.Add($name)
        [void]$item.SubItems.Add([string]$Script:ReadGroups[$name])
        [void]$lstGroupStatus.Items.Add($item)
    }
    if ($lstGroupStatus.Items.Count -eq 0) {
        $item = New-Object System.Windows.Forms.ListViewItem("● 未读取")
        $item.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#C62828")
        [void]$item.SubItems.Add("还没有成功读取过关键词匹配群")
        [void]$item.SubItems.Add("")
        [void]$lstGroupStatus.Items.Add($item)
    }
}

function Scroll-WeChatMessages {
    if (-not $Script:CaptureRect) { return }
    $captureRect = [System.Drawing.Rectangle]::new(
        [int]$Script:CaptureRect.X,
        [int]$Script:CaptureRect.Y,
        [int]$Script:CaptureRect.Width,
        [int]$Script:CaptureRect.Height
    )
    $scrollPoint = Get-WeChatScrollPoint $captureRect
    # Do not click before scrolling. The center of a chat can contain a link,
    # video or mini-program card, which would navigate away from the group.
    [NativeDpi]::SetCursorPos($scrollPoint.X, $scrollPoint.Y) | Out-Null
    Wait-Responsive 120
    # Move roughly half a screen. The overlap lets adjacent OCR results be
    # stitched together when one long order crosses the viewport boundary.
    for ($i = 0; $i -lt 4; $i++) {
        [NativeDpi]::Scroll(120)
        Wait-Responsive 70
    }
}

function Get-List([string]$text) {
    return @($text -split "[,，、;；\s]+" | Where-Object { $_.Trim().Length -gt 0 } | ForEach-Object { $_.Trim() })
}

function Load-GeoCache {
    $Script:GeoCache = @{}
    if (Test-Path $Script:GeoCachePath) {
        try {
            $obj = Get-Content $Script:GeoCachePath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $obj.PSObject.Properties) { $Script:GeoCache[$p.Name] = $p.Value }
        } catch { $Script:GeoCache = @{} }
    }
}

function Save-GeoCache {
    $obj = [ordered]@{}
    foreach ($k in $Script:GeoCache.Keys) { $obj[$k] = $Script:GeoCache[$k] }
    $obj | ConvertTo-Json -Depth 5 | Set-Content -Path $Script:GeoCachePath -Encoding UTF8
}

function Get-AmapKey {
    if ($txtAmapKey -and $txtAmapKey.Text) { return $txtAmapKey.Text.Trim() }
    return ""
}

function Get-AmapCity {
    if ($txtCity -and $txtCity.Text.Trim()) { return $txtCity.Text.Trim() }
    return "深圳"
}

function Invoke-AmapGeocode([string]$address) {
    $key = Get-AmapKey
    if (-not $key) { return $null }
    if (-not $address -or $address.Trim().Length -lt 2) { return $null }
    $city = Get-AmapCity
    $cacheKey = "geo|$city|$address"
    if ($Script:GeoCache.ContainsKey($cacheKey)) { return $Script:GeoCache[$cacheKey] }
    $url = "https://restapi.amap.com/v3/geocode/geo?key=$([uri]::EscapeDataString($key))&address=$([uri]::EscapeDataString($address))&city=$([uri]::EscapeDataString($city))&output=JSON"
    try {
        $res = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 8
        if ($res.status -eq "1" -and [int]$res.count -gt 0 -and $res.geocodes[0].location) {
            $geo = [pscustomobject]@{
                Location = [string]$res.geocodes[0].location
                Formatted = [string]$res.geocodes[0].formatted_address
                Level = [string]$res.geocodes[0].level
            }
            $Script:GeoCache[$cacheKey] = $geo
            Save-GeoCache
            return $geo
        }
    } catch { }
    return $null
}

function Get-DestinationAddress([string]$district, [string]$place, [string]$raw) {
    $city = Get-AmapCity
    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add("广东省")
    if ($city -notmatch "市$") { $parts.Add($city + "市") } else { $parts.Add($city) }
    if ($district) {
        if ($district -match "区$") { $parts.Add($district) } else { $parts.Add($district + "区") }
    }
    if ($place) { $parts.Add($place) }
    if (-not $place -and $raw) {
        $clean = ($raw -replace "(家教|老师|学生|男生|女生|上门|课酬|周末|工作日|数学|英语|物理|化学|语文|生物|初一|初二|初三|高一|高二|高三|小学|初中|高中).*", "").Trim()
        if ($clean.Length -gt 2 -and $clean.Length -lt 40) { $parts.Add($clean) }
    }
    return (($parts | Where-Object { $_ }) -join "")
}

function Invoke-AmapRoute([string]$origin, [string]$destination) {
    $key = Get-AmapKey
    if (-not $key -or -not $origin -or -not $destination) { return $null }

    foreach ($routeType in @(
        @{ Mode = "电动车"; Url = "https://restapi.amap.com/v5/direction/electrobike?key=$([uri]::EscapeDataString($key))&origin=$([uri]::EscapeDataString($origin))&destination=$([uri]::EscapeDataString($destination))&show_fields=cost&output=JSON" },
        @{ Mode = "骑行"; Url = "https://restapi.amap.com/v5/direction/bicycling?key=$([uri]::EscapeDataString($key))&origin=$([uri]::EscapeDataString($origin))&destination=$([uri]::EscapeDataString($destination))&show_fields=cost&output=JSON" },
        @{ Mode = "驾车"; Url = "https://restapi.amap.com/v5/direction/driving?key=$([uri]::EscapeDataString($key))&origin=$([uri]::EscapeDataString($origin))&destination=$([uri]::EscapeDataString($destination))&show_fields=cost&strategy=32&output=JSON" }
    )) {
        try {
            $res = Invoke-RestMethod -Uri $routeType.Url -Method Get -TimeoutSec 8
            if ($res.status -eq "1" -and $res.route.paths -and $res.route.paths.Count -gt 0) {
                $path = $res.route.paths[0]
                $duration = 0
                if ($path.cost -and $path.cost.duration) { $duration = [double]$path.cost.duration }
                elseif ($path.duration) { $duration = [double]$path.duration }
                return [pscustomobject]@{
                    DistanceKm = [math]::Round(([double]$path.distance) / 1000, 1)
                    DurationMin = if ($duration -gt 0) { [math]::Ceiling($duration / 60) } else { "" }
                    Mode = $routeType.Mode
                }
            }
        } catch { }
    }

    $legacyBikeUrl = "https://restapi.amap.com/v4/direction/bicycling?key=$([uri]::EscapeDataString($key))&origin=$([uri]::EscapeDataString($origin))&destination=$([uri]::EscapeDataString($destination))"
    try {
        $legacyBike = Invoke-RestMethod -Uri $legacyBikeUrl -Method Get -TimeoutSec 8
        if (($legacyBike.errcode -eq 0 -or $legacyBike.errcode -eq "0") -and $legacyBike.data.paths -and $legacyBike.data.paths.Count -gt 0) {
            $path = $legacyBike.data.paths[0]
            return [pscustomobject]@{
                DistanceKm = [math]::Round(([double]$path.distance) / 1000, 1)
                DurationMin = [math]::Ceiling(([double]$path.duration) / 60)
                Mode = "骑行"
            }
        }
    } catch { }
    return $null
}

function Get-AmapRouteInfo([string]$district, [string]$place, [string]$raw) {
    $key = Get-AmapKey
    if (-not $key) { return $null }
    $homeGeo = Invoke-AmapGeocode $txtHome.Text.Trim()
    $destAddress = Get-DestinationAddress $district $place $raw
    $destGeo = Invoke-AmapGeocode $destAddress
    if (-not $homeGeo -or -not $destGeo) { return $null }
    $route = Invoke-AmapRoute $homeGeo.Location $destGeo.Location
    if ($route) {
        $route | Add-Member -NotePropertyName Address -NotePropertyValue $destAddress
        $route | Add-Member -NotePropertyName MatchedAddress -NotePropertyValue $destGeo.Formatted
    }
    return $route
}

function Get-TutorOrderFromText([string]$raw) {
    $text = ($raw -replace "\s+", " ").Trim()
    if ($text.Length -lt 6) { return $null }

    $districts = "宝安|南山|福田|罗湖|龙华|龙岗|光明|坪山|盐田|大鹏|前海|深圳湾"
    $subjects = "语文|数学|英语|物理|化学|生物|政治|历史|地理|科学|奥数|编程|信息|日语|雅思|托福"
    $grades = "小学|一年级|二年级|三年级|四年级|五年级|六年级|七年级|八年级|九年级|初一|初二|初三|初中|高一|高二|高三|高中|中考|高考|一升二|二升三|三升四|四升五|五升六|六升初一|[2-9]岁|1[0-2]岁"
    $orderSignals = "家教|上门|课酬|小时|h|H|一小时|每小时|老师|学生|男生|女生|补习|辅导|试课|周末|工作日|晚"
    $hits = 0
    foreach ($pat in @($districts, $subjects, $grades, $orderSignals)) {
        if ($text -match $pat) { $hits++ }
    }
    if ($hits -lt 2) { return $null }

    $district = ""
    if ($text -match $districts) { $district = $Matches[0] }
    if ($district -eq "前海" -or $district -eq "深圳湾") { $district = "南山" }

    $subject = ""
    if ($text -match $subjects) { $subject = $Matches[0] }

    $grade = ""
    if ($text -match $grades) { $grade = $Matches[0] }
    if ($grade -match "^[2-6]岁$") { $grade = "幼儿园" }
    elseif ($grade -match "^(?:[7-9]|1[0-2])岁$") { $grade = "小学" }
    elseif ($grade -eq "一升二") { $grade = "二年级" }
    elseif ($grade -eq "二升三") { $grade = "三年级" }
    elseif ($grade -eq "三升四") { $grade = "四年级" }
    elseif ($grade -eq "四升五") { $grade = "五年级" }
    elseif ($grade -eq "五升六") { $grade = "六年级" }
    elseif ($grade -eq "六升初一") { $grade = "初一" }
    elseif ($grade -eq "七年级") { $grade = "初一" }
    elseif ($grade -eq "八年级") { $grade = "初二" }
    elseif ($grade -eq "九年级") { $grade = "初三" }

    $price = ""
    $priceNum = 0
    if ($text -match "(\d{2,4})\s*(元|块|rmb|RMB)?\s*(/|每|一)?\s*(小时|h|H)") {
        $priceNum = [int]$Matches[1]
        $price = "$priceNum/小时"
    } elseif ($text -match "(\d{2,4})\s*(元|块)?\s*/\s*(\d+)\s*(小时|h|H)") {
        $total = [int]$Matches[1]
        $hours = [int]$Matches[3]
        if ($hours -gt 0) { $priceNum = [math]::Round($total / $hours) }
        $price = "$total/$hours小时"
    } elseif ($text -match "课酬[:：]?\s*(\d{2,4})") {
        $priceNum = [int]$Matches[1]
        $price = "$priceNum/小时"
    }

    $places = "西乡|固戍|宝体|翻身|新安|灵芝|坪洲|碧海湾|沙井|福永|松岗|石岩|前海|科技园|后海|蛇口|西丽|桃源村|桃园|南油|深圳湾|白石洲|华侨城|农林|景田|香蜜湖|侨香|笔架山|孖岭|车公庙|岗厦|会展中心|民治|红山|深圳北|坂田|布吉|大运|中心城|龙城|公明|凤凰城"
    $place = ""
    if ($text -match $places) { $place = $Matches[0] }
    if (-not $district) {
        if ($place -match "桃源村|科技园|后海|蛇口|西丽|南油|白石洲|华侨城") { $district = "南山" }
        elseif ($place -match "农林|景田|香蜜湖|侨香|笔架山|孖岭|车公庙|岗厦|会展中心") { $district = "福田" }
        elseif ($place -match "布吉|大运|中心城|龙城|坂田") { $district = "龙岗" }
        elseif ($place -match "民治|红山|深圳北") { $district = "龙华" }
        elseif ($place -match "公明|凤凰城") { $district = "光明" }
        elseif ($place -match "西乡|固戍|宝体|翻身|新安|灵芝|坪洲|碧海湾|沙井|福永|松岗|石岩") { $district = "宝安" }
    }

    $time = ""
    if ($text -match "(周[一二三四五六日天末][^，。；;]{0,10}|工作日[^，。；;]{0,10}|晚上|晚间|下午|上午|寒暑假|暑假|寒假)") {
        $time = $Matches[0]
    }

    $gender = ""
    if ($text -match "男生|男孩|男老师|男教员") { $gender = $Matches[0] }
    elseif ($text -match "女生|女孩|女老师|女教员") { $gender = $Matches[0] }

    $route = Get-AmapRouteInfo $district $place $text
    $bikeKm = ""
    $bikeMinutes = ""
    $routeMode = "估算"
    $address = ""
    if ($route) {
        $bikeKm = $route.DistanceKm
        $bikeMinutes = $route.DurationMin
        $routeMode = $route.Mode
        $address = $route.Address
        $commute = "$($route.DistanceKm)公里 $($route.Mode)"
    } else {
        $commute = Get-CommuteEstimate $district $place
    }
    $score = Get-Score $district $subject $grade $priceNum $commute $text $bikeKm

    return [pscustomobject]@{
        Time = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        Score = $score
        District = $district
        Place = $place
        Subject = $subject
        Grade = $grade
        Price = $price
        PriceNum = $priceNum
        ClassTime = $time
        Gender = $gender
        Commute = $commute
        BikeKm = $bikeKm
        BikeMinutes = $bikeMinutes
        RouteMode = $routeMode
        Address = $address
        Status = "新发现"
        Raw = $text
        Hash = (New-Hash $text)
    }
}

function Get-CommuteEstimate([string]$district, [string]$place) {
    $near = @{
        "西乡"=12; "固戍"=18; "宝体"=18; "翻身"=20; "新安"=22; "灵芝"=25; "坪洲"=15; "碧海湾"=15
        "前海"=30; "科技园"=45; "后海"=45; "南油"=45; "深圳湾"=50; "西丽"=40; "桃源村"=45
        "农林"=65; "侨香"=65; "笔架山"=70; "孖岭"=70
        "民治"=45; "红山"=50; "深圳北"=48
    }
    if ($place -and $near.ContainsKey($place)) { return "约$($near[$place])分钟" }
    $districtMinutes = @{
        "宝安"=25; "南山"=45; "福田"=65; "龙华"=55; "光明"=60; "罗湖"=80; "龙岗"=90; "盐田"=100; "坪山"=110; "大鹏"=130
    }
    if ($district -and $districtMinutes.ContainsKey($district)) { return "约$($districtMinutes[$district])分钟" }
    return "待确认"
}

function Get-Minutes([string]$commute) {
    if ($commute -match "(\d+)") { return [int]$Matches[1] }
    return 75
}

function Get-Score([string]$district, [string]$subject, [string]$grade, [int]$priceNum, [string]$commute, [string]$text, $bikeKm) {
    $score = 45
    $prefDistricts = Get-List $txtDistricts.Text
    $prefSubjects = Get-List $txtSubjects.Text
    $prefGrades = Get-List $txtGrades.Text
    if ($district -and ($prefDistricts -contains $district)) { $score += 18 }
    elseif ($district -eq "宝安" -or $district -eq "南山") { $score += 10 }
    elseif ($district -eq "龙岗" -or $district -eq "坪山" -or $district -eq "大鹏") { $score -= 12 }
    if ($subject -and ($prefSubjects -contains $subject)) { $score += 18 }
    elseif ($subject) { $score += 5 }
    if ($grade -and (($prefGrades -contains $grade) -or ($prefGrades -contains "初中" -and $grade -match "初|中考") -or ($prefGrades -contains "高中" -and $grade -match "高|高考"))) { $score += 12 }
    if ($priceNum -gt 0) {
        if ($priceNum -ge [int]$numMinPrice.Value) { $score += [Math]::Min(15, [Math]::Floor(($priceNum - [int]$numMinPrice.Value) / 20) + 8) }
        else { $score -= 15 }
    }
    if ($bikeKm -ne "" -and $null -ne $bikeKm) {
        $km = [double]$bikeKm
        $maxKm = [double]$numMaxBikeKm.Value
        if ($km -le 3) { $score += 18 }
        elseif ($km -le 6) { $score += 15 }
        elseif ($km -le $maxKm) { $score += 9 }
        elseif ($km -le ($maxKm + 4)) { $score -= 3 }
        else { $score -= 18 }
    } else {
        $m = Get-Minutes $commute
        if ($m -le 25) { $score += 15 }
        elseif ($m -le 45) { $score += 9 }
        elseif ($m -le 65) { $score += 2 }
        else { $score -= 12 }
    }
    if ($text -match "急|今晚|今天|马上") { $score += 4 }
    if ($text -match "太远|低价|无课酬") { $score -= 10 }
    return [Math]::Max(0, [Math]::Min(100, [int]$score))
}

function Capture-RectImage([System.Drawing.Rectangle]$rect, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

function Get-ImageDataUrl([string]$path) {
    if (-not $path -or -not (Test-Path $path)) { return "" }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if (-not $bytes -or $bytes.Length -eq 0) { return "" }
    return "data:image/png;base64," + [Convert]::ToBase64String($bytes)
}

function Get-BitmapFromDataUrl([string]$dataUrl) {
    $comma = $dataUrl.IndexOf(',')
    if ($comma -lt 0) { return $null }
    try {
        $bytes = [Convert]::FromBase64String($dataUrl.Substring($comma + 1))
        $stream = New-Object System.IO.MemoryStream(,$bytes)
        try {
            $source = [System.Drawing.Bitmap]::FromStream($stream)
            try { return [System.Drawing.Bitmap]::new($source) }
            finally { $source.Dispose() }
        } finally { $stream.Dispose() }
    } catch { return $null }
}

function Join-CapturedPageSeam([string]$olderDataUrl, [string]$newerDataUrl) {
    $older = Get-BitmapFromDataUrl $olderDataUrl
    $newer = Get-BitmapFromDataUrl $newerDataUrl
    if (-not $older -or -not $newer) {
        if ($older) { $older.Dispose() }
        if ($newer) { $newer.Dispose() }
        return ""
    }
    try {
        $ratio = 0.72
        $olderHeight = [Math]::Max(1, [int][Math]::Round($older.Height * $ratio))
        $newerHeight = [Math]::Max(1, [int][Math]::Round($newer.Height * $ratio))
        $width = [Math]::Max($older.Width, $newer.Width)
        $joined = New-Object System.Drawing.Bitmap $width, ($olderHeight + $newerHeight)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($joined)
            try {
                $graphics.Clear([System.Drawing.Color]::White)
                $olderSourceY = $older.Height - $olderHeight
                $graphics.DrawImage($older,
                    [System.Drawing.Rectangle]::new(0, 0, $older.Width, $olderHeight),
                    0, $olderSourceY, $older.Width, $olderHeight,
                    [System.Drawing.GraphicsUnit]::Pixel)
                $graphics.DrawImage($newer,
                    [System.Drawing.Rectangle]::new(0, $olderHeight, $newer.Width, $newerHeight),
                    0, 0, $newer.Width, $newerHeight,
                    [System.Drawing.GraphicsUnit]::Pixel)
            } finally { $graphics.Dispose() }
            $output = New-Object System.IO.MemoryStream
            try {
                $joined.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
                return "data:image/png;base64," + [Convert]::ToBase64String($output.ToArray())
            } finally { $output.Dispose() }
        } finally { $joined.Dispose() }
    } finally {
        $older.Dispose()
        $newer.Dispose()
    }
}

function Join-CapturedPagesChronologically([string[]]$dataUrls) {
    $bitmaps = New-Object System.Collections.Generic.List[System.Drawing.Bitmap]
    try {
        for ($i = $dataUrls.Count - 1; $i -ge 0; $i--) {
            $bitmap = Get-BitmapFromDataUrl ([string]$dataUrls[$i])
            if ($bitmap) { $bitmaps.Add($bitmap) }
        }
        if ($bitmaps.Count -lt 2) { return "" }

        $sourceWidth = ($bitmaps | Measure-Object Width -Maximum).Maximum
        $sourceHeight = ($bitmaps | Measure-Object Height -Sum).Sum
        $scale = [Math]::Min(1.0, 30000.0 / [double]$sourceHeight)
        $width = [Math]::Max(1, [int][Math]::Round($sourceWidth * $scale))
        $height = [Math]::Max(1, [int][Math]::Round($sourceHeight * $scale))
        $joined = New-Object System.Drawing.Bitmap $width, $height
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($joined)
            try {
                $graphics.Clear([System.Drawing.Color]::White)
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $y = 0
                foreach ($bitmap in $bitmaps) {
                    $drawWidth = [Math]::Max(1, [int][Math]::Round($bitmap.Width * $scale))
                    $drawHeight = [Math]::Max(1, [int][Math]::Round($bitmap.Height * $scale))
                    $graphics.DrawImage($bitmap, 0, $y, $drawWidth, $drawHeight)
                    $y += $drawHeight
                }
            } finally { $graphics.Dispose() }
            $output = New-Object System.IO.MemoryStream
            try {
                $joined.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
                return "data:image/png;base64," + [Convert]::ToBase64String($output.ToArray())
            } finally { $output.Dispose() }
        } finally { $joined.Dispose() }
    } finally {
        foreach ($bitmap in $bitmaps) { $bitmap.Dispose() }
    }
}

function Convert-ToOcrImage([string]$imagePath, [string]$outPath) {
    $src = [System.Drawing.Bitmap]::FromFile($imagePath)
    $scale = 3
    $dst = New-Object System.Drawing.Bitmap ($src.Width * $scale), ($src.Height * $scale)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src, 0, 0, $dst.Width, $dst.Height)
    $g.Dispose()
    $src.Dispose()
    $rect = [System.Drawing.Rectangle]::new(0, 0, $dst.Width, $dst.Height)
    $data = $dst.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $byteCount = [Math]::Abs($data.Stride) * $dst.Height
        $bytes = New-Object byte[] $byteCount
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $byteCount)
        for ($y = 0; $y -lt $dst.Height; $y++) {
            if (($y % 80) -eq 0) {
                [System.Windows.Forms.Application]::DoEvents()
                Test-StopRequested
            }
            $row = $y * [Math]::Abs($data.Stride)
            for ($x = 0; $x -lt $dst.Width; $x++) {
                $i = $row + ($x * 4)
                $b = [int]$bytes[$i]
                $g2 = [int]$bytes[$i + 1]
                $r = [int]$bytes[$i + 2]
                $brightness = ($r * 0.299) + ($g2 * 0.587) + ($b * 0.114)
                $v = [byte]255
                if ($brightness -lt 185) { $v = [byte]0 }
                $bytes[$i] = $v
                $bytes[$i + 1] = $v
                $bytes[$i + 2] = $v
                $bytes[$i + 3] = [byte]255
            }
        }
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $byteCount)
    } finally {
        $dst.UnlockBits($data)
    }
    $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $dst.Dispose()
}

function Invoke-TesseractText([string]$imagePath, [string]$psm) {
    $base = Join-Path $Script:TempDir ("ocr_" + [Guid]::NewGuid().ToString("N"))
    $args = @(
        $imagePath, $base,
        "--tessdata-dir", $Script:TessDataDir,
        "-l", "chi_sim+eng",
        "--oem", "1",
        "--psm", $psm,
        "-c", "preserve_interword_spaces=1",
        "-c", "user_defined_dpi=300"
    )
    $process = Start-Process -FilePath $Script:TesseractPath -ArgumentList $args -NoNewWindow -PassThru
    $startedAt = Get-Date
    while (-not $process.HasExited) {
        [System.Windows.Forms.Application]::DoEvents()
        if ($Script:StopRequested) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            throw "自动搬运已停止。"
        }
        if (((Get-Date) - $startedAt).TotalSeconds -gt 12) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            throw "OCR识别超时，已停止本轮。"
        }
        Start-Sleep -Milliseconds 80
        try { $process.Refresh() } catch { }
    }
    $txt = "$base.txt"
    if (Test-Path $txt) {
        $content = Get-Content $txt -Raw -Encoding UTF8
        Remove-Item $txt -Force -ErrorAction SilentlyContinue
        return $content
    }
    return ""
}

function Get-OcrQualityScore([string]$text) {
    if (-not $text) { return -100000 }
    $signals = ([regex]::Matches($text, "辅导地址|年级性别|科目内容|学习成绩|时间次数|老师要求|课时价格|学员地址|时间安排|教员要求|薪资|深圳|宝安|南山|福田|罗湖|龙华|龙岗|光明|坪山|盐田|数学|英语|语文|物理|化学")).Count
    $noise = ([regex]::Matches($text, "\b[A-Za-z]{2,}\b|^\d{1,2}:\d{2}$", [System.Text.RegularExpressions.RegexOptions]::Multiline)).Count
    $garbage = ([regex]::Matches($text, "[丿刭朩亇氵]|囗囗|刀讠|[|｜]{3,}|[\\/_=]{4,}")).Count
    $fieldLines = ([regex]::Matches($text, "(?m)^(?:【[^】]{1,14}】|(?:地址|地点|科目|情况|时间|次数|薪酬|薪资|要求|家教编号|家教内容|家教地点)\s*[：:])")).Count
    return ($signals * 1000) + ($fieldLines * 350) + [Math]::Min(1400, $text.Length) - ($noise * 160) - ($garbage * 320)
}

function Find-SimilarOcrLineIndex([System.Collections.Generic.List[string]]$lines, [string]$needle, [double]$threshold = 0.58) {
    $bestIndex = -1
    $bestScore = 0.0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $score = Get-OcrTextSimilarity $lines[$i] $needle
        if ($score -gt $bestScore) {
            $bestScore = $score
            $bestIndex = $i
        }
    }
    if ($bestScore -ge $threshold) { return $bestIndex }
    return -1
}

function Test-HighValueOcrLine([string]$line) {
    $s = $line.Trim()
    if (-not $s) { return $false }
    if ($s -match "^(?:【[^】]{1,14}】|(?:地址|地点|科目|情况|时间|次数|薪酬|薪资|课酬|时薪|要求|老师要求|教师要求|家教编号|家教内容|家教地点)\s*[：:])") { return $true }
    if ($s -match "(?:^|\s)(?:\d+[、.．)]\s*)?\d{2,5}(?:\s*[-~～]\s*\d{2,5})?\s*(?:元|/\s*(?:\d+(?:\.\d+)?\s*)?(?:h|小时|时|次|节)|每小时)") { return $true }
    if ($s -match "^(?:WY深圳|深圳线下[A-Z]|深圳BY|SZ\d|lw\d|编号\s*[：:])") { return $true }
    return $false
}

function Resolve-OcrGradeConflict([string]$preferredLine, [string]$fallbackLine) {
    if ($preferredLine -notmatch "年级科目|年级学科|家教内容" -or $fallbackLine -notmatch "年级科目|年级学科|家教内容") {
        return $preferredLine
    }
    $pattern = "(?<prefix>高|初|小)(?<number>[一二三])"
    $preferredMatch = [regex]::Match($preferredLine, $pattern)
    $fallbackMatch = [regex]::Match($fallbackLine, $pattern)
    if (-not $preferredMatch.Success -or -not $fallbackMatch.Success) { return $preferredLine }
    if ($preferredMatch.Groups["prefix"].Value -ne $fallbackMatch.Groups["prefix"].Value) { return $preferredLine }
    if ($preferredMatch.Groups["number"].Value -eq $fallbackMatch.Groups["number"].Value) { return $preferredLine }

    $rank = @{ "一" = 1; "二" = 2; "三" = 3 }
    $preferredRank = $rank[$preferredMatch.Groups["number"].Value]
    $fallbackRank = $rank[$fallbackMatch.Groups["number"].Value]
    $preferredBase = [regex]::Replace($preferredLine, $pattern, '${prefix}?', 1)
    $fallbackBase = [regex]::Replace($fallbackLine, $pattern, '${prefix}?', 1)
    if ((Get-OcrTextSimilarity $preferredBase $fallbackBase) -lt 0.78) { return $preferredLine }

    # OCR is more likely to drop one horizontal stroke than invent one. When
    # both engines agree on the rest of the field, retain the fuller numeral.
    if ($fallbackRank -gt $preferredRank) {
        return $preferredLine.Remove($preferredMatch.Groups["number"].Index, 1).Insert(
            $preferredMatch.Groups["number"].Index,
            $fallbackMatch.Groups["number"].Value
        )
    }
    return $preferredLine
}

function Merge-PreferredOcrText([string]$preferredText, [string]$fallbackText) {
    if (-not $preferredText) { return $fallbackText }
    if (-not $fallbackText) { return $preferredText }
    $preferred = New-Object System.Collections.Generic.List[string]
    foreach ($line in @($preferredText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })) { $preferred.Add($line) }
    $fallback = @($fallbackText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })

    for ($i = 0; $i -lt $fallback.Count; $i++) {
        $line = $fallback[$i]
        if (-not (Test-HighValueOcrLine $line)) {
            if ($line -match '^\d+(?:[.,，]\d+)?\s*h(?:\s*/\s*次)?$' -and $i -gt 0 -and $fallback[$i - 1] -match '(?:时间|时长).*(?:每次|一次)\s*$') {
                $anchor = Find-SimilarOcrLineIndex $preferred $fallback[$i - 1] 0.45
                $nextIsDuration = $anchor -ge 0 -and ($anchor + 1) -lt $preferred.Count -and $preferred[$anchor + 1] -match '^\d+(?:[.,，]\d+)?\s*h(?:\s*/\s*次)?$'
                if ($anchor -ge 0 -and -not $nextIsDuration) { $preferred.Insert($anchor + 1, $line) }
            }
            if ($line -match '^[一二三四五六七八九十百]{2,5}$' -and $i -gt 0 -and $fallback[$i - 1] -match '【(?:学员|学生|学生情况|学员情况)】') {
                $anchor = Find-SimilarOcrLineIndex $preferred $fallback[$i - 1] 0.45
                $alreadyPresent = $false
                foreach ($preferredLine in $preferred) {
                    if ((ConvertTo-OcrComparableText $preferredLine) -eq (ConvertTo-OcrComparableText $line)) { $alreadyPresent = $true; break }
                }
                if ($anchor -ge 0 -and -not $alreadyPresent) { $preferred.Insert($anchor + 1, $line) }
            }
            continue
        }
        $similarIndex = Find-SimilarOcrLineIndex $preferred $line 0.58
        if ($similarIndex -ge 0) {
            $preferred[$similarIndex] = Resolve-OcrGradeConflict $preferred[$similarIndex] $line
            continue
        }

        $insertAt = $preferred.Count
        for ($before = $i - 1; $before -ge 0; $before--) {
            $anchor = Find-SimilarOcrLineIndex $preferred $fallback[$before] 0.52
            if ($anchor -ge 0) { $insertAt = $anchor + 1; break }
        }
        if ($insertAt -eq $preferred.Count) {
            for ($after = $i + 1; $after -lt $fallback.Count; $after++) {
                $anchor = Find-SimilarOcrLineIndex $preferred $fallback[$after] 0.52
                if ($anchor -ge 0) { $insertAt = $anchor; break }
            }
        }
        $preferred.Insert($insertAt, $line)
    }
    return ($preferred -join "`n").Trim()
}

function Invoke-Ocr([string]$imagePath) {
    $windowsOcrAvailable = (Get-Command Invoke-WindowsOcrText -ErrorAction SilentlyContinue) -and $Script:WindowsOcrReady
    if (-not $windowsOcrAvailable -and (-not $Script:TesseractPath -or -not (Test-Path $Script:TesseractPath))) {
        throw "没有找到可用的中文 OCR。请确认 Windows 中文识别组件或 Tesseract 已安装。"
    }
    $enhanced = Join-Path $Script:TempDir ("enhanced_" + [Guid]::NewGuid().ToString("N") + ".png")
    $results = New-Object System.Collections.ArrayList
    $fallbackResults = New-Object System.Collections.ArrayList
    $windowsCandidate = ""
    $forceWindows = $env:TUTOR_OCR_ENGINE -eq "windows"

    if ($windowsOcrAvailable) {
        Test-StopRequested
        try {
            $windowsText = Invoke-WindowsOcrText $imagePath
            $windowsCleaned = Clean-OcrText $windowsText
            if ($windowsCleaned.Trim().Length -gt 0) {
                $windowsCandidate = $windowsCleaned
                $results.Add($windowsCleaned) | Out-Null
            }
        } catch { }
    }

    $bestFast = $results | Sort-Object { Get-OcrQualityScore ([string]$_) } -Descending | Select-Object -First 1
    if ($env:TUTOR_OCR_DEBUG) { Write-Host "windowsScore=$(Get-OcrQualityScore ([string]$bestFast))" }
    $needsSparseCrossCheck = $windowsCandidate -match '(?m)^【(?:学员|学生|学生情况|学员情况)】.*[一二三四五六七八九十]\s*$'
    $needsStructuredCrossCheck = $windowsCandidate -match "年级科目|年级学科|家教内容" -or $needsSparseCrossCheck
    if (-not $forceWindows -and ((Get-OcrQualityScore ([string]$bestFast)) -lt 7200 -or $needsStructuredCrossCheck) -and $Script:TesseractPath -and (Test-Path $Script:TesseractPath)) {
        Test-StopRequested
        $tesseractText = Invoke-TesseractText $imagePath "6"
        $tesseractCleaned = Clean-OcrText $tesseractText
        if ($tesseractCleaned.Trim().Length -gt 0) {
            $results.Add($tesseractCleaned) | Out-Null
            $fallbackResults.Add($tesseractCleaned) | Out-Null
        }
    }
    if (-not $forceWindows -and $needsSparseCrossCheck -and $Script:TesseractPath -and (Test-Path $Script:TesseractPath)) {
        Test-StopRequested
        $sparseText = Invoke-TesseractText $imagePath "11"
        $sparseCleaned = Clean-OcrText $sparseText
        if ($sparseCleaned.Trim().Length -gt 0) {
            $results.Add($sparseCleaned) | Out-Null
            $fallbackResults.Add($sparseCleaned) | Out-Null
        }
    }

    $bestNormal = $results | Sort-Object { Get-OcrQualityScore ([string]$_) } -Descending | Select-Object -First 1
    if (-not $forceWindows -and -not $windowsCandidate -and (Get-OcrQualityScore ([string]$bestNormal)) -lt 4200 -and $Script:TesseractPath -and (Test-Path $Script:TesseractPath)) {
        Convert-ToOcrImage $imagePath $enhanced
        Test-StopRequested
        $enhancedText = Invoke-TesseractText $enhanced "6"
        $enhancedCleaned = Clean-OcrText $enhancedText
        if ($enhancedCleaned.Trim().Length -gt 0) {
            $results.Add($enhancedCleaned) | Out-Null
            $fallbackResults.Add($enhancedCleaned) | Out-Null
        }
    }
    Remove-Item $enhanced -Force -ErrorAction SilentlyContinue
    if ($results.Count -eq 0) { return "" }
    $best = $results | Sort-Object { Get-OcrQualityScore ([string]$_) } -Descending | Select-Object -First 1
    if ($windowsCandidate) {
        $fallbackCandidates = @($fallbackResults | Sort-Object { Get-OcrQualityScore ([string]$_) } -Descending)
        $fallbackBest = if ($fallbackCandidates.Count) { [string]$fallbackCandidates[0] } else { "" }
        for ($fallbackIndex = 1; $fallbackIndex -lt $fallbackCandidates.Count; $fallbackIndex++) {
            $fallbackBest = Merge-PreferredOcrText $fallbackBest ([string]$fallbackCandidates[$fallbackIndex])
        }
        if ($fallbackBest) {
            if ($env:TUTOR_OCR_DEBUG) { Write-Host "fallbackScore=$(Get-OcrQualityScore ([string]$fallbackBest)) fallback=$([string]$fallbackBest -replace "`r?`n", ' | ')" }
            $windowsCandidate = Merge-PreferredOcrText $windowsCandidate ([string]$fallbackBest)
        }
        $windowsScore = Get-OcrQualityScore $windowsCandidate
        $bestScore = Get-OcrQualityScore ([string]$best)
        if ($env:TUTOR_OCR_DEBUG) { Write-Host "mergedScore=$windowsScore bestScore=$bestScore merged=$($windowsCandidate -replace "`r?`n", ' | ')" }
        if ($windowsScore -ge 1200 -and $bestScore -lt ($windowsScore + 1500)) { return $windowsCandidate }
    }
    return $best
}

if ($env:TUTOR_CAPTURE_RECT_TEST_INPUT) {
    $testWindow = $env:TUTOR_CAPTURE_RECT_TEST_INPUT | ConvertFrom-Json
    $windowRect = [System.Drawing.Rectangle]::new(
        [int]$testWindow.X,
        [int]$testWindow.Y,
        [int]$testWindow.Width,
        [int]$testWindow.Height
    )
    $testCapture = Get-WeChatChatBodyRect $windowRect
    $testScrollPoint = Get-WeChatScrollPoint $testCapture
    [pscustomobject]@{
        X = $testCapture.X
        Y = $testCapture.Y
        Width = $testCapture.Width
        Height = $testCapture.Height
        ScrollX = $testScrollPoint.X
        ScrollY = $testScrollPoint.Y
    } | ConvertTo-Json -Compress
    exit 0
}

if ($env:TUTOR_WECHAT_PROCESS_NAME_TEST_INPUT) {
    $testNames = $env:TUTOR_WECHAT_PROCESS_NAME_TEST_INPUT | ConvertFrom-Json
    $testRows = New-Object System.Collections.ArrayList
    foreach ($testName in $testNames) {
        [void]$testRows.Add([pscustomobject]@{
            Name = [string]$testName
            Valid = Test-WeChatMainProcessName ([string]$testName)
        })
    }
    ConvertTo-Json -InputObject @($testRows) -Compress
    exit 0
}

if ($env:TUTOR_LIVE_CAPTURE_TEST_OUTPUT) {
    $diagnosticDir = [System.IO.Path]::GetFullPath($env:TUTOR_LIVE_CAPTURE_TEST_OUTPUT)
    New-Item -ItemType Directory -Force -Path $diagnosticDir | Out-Null
    $requestedKeyword = [string]$env:TUTOR_LIVE_CAPTURE_GROUP_KEYWORD
    $requestedIndex = if ($env:TUTOR_LIVE_CAPTURE_GROUP_INDEX -match '^\d+$') { [int]$env:TUTOR_LIVE_CAPTURE_GROUP_INDEX } else { 0 }
    if ($requestedKeyword) {
        if (-not (Get-Command Write-TransferLog -ErrorAction SilentlyContinue)) {
            function Write-TransferLog([string]$message) { Write-Host $message }
        }
        Open-WeChatKeywordResult $requestedKeyword $requestedIndex
    }
    $wechat = Get-WeChatProcess
    if (-not $wechat) { throw "没有找到电脑版微信窗口，请先打开并登录微信。" }
    $windowRect = Get-WeChatWindowRect
    if (-not $windowRect) { throw "没有找到可见的电脑版微信主窗口。" }
    $captureRect = Get-WeChatChatBodyRect $windowRect
    $pageCount = if ($env:TUTOR_LIVE_CAPTURE_PAGES -match '^\d+$') {
        [Math]::Max(1, [Math]::Min(8, [int]$env:TUTOR_LIVE_CAPTURE_PAGES))
    } else { 1 }
    $Script:CaptureRect = [ordered]@{ X=$captureRect.X; Y=$captureRect.Y; Width=$captureRect.Width; Height=$captureRect.Height }
    $pageTexts = New-Object System.Collections.Generic.List[string]
    $pageImages = New-Object System.Collections.Generic.List[string]
    $imagePaths = New-Object System.Collections.Generic.List[string]
    for ($pageNumber = 1; $pageNumber -le $pageCount; $pageNumber++) {
        $pageImagePath = if ($pageNumber -eq 1) {
            Join-Path $diagnosticDir "live-capture.png"
        } else {
            Join-Path $diagnosticDir "live-capture-page-$pageNumber.png"
        }
        Capture-RectImage $captureRect $pageImagePath
        $pageText = Invoke-Ocr $pageImagePath
        $pageText | Set-Content -LiteralPath (Join-Path $diagnosticDir "live-ocr-page-$pageNumber.txt") -Encoding UTF8
        $pageTexts.Add($pageText)
        $pageImages.Add((Get-ImageDataUrl $pageImagePath))
        $imagePaths.Add($pageImagePath)
        if ($pageNumber -lt $pageCount) {
            Scroll-WeChatMessages
            Wait-Responsive 900
        }
    }
    $ocrText = if ($pageTexts.Count -gt 1) { Merge-OcrPages ([string[]]$pageTexts.ToArray()) } else { $pageTexts[0] }
    $textPath = Join-Path $diagnosticDir "live-ocr.txt"
    $metadataPath = Join-Path $diagnosticDir "live-capture.json"
    $ocrText | Set-Content -LiteralPath $textPath -Encoding UTF8
    $compositePath = ""
    if ($pageImages.Count -gt 1) {
        $joinedImage = Join-CapturedPagesChronologically ([string[]]$pageImages.ToArray())
        if ($joinedImage) {
            $compositePath = Join-Path $diagnosticDir "live-composite.png"
            [System.IO.File]::WriteAllBytes($compositePath, [Convert]::FromBase64String($joinedImage.Substring($joinedImage.IndexOf(',') + 1)))
        }
    }
    $metadata = [ordered]@{
        CapturedAt = (Get-Date).ToString("o")
        WeChatProcessId = $wechat.Id
        WeChatTitle = $wechat.MainWindowTitle
        RequestedKeyword = $requestedKeyword
        RequestedIndex = $requestedIndex
        OpenedGroup = $Script:LastOpenedGroupName
        Window = [ordered]@{ X=$windowRect.X; Y=$windowRect.Y; Width=$windowRect.Width; Height=$windowRect.Height }
        Capture = [ordered]@{ X=$captureRect.X; Y=$captureRect.Y; Width=$captureRect.Width; Height=$captureRect.Height }
        PageCount = $pageCount
        OcrQuality = Get-OcrQualityScore $ocrText
        OcrLength = $ocrText.Length
        ImagePaths = [string[]]$imagePaths.ToArray()
        CompositePath = $compositePath
        TextPath = $textPath
    }
    $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadataPath -Encoding UTF8
    $metadata | ConvertTo-Json -Depth 4
    exit 0
}

if ($env:TUTOR_COMPOSITE_TEST_DIRECTORY) {
    $testImages = @(Get-ChildItem -LiteralPath $env:TUTOR_COMPOSITE_TEST_DIRECTORY -File |
        Where-Object { $_.Extension -match '^\.(png|jpg|jpeg)$' } |
        Sort-Object Name |
        ForEach-Object { Get-ImageDataUrl $_.FullName })
    $joinedData = Join-CapturedPagesChronologically ([string[]]$testImages)
    if (-not $joinedData) { throw '无法生成跨屏原图' }
    $target = if ($env:TUTOR_COMPOSITE_TEST_OUTPUT) { $env:TUTOR_COMPOSITE_TEST_OUTPUT } else { Join-Path $Script:TempDir 'composite-test.png' }
    [System.IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($joinedData.Substring($joinedData.IndexOf(',') + 1)))
    if ($env:TUTOR_SEAM_TEST_OUTPUT -and $testImages.Count -ge 2) {
        $seamData = Join-CapturedPageSeam ([string]$testImages[$testImages.Count - 1]) ([string]$testImages[$testImages.Count - 2])
        if (-not $seamData) { throw 'Unable to generate seam image' }
        [System.IO.File]::WriteAllBytes($env:TUTOR_SEAM_TEST_OUTPUT, [Convert]::FromBase64String($seamData.Substring($seamData.IndexOf(',') + 1)))
    }
    Write-Host $target
    exit 0
}

if ($env:TUTOR_OCR_TEST_PATH) {
    Invoke-Ocr $env:TUTOR_OCR_TEST_PATH
    exit 0
}

if ($env:TUTOR_GROUP_NAME_TEST_INPUT) {
    $decodedNames = $env:TUTOR_GROUP_NAME_TEST_INPUT | ConvertFrom-Json
    $testResults = New-Object System.Collections.ArrayList
    for ($testNameIndex = 0; $testNameIndex -lt $decodedNames.Count; $testNameIndex++) {
        $testName = [string]$decodedNames[$testNameIndex]
        [void]$testResults.Add([pscustomobject]@{
            Input = $testName
            Normalized = Normalize-WeChatGroupName $testName
            Valid = Test-UsefulWeChatGroupName $testName
        })
    }
    ConvertTo-Json -InputObject @($testResults) -Depth 3
    exit 0
}

if ($env:TUTOR_OCR_TEST_DIRECTORY) {
    $testRows = foreach ($file in (Get-ChildItem -LiteralPath $env:TUTOR_OCR_TEST_DIRECTORY -File | Where-Object { $_.Extension -match '^\.(png|jpg|jpeg)$' })) {
        $started = Get-Date
        try {
            $testText = Invoke-Ocr $file.FullName
            [pscustomobject]@{
                File = $file.Name
                DurationMs = [int]((Get-Date) - $started).TotalMilliseconds
                Quality = Get-OcrQualityScore $testText
                Text = $testText
                Error = ""
            }
        } catch {
            [pscustomobject]@{
                File = $file.Name
                DurationMs = [int]((Get-Date) - $started).TotalMilliseconds
                Quality = -100000
                Text = ""
                Error = $_.Exception.Message
            }
        }
    }
    $testJson = $testRows | ConvertTo-Json -Depth 4
    if ($env:TUTOR_OCR_TEST_OUTPUT) {
        $testJson | Set-Content -LiteralPath $env:TUTOR_OCR_TEST_OUTPUT -Encoding UTF8
    } else {
        $testJson
    }
    exit 0
}

if ($env:TUTOR_MERGE_TEST_INPUT) {
    $mergePages = Get-Content -LiteralPath $env:TUTOR_MERGE_TEST_INPUT -Raw -Encoding UTF8 | ConvertFrom-Json
    Merge-OcrPages ([string[]]@($mergePages))
    exit 0
}

function Get-CandidateLines([string]$ocrText) {
    $lines = @($ocrText -split "`r?`n" | ForEach-Object { ($_ -replace "\s{2,}", " ").Trim() } | Where-Object { $_.Length -gt 4 })
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) { $candidates.Add($line) }
    for ($i = 0; $i -lt $lines.Count - 1; $i++) {
        if (($lines[$i] + $lines[$i+1]).Length -lt 180) { $candidates.Add($lines[$i] + " " + $lines[$i+1]) }
    }
    for ($i = 0; $i -lt $lines.Count - 2; $i++) {
        $joined = ($lines[$i..($i+2)] -join " ")
        if ($joined.Length -lt 260) { $candidates.Add($joined) }
    }
    if ($ocrText.Trim().Length -gt 8 -and $ocrText.Trim().Length -lt 1200) {
        $candidates.Add(($ocrText -replace "\s+", " ").Trim())
    }
    return $candidates
}

function Add-Order($order) {
    if (-not $order) { return $false }
    if ($Script:Seen.ContainsKey($order.Hash)) { return $false }
    $Script:Seen[$order.Hash] = $true
    $Script:Orders.Add($order) | Out-Null
    Save-Orders
    Refresh-Grid
    if ($order.Score -ge [int]$numAlert.Value) {
        $notify.BalloonTipTitle = "高分家教单：$($order.Score)分"
        $notify.BalloonTipText = "$($order.District)$($order.Place) $($order.Grade)$($order.Subject) $($order.Price) $($order.Commute)"
        $notify.ShowBalloonTip(5000)
    }
    return $true
}

function Save-Orders {
    if ($Script:Orders.Count -eq 0) { return }
    $Script:Orders | Sort-Object Time -Descending | Export-Csv -Path $Script:OrdersPath -NoTypeInformation -Encoding UTF8
}

function Load-Orders {
    $Script:Orders = New-Object System.Collections.ArrayList
    $Script:Seen = @{}
    if (Test-Path $Script:OrdersPath) {
        Import-Csv $Script:OrdersPath | ForEach-Object {
            $Script:Orders.Add($_) | Out-Null
            if ($_.Hash) { $Script:Seen[$_.Hash] = $true }
        }
    }
}

function Refresh-Grid {
    $subjectFilter = $cmbSubject.Text
    $districtFilter = $cmbDistrict.Text
    $gradeFilter = $cmbGrade.Text
    $rows = $Script:Orders | Where-Object {
        $bikeOk = $true
        if ($chkBikeRange -and $chkBikeRange.Checked) {
            $bikeOk = $false
            if ($_.BikeKm -ne $null -and "$($_.BikeKm)" -ne "") {
                try { $bikeOk = ([double]$_.BikeKm -le [double]$numMaxBikeKm.Value) } catch { $bikeOk = $false }
            }
        }
        ($subjectFilter -eq "全部科目" -or $_.Subject -eq $subjectFilter) -and
        ($districtFilter -eq "全部区域" -or $_.District -eq $districtFilter) -and
        ($gradeFilter -eq "全部年级" -or $_.Grade -eq $gradeFilter) -and
        $bikeOk
    } | Sort-Object @{Expression={ [int]$_.Score }; Descending=$true}, Time -Descending
    $grid.DataSource = @($rows | Select-Object Score,District,Place,Subject,Grade,Price,BikeKm,BikeMinutes,RouteMode,ClassTime,Gender,Commute,Status,Address,Raw,Time)
    $lblCount.Text = "订单：$($rows.Count) / 总计 $($Script:Orders.Count)"
}

function Get-RealCursorPoint {
    $pt = New-Object POINT
    [NativeDpi]::GetCursorPos([ref]$pt) | Out-Null
    return [System.Drawing.Point]::new($pt.X, $pt.Y)
}

function Select-CaptureRect {
    $vx = [NativeDpi]::GetSystemMetrics(76)
    $vy = [NativeDpi]::GetSystemMetrics(77)
    $vw = [NativeDpi]::GetSystemMetrics(78)
    $vh = [NativeDpi]::GetSystemMetrics(79)
    $vs = [System.Drawing.Rectangle]::new($vx, $vy, $vw, $vh)
    $overlay = New-Object System.Windows.Forms.Form
    $overlay.FormBorderStyle = "None"
    $overlay.Bounds = $vs
    $overlay.StartPosition = "Manual"
    $overlay.TopMost = $true
    $overlay.BackColor = [System.Drawing.Color]::Black
    $overlay.Opacity = 0.25
    $overlay.Cursor = [System.Windows.Forms.Cursors]::Cross
    $overlay.ShowInTaskbar = $false
    $Script:SelectedRect = $null
    $start = $null
    $current = $null
    $overlay.Add_MouseDown({
        $script:start = Get-RealCursorPoint
        $script:current = Get-RealCursorPoint
    })
    $overlay.Add_MouseMove({
        if ($script:start) {
            $script:current = Get-RealCursorPoint
            $overlay.Invalidate()
        }
    })
    $overlay.Add_Paint({
        if ($script:start -and $script:current) {
            $x = [Math]::Min($script:start.X, $script:current.X) - $overlay.Left
            $y = [Math]::Min($script:start.Y, $script:current.Y) - $overlay.Top
            $w = [Math]::Abs($script:start.X - $script:current.X)
            $h = [Math]::Abs($script:start.Y - $script:current.Y)
            $_.Graphics.DrawRectangle((New-Object System.Drawing.Pen ([System.Drawing.Color]::DeepSkyBlue), 3), $x, $y, $w, $h)
        }
    })
    $overlay.Add_MouseUp({
        $end = Get-RealCursorPoint
        $x = [Math]::Min($script:start.X, $end.X)
        $y = [Math]::Min($script:start.Y, $end.Y)
        $w = [Math]::Abs($script:start.X - $end.X)
        $h = [Math]::Abs($script:start.Y - $end.Y)
        if ($w -gt 120 -and $h -gt 80) {
            $Script:SelectedRect = [System.Drawing.Rectangle]::new($x, $y, $w, $h)
        }
        $overlay.Close()
    })
    [void]$overlay.ShowDialog()
    return $Script:SelectedRect
}

function Show-ImageWindow([string]$path) {
    if (-not (Test-Path $path)) {
        [System.Windows.Forms.MessageBox]::Show("还没有截图。请先点一次[识别一次]。", "没有截图") | Out-Null
        return
    }
    $viewer = New-Object System.Windows.Forms.Form
    $viewer.Text = "上次截到的微信区域"
    $viewer.Size = New-Object System.Drawing.Size(1000, 700)
    $viewer.StartPosition = "CenterScreen"
    $viewer.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Dock = "Fill"
    $panel.AutoScroll = $true
    $viewer.Controls.Add($panel)
    $pic = New-Object System.Windows.Forms.PictureBox
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sourceImage = [System.Drawing.Image]::FromStream($stream)
        $img = New-Object System.Drawing.Bitmap $sourceImage
        $sourceImage.Dispose()
    } finally {
        $stream.Dispose()
    }
    $pic.Image = $img
    $pic.SizeMode = "AutoSize"
    $panel.Controls.Add($pic)
    $viewer.Add_FormClosed({ $img.Dispose() })
    [void]$viewer.ShowDialog()
}

function Show-TextWindow([string]$path) {
    $text = ""
    if (Test-Path $path) { $text = Get-Content $path -Raw -Encoding UTF8 }
    if (-not $text) { $text = "还没有识别文字。请先点一次[识别一次]。" }
    if ((Test-Path $Script:LastCapturePath) -and (Test-Path $path)) {
        $captureTime = (Get-Item $Script:LastCapturePath).LastWriteTime
        $ocrTime = (Get-Item $path).LastWriteTime
        if ($ocrTime -lt $captureTime) {
            $text = "截图比识别文字更新。当前显示的不是这张截图的识别结果。`r`n请点击 [识别并上传一次] 后，再查看识别文字。`r`n`r`n旧识别文字：`r`n" + $text
        }
    }
    $viewer = New-Object System.Windows.Forms.Form
    $viewer.Text = "上次 OCR 识别文字"
    $viewer.Size = New-Object System.Drawing.Size(900, 650)
    $viewer.StartPosition = "CenterScreen"
    $viewer.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)
    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.ScrollBars = "Both"
    $box.WordWrap = $false
    $box.Dock = "Fill"
    $box.Text = $text
    $viewer.Controls.Add($box)
    [void]$viewer.ShowDialog()
}

$Script:Config = Load-Config
Load-GeoCache
Load-Orders
Load-ReadGroups
if ($Script:Config.CaptureRect) {
    $r = $Script:Config.CaptureRect
    $Script:CaptureRect = [ordered]@{ X=[int]$r.X; Y=[int]$r.Y; Width=[int]$r.Width; Height=[int]$r.Height }
} else { $Script:CaptureRect = $null }

$form = New-Object System.Windows.Forms.Form
$form.Text = "家教订单助手 - 屏幕监控版"
$form.Size = New-Object System.Drawing.Size(1180, 760)
$form.StartPosition = "CenterScreen"
$form.MinimumSize = New-Object System.Drawing.Size(980, 640)
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)

$top = New-Object System.Windows.Forms.Panel
$top.Dock = "Top"
$top.Height = 300
$top.Padding = New-Object System.Windows.Forms.Padding(10)
$form.Controls.Add($top)

$lblHome = New-Object System.Windows.Forms.Label
$lblHome.Text = "我的位置"
$lblHome.Location = New-Object System.Drawing.Point(10, 14)
$lblHome.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblHome)
$txtHome = New-Object System.Windows.Forms.TextBox
$txtHome.Text = $Script:Config.Home
$txtHome.Location = New-Object System.Drawing.Point(82, 11)
$txtHome.Size = New-Object System.Drawing.Size(190, 26)
$top.Controls.Add($txtHome)

$lblSubjects = New-Object System.Windows.Forms.Label
$lblSubjects.Text = "主教科目"
$lblSubjects.Location = New-Object System.Drawing.Point(290, 14)
$lblSubjects.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblSubjects)
$txtSubjects = New-Object System.Windows.Forms.TextBox
$txtSubjects.Text = $Script:Config.PreferredSubjects
$txtSubjects.Location = New-Object System.Drawing.Point(362, 11)
$txtSubjects.Size = New-Object System.Drawing.Size(180, 26)
$top.Controls.Add($txtSubjects)

$lblDistricts = New-Object System.Windows.Forms.Label
$lblDistricts.Text = "优先区域"
$lblDistricts.Location = New-Object System.Drawing.Point(560, 14)
$lblDistricts.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblDistricts)
$txtDistricts = New-Object System.Windows.Forms.TextBox
$txtDistricts.Text = $Script:Config.PreferredDistricts
$txtDistricts.Location = New-Object System.Drawing.Point(632, 11)
$txtDistricts.Size = New-Object System.Drawing.Size(180, 26)
$top.Controls.Add($txtDistricts)

$lblGrades = New-Object System.Windows.Forms.Label
$lblGrades.Text = "优先年级"
$lblGrades.Location = New-Object System.Drawing.Point(830, 14)
$lblGrades.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblGrades)
$txtGrades = New-Object System.Windows.Forms.TextBox
$txtGrades.Text = $Script:Config.PreferredGrades
$txtGrades.Location = New-Object System.Drawing.Point(902, 11)
$txtGrades.Size = New-Object System.Drawing.Size(230, 26)
$top.Controls.Add($txtGrades)

$lblMin = New-Object System.Windows.Forms.Label
$lblMin.Text = "最低课酬"
$lblMin.Location = New-Object System.Drawing.Point(10, 52)
$lblMin.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblMin)
$numMinPrice = New-Object System.Windows.Forms.NumericUpDown
$numMinPrice.Minimum = 0; $numMinPrice.Maximum = 2000; $numMinPrice.Increment = 10
$numMinPrice.Value = [decimal]$Script:Config.MinPrice
$numMinPrice.Location = New-Object System.Drawing.Point(82, 49)
$numMinPrice.Size = New-Object System.Drawing.Size(90, 26)
$top.Controls.Add($numMinPrice)

$lblAlert = New-Object System.Windows.Forms.Label
$lblAlert.Text = "提醒分"
$lblAlert.Location = New-Object System.Drawing.Point(190, 52)
$lblAlert.Size = New-Object System.Drawing.Size(54, 24)
$top.Controls.Add($lblAlert)
$numAlert = New-Object System.Windows.Forms.NumericUpDown
$numAlert.Minimum = 0; $numAlert.Maximum = 100; $numAlert.Value = [decimal]$Script:Config.AlertScore
$numAlert.Location = New-Object System.Drawing.Point(246, 49)
$numAlert.Size = New-Object System.Drawing.Size(70, 26)
$top.Controls.Add($numAlert)

$lblInterval = New-Object System.Windows.Forms.Label
$lblInterval.Text = "间隔秒"
$lblInterval.Location = New-Object System.Drawing.Point(334, 52)
$lblInterval.Size = New-Object System.Drawing.Size(54, 24)
$top.Controls.Add($lblInterval)
$numInterval = New-Object System.Windows.Forms.NumericUpDown
$numInterval.Minimum = 3; $numInterval.Maximum = 120; $numInterval.Value = [decimal]$Script:Config.IntervalSeconds
$numInterval.Location = New-Object System.Drawing.Point(390, 49)
$numInterval.Size = New-Object System.Drawing.Size(70, 26)
$top.Controls.Add($numInterval)

$lblBike = New-Object System.Windows.Forms.Label
$lblBike.Text = "电动车范围"
$lblBike.Location = New-Object System.Drawing.Point(480, 52)
$lblBike.Size = New-Object System.Drawing.Size(78, 24)
$top.Controls.Add($lblBike)
$numMaxBikeKm = New-Object System.Windows.Forms.NumericUpDown
$numMaxBikeKm.Minimum = 1; $numMaxBikeKm.Maximum = 80; $numMaxBikeKm.Value = [decimal]$Script:Config.MaxBikeKm
$numMaxBikeKm.Location = New-Object System.Drawing.Point(560, 49)
$numMaxBikeKm.Size = New-Object System.Drawing.Size(58, 26)
$top.Controls.Add($numMaxBikeKm)
$lblKm = New-Object System.Windows.Forms.Label
$lblKm.Text = "公里内"
$lblKm.Location = New-Object System.Drawing.Point(622, 52)
$lblKm.Size = New-Object System.Drawing.Size(54, 24)
$top.Controls.Add($lblKm)

$lblCity = New-Object System.Windows.Forms.Label
$lblCity.Text = "城市"
$lblCity.Location = New-Object System.Drawing.Point(690, 52)
$lblCity.Size = New-Object System.Drawing.Size(42, 24)
$top.Controls.Add($lblCity)
$txtCity = New-Object System.Windows.Forms.TextBox
$txtCity.Text = $Script:Config.City
$txtCity.Location = New-Object System.Drawing.Point(734, 49)
$txtCity.Size = New-Object System.Drawing.Size(78, 26)
$top.Controls.Add($txtCity)

$lblAmap = New-Object System.Windows.Forms.Label
$lblAmap.Text = "高德Key"
$lblAmap.Location = New-Object System.Drawing.Point(10, 90)
$lblAmap.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblAmap)
$txtAmapKey = New-Object System.Windows.Forms.TextBox
$txtAmapKey.Text = $Script:Config.AmapKey
$txtAmapKey.Location = New-Object System.Drawing.Point(82, 87)
$txtAmapKey.Size = New-Object System.Drawing.Size(456, 26)
$top.Controls.Add($txtAmapKey)
$btnTestAmap = New-Object System.Windows.Forms.Button
$btnTestAmap.Text = "测试高德"
$btnTestAmap.Location = New-Object System.Drawing.Point(550, 85)
$btnTestAmap.Size = New-Object System.Drawing.Size(90, 30)
$top.Controls.Add($btnTestAmap)

$lblPlatformUrl = New-Object System.Windows.Forms.Label
$lblPlatformUrl.Text = "网站地址"
$lblPlatformUrl.Location = New-Object System.Drawing.Point(10, 126)
$lblPlatformUrl.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblPlatformUrl)
$txtPlatformUrl = New-Object System.Windows.Forms.TextBox
$txtPlatformUrl.Text = $Script:Config.PlatformUrl
$txtPlatformUrl.Location = New-Object System.Drawing.Point(82, 123)
$txtPlatformUrl.Size = New-Object System.Drawing.Size(260, 26)
$top.Controls.Add($txtPlatformUrl)

$lblAgencyName = New-Object System.Windows.Forms.Label
$lblAgencyName.Text = "采集账号"
$lblAgencyName.Location = New-Object System.Drawing.Point(356, 126)
$lblAgencyName.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblAgencyName)
$txtAgencyName = New-Object System.Windows.Forms.TextBox
$txtAgencyName.Text = $Script:Config.AgencyName
$txtAgencyName.Location = New-Object System.Drawing.Point(428, 123)
$txtAgencyName.Size = New-Object System.Drawing.Size(130, 26)
$top.Controls.Add($txtAgencyName)

$txtAgencyPhone = New-Object System.Windows.Forms.TextBox
$txtAgencyPhone.Text = $Script:Config.AgencyPhone
$txtAgencyPhone.Location = New-Object System.Drawing.Point(568, 123)
$txtAgencyPhone.Size = New-Object System.Drawing.Size(140, 26)
$top.Controls.Add($txtAgencyPhone)

$txtAgencyPassword = New-Object System.Windows.Forms.TextBox
$txtAgencyPassword.UseSystemPasswordChar = $true
$txtAgencyPassword.Location = New-Object System.Drawing.Point(718, 123)
$txtAgencyPassword.Size = New-Object System.Drawing.Size(130, 26)
$top.Controls.Add($txtAgencyPassword)

$btnTestPlatform = New-Object System.Windows.Forms.Button
$btnTestPlatform.Text = "测试网站连接"
$btnTestPlatform.Location = New-Object System.Drawing.Point(858, 121)
$btnTestPlatform.Size = New-Object System.Drawing.Size(120, 30)
$top.Controls.Add($btnTestPlatform)

$lblGroups = New-Object System.Windows.Forms.Label
$lblGroups.Text = "微信群名"
$lblGroups.Location = New-Object System.Drawing.Point(10, 164)
$lblGroups.Size = New-Object System.Drawing.Size(70, 24)
$top.Controls.Add($lblGroups)
$txtWeChatGroups = New-Object System.Windows.Forms.TextBox
$txtWeChatGroups.Text = $Script:Config.WeChatGroups
$txtWeChatGroups.Location = New-Object System.Drawing.Point(82, 161)
$txtWeChatGroups.Size = New-Object System.Drawing.Size(540, 26)
$top.Controls.Add($txtWeChatGroups)

$toolTip = New-Object System.Windows.Forms.ToolTip
$toolTip.SetToolTip($txtAgencyPhone, "采集账号的手机号或微信号")
$toolTip.SetToolTip($txtAgencyPassword, "采集账号密码，至少6位；密码不会保存到配置文件")
$toolTip.SetToolTip($txtWeChatGroups, "多个群名用逗号分隔，例如：深圳家教群,南山家教群")

$chkAutoSwitch = New-Object System.Windows.Forms.CheckBox
$chkAutoSwitch.Text = "自动切换群聊"
$chkAutoSwitch.Checked = [bool]$Script:Config.AutoSwitchGroups
$chkAutoSwitch.Location = New-Object System.Drawing.Point(640, 162)
$chkAutoSwitch.Size = New-Object System.Drawing.Size(120, 26)
$top.Controls.Add($chkAutoSwitch)

$chkAutoScroll = New-Object System.Windows.Forms.CheckBox
$chkAutoScroll.Text = "自动向上翻页"
$chkAutoScroll.Checked = [bool]$Script:Config.AutoScroll
$chkAutoScroll.Location = New-Object System.Drawing.Point(770, 162)
$chkAutoScroll.Size = New-Object System.Drawing.Size(120, 26)
$top.Controls.Add($chkAutoScroll)

$chkAutoUpload = New-Object System.Windows.Forms.CheckBox
$chkAutoUpload.Text = "自动上传网站"
$chkAutoUpload.Checked = [bool]$Script:Config.AutoUpload
$chkAutoUpload.Location = New-Object System.Drawing.Point(900, 162)
$chkAutoUpload.Size = New-Object System.Drawing.Size(130, 26)
$top.Controls.Add($chkAutoUpload)

$btnSelect = New-Object System.Windows.Forms.Button
$btnSelect.Text = "框选微信消息区域"
$btnSelect.Location = New-Object System.Drawing.Point(830, 47)
$btnSelect.Size = New-Object System.Drawing.Size(150, 30)
$top.Controls.Add($btnSelect)

$btnScan = New-Object System.Windows.Forms.Button
$btnScan.Text = "识别一次"
$btnScan.Location = New-Object System.Drawing.Point(992, 47)
$btnScan.Size = New-Object System.Drawing.Size(90, 30)
$top.Controls.Add($btnScan)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = "开始监控"
$btnStart.Location = New-Object System.Drawing.Point(650, 85)
$btnStart.Size = New-Object System.Drawing.Size(96, 30)
$top.Controls.Add($btnStart)

$btnExport = New-Object System.Windows.Forms.Button
$btnExport.Text = "导出CSV"
$btnExport.Location = New-Object System.Drawing.Point(758, 85)
$btnExport.Size = New-Object System.Drawing.Size(90, 30)
$top.Controls.Add($btnExport)

$btnReply = New-Object System.Windows.Forms.Button
$btnReply.Text = "复制接单话术"
$btnReply.Location = New-Object System.Drawing.Point(860, 85)
$btnReply.Size = New-Object System.Drawing.Size(120, 30)
$top.Controls.Add($btnReply)

$btnViewCapture = New-Object System.Windows.Forms.Button
$btnViewCapture.Text = "查看截图"
$btnViewCapture.Location = New-Object System.Drawing.Point(992, 85)
$btnViewCapture.Size = New-Object System.Drawing.Size(80, 30)
$top.Controls.Add($btnViewCapture)

$btnViewText = New-Object System.Windows.Forms.Button
$btnViewText.Text = "看文字"
$btnViewText.Location = New-Object System.Drawing.Point(1082, 85)
$btnViewText.Size = New-Object System.Drawing.Size(70, 30)
$top.Controls.Add($btnViewText)

$lblRect = New-Object System.Windows.Forms.Label
$lblRect.Location = New-Object System.Drawing.Point(10, 204)
$lblRect.Size = New-Object System.Drawing.Size(1060, 24)
if ($Script:CaptureRect) {
    $lblRect.Text = "已选择区域：X=$($Script:CaptureRect.X), Y=$($Script:CaptureRect.Y), W=$($Script:CaptureRect.Width), H=$($Script:CaptureRect.Height)"
} else {
    $lblRect.Text = "还未框选区域。请先点击[框选微信消息区域]。"
}
$top.Controls.Add($lblRect)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(10, 232)
$lblStatus.Size = New-Object System.Drawing.Size(1060, 24)
if ($Script:WindowsOcrReady -and $Script:TesseractPath) {
    $lblStatus.Text = "中文 OCR 已就绪（Windows 识别为主，Tesseract 备用）"
} elseif ($Script:WindowsOcrReady) {
    $lblStatus.Text = "中文 OCR 已就绪（Windows 识别）"
} elseif ($Script:TesseractPath) {
    $lblStatus.Text = "OCR 已就绪（Tesseract 备用识别）"
} else {
    $lblStatus.Text = "未找到可用的中文 OCR，请检查 Windows 中文语言组件。"
}
$top.Controls.Add($lblStatus)

$filter = New-Object System.Windows.Forms.Panel
$filter.Dock = "Top"
$filter.Height = 44
$filter.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$form.Controls.Add($filter)

$cmbSubject = New-Object System.Windows.Forms.ComboBox
$cmbSubject.DropDownStyle = "DropDownList"
$cmbSubject.Items.AddRange(@("全部科目","语文","数学","英语","物理","化学","生物","政治","历史","地理","科学","奥数","编程"))
$cmbSubject.SelectedIndex = 0
$cmbSubject.Location = New-Object System.Drawing.Point(10, 8)
$cmbSubject.Size = New-Object System.Drawing.Size(120, 26)
$filter.Controls.Add($cmbSubject)

$cmbDistrict = New-Object System.Windows.Forms.ComboBox
$cmbDistrict.DropDownStyle = "DropDownList"
$cmbDistrict.Items.AddRange(@("全部区域","宝安","南山","福田","罗湖","龙华","龙岗","光明","坪山","盐田","大鹏"))
$cmbDistrict.SelectedIndex = 0
$cmbDistrict.Location = New-Object System.Drawing.Point(142, 8)
$cmbDistrict.Size = New-Object System.Drawing.Size(120, 26)
$filter.Controls.Add($cmbDistrict)

$cmbGrade = New-Object System.Windows.Forms.ComboBox
$cmbGrade.DropDownStyle = "DropDownList"
$cmbGrade.Items.AddRange(@("全部年级","小学","初一","初二","初三","初中","高一","高二","高三","高中","中考","高考"))
$cmbGrade.SelectedIndex = 0
$cmbGrade.Location = New-Object System.Drawing.Point(274, 8)
$cmbGrade.Size = New-Object System.Drawing.Size(120, 26)
$filter.Controls.Add($cmbGrade)

$lblCount = New-Object System.Windows.Forms.Label
$lblCount.Location = New-Object System.Drawing.Point(548, 10)
$lblCount.Size = New-Object System.Drawing.Size(220, 24)
$filter.Controls.Add($lblCount)

$chkBikeRange = New-Object System.Windows.Forms.CheckBox
$chkBikeRange.Text = "只看电动车范围内"
$chkBikeRange.Location = New-Object System.Drawing.Point(414, 9)
$chkBikeRange.Size = New-Object System.Drawing.Size(132, 24)
$filter.Controls.Add($chkBikeRange)

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock = "Fill"
$grid.ReadOnly = $true
$grid.AllowUserToAddRows = $false
$grid.AllowUserToDeleteRows = $false
$grid.SelectionMode = "FullRowSelect"
$grid.MultiSelect = $false
$grid.AutoSizeColumnsMode = "DisplayedCells"
$grid.RowHeadersVisible = $false
$form.Controls.Add($grid)

# Rebuild the fixed-coordinate controls into a DPI-aware product layout.
$form.SuspendLayout()
$form.Controls.Clear()
$form.Text = "家教订单自动采集助手"
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#F3F6F8")
$form.MinimumSize = New-Object System.Drawing.Size(1180, 760)
$form.WindowState = [System.Windows.Forms.FormWindowState]::Maximized

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.ColumnCount = 1
$root.RowCount = 4
$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 104)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 390)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 64)))
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$form.Controls.Add($root)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Fill"
$header.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#123B4A")
$root.Controls.Add($header, 0, 0)

$appTitle = New-Object System.Windows.Forms.Label
$appTitle.Text = "家教订单自动采集助手"
$appTitle.ForeColor = [System.Drawing.Color]::White
$appTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 14, [System.Drawing.FontStyle]::Bold)
$appTitle.AutoSize = $true
$appTitle.Location = New-Object System.Drawing.Point(24, 13)
$header.Controls.Add($appTitle)

$appSubtitle = New-Object System.Windows.Forms.Label
$appSubtitle.Text = "自动切换微信群、识别订单并上传到家教单平台"
$appSubtitle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#C8DDE4")
$appSubtitle.AutoSize = $true
$appSubtitle.Location = New-Object System.Drawing.Point(26, 60)
$header.Controls.Add($appSubtitle)

$configArea = New-Object System.Windows.Forms.TabControl
$configArea.Dock = "Fill"
$configArea.Padding = New-Object System.Drawing.Point(18, 8)
$configArea.Margin = New-Object System.Windows.Forms.Padding(16, 12, 16, 8)
$root.Controls.Add($configArea, 0, 1)

function New-ConfigSection([string]$title) {
    $box = New-Object System.Windows.Forms.GroupBox
    $box.Text = $title
    $box.Dock = "Fill"
    $box.Padding = New-Object System.Windows.Forms.Padding(12, 12, 12, 10)
    $box.Margin = New-Object System.Windows.Forms.Padding(6)
    $box.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#17313B")
    $table = New-Object System.Windows.Forms.TableLayoutPanel
    $table.Dock = "Fill"
    $table.AutoScroll = $false
    $table.ColumnCount = 2
    $table.RowCount = 0
    [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 210)))
    [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void]$box.Controls.Add($table)
    return ,@($box, $table)
}

function Add-ConfigField($table, [string]$caption, $control) {
    $row = $table.RowCount
    $table.RowCount++
    [void]$table.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 38)))
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $caption
    $label.Dock = "Fill"
    $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $label.AutoEllipsis = $false
    $control.Dock = "Fill"
    $control.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
    [void]$table.Controls.Add($label, 0, $row)
    [void]$table.Controls.Add($control, 1, $row)
}

function Add-ConfigFullRow($table, $control, [int]$height = 42) {
    $row = $table.RowCount
    $table.RowCount++
    [void]$table.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, $height)))
    $control.Dock = "Fill"
    $control.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
    [void]$table.Controls.Add($control, 0, $row)
    $table.SetColumnSpan($control, 2)
}

$prefSection = New-ConfigSection "1  筛选与路线偏好"
$prefBox = $prefSection[0]; $prefTable = $prefSection[1]
$accountSection = New-ConfigSection "2  网站中介账号"
$accountBox = $accountSection[0]; $accountTable = $accountSection[1]
$autoSection = New-ConfigSection "3  微信自动采集"
$autoBox = $autoSection[0]; $autoTable = $autoSection[1]
$prefPage = New-Object System.Windows.Forms.TabPage
$prefPage.Text = "筛选与路线偏好"
$prefPage.Padding = New-Object System.Windows.Forms.Padding(10)
$accountPage = New-Object System.Windows.Forms.TabPage
$accountPage.Text = "网站中介账号"
$accountPage.Padding = New-Object System.Windows.Forms.Padding(10)
$autoPage = New-Object System.Windows.Forms.TabPage
$autoPage.Text = "微信自动采集"
$autoPage.Padding = New-Object System.Windows.Forms.Padding(10)
[void]$configArea.TabPages.Add($prefPage)
[void]$configArea.TabPages.Add($accountPage)
[void]$configArea.TabPages.Add($autoPage)
$prefPage.Controls.Add($prefBox)
$accountPage.Controls.Add($accountBox)
$autoPage.Controls.Add($autoBox)

Add-ConfigField $prefTable "我的出发位置" $txtHome
Add-ConfigField $prefTable "主教科目" $txtSubjects
Add-ConfigField $prefTable "优先区域" $txtDistricts
Add-ConfigField $prefTable "优先年级" $txtGrades
Add-ConfigField $prefTable "最低课酬（元/时）" $numMinPrice
Add-ConfigField $prefTable "高分提醒分数" $numAlert
Add-ConfigField $prefTable "监控间隔（秒）" $numInterval
Add-ConfigField $prefTable "骑行范围（公里）" $numMaxBikeKm

Add-ConfigField $accountTable "网站地址" $txtPlatformUrl
Add-ConfigField $accountTable "中介名称" $txtAgencyName
Add-ConfigField $accountTable "联系电话/微信" $txtAgencyPhone
Add-ConfigField $accountTable "中介账号密码" $txtAgencyPassword
Add-ConfigField $accountTable "所在城市" $txtCity
Add-ConfigField $accountTable "高德 Web服务 Key" $txtAmapKey
$accountButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$accountButtons.FlowDirection = "LeftToRight"
$accountButtons.WrapContents = $false
$btnTestPlatform.Text = "测试网站账号"
$btnTestPlatform.AutoSize = $true
$btnTestAmap.Text = "测试高德地图"
$btnTestAmap.AutoSize = $true
$accountButtons.Controls.Add($btnTestPlatform)
$accountButtons.Controls.Add($btnTestAmap)
Add-ConfigFullRow $accountTable $accountButtons 48

Add-ConfigField $autoTable "微信群名称" $txtWeChatGroups
$optionPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$optionPanel.FlowDirection = "TopDown"
$optionPanel.WrapContents = $false
$optionPanel.AutoSize = $true
$chkAutoSwitch.Text = "自动搜索并切换群聊"
$chkAutoSwitch.AutoSize = $true
$chkAutoScroll.Text = "自动向上翻阅历史消息"
$chkAutoScroll.AutoSize = $true
$chkAutoUpload.Text = "识别后自动上传网站"
$chkAutoUpload.AutoSize = $true
$optionPanel.Controls.Add($chkAutoSwitch)
$optionPanel.Controls.Add($chkAutoScroll)
$optionPanel.Controls.Add($chkAutoUpload)
Add-ConfigFullRow $autoTable $optionPanel 92

$captureButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$captureButtons.FlowDirection = "LeftToRight"
$captureButtons.WrapContents = $true
$btnSelect.Text = "框选微信消息区域"
$btnScan.Text = "识别当前画面"
$btnStart.Text = "开始自动采集"
foreach ($button in @($btnSelect, $btnScan, $btnStart)) { $button.AutoSize = $true; $captureButtons.Controls.Add($button) }
Add-ConfigFullRow $autoTable $captureButtons 76

$inspectButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$inspectButtons.FlowDirection = "LeftToRight"
$inspectButtons.WrapContents = $true
$btnViewCapture.Text = "查看上次截图"
$btnViewText.Text = "查看识别文字"
$btnExport.Text = "导出订单表格"
$btnReply.Text = "复制接单话术"
foreach ($button in @($btnViewCapture, $btnViewText, $btnExport, $btnReply)) { $button.AutoSize = $true; $inspectButtons.Controls.Add($button) }
Add-ConfigFullRow $autoTable $inspectButtons 76

$lblRect.AutoSize = $false
$lblRect.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#51636B")
$lblRect.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
Add-ConfigFullRow $autoTable $lblRect 42
$lblStatus.AutoSize = $false
$lblStatus.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#176B54")
$lblStatus.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
Add-ConfigFullRow $autoTable $lblStatus 48

$filterBar = New-Object System.Windows.Forms.FlowLayoutPanel
$filterBar.Dock = "Fill"
$filterBar.Padding = New-Object System.Windows.Forms.Padding(18, 10, 12, 8)
$filterBar.BackColor = [System.Drawing.Color]::White
$filterBar.WrapContents = $false
$filterTitle = New-Object System.Windows.Forms.Label
$filterTitle.Text = "订单结果"
$filterTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 11, [System.Drawing.FontStyle]::Bold)
$filterTitle.AutoSize = $true
$filterTitle.Margin = New-Object System.Windows.Forms.Padding(0, 5, 18, 0)
$filterBar.Controls.Add($filterTitle)
foreach ($combo in @($cmbSubject, $cmbDistrict, $cmbGrade)) {
    $combo.Width = 145
    $combo.Margin = New-Object System.Windows.Forms.Padding(0, 0, 10, 0)
    $filterBar.Controls.Add($combo)
}
$chkBikeRange.Text = "只看骑行范围内"
$chkBikeRange.AutoSize = $true
$chkBikeRange.Margin = New-Object System.Windows.Forms.Padding(4, 5, 18, 0)
$filterBar.Controls.Add($chkBikeRange)
$lblCount.AutoSize = $true
$lblCount.Margin = New-Object System.Windows.Forms.Padding(0, 5, 0, 0)
$filterBar.Controls.Add($lblCount)
$root.Controls.Add($filterBar, 0, 2)

$grid.Dock = "Fill"
$grid.BackgroundColor = [System.Drawing.Color]::White
$grid.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$grid.EnableHeadersVisualStyles = $false
$grid.ColumnHeadersDefaultCellStyle.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#E8F0F3")
$grid.ColumnHeadersDefaultCellStyle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#17313B")
$grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
$grid.ColumnHeadersHeight = 38
$grid.RowTemplate.Height = 34
$grid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#F7FAFB")
$grid.DefaultCellStyle.SelectionBackColor = [System.Drawing.ColorTranslator]::FromHtml("#D6E8EE")
$grid.DefaultCellStyle.SelectionForeColor = [System.Drawing.ColorTranslator]::FromHtml("#17313B")
$root.Controls.Add($grid, 0, 3)
$form.ResumeLayout($true)

# Focused product UI: this app only moves WeChat order information to the website.
$form.SuspendLayout()
$form.Controls.Clear()
$form.Text = "微信家教订单搬运助手"

$transferRoot = New-Object System.Windows.Forms.TableLayoutPanel
$transferRoot.Dock = "Fill"
$transferRoot.ColumnCount = 1
$transferRoot.RowCount = 4
[void]$transferRoot.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$transferRoot.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 108)))
[void]$transferRoot.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 360)))
[void]$transferRoot.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 86)))
[void]$transferRoot.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$form.Controls.Add($transferRoot)

$transferHeader = New-Object System.Windows.Forms.Panel
$transferHeader.Dock = "Fill"
$transferHeader.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#123B4A")
$transferTitle = New-Object System.Windows.Forms.Label
$transferTitle.Text = "微信家教订单搬运助手"
$transferTitle.ForeColor = [System.Drawing.Color]::White
$transferTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 14, [System.Drawing.FontStyle]::Bold)
$transferTitle.AutoSize = $true
$transferTitle.Location = New-Object System.Drawing.Point(26, 16)
$transferHeader.Controls.Add($transferTitle)
$transferSubtitle = New-Object System.Windows.Forms.Label
$transferSubtitle.Text = "使用顺序：连接网站账号 → 打开电脑版微信 → 自动定位读取范围 → 单次测试 → 开始搬运"
$transferSubtitle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#C8DDE4")
$transferSubtitle.AutoSize = $true
$transferSubtitle.Location = New-Object System.Drawing.Point(28, 63)
$transferHeader.Controls.Add($transferSubtitle)
$transferRoot.Controls.Add($transferHeader, 0, 0)

$setupArea = New-Object System.Windows.Forms.TabControl
$setupArea.Dock = "Fill"
$setupArea.Padding = New-Object System.Drawing.Point(18, 8)
$setupArea.Margin = New-Object System.Windows.Forms.Padding(18, 12, 18, 8)
$transferRoot.Controls.Add($setupArea, 0, 1)

$accountSection2 = New-ConfigSection "1  网站中介账号"
$accountBox2 = $accountSection2[0]; $accountTable2 = $accountSection2[1]
$wechatSection2 = New-ConfigSection "2  微信采集范围"
$wechatBox2 = $wechatSection2[0]; $wechatTable2 = $wechatSection2[1]
$accountTransferPage = New-Object System.Windows.Forms.TabPage
$accountTransferPage.Text = "1  网站中介账号"
$accountTransferPage.Padding = New-Object System.Windows.Forms.Padding(10)
$wechatTransferPage = New-Object System.Windows.Forms.TabPage
$wechatTransferPage.Text = "2  微信采集范围"
$wechatTransferPage.Padding = New-Object System.Windows.Forms.Padding(10)
[void]$setupArea.TabPages.Add($accountTransferPage)
[void]$setupArea.TabPages.Add($wechatTransferPage)
$accountTransferPage.Controls.Add($accountBox2)
$wechatTransferPage.Controls.Add($wechatBox2)

Add-ConfigField $accountTable2 "网站地址" $txtPlatformUrl
Add-ConfigField $accountTable2 "中介名称" $txtAgencyName
Add-ConfigField $accountTable2 "联系电话/微信" $txtAgencyPhone
Add-ConfigField $accountTable2 "中介账号密码" $txtAgencyPassword
$accountHelp = New-Object System.Windows.Forms.Label
$accountHelp.Text = "这里填写的名称、电话和密码，与网站中介端登录信息完全一致。首次使用新名称时会创建中介账号。密码不会保存。"
$accountHelp.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#53666E")
$accountHelp.AutoSize = $false
$accountHelp.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
Add-ConfigFullRow $accountTable2 $accountHelp 74
$btnTestPlatform.Text = "测试中介账号并连接网站"
$btnTestPlatform.AutoSize = $true
Add-ConfigFullRow $accountTable2 $btnTestPlatform 54

Add-ConfigField $wechatTable2 "群名关键词" $txtWeChatGroups
$numGroupSearchLimit = New-Object System.Windows.Forms.NumericUpDown
$numGroupSearchLimit.Minimum = 1
$numGroupSearchLimit.Maximum = 50
$numGroupSearchLimit.Value = [decimal]$Script:Config.GroupSearchLimit
Add-ConfigField $wechatTable2 "最多检查群数" $numGroupSearchLimit
$numPagesPerGroup = New-Object System.Windows.Forms.NumericUpDown
$numPagesPerGroup.Minimum = 1
$numPagesPerGroup.Maximum = 20
$numPagesPerGroup.Value = [decimal]$Script:Config.PagesPerGroup
Add-ConfigField $wechatTable2 "每群读取屏数" $numPagesPerGroup
$groupHelp = New-Object System.Windows.Forms.Label
$groupHelp.Text = "例如填写：家教。助手会搜索名称中包含这个词的群；每次向上只滚动半屏，相邻画面先拼接完整，再统一上传。"
$groupHelp.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#53666E")
$groupHelp.AutoSize = $false
$groupHelp.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
Add-ConfigFullRow $wechatTable2 $groupHelp 50
$transferOptions = New-Object System.Windows.Forms.FlowLayoutPanel
$transferOptions.FlowDirection = "TopDown"
$transferOptions.WrapContents = $false
$chkAutoSwitch.Text = "自动搜索并切换群聊"
$chkAutoScroll.Text = "自动向上翻阅历史消息"
$chkAutoUpload.Text = "识别后自动上传网站"
foreach ($check in @($chkAutoSwitch, $chkAutoScroll, $chkAutoUpload)) { $check.AutoSize = $true; $transferOptions.Controls.Add($check) }
Add-ConfigFullRow $wechatTable2 $transferOptions 104
$btnSelect.Text = "框选微信聊天正文区域"
$btnSelect.AutoSize = $true
$btnAutoRange = New-Object System.Windows.Forms.Button
$btnAutoRange.Text = "自动定位并查看截图"
$btnAutoRange.AutoSize = $true
$rangeButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$rangeButtons.FlowDirection = "LeftToRight"
$rangeButtons.WrapContents = $false
$rangeButtons.Controls.Add($btnSelect)
Add-ConfigFullRow $wechatTable2 $rangeButtons 58
$visualHelp = New-Object System.Windows.Forms.Label
$visualHelp.Text = "必须打开电脑版微信并保持窗口正常显示。工具读取屏幕聊天文字，以及图片中清晰可见的文字。"
$visualHelp.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#53666E")
$visualHelp.AutoSize = $false
$visualHelp.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
Add-ConfigFullRow $wechatTable2 $visualHelp 50

$actionBar = New-Object System.Windows.Forms.FlowLayoutPanel
$actionBar.Dock = "Fill"
$actionBar.Padding = New-Object System.Windows.Forms.Padding(20, 14, 16, 10)
$actionBar.BackColor = [System.Drawing.Color]::White
$actionBar.WrapContents = $false
$btnStart.Text = "开始自动搬运"
$btnStart.AutoSize = $true
$btnAutoRange.Margin = New-Object System.Windows.Forms.Padding(0, 0, 12, 0)
$actionBar.Controls.Add($btnAutoRange)
$btnScan.Text = "识别并上传一次"
$btnScan.AutoSize = $true
$btnViewCapture.Text = "查看上次截图"
$btnViewCapture.AutoSize = $true
$btnViewText.Text = "查看识别文字"
$btnViewText.AutoSize = $true
foreach ($button in @($btnStart, $btnScan, $btnViewCapture, $btnViewText)) {
    $button.Margin = New-Object System.Windows.Forms.Padding(0, 0, 12, 0)
    $actionBar.Controls.Add($button)
}
$transferRoot.Controls.Add($actionBar, 0, 2)

$statusArea = New-Object System.Windows.Forms.TableLayoutPanel
$statusArea.Dock = "Fill"
$statusArea.Padding = New-Object System.Windows.Forms.Padding(20, 12, 20, 18)
$statusArea.ColumnCount = 1
$statusArea.RowCount = 3
[void]$statusArea.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 44)))
[void]$statusArea.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 76)))
[void]$statusArea.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$statusTitle = New-Object System.Windows.Forms.Label
$statusTitle.Text = "搬运状态"
$statusTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 11, [System.Drawing.FontStyle]::Bold)
$statusTitle.Dock = "Fill"
$statusArea.Controls.Add($statusTitle, 0, 0)
$statusSummary = New-Object System.Windows.Forms.FlowLayoutPanel
$statusSummary.Dock = "Fill"
$statusSummary.WrapContents = $false
$statusSummary.FlowDirection = "TopDown"
$lblRect.AutoSize = $true
$lblRect.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 0)
$lblStatus.AutoSize = $true
$lblStatus.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 0)
$statusSummary.Controls.Add($lblRect)
$statusSummary.Controls.Add($lblStatus)
$statusArea.Controls.Add($statusSummary, 0, 1)
$bottomStatus = New-Object System.Windows.Forms.TableLayoutPanel
$bottomStatus.Dock = "Fill"
$bottomStatus.ColumnCount = 2
$bottomStatus.RowCount = 1
[void]$bottomStatus.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 44)))
[void]$bottomStatus.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 56)))
$lstGroupStatus = New-Object System.Windows.Forms.ListView
$lstGroupStatus.Dock = "Fill"
$lstGroupStatus.View = "Details"
$lstGroupStatus.FullRowSelect = $true
$lstGroupStatus.GridLines = $true
[void]$lstGroupStatus.Columns.Add("状态", 110)
[void]$lstGroupStatus.Columns.Add("微信群", 330)
[void]$lstGroupStatus.Columns.Add("最后读取", 180)
$bottomStatus.Controls.Add($lstGroupStatus, 0, 0)

$txtTransferLog = New-Object System.Windows.Forms.TextBox
$txtTransferLog.Dock = "Fill"
$txtTransferLog.Multiline = $true
$txtTransferLog.ReadOnly = $true
$txtTransferLog.ScrollBars = "Vertical"
$txtTransferLog.BackColor = [System.Drawing.Color]::White
$txtTransferLog.Text = "等待开始。先填写中介账号、微信群名称并框选微信聊天正文区域。"
$bottomStatus.Controls.Add($txtTransferLog, 1, 0)
$statusArea.Controls.Add($bottomStatus, 0, 2)
$transferRoot.Controls.Add($statusArea, 0, 3)
Refresh-GroupStatus

function Write-TransferLog([string]$message) {
    if (-not $txtTransferLog) { return }
    $line = "[$((Get-Date).ToString('HH:mm:ss'))] $message"
    if ($txtTransferLog.Text -eq "等待开始。先填写中介账号、微信群名称并框选微信聊天正文区域。") {
        $txtTransferLog.Text = $line
    } else {
        $txtTransferLog.AppendText("`r`n" + $line)
    }
    $txtTransferLog.SelectionStart = $txtTransferLog.TextLength
    $txtTransferLog.ScrollToCaret()
}

$form.ResumeLayout($true)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [int]$numInterval.Value * 1000

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.Text = "家教订单助手"

function Start-AutoRun {
    Save-Config
    $Script:StopRequested = $false
    $Script:AutoRunning = $true
    $Script:GroupPageIndex = 0
    $Script:LastScanText = ""
    $timer.Interval = 800
    $timer.Start()
    $btnStart.Text = "停止自动搬运"
    $lblStatus.Text = "自动搬运已启动，下一轮马上开始。"
    Write-TransferLog "自动搬运已启动。运行期间尽量不要操作微信窗口；需要暂停时直接点停止。"
}

function Stop-AutoRun {
    $Script:StopRequested = $true
    $Script:AutoRunning = $false
    $timer.Stop()
    $btnStart.Text = "正在停止..."
    $btnStart.Enabled = $false
    $lblStatus.Text = "正在停止自动搬运，请稍等本步退出。"
    Write-TransferLog "已收到停止请求，正在结束当前步骤。"
    [System.Windows.Forms.Application]::DoEvents()
    if (-not $Script:Scanning) { Finish-StopUi }
}

function Finish-StopUi {
    $timer.Stop()
    $Script:AutoRunning = $false
    $Script:StopRequested = $false
    $btnStart.Enabled = $true
    $btnStart.Text = "开始自动搬运"
    if ($lblStatus.Text -match "正在停止|已停止|自动搬运已停止") {
        $lblStatus.Text = "自动搬运已停止。"
    }
}

function Process-OcrText([string]$ocr, [string[]]$images = @(), [object[]]$pages = @()) {
    if (-not $ocr -or $ocr.Trim().Length -lt 10) {
        return [pscustomobject]@{ Added = 0; CandidateCount = 0; UploadText = ""; Created = 0; Incomplete = 0 }
    }
    $ocr | Set-Content -Path $Script:LastOcrPath -Encoding UTF8
    $added = 0
    $candidateCount = 0
    foreach ($candidate in Get-CandidateLines $ocr) {
        $candidateCount++
        $order = Get-TutorOrderFromText $candidate
        if (Add-Order $order) { $added++ }
    }

    $uploadText = ""
    $createdCount = 0
    $incompleteCount = 0
    if ($chkAutoUpload.Checked) {
        Test-StopRequested
        $uploaded = Send-ToPlatform $ocr $images $pages
        if ($uploaded) {
            $createdCount = @($uploaded.created).Count
            if ($uploaded.PSObject.Properties.Name -contains "incompleteSkipped") {
                $incompleteCount = [int]$uploaded.incompleteSkipped
            }
            $uploadText = "，网站新增 $createdCount 条，跳过重复 $([int]$uploaded.duplicatesSkipped) 条"
            if ($incompleteCount -gt 0) { $uploadText += "，暂缓半条单子 $incompleteCount 条" }
        }
    }
    return [pscustomobject]@{
        Added = $added
        CandidateCount = $candidateCount
        UploadText = $uploadText
        Created = $createdCount
        Incomplete = $incompleteCount
    }
}

function Scan-Once([bool]$deferProcessing = $false) {
    Test-StopRequested
    if ($Script:Scanning) {
        Write-TransferLog "上一轮仍在识别，本轮已跳过。"
        return
    }
    $Script:LastScanSucceeded = $false
    $Script:LastScanText = ""
    $Script:LastScanImageData = ""
    $Script:Scanning = $true
    Save-Config
    $img = $null
    try {
        if ($chkAutoSwitch.Checked) {
            Set-CaptureRectFromWeChat | Out-Null
        } else {
            Ensure-WeChatCaptureRect
        }
        Test-StopRequested
        $wechat = Activate-WeChatWindow
        Wait-Responsive 100
        $rect = [System.Drawing.Rectangle]::new([int]$Script:CaptureRect.X, [int]$Script:CaptureRect.Y, [int]$Script:CaptureRect.Width, [int]$Script:CaptureRect.Height)
        $img = Join-Path $Script:TempDir ("screen_" + (Get-Date -Format "yyyyMMdd_HHmmss_fff") + ".png")
        Capture-RectImage $rect $img
        [System.IO.File]::Copy($img, $Script:LastCapturePath, $true)
        $Script:LastScanImageData = Get-ImageDataUrl $img
        $lblStatus.Text = "正在识别屏幕文字..."
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
        Test-StopRequested
        $ocr = Invoke-Ocr $img
        if ($ocr -match "微信家教订单搬运助手|家教订单自动采集助手|搬运状态|网站中介账号") {
            throw "当前截图仍然包含搬运助手界面，没有截到微信聊天正文。请打开微信后点击 [自动定位微信读取范围]。"
        }
        $ocr | Set-Content -Path $Script:LastOcrPath -Encoding UTF8
        if (Test-LooksLikeWrongScreen $ocr) {
            $lblStatus.Text = "本次没有截到有效家教单，已跳过上传。请先确认微信打开的是群聊正文。"
            Write-TransferLog "本次截图不像家教订单，已跳过上传。可点[查看上次截图]确认截到的画面。"
            return
        }
        $Script:LastScanText = $ocr
        if ($deferProcessing) {
            $lblStatus.Text = "本屏识别完成：读到 $($ocr.Trim().Length) 个字，等待与相邻画面拼接。"
            $Script:LastScanSucceeded = $true
            return
        }
        $singlePage = [pscustomobject]@{ text = $ocr; image = $Script:LastScanImageData }
        $result = Process-OcrText $ocr ([string[]]@($Script:LastScanImageData)) ([object[]]@($singlePage))
        $lblStatus.Text = "识别完成：读到 $($ocr.Trim().Length) 个字，候选 $($result.CandidateCount) 条，本地新增 $($result.Added) 条$($result.UploadText)。上次 " + (Get-Date).ToString("HH:mm:ss")
        Write-TransferLog "识别完成：读到 $($ocr.Trim().Length) 个字$($result.UploadText)。"
        $Script:LastScanSucceeded = $true
    } catch {
        if ($_.Exception.Message -match "已停止") {
            $lblStatus.Text = "自动搬运已停止。"
            Write-TransferLog "自动搬运已停止。"
        } else {
            $lblStatus.Text = "识别失败：" + $_.Exception.Message
            Write-TransferLog ("识别失败：" + $_.Exception.Message)
        }
    } finally {
        $Script:Scanning = $false
        if ($img) { Remove-Item $img -Force -ErrorAction SilentlyContinue }
    }
}

function Scan-PageBatch([int]$pagesPerGroup, [string]$contextName) {
    $pageTexts = New-Object System.Collections.Generic.List[string]
    $pageImages = New-Object System.Collections.Generic.List[string]
    $pageRecords = New-Object System.Collections.Generic.List[object]
    for ($page = 1; $page -le $pagesPerGroup; $page++) {
        Test-StopRequested
        $Script:GroupPageIndex = $page - 1
        $lblStatus.Text = "正在读取：$contextName，第 $page / $pagesPerGroup 屏（完成后统一拼接）"
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
        Scan-Once $true
        Test-StopRequested
        if ($Script:LastScanSucceeded -and $Script:LastScanText) {
            $pageTexts.Add($Script:LastScanText)
            if ($Script:LastScanImageData) { $pageImages.Add($Script:LastScanImageData) }
            $pageRecords.Add([pscustomobject]@{ text = $Script:LastScanText; image = $Script:LastScanImageData })
        }
        if ($chkAutoScroll.Checked -and $page -lt $pagesPerGroup) {
            Scroll-WeChatMessages
            Write-TransferLog "第 $page 屏完成，已向上滚动半屏并保留重叠内容。"
            Wait-Responsive 900
        }
    }

    if ($pageTexts.Count -eq 0) {
        Write-TransferLog "$contextName 没有读到可用文字，本轮未上传。"
        return $null
    }

    $merged = Merge-OcrPages ([string[]]$pageTexts.ToArray())
    if (-not $merged -or $merged.Trim().Length -lt 10) { return $null }
    if ($pageImages.Count -gt 1) {
        $capturedRecords = @($pageRecords.ToArray())
        for ($i = $capturedRecords.Count - 1; $i -ge 1; $i--) {
            $older = $capturedRecords[$i]
            $newer = $capturedRecords[$i - 1]
            $seamImage = Join-CapturedPageSeam ([string]$older.image) ([string]$newer.image)
            if ($seamImage) {
                $pageRecords.Add([pscustomobject]@{
                    text = ([string]$older.text).Trim() + "`n`n" + ([string]$newer.text).Trim()
                    image = $seamImage
                })
            }
        }
        $joinedImage = Join-CapturedPagesChronologically ([string[]]$pageImages.ToArray())
        if ($joinedImage) {
            $pageRecords.Add([pscustomobject]@{ text = $merged; image = $joinedImage })
        }
    }
    $result = Process-OcrText $merged ([string[]]$pageImages.ToArray()) ([object[]]$pageRecords.ToArray())
    $Script:LastScanText = $merged
    $Script:LastScanSucceeded = $true
    $lblStatus.Text = "拼接完成：$contextName 共 $($pageTexts.Count) 屏，合并后 $($merged.Length) 个字，网站新增 $($result.Created) 条。"
    Write-TransferLog "已将 $contextName 的 $($pageTexts.Count) 屏重叠内容拼接后统一上传$($result.UploadText)。"
    return [pscustomobject]@{ Pages = $pageTexts.Count; TextLength = $merged.Length; Result = $result }
}

function Auto-Cycle {
    if (-not $Script:AutoRunning -or $Script:StopRequested) { Finish-StopUi; return }
    $timer.Stop()
    try {
        Test-StopRequested
        $keyword = $txtWeChatGroups.Text.Trim()
        $limit = [int]$numGroupSearchLimit.Value
        $pagesPerGroup = 1
        if ($chkAutoScroll.Checked) { $pagesPerGroup = [Math]::Max(1, [int]$numPagesPerGroup.Value) }

        if ($chkAutoSwitch.Checked -and $keyword) {
            if ($Script:GroupIndex -ge $limit) { $Script:GroupIndex = 0 }
            $resultNumber = $Script:GroupIndex + 1

            $lblStatus.Text = "正在搜索关键词 [$keyword]，将点开查看全部里的第 $resultNumber 个群"
            $form.Refresh()
            [System.Windows.Forms.Application]::DoEvents()
            Test-StopRequested
            Open-WeChatKeywordResult $keyword $Script:GroupIndex
            $fallback = "$keyword 匹配群 #$resultNumber"
            $Script:CurrentGroupName = Get-CurrentChatName $fallback
            if (-not $Script:ReadGroups.ContainsKey($Script:CurrentGroupName)) {
                Refresh-GroupStatus
                $pending = New-Object System.Windows.Forms.ListViewItem("● 未读取")
                $pending.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#C62828")
                [void]$pending.SubItems.Add($Script:CurrentGroupName)
                [void]$pending.SubItems.Add("")
                [void]$lstGroupStatus.Items.Insert(0, $pending)
            }
            Write-TransferLog "已打开：$($Script:CurrentGroupName)，准备连续读取 $pagesPerGroup 屏。"

            $batch = Scan-PageBatch $pagesPerGroup $Script:CurrentGroupName
            if ($batch -and $Script:CurrentGroupName) {
                $Script:ReadGroups[$Script:CurrentGroupName] = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + " 已拼接 $($batch.Pages) 屏"
                Save-ReadGroups
                Refresh-GroupStatus
            }

            $Script:GroupIndex = ($Script:GroupIndex + 1) % $limit
            $Script:GroupPageIndex = 0
            $Script:CurrentGroupName = ""
            $lblStatus.Text = "当前群已连续读取 $pagesPerGroup 屏，下一轮切换下一个群。"
            Write-TransferLog "当前群已连续读取 $pagesPerGroup 屏，下一轮切换下一个群。"
        } else {
            Scan-PageBatch $pagesPerGroup "当前聊天" | Out-Null
        }
    } catch {
        if ($_.Exception.Message -match "已停止") {
            $lblStatus.Text = "自动搬运已停止。"
            Write-TransferLog "自动搬运已停止。"
        } else {
            $lblStatus.Text = "自动采集失败：" + $_.Exception.Message
            Write-TransferLog ("自动搬运失败：" + $_.Exception.Message)
        }
    } finally {
        if ($Script:StopRequested -or -not $Script:AutoRunning) {
            Finish-StopUi
        } else {
            $timer.Interval = [Math]::Max(1000, [int]$numInterval.Value * 1000)
            $timer.Start()
        }
    }
}

$btnSelect.Add_Click({
    Stop-AutoRun
    Finish-StopUi
    $rect = Select-CaptureRect
    if ($rect) {
        $Script:CaptureRect = [ordered]@{ X=$rect.X; Y=$rect.Y; Width=$rect.Width; Height=$rect.Height }
        $lblRect.Text = "已选择区域：X=$($rect.X), Y=$($rect.Y), W=$($rect.Width), H=$($rect.Height)"
        Save-Config
    }
})

$btnScan.Add_Click({
    $wasEnabled = $chkAutoUpload.Checked
    $chkAutoUpload.Checked = $true
    try {
        Scan-Once
    } catch {
        $lblStatus.Text = "读取失败：" + $_.Exception.Message
        Write-TransferLog ("读取失败：" + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "读取失败") | Out-Null
    } finally { $chkAutoUpload.Checked = $wasEnabled }
})

$btnAutoRange.Add_Click({
    try {
        $rect = Capture-WeChatPreview
        Write-TransferLog "已自动定位并截取微信聊天正文范围。"
        Show-ImageWindow $Script:LastCapturePath
    } catch {
        Write-TransferLog ("自动定位失败：" + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "自动定位失败") | Out-Null
    }
})

$btnTestPlatform.Add_Click({
    try {
        Save-Config
        Connect-Platform | Out-Null
        $lblStatus.Text = "网站连接成功，自动采集账号可以上传订单。"
        Write-TransferLog "网站中介账号验证成功。"
        [System.Windows.Forms.MessageBox]::Show("连接成功。识别到的新订单会自动上传到网站。", "网站连接成功") | Out-Null
    } catch {
        $lblStatus.Text = "网站连接失败：" + $_.Exception.Message
        Write-TransferLog ("网站连接失败：" + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "网站连接失败") | Out-Null
    }
})

$btnStart.Add_Click({
    if ($Script:AutoRunning -or $timer.Enabled -or $Script:Scanning) {
        Stop-AutoRun
    } else {
        Start-AutoRun
    }
})

$btnExport.Add_Click({
    $path = Join-Path $Script:ExportDir ("家教订单_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".csv")
    $grid.DataSource | Export-Csv -Path $path -NoTypeInformation -Encoding UTF8
    [System.Windows.Forms.MessageBox]::Show("已导出：$path", "导出完成") | Out-Null
})

$btnReply.Add_Click({
    $reply = "您好，这个单我有意向。我主要带$($txtSubjects.Text)，方便发一下详细地址、学生情况、上课时间和课酬吗？"
    [System.Windows.Forms.Clipboard]::SetText($reply)
    $lblStatus.Text = "已复制接单话术。"
})

$btnViewCapture.Add_Click({ Show-ImageWindow $Script:LastCapturePath })
$btnViewText.Add_Click({ Show-TextWindow $Script:LastOcrPath })

$btnTestAmap.Add_Click({
    Save-Config
    if (-not (Get-AmapKey)) {
        [System.Windows.Forms.MessageBox]::Show("请先填写高德 Web服务 Key。没有 Key 时，工具会继续使用本地估算距离。", "需要高德Key") | Out-Null
        return
    }
    $lblStatus.Text = "正在测试高德定位..."
    $form.Refresh()
    $homeGeo = Invoke-AmapGeocode $txtHome.Text.Trim()
    if ($homeGeo) {
        [System.Windows.Forms.MessageBox]::Show("定位成功：$($homeGeo.Formatted)`n坐标：$($homeGeo.Location)", "高德测试成功") | Out-Null
        $lblStatus.Text = "高德测试成功：" + $homeGeo.Formatted
    } else {
        [System.Windows.Forms.MessageBox]::Show("没有定位成功。请检查高德 Key 是否开通 Web服务 API，并把[我的位置]写具体一点，例如：深圳市宝安区西乡地铁站。", "高德测试失败") | Out-Null
        $lblStatus.Text = "高德测试失败。"
    }
})

$cmbSubject.Add_SelectedIndexChanged({ Refresh-Grid })
$cmbDistrict.Add_SelectedIndexChanged({ Refresh-Grid })
$cmbGrade.Add_SelectedIndexChanged({ Refresh-Grid })
$chkBikeRange.Add_CheckedChanged({ Refresh-Grid })
$timer.Add_Tick({ Auto-Cycle })
$form.Add_FormClosing({
    $Script:StopRequested = $true
    $timer.Stop()
    Save-Config
    $notify.Visible = $false
    $notify.Dispose()
})

$form.Add_Shown({
    if ($env:TUTOR_WATCHER_AUTOSTART -eq "1") {
        if ($env:TUTOR_WATCHER_PASSWORD) {
            $txtAgencyPassword.Text = $env:TUTOR_WATCHER_PASSWORD
        }
        $form.BeginInvoke([Action]{ Start-AutoRun }) | Out-Null
    }
})

Refresh-Grid
[void]$form.ShowDialog()
