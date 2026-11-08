# SampCrew signature test kit: saves this Windows user's Outlook signature settings before the test, so that
# 3-Remove-Test.cmd can put them back exactly. Only reads the registry; writes .reg files into the kit's backup folder.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Backup = Join-Path $Root 'backup'
if (Test-Path (Join-Path $Backup 'done.txt')) { Write-Host 'Your earlier Outlook settings are already saved from the first run.'; exit 0 }
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
$keys = @(
  'HKCU\Software\Microsoft\Office\14.0\Common\MailSettings', 'HKCU\Software\Microsoft\Office\15.0\Common\MailSettings', 'HKCU\Software\Microsoft\Office\16.0\Common\MailSettings',
  'HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows Messaging Subsystem\Profiles', 'HKCU\Software\Microsoft\Office\15.0\Outlook\Profiles', 'HKCU\Software\Microsoft\Office\16.0\Outlook\Profiles'
)
$i = 0
foreach ($k in $keys) {
  $i++
  if (Test-Path ('Registry::' + $k)) {
    & reg.exe export $k (Join-Path $Backup ("key-$i.reg")) /y 2>&1 | Out-Null
  }
}
$sig = Join-Path $env:APPDATA 'Microsoft\Signatures'
if (Test-Path (Join-Path $sig 'SampCrew.htm')) { 'A SampCrew signature was already on this computer before the test.' | Set-Content (Join-Path $Backup 'note.txt') }
(Get-Date).ToString('yyyy-MM-dd HH:mm:ss') | Set-Content (Join-Path $Backup 'done.txt')
Write-Host 'Saved your current Outlook signature settings.'
