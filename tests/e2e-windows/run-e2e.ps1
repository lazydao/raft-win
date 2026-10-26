# End-to-end test of the Pontoon installer on a real Windows machine.
# Installs silently, launches the app with WebView2 remote debugging enabled,
# drives the real WebView2 through Playwright (CDP), then uninstalls.
#
#   powershell -ExecutionPolicy Bypass -File tests\e2e-windows\run-e2e.ps1 -Installer path\to\setup.exe [-KeepInstalled]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [switch]$KeepInstalled
)
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$installDir = Join-Path $env:LOCALAPPDATA "Pontoon"
$exe = Join-Path $installDir "pontoon.exe"
$failures = 0

function Pass($m) { Write-Host "PASS  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "FAIL  $m" -ForegroundColor Red; $script:failures++ }
function Stop-Pontoon { Get-Process pontoon -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 1 }
function Start-Pontoon($extraEnv, $arguments = "") {
  $psi = New-Object System.Diagnostics.ProcessStartInfo $exe
  $psi.Arguments = $arguments
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=9222"
  foreach ($k in $extraEnv.Keys) { $psi.EnvironmentVariables[$k] = $extraEnv[$k] }
  return [System.Diagnostics.Process]::Start($psi)
}
function Wait-Cdp {
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-RestMethod "http://127.0.0.1:9222/json/version" -TimeoutSec 2 | Out-Null; return $true } catch { Start-Sleep -Seconds 1 }
  }
  return $false
}
function Run-Node($scenario) {
  # Print node's output instead of returning it, so the function returns only the exit code.
  # Include node's stderr; under "Stop", Windows PowerShell would turn its lines into terminating errors.
  $ErrorActionPreference = "Continue"
  & node (Join-Path $PSScriptRoot "e2e.mjs") $scenario 2>&1 | ForEach-Object { "$_" } | Out-Host
  return $LASTEXITCODE
}

# The font scenarios change the font settings; keep an exact copy of the
# user's settings.json and put it back at the end, whatever happens.
$settingsFile = Join-Path $env:APPDATA "build.pontoon.desktop\settings.json"
$settingsBackup = Join-Path $env:TEMP "pontoon-e2e-settings-backup.json"
$hadSettings = Test-Path $settingsFile
if ($hadSettings) { Copy-Item $settingsFile $settingsBackup -Force }
# Same for the list of open server windows. Start without it, so only the
# main window opens and the test's own second window is the only other one.
$windowsFile = Join-Path $env:APPDATA "build.pontoon.desktop\windows.json"
$windowsBackup = Join-Path $env:TEMP "pontoon-e2e-windows-backup.json"
$hadWindows = Test-Path $windowsFile
if ($hadWindows) { Copy-Item $windowsFile $windowsBackup -Force; Remove-Item $windowsFile -Force }
function Show-PontoonProcesses {
  Get-CimInstance Win32_Process -Filter "Name='pontoon.exe'" | ForEach-Object {
    Write-Host ("      pid {0} parent {1} session {2}: {3}" -f $_.ProcessId, $_.ParentProcessId, $_.SessionId, $_.CommandLine)
  }
}

try {
Write-Host "== Install"
Stop-Pontoon
$p = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
if ($p.ExitCode -eq 0 -and (Test-Path $exe)) { Pass "silent install to $installDir" } else { Fail "installer exit $($p.ExitCode), exe present: $(Test-Path $exe)"; exit 1 }
$lnk = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter "Pontoon*.lnk" -ErrorAction SilentlyContinue
if ($lnk) { Pass "Start menu shortcut" } else { Fail "Start menu shortcut missing" }
# The tray menu shows the version tauri.conf.json sets; the installed exe carries the same one.
$expectedVersion = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
$installedVersion = (Get-Item $exe).VersionInfo.ProductVersion
if ($installedVersion -eq $expectedVersion) { Pass "installed version is $installedVersion" } else { Fail "installed version is '$installedVersion', expected $expectedVersion" }
# The installer may start the app; begin from a clean state.
Stop-Pontoon

Write-Host "== Online scenario"
$app = Start-Pontoon @{}
if (Wait-Cdp) { Pass "app started, WebView2 debugging endpoint up" } else { Fail "no WebView2 debugging endpoint"; Stop-Pontoon; exit 1 }
if ((Run-Node "online") -eq 0) { Pass "online scenario" } else { Fail "online scenario" }

# Look the window up by its exact title: the process also owns a hidden
# single-instance window, so MainWindowTitle can name the wrong one.
Add-Type -Namespace Pontoon -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hwnd, uint msg, System.IntPtr w, System.IntPtr l);
'@
if ([Pontoon.Win32]::FindWindow([NullString]::Value, "E2E check | Raft") -ne [System.IntPtr]::Zero) { Pass "native window title follows window.setServerTitle" } else { Fail "no top-level window titled 'E2E check | Raft'" }
# Server windows have no Windows title bar: the page fills the whole window
# (tao keeps WS_CAPTION for snapping and animations, and draws no frame), and
# the window can still be resized from its edges (WS_THICKFRAME).
Add-Type -Namespace Pontoon -Name Frame -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hwnd, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr hwnd, out RECT r);
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hwnd, int index);
[DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr hwnd);
'@
function Test-Frameless($title) {
  $hwnd = [Pontoon.Win32]::FindWindow([NullString]::Value, $title)
  if ($hwnd -eq [System.IntPtr]::Zero) { Fail "no window titled '$title' to check the frame of"; return }
  $w = New-Object Pontoon.Frame+RECT; $c = New-Object Pontoon.Frame+RECT
  [Pontoon.Frame]::GetWindowRect($hwnd, [ref]$w) | Out-Null
  [Pontoon.Frame]::GetClientRect($hwnd, [ref]$c) | Out-Null
  $extra = ($w.Bottom - $w.Top) - ($c.Bottom - $c.Top)
  $zoomed = [Pontoon.Frame]::IsZoomed($hwnd)
  if ($zoomed -or $extra -le 2) { Pass "'$title' has no Windows title bar (window is $extra px taller than the page, maximized: $zoomed)" }
  else { Fail "'$title' has a title bar: the window is $extra px taller than the page" }
  $style = [Pontoon.Frame]::GetWindowLong($hwnd, -16)
  if (($style -band 0x00040000) -ne 0) { Pass "'$title' can be resized from its edges" } else { Fail ("'$title' is not resizable (style 0x{0:X8})" -f $style) }
}
Test-Frameless "E2E check | Raft"

Write-Host "== Notifications"
# notifications.log records what happened to each message (never its text).
$notifyLog = Join-Path $env:LOCALAPPDATA "build.pontoon.desktop\logs\notifications.log"
function Notify-LogLines { if (Test-Path $notifyLog) { @(Get-Content $notifyLog) } else { @() } }
$deadline = (Get-Date).AddSeconds(30)
while (-not ((Notify-LogLines) -match "push-socket connected") -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
if ((Notify-LogLines) -match "push-socket connected") { Pass "the main window's push socket connected to Raft" } else { Fail "no 'push-socket connected' in $notifyLog" }
$aumidKey = "HKCU:\Software\Classes\AppUserModelId\build.pontoon.desktop"
if ((Get-ItemProperty $aumidKey -ErrorAction SilentlyContinue).DisplayName -eq "Pontoon") { Pass "notification identity registered" } else { Fail "$aumidKey missing or without DisplayName" }
Add-Type -Namespace Pontoon -Name Show -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hwnd, int cmd);'
$e2eWindow = [Pontoon.Win32]::FindWindow([NullString]::Value, "E2E check | Raft")
[Pontoon.Show]::ShowWindow($e2eWindow, 6) | Out-Null  # minimize
Start-Sleep -Seconds 1
$linesBefore = (Notify-LogLines).Count
if ((Run-Node "notify") -eq 0) { Pass "notify scenario" } else { Fail "notify scenario" }
Start-Sleep -Seconds 2
$newLines = @(Notify-LogLines | Select-Object -Skip $linesBefore)
$newLines | ForEach-Object { Write-Host "      log: $_" }
$notifySettings = Join-Path $env:APPDATA "build.pontoon.desktop\notifications.json"
$allMessages = (Test-Path $notifySettings) -and ((Get-Content $notifySettings -Raw) -match '"all_messages"\s*:\s*true')
if ($newLines -match "push skipped NotImportant") { Pass "a plain channel message gets no notification or badge (only DMs and @mentions count)" }
elseif ($allMessages) { Write-Host "SKIP  this user chose to be told about all new messages" -ForegroundColor Yellow }
else { Fail "a plain channel message was not skipped" }
# Whether Windows displays toasts is the user's own setting (Settings > System >
# Notifications). When it is off, Pontoon still hands the toast over and shows
# the taskbar badge; only the display checks are skipped.
$toastsOff = [bool]($newLines -match "push shown windows-setting=Disabled")
if ($newLines -match "push shown windows-setting=Enabled") { Pass "Windows showed the toast (notifications enabled for Pontoon)" }
elseif ($toastsOff) { Write-Host "SKIP  toast handed to Windows, but this user has notifications turned off: $(@($newLines -match 'push shown')[0])" -ForegroundColor Yellow }
else { Fail "no toast shown" }
# A picture of the taskbar with the badge, for a person to look at.
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  # Without this, a scaled display reports logical pixels and the capture misses the taskbar.
  Add-Type -Namespace Pontoon -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [Pontoon.Dpi]::SetProcessDPIAware() | Out-Null
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  $full = $screen.Bounds; $work = $screen.WorkingArea
  # The strip below the working area is the taskbar (bottom-docked); keep a little above it.
  $top = [Math]::Max($full.Top, $work.Bottom - 40)
  $height = $full.Bottom - $top
  if ($height -lt 40) { $top = $full.Bottom - 200; $height = 200 }
  $bmp = New-Object System.Drawing.Bitmap $full.Width, $height
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($full.Left, $top, 0, 0, $bmp.Size)
  $shot = Join-Path $env:TEMP "pontoon-e2e-badge.png"
  $bmp.Save($shot); $bmp.Dispose()
  Write-Host "      screenshot of the taskbar with the badge: $shot ($($full.Width)x$height)"
} catch { Write-Host "      (no screenshot: $($_.Exception.Message))" }
if ($newLines -match "^\d+ badge 1$") { Pass "the minimized window got an unread badge on its taskbar button" } else { Fail "no 'badge 1' in the log" }
if (@($newLines -match "push skipped Duplicate").Count -eq 1) { Pass "a repeated message is not shown twice" } else { Fail "expected one 'push skipped Duplicate'" }
if ($toastsOff) { Write-Host "SKIP  notification center check (notifications off)" -ForegroundColor Yellow } else { try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $history = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory("build.pontoon.desktop")
  if ($history.Count -gt 0) { Pass "toast is in the notification center ($($history.Count) from Pontoon)" } else { Fail "notification center has no Pontoon toast" }
} catch { Write-Host "      (could not read the notification center: $($_.Exception.Message))" } }
[Pontoon.Show]::ShowWindow($e2eWindow, 9) | Out-Null  # restore
Run-Node "focus" | Out-Null
Start-Sleep -Seconds 2
if ((Notify-LogLines | Select-Object -Skip $linesBefore) -match "^\d+ badge 0$") { Pass "restoring the window clears its badge" } else { Fail "badge not cleared after the window was restored" }

# A second launch passes its arguments to the running app and exits. It
# waits for the running app to take them, for at most 10 s, so a slow or
# stuck running app shows up as a slow exit.
function Test-Handoff([string]$name, [string[]]$arguments = @()) {
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $p = if ($arguments) { Start-Process -FilePath $exe -ArgumentList $arguments -PassThru } else { Start-Process -FilePath $exe -PassThru }
  if ($p.WaitForExit(5000)) { Pass "$name (second launch exited after $($timer.ElapsedMilliseconds) ms)" }
  else { Fail "$name (second launch still running after 5 s)"; Show-PontoonProcesses; $p.WaitForExit(10000) | Out-Null; Write-Host "  second launch exited: $($p.HasExited) after $($timer.ElapsedMilliseconds) ms" }
}

Write-Host "== Font settings"
# A second launch with --font-settings opens the settings window in the running app.
Test-Handoff "--font-settings hands off to the running instance" "--font-settings"
if ((Run-Node "font") -eq 0) { Pass "font settings scenario" } else { Fail "font settings scenario" }

Write-Host "== Single instance"
Test-Handoff "second launch hands off to the running instance"

Write-Host "== Server windows"
# The scenario writes this file first thing; if it dies before that, the window checks are skipped.
$multiFile = Join-Path $env:TEMP "pontoon-e2e-multiwindow.json"
Remove-Item $multiFile -Force -ErrorAction SilentlyContinue
if ((Run-Node "multiwindow") -eq 0) { Pass "multiwindow scenario" } else { Fail "multiwindow scenario" }
$multi = if (Test-Path $multiFile) { Get-Content $multiFile -Raw | ConvertFrom-Json } else { $null }
if ($multi) {
  if ([Pontoon.Win32]::FindWindow([NullString]::Value, "E2E second window | Raft") -ne [System.IntPtr]::Zero) { Pass "second server window is a native top-level window" } else { Fail "no window titled 'E2E second window | Raft'" }
  Test-Frameless "E2E second window | Raft"
}

Write-Host "== Close to tray"
# Close the font settings window first, so the main window is the one closed below.
$settingsWindow = [Pontoon.Win32]::FindWindow([NullString]::Value, "字体设置 · Pontoon")
if ($settingsWindow -ne [System.IntPtr]::Zero) { [Pontoon.Win32]::PostMessage($settingsWindow, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null; Start-Sleep -Seconds 1 }
# Find the main window by title: with a second server window open, the
# process's MainWindowHandle can be either of them.
$mainWindow = [Pontoon.Win32]::FindWindow([NullString]::Value, "E2E check | Raft")
if ($mainWindow -ne [System.IntPtr]::Zero) { [Pontoon.Win32]::PostMessage($mainWindow, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null } else { Fail "main window not found by title" }
Start-Sleep -Seconds 2
if (Get-Process -Id $app.Id -ErrorAction SilentlyContinue) { Pass "closing the window keeps the app running" } else { Fail "app exited when the window was closed" }
# Quitting (here: ending the process) keeps the list of open server windows.
Stop-Pontoon

Write-Host "== Relaunch keeps the sign-in and the font"
$app = Start-Pontoon @{} "--font-settings"
if (Wait-Cdp) {
  if ((Run-Node "relaunch") -eq 0) { Pass "relaunch scenario" } else { Fail "relaunch scenario" }
  if ((Run-Node "restore") -eq 0) { Pass "server windows reopen after a restart" } else { Fail "restore scenario" }
  if ($multi) {
    # Closing a second server window closes it for real and forgets it.
    $second = [Pontoon.Win32]::FindWindow([NullString]::Value, "E2E second window | Raft")
    if ($second -ne [System.IntPtr]::Zero) { [Pontoon.Win32]::PostMessage($second, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null } else { Fail "second window not found after restart" }
    Start-Sleep -Seconds 2
    if ([Pontoon.Win32]::FindWindow([NullString]::Value, "E2E second window | Raft") -eq [System.IntPtr]::Zero) { Pass "second window closes" } else { Fail "second window still open after close" }
    if (Get-Process pontoon -ErrorAction SilentlyContinue) { Pass "closing a second window keeps the app running" } else { Fail "app exited when a second window was closed" }
    $saved = Get-Content (Join-Path $env:APPDATA "build.pontoon.desktop\windows.json") -Raw -ErrorAction SilentlyContinue
    if ($saved -and -not $saved.Contains($multi.id)) { Pass "a closed window is not reopened at start" } else { Fail "windows.json still lists the closed window: $saved" }
  }
} else { Fail "no WebView2 debugging endpoint (relaunch)" }
Stop-Pontoon

Write-Host "== Offline recovery"
# Only the startup reachability probe honours HTTPS_PROXY, so this forces the recovery page.
$app = Start-Pontoon @{ "HTTPS_PROXY" = "http://127.0.0.1:9"; "ALL_PROXY" = "http://127.0.0.1:9" }
if (Wait-Cdp) {
  if ((Run-Node "offline") -eq 0) { Pass "offline recovery page and quit" } else { Fail "offline scenario" }
} else { Fail "no WebView2 debugging endpoint (offline run)" }
Start-Sleep -Seconds 2
if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) { Pass "recovery quit exits the app" } else { Fail "app still running after recovery quit"; Stop-Pontoon }

if (-not $KeepInstalled) {
  Write-Host "== Uninstall"
  Stop-Pontoon
  $un = Join-Path $installDir "uninstall.exe"
  $p = Start-Process -FilePath $un -ArgumentList "/S" -Wait -PassThru
  Start-Sleep -Seconds 3
  if (-not (Test-Path $exe)) { Pass "silent uninstall" } else { Fail "pontoon.exe still present after uninstall" }
}

} finally {
  Write-Host "== Restore font settings and window list"
  Stop-Pontoon
  if ($hadSettings) { Copy-Item $settingsBackup $settingsFile -Force; Remove-Item $settingsBackup -Force }
  elseif (Test-Path $settingsFile) { Remove-Item $settingsFile -Force }
  if ($hadSettings) { Write-Host "settings.json restored" } else { Write-Host "settings.json removed (there was none before)" }
  if ($hadWindows) { Copy-Item $windowsBackup $windowsFile -Force; Remove-Item $windowsBackup -Force }
  elseif (Test-Path $windowsFile) { Remove-Item $windowsFile -Force }
  if ($hadWindows) { Write-Host "windows.json restored" } else { Write-Host "windows.json removed (there was none before)" }
}

Write-Host ""
if ($failures -eq 0) { Write-Host "ALL E2E CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host "$failures E2E CHECK(S) FAILED" -ForegroundColor Red
exit 1
