# Installs 7763 Match Logs for the current Windows user: copies the app to %LOCALAPPDATA% and adds
# Desktop + Start menu shortcuts that open it in its own window (Edge or Chrome "app" mode). No admin needed.
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'FRC7763MatchLogs'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force (Join-Path $src 'FRC7763-Match-Logs.html'), (Join-Path $src 'icon.ico') $dest

$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { throw 'Microsoft Edge or Google Chrome is required. Install either one and run this again.' }

$uri = ([System.Uri](Join-Path $dest 'FRC7763-Match-Logs.html')).AbsoluteUri
$dataDir = Join-Path $dest 'browser-data'   # keeps the app's saved robot setup separate from normal browsing
$appArgs = "--app=`"$uri`" --user-data-dir=`"$dataDir`" --window-size=1440,900 --no-first-run --no-default-browser-check"

# Match view: opens straight into the full-window live view, sized to fill the screen above the FRC
# Driver Station (which docks along the bottom). Change $dsHeight if the DS strip is taller on this laptop.
$dsHeight = 230
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$mvHeight = [Math]::Max(400, $wa.Height - $dsHeight)
$mvArgs = "--app=`"$uri#matchview`" --user-data-dir=`"$dataDir`" --window-position=$($wa.X),$($wa.Y) --window-size=$($wa.Width),$mvHeight --no-first-run --no-default-browser-check"

$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir '7763 Match Logs.lnk'))
  $lnk.TargetPath = $browser
  $lnk.Arguments = $appArgs
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = (Join-Path $dest 'icon.ico')
  $lnk.Description = 'FRC 7763 match logs and live robot view'
  $lnk.Save()
  $lnk = $shell.CreateShortcut((Join-Path $dir '7763 Match View.lnk'))
  $lnk.TargetPath = $browser
  $lnk.Arguments = $mvArgs
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = (Join-Path $dest 'icon.ico')
  $lnk.Description = 'FRC 7763 live match view, sized to sit above the Driver Station'
  $lnk.Save()
}
Write-Host "Installed to $dest"
Write-Host 'Shortcuts: Desktop and Start menu ("7763 Match Logs" and "7763 Match View").'
Start-Process -FilePath $browser -ArgumentList $appArgs
