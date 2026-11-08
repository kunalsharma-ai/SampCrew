# SampCrew signature test kit: removes the test signature with the setup file's own uninstall, then puts back the
# Outlook signature settings saved by backup.ps1.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Backup = Join-Path $Root 'backup'
$AppDir = Join-Path $env:LOCALAPPDATA 'SampCrew\Signature'
$Sync = Join-Path $AppDir 'sync.ps1'
if (Test-Path $Sync) {
  Write-Host 'Running the SampCrew uninstall...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Sync -Trigger uninstall
  Write-Host ("Uninstall finished with code $LASTEXITCODE.")
} else {
  Write-Host 'The SampCrew sync is not installed for this Windows user.'
}
$left = @()
& schtasks.exe /Query /TN 'SampCrew signature sync' 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { $left += 'the scheduled task' }
if (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sync SampCrew signature.lnk')) { $left += 'the desktop shortcut' }
if (Test-Path (Join-Path $env:APPDATA 'Microsoft\Signatures\SampCrew.htm')) { $left += 'the signature file' }
if ($left.Count -gt 0) { Write-Host ('NOT REMOVED by the uninstall: ' + ($left -join ', ') + '. Please tell SampCrew support.') -ForegroundColor Red }
else { Write-Host 'The uninstall removed the task, the shortcut and the signature.' -ForegroundColor Green }
Add-Content -Path (Join-Path $Root 'SampCrew-signature-test-result.txt') -Value ('Uninstall check: ' + $(if ($left.Count -gt 0) { 'FAIL, left ' + ($left -join ', ') } else { 'PASS' })) -Encoding UTF8

if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
$restored = 0
Get-ChildItem -Path $Backup -Filter 'key-*.reg' -ErrorAction SilentlyContinue | ForEach-Object {
  & reg.exe import $_.FullName 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $restored++ }
}
if ($restored -gt 0) { Write-Host "Put back your earlier Outlook signature settings ($restored saved keys)." }
if (Test-Path $Backup) { Remove-Item $Backup -Recurse -Force }
Write-Host 'Done. Restart Outlook to see your usual signature again.'
