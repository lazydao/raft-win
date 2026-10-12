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
if ((Run-Node "multiwindow") -eq 0) { Pass "multiwindow scenario" } else { Fail "multiwindow scenario" }
$multi = Get-Content (Join-Path $env:TEMP "pontoon-e2e-multiwindow.json") -Raw | ConvertFrom-Json
if ($multi) {
  if ([Pontoon.Win32]::FindWindow([NullString]::Value, "E2E second window | Raft") -ne [System.IntPtr]::Zero) { Pass "second server window is a native top-level window" } else { Fail "no window titled 'E2E second window | Raft'" }
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
  Write-Host "== Restore font settings"
  Stop-Pontoon
  if ($hadSettings) { Copy-Item $settingsBackup $settingsFile -Force; Remove-Item $settingsBackup -Force }
  elseif (Test-Path $settingsFile) { Remove-Item $settingsFile -Force }
  if ($hadSettings) { Write-Host "settings.json restored" } else { Write-Host "settings.json removed (there was none before)" }
}

Write-Host ""
if ($failures -eq 0) { Write-Host "ALL E2E CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host "$failures E2E CHECK(S) FAILED" -ForegroundColor Red
exit 1
