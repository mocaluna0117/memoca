# Installs the Windows app from its installer, as a person would but with no
# one there (CI, .github/workflows/desktop.yml), and checks it: installed for
# this user, memoca:// links handed to it, started (hidden) and still
# running, one only however often it is started or a link opened, and gone
# again once uninstalled. Then checks its window (e2e/window.mjs) unless
# -NoWindow.
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
Start-Sleep -Seconds 2

if (-not $NoWindow) {
  Write-Host "Checking the window through tauri-driver"
  $driver = Start-Process -FilePath "tauri-driver" -ArgumentList "--native-driver", (Resolve-Path "msedgedriver.exe") -PassThru
  Start-Sleep -Seconds 3
  try {
    node e2e/window.mjs $exe.FullName
    if ($LASTEXITCODE -ne 0) { throw "the window's checks failed" }
  } finally {
    Stop-Process -Id $driver.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Name "Memoca" -Force -ErrorAction SilentlyContinue
  }
}

$uninstall = Join-Path $folder "uninstall.exe"
Check (Test-Path $uninstall) "it has its uninstaller"
Start-Process -FilePath $uninstall -ArgumentList "/S" -Wait
# The uninstaller goes on from a copy of itself: given time to finish.
for ($i = 0; $i -lt 30 -and (Test-Path $exe.FullName); $i++) { Start-Sleep -Seconds 1 }
Check (-not (Test-Path $exe.FullName)) "uninstalled, the app is gone"
Write-Host "All checked."
