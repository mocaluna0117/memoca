# Installs the Windows app from its installer, as a person would but with no
# one there (CI, .github/workflows/desktop.yml), and checks it: installed for
# this user, memoca:// links handed to it, started (hidden) and still
# running, one only however often it is started or a link opened, and gone
# again once uninstalled; and, unless -NoWindow, that its window loads
# Memoca's site as the Windows shell (e2e/window.mjs).
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [switch]$NoWindow
)
$ErrorActionPreference = "Stop"

function Check($ok, $what) {
  if (-not $ok) { throw "not so: $what" }
  Write-Host "ok: $what"
}
function Running { @(Get-Process -Name "Memoca" -ErrorAction SilentlyContinue) }

Write-Host "Installing $Installer"
Start-Process -FilePath $Installer -ArgumentList "/S" -Wait
$exe = Get-ChildItem -Path $env:LOCALAPPDATA -Filter "Memoca.exe" -Recurse -Depth 3 -ErrorAction SilentlyContinue |
  Select-Object -First 1
Check ($null -ne $exe) "installed for this user, in AppData\Local ($($exe.FullName))"
$folder = $exe.DirectoryName

$link = Get-Item -Path "Registry::HKEY_CURRENT_USER\Software\Classes\memoca" -ErrorAction SilentlyContinue
Check ($null -ne $link) "memoca:// links are the app's (HKCU\Software\Classes\memoca)"

Start-Process -FilePath $exe.FullName -ArgumentList "--hidden"
Start-Sleep -Seconds 10
Check ((Running).Count -eq 1) "started hidden, and still running after 10 s"

Start-Process -FilePath $exe.FullName
Start-Sleep -Seconds 5
Check ((Running).Count -eq 1) "started again: the one running takes it, no second one"

Start-Process "memoca://auth?code=not-a-code&state=not-a-state"
Start-Sleep -Seconds 5
Check ((Running).Count -eq 1) "a memoca:// link goes to the one running"

Stop-Process -Name "Memoca" -Force
# And its WebView2's processes, which would otherwise be used again by the
# next start, without the debugging port it is started with below.
Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 15 -and @(Get-Process -Name "msedgewebview2", "Memoca" -ErrorAction SilentlyContinue).Count -gt 0; $i++) {
  Start-Sleep -Seconds 1
}

if (-not $NoWindow) {
  # Started as at login, hidden, its WebView2 with a debugging port the
  # window's checks drive it through.
  Write-Host "Checking the window, through its WebView2's debugging port"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
  Start-Process -FilePath $exe.FullName -ArgumentList "--hidden"
  Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  $open = $false
  for ($i = 0; $i -lt 60 -and -not $open; $i++) {
    try {
      Invoke-RestMethod "http://127.0.0.1:9222/json/version" -TimeoutSec 2 | Out-Null
      $open = $true
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  try {
    if (-not $open) {
      # What was started, and with what, for whoever reads the log.
      Get-CimInstance Win32_Process -Filter "Name = 'Memoca.exe' OR Name = 'msedgewebview2.exe'" |
        ForEach-Object { Write-Host "$($_.ProcessId) $($_.CommandLine)" }
    }
    Check $open "its WebView2 opens the debugging port it is started with"
    node e2e/window.mjs 9222
    if ($LASTEXITCODE -ne 0) { throw "the window's checks failed" }
  } finally {
    Stop-Process -Name "Memoca" -Force -ErrorAction SilentlyContinue
    Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue | Stop-Process -Force
  }
}

$uninstall = Join-Path $folder "uninstall.exe"
Check (Test-Path $uninstall) "it has its uninstaller"
Start-Process -FilePath $uninstall -ArgumentList "/S" -Wait
# The uninstaller goes on from a copy of itself: given time to finish.
for ($i = 0; $i -lt 30 -and (Test-Path $exe.FullName); $i++) { Start-Sleep -Seconds 1 }
Check (-not (Test-Path $exe.FullName)) "uninstalled, the app is gone"
Write-Host "All checked."
