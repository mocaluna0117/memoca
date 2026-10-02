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

# Every Memoca and WebView2 process there is: started with, from, when.
function Show-Running($why) {
  Write-Host "-- running, $($why):"
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -in "memoca.exe", "msedgewebview2.exe" } |
    ForEach-Object { Write-Host "$($_.ProcessId) (from $($_.ParentProcessId), $($_.CreationDate)) $($_.CommandLine)" }
}

# Stops the app and its WebView2's processes. One of these still there for
# the app's data folder is shared by the next start, and that start's
# WebView2 then fails for being asked with other arguments.
function Stop-All {
  for ($i = 0; $i -lt 15; $i++) {
    $left = @(Get-Process -Name "Memoca", "msedgewebview2" -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) { return }
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
  Show-Running "still, once stopped"
}

# Starts it hidden, as at login, and waits for its WebView2's debugging
# port; if it does not open, says what was running and what the app said.
function Start-Debuggable($how) {
  Write-Host "Starting it with its WebView2's debugging port, $how"
  $said = Join-Path ([IO.Path]::GetTempPath()) "memoca-said.txt"
  $app = Start-Process -FilePath $exe.FullName -ArgumentList "--hidden" -PassThru `
    -RedirectStandardOutput "$said.out" -RedirectStandardError "$said.err"
  for ($i = 0; $i -lt 45; $i++) {
    try {
      Invoke-RestMethod "http://127.0.0.1:9222/json/version" -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  Show-Running "the port not open"
  if ($app.HasExited) { Write-Host "-- the app ended, with $($app.ExitCode)" } else { Write-Host "-- the app is running ($($app.Id))" }
  Get-Content "$said.out", "$said.err" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "app: $_" }
  return $false
}

Stop-All

if (-not $NoWindow) {
  # Its window driven through its WebView2's debugging port, opened by
  # either of WebView2's ways of being given more arguments: an environment
  # variable, or (if that is not taken) a policy in the registry.
  Write-Host "Checking the window"
  Show-Running "before it is started"
  $policy = "HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
  try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
    $open = Start-Debuggable "from WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
    Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    if (-not $open) {
      Stop-All
      New-Item -Path $policy -Force | Out-Null
      New-ItemProperty -Path $policy -Name "memoca.exe" -Value "--remote-debugging-port=9222" -Force | Out-Null
      $open = Start-Debuggable "from the AdditionalBrowserArguments policy"
    }
    Check $open "its WebView2 opens the debugging port it is started with"
    node e2e/window.mjs 9222
    if ($LASTEXITCODE -ne 0) { throw "the window's checks failed" }
  } finally {
    Remove-Item -Path $policy -Recurse -ErrorAction SilentlyContinue
    Stop-All
  }
}

$uninstall = Join-Path $folder "uninstall.exe"
Check (Test-Path $uninstall) "it has its uninstaller"
Start-Process -FilePath $uninstall -ArgumentList "/S" -Wait
# The uninstaller goes on from a copy of itself: given time to finish.
for ($i = 0; $i -lt 30 -and (Test-Path $exe.FullName); $i++) { Start-Sleep -Seconds 1 }
Check (-not (Test-Path $exe.FullName)) "uninstalled, the app is gone"
Write-Host "All checked."
