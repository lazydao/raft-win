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
function Start-Pontoon($extraEnv) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo $exe
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
  & node (Join-Path $PSScriptRoot "e2e.mjs") $scenario | Out-Host
  return $LASTEXITCODE
}

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
Add-Type -Namespace Pontoon -Name Win32 -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr FindWindow(string cls, string title);'
if ([Pontoon.Win32]::FindWindow([NullString]::Value, "E2E check | Raft") -ne [System.IntPtr]::Zero) { Pass "native window title follows window.setServerTitle" } else { Fail "no top-level window titled 'E2E check | Raft'" }

Write-Host "== Single instance"
$before = @(Get-Process pontoon).Count
Start-Process -FilePath $exe | Out-Null
Start-Sleep -Seconds 4
$after = @(Get-Process pontoon).Count
if ($after -eq $before) { Pass "second launch hands off to the running instance" } else { Fail "process count went from $before to $after" }

Write-Host "== Close to tray"
$main = Get-Process pontoon | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($main) { $main.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 2
if (Get-Process -Id $app.Id -ErrorAction SilentlyContinue) { Pass "closing the window keeps the app running" } else { Fail "app exited when the window was closed" }
Stop-Pontoon

Write-Host "== Relaunch keeps the sign-in"
$app = Start-Pontoon @{}
if (Wait-Cdp) {
  if ((Run-Node "relaunch") -eq 0) { Pass "relaunch scenario" } else { Fail "relaunch scenario" }
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

Write-Host ""
if ($failures -eq 0) { Write-Host "ALL E2E CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host "$failures E2E CHECK(S) FAILED" -ForegroundColor Red
exit 1
