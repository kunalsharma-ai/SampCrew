/**
 * The Windows installer for the SampCrew signature sync: one .cmd file the person double-clicks.
 *
 * The first lines are a batch script that hands the rest of the file to Windows PowerShell (5.1 ships with every
 * supported Windows; 3.0 on Windows 7 also works). The PowerShell part installs itself under
 * %LOCALAPPDATA%\SampCrew\Signature, then on every run it asks SampCrew for the signature, writes it to
 * %APPDATA%\Microsoft\Signatures (an .htm, a .txt and the images) and makes it Outlook's default for new messages and
 * replies, for Outlook 2010 (14.0), 2013 (15.0) and 2016 or later (16.0).
 *
 * Automatic mode: a scheduled task runs it every 30 minutes and at sign-in. Manual mode: only the "Sync SampCrew
 * signature" shortcut on the desktop runs it. The mode comes from SampCrew on every run, so a change made there
 * reaches the computer at its next sync.
 */

export const SIGNATURE_NAME = 'SampCrew';
export const AGENT_VERSION = '1.0.0';

const PS = String.raw`##PS-BEGIN SampCrew signature sync
param([string]$Trigger = 'install')
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
$AgentVersion = '__AGENT_VERSION__'
$Api = '__API__'
$Token = '__TOKEN__'
$SigName = '__SIGNAME__'
$AppDir = Join-Path $env:LOCALAPPDATA 'SampCrew\Signature'
$ScriptPath = Join-Path $AppDir 'sync.ps1'
$StateFile = Join-Path $AppDir 'state.json'
$LogFile = Join-Path $AppDir 'sync.log'
$TaskName = 'SampCrew signature sync'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sync SampCrew signature.lnk'
$Headers = @{ Authorization = "Bearer $Token" }

function Write-Log($Message) {
  try { Add-Content -Path $LogFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Message) } catch { }
}
function Show-Message($Text, $Icon = 64) {
  if ($Trigger -ne 'scheduled') { try { (New-Object -ComObject WScript.Shell).Popup($Text, 0, 'SampCrew signature', $Icon) | Out-Null } catch { Write-Host $Text } }
}
function Invoke-Crew($Path, $Body) {
  $json = $Body | ConvertTo-Json -Depth 5 -Compress
  Invoke-RestMethod -Method Post -Uri ($Api + '/api/v1' + $Path) -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}
function Get-OutlookVersions {
  $found = @()
  foreach ($v in '14.0', '15.0', '16.0') { if (Test-Path "HKCU:\Software\Microsoft\Office\$v\Outlook") { $found += $v } }
  return ,$found
}
function Set-DefaultSignature($Versions) {
  # The name as Outlook stores it per account: UTF-16 text ending in a null character.
  $bytes = [Text.Encoding]::Unicode.GetBytes($SigName + [char]0)
  foreach ($v in $Versions) {
    $mail = "HKCU:\Software\Microsoft\Office\$v\Common\MailSettings"
    if (-not (Test-Path $mail)) { New-Item -Path $mail -Force | Out-Null }
    New-ItemProperty -Path $mail -Name 'NewSignature' -Value $SigName -PropertyType ExpandString -Force | Out-Null
    New-ItemProperty -Path $mail -Name 'ReplySignature' -Value $SigName -PropertyType ExpandString -Force | Out-Null
    $profiles = if ($v -eq '14.0') { 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows Messaging Subsystem\Profiles' } else { "HKCU:\Software\Microsoft\Office\$v\Outlook\Profiles" }
    if (Test-Path $profiles) {
      Get-ChildItem -Path $profiles | ForEach-Object {
        $accounts = Join-Path $_.PSPath '9375CFF0413111d3B88A00104B2A6676'
        if (Test-Path $accounts) {
          Get-ChildItem -Path $accounts | Where-Object { $_.GetValue('Account Name') -ne $null -and $_.GetValue('Account Name') -ne 'Outlook Address Book' } | ForEach-Object {
            New-ItemProperty -Path $_.PSPath -Name 'New Signature' -Value $bytes -PropertyType Binary -Force | Out-Null
            New-ItemProperty -Path $_.PSPath -Name 'Reply-Forward Signature' -Value $bytes -PropertyType Binary -Force | Out-Null
          }
        }
      }
    }
  }
}
function Set-Schedule($Mode) {
  $command = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -Trigger scheduled'
  if ($Mode -eq 'auto') {
    schtasks.exe /Create /F /SC MINUTE /MO 30 /TN $TaskName /TR $command | Out-Null
  } else {
    schtasks.exe /Query /TN $TaskName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { schtasks.exe /Delete /F /TN $TaskName | Out-Null }
  }
}
function Set-Shortcut {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($ShortcutPath)
  $lnk.TargetPath = 'powershell.exe'
  $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '" -Trigger manual'
  $lnk.Description = 'Update your Outlook signature from SampCrew now'
  $lnk.Save()
}
function Remove-Setup {
  Set-Schedule 'manual'
  if (Test-Path $ShortcutPath) { Remove-Item $ShortcutPath -Force }
  if (Test-Path $StateFile) { Remove-Item $StateFile -Force }
}

if ($Trigger -eq 'install') {
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  # Keep a copy of this script (with this computer's token) where only this Windows user can read it.
  [IO.File]::WriteAllText($ScriptPath, $env:SAMPCREW_SCRIPT, (New-Object Text.UTF8Encoding $true))
  Set-Shortcut
}

$state = $null
if (Test-Path $StateFile) { try { $state = Get-Content -Path $StateFile -Raw | ConvertFrom-Json } catch { $state = $null } }
$current = if ($state) { [string]$state.version } else { '' }
$versions = Get-OutlookVersions

try {
  $r = Invoke-Crew '/signature-agent/sync' @{ currentVersion = $current; trigger = $Trigger; computerName = $env:COMPUTERNAME; outlookVersions = $versions; agentVersion = $AgentVersion }
} catch {
  $code = 0
  try { $code = [int]$_.Exception.Response.StatusCode } catch { }
  if ($code -eq 401) {
    Write-Log 'SampCrew no longer recognises this computer; automatic updates are switched off.'
    Remove-Setup
    Show-Message 'This computer is no longer connected to SampCrew. Download the setup again from SampCrew, Email signature, to reconnect it.' 48
    exit 1
  }
  Write-Log ('Could not reach SampCrew: ' + $_.Exception.Message)
  Show-Message ('Could not reach SampCrew. Check the internet connection and try again.' + [Environment]::NewLine + $_.Exception.Message) 48
  exit 1
}

if ($r.status -eq 'update') {
  try {
    $dir = Join-Path $env:APPDATA 'Microsoft\Signatures'
    $files = Join-Path $dir ($SigName + '_files')
    New-Item -ItemType Directory -Force -Path $files | Out-Null
    foreach ($img in $r.images) {
      Invoke-WebRequest -Uri ($Api + '/api/v1' + $img.path) -Headers $Headers -OutFile (Join-Path $files $img.name) -UseBasicParsing
    }
    # Outlook reads the .htm as UTF-8 (with a byte order mark) and the .txt as UTF-16.
    [IO.File]::WriteAllText((Join-Path $dir ($SigName + '.htm')), $r.html, (New-Object Text.UTF8Encoding $true))
    [IO.File]::WriteAllText((Join-Path $dir ($SigName + '.txt')), $r.text, [Text.Encoding]::Unicode)
    Set-DefaultSignature $versions
    Invoke-Crew '/signature-agent/report' @{ version = $r.version; ok = $true; outlookVersions = $versions } | Out-Null
    $state = @{ version = $r.version; mode = $r.mode }
    Write-Log ('Signature updated (' + $r.version.Substring(0, 8) + ').')
    if ($versions.Count -eq 0) {
      Show-Message 'Your signature is saved, but Outlook was not found for this Windows user. Open Outlook once, then click Sync SampCrew signature on the desktop.' 48
    } else {
      Show-Message 'Your SampCrew signature is now in Outlook. If Outlook is open, start a new message to see it; restart Outlook if it does not show.'
    }
  } catch {
    $message = $_.Exception.Message
    Write-Log ('Could not write the signature: ' + $message)
    try { Invoke-Crew '/signature-agent/report' @{ version = $r.version; ok = $false; error = $message.Substring(0, [Math]::Min(480, $message.Length)) } | Out-Null } catch { }
    Show-Message ('The signature could not be written: ' + $message) 16
    exit 1
  }
} else {
  $state = @{ version = $current; mode = $r.mode }
  Show-Message 'Your Outlook signature is already up to date.'
}

Set-Schedule $r.mode
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
($state | ConvertTo-Json -Compress) | Set-Content -Path $StateFile -Encoding UTF8
exit 0
`;

/** The single .cmd file for one computer. Windows needs CRLF line ends in batch files. */
export function buildInstaller(opts: { apiUrl: string; token: string }): string {
  if (!/^https?:\/\/[^'"\s]+$/.test(opts.apiUrl)) throw new Error('Bad API address for the installer');
  if (!/^[A-Za-z0-9_-]+$/.test(opts.token)) throw new Error('Bad token for the installer');
  const ps = PS.replace('__AGENT_VERSION__', AGENT_VERSION).replace('__API__', opts.apiUrl.replace(/\/$/, '')).replace('__TOKEN__', opts.token).replace('__SIGNAME__', SIGNATURE_NAME);
  const cmd = [
    '@echo off',
    'rem SampCrew: installs your email signature in Outlook on this computer and keeps it up to date.',
    'rem Double-click to run. Nothing needs administrator rights.',
    'echo Setting up your SampCrew signature for Outlook...',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText('%~f0'); $i=$s.IndexOf('#'+'#PS-BEGIN'); $env:SAMPCREW_SCRIPT=$s.Substring($i); Invoke-Expression ('& {' + $env:SAMPCREW_SCRIPT + '} -Trigger install')"`,
    'exit /b %errorlevel%',
  ].join('\r\n');
  return `${cmd}\r\n${ps.replace(/\r?\n/g, '\r\n')}`;
}
