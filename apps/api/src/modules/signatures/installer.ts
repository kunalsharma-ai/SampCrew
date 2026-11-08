/**
 * The Windows installer for the SampCrew signature sync: one .cmd file the person double-clicks.
 *
 * The first lines are a batch script that hands the rest of the file to Windows PowerShell (5.1 ships with every
 * supported Windows; 3.0 on Windows 7 also works). The PowerShell part installs itself under
 * %LOCALAPPDATA%\SampCrew\Signature, then on every run it asks SampCrew for the signature, writes it to
 * %APPDATA%\Microsoft\Signatures (an .htm, a .txt and the images) and makes it Outlook's default for new messages and
 * replies, for Outlook 2010 (14.0), 2013 (15.0) and 2016 or later (16.0).
 *
 * Automatic mode: a scheduled task runs it every 30 minutes, on battery too, and catches up as soon as it can after the
 * computer was off or asleep. It starts through a small hidden launcher (run-hidden.vbs) so no window flashes. Manual
 * mode: only the "Sync SampCrew signature" shortcut on the desktop runs it. The mode comes from SampCrew on every run,
 * so a change made there reaches the computer at its next sync.
 *
 * `-Trigger uninstall` removes everything it set up on this computer (task, shortcut, signature files, Outlook
 * defaults that still name the SampCrew signature) without contacting SampCrew.
 */

export const SIGNATURE_NAME = 'SampCrew';
export const AGENT_VERSION = '1.1.0';

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
$LauncherPath = Join-Path $AppDir 'run-hidden.vbs'
$TaskXmlPath = Join-Path $AppDir 'task.xml'
$StateFile = Join-Path $AppDir 'state.json'
$LogFile = Join-Path $AppDir 'sync.log'
$TaskName = 'SampCrew signature sync'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sync SampCrew signature.lnk'
$Headers = @{ Authorization = "Bearer $Token" }
$SigDir = Join-Path $env:APPDATA 'Microsoft\Signatures'

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
# Windows PowerShell turns a native program's error output into a terminating error while $ErrorActionPreference is
# 'Stop' and the output is redirected, so schtasks.exe is always run through here.
function Invoke-Schtasks {
  $ErrorActionPreference = 'Continue'
  $out = (& schtasks.exe @args 2>&1 | Out-String).Trim()
  return @{ Code = $LASTEXITCODE; Output = $out }
}
function Test-Task { return (Invoke-Schtasks /Query /TN $TaskName).Code -eq 0 }
function Write-Launcher {
  # Starts the sync with no window at all; powershell.exe -WindowStyle Hidden alone still flashes a console.
  $crlf = [string][char]13 + [char]10
  $vbs = 'Set sh = CreateObject("WScript.Shell")' + $crlf +
    'sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $ScriptPath + '"" -Trigger " & WScript.Arguments(0), 0, False' + $crlf
  [IO.File]::WriteAllText($LauncherPath, $vbs, [Text.Encoding]::Unicode)
}
function Register-Task {
  # A task definition (not schtasks /SC) so that it also runs on battery, catches up after sleep and never overlaps.
  $esc = { param($v) [Security.SecurityElement]::Escape([string]$v) }
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Keeps your Outlook signature up to date from SampCrew.</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition><Interval>PT30M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>$((Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss'))</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>$(& $esc ('"' + $LauncherPath + '" scheduled'))</Arguments></Exec></Actions>
</Task>
"@
  [IO.File]::WriteAllText($TaskXmlPath, $xml, [Text.Encoding]::Unicode)
  $r = Invoke-Schtasks /Create /F /TN $TaskName /XML $TaskXmlPath
  if ($r.Code -ne 0) { throw ('Windows did not create the scheduled task: ' + $r.Output) }
}
function Set-Schedule($Mode) {
  if ($Mode -eq 'auto') {
    # Re-register when set up or synced by hand (picks up a new launcher or settings); a scheduled run leaves it alone.
    if ($Trigger -ne 'scheduled' -or -not (Test-Task)) { Register-Task }
  } elseif (Test-Task) {
    Invoke-Schtasks /Delete /F /TN $TaskName | Out-Null
  }
}
function Set-Shortcut {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($ShortcutPath)
  $lnk.TargetPath = 'wscript.exe'
  $lnk.Arguments = '"' + $LauncherPath + '" manual'
  $lnk.IconLocation = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') + ',0'
  $lnk.Description = 'Update your Outlook signature from SampCrew now'
  $lnk.Save()
}
function Remove-Setup {
  if (Test-Task) { Invoke-Schtasks /Delete /F /TN $TaskName | Out-Null }
  if (Test-Path $ShortcutPath) { Remove-Item $ShortcutPath -Force }
  if (Test-Path $StateFile) { Remove-Item $StateFile -Force }
}
function Remove-Signature {
  foreach ($f in ($SigName + '.htm'), ($SigName + '.txt'), ($SigName + '.rtf'), ($SigName + '_files')) {
    $p = Join-Path $SigDir $f
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
  }
  foreach ($v in '14.0', '15.0', '16.0') {
    $mail = "HKCU:\Software\Microsoft\Office\$v\Common\MailSettings"
    if (Test-Path $mail) {
      $item = Get-Item $mail
      foreach ($n in 'NewSignature', 'ReplySignature') { if ($item.GetValue($n) -eq $SigName) { Remove-ItemProperty -Path $mail -Name $n } }
    }
  }
  # Per-account values: clear them only where they still name the SampCrew signature.
  $bytes = [Text.Encoding]::Unicode.GetBytes($SigName + [char]0)
  $roots = @('HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows Messaging Subsystem\Profiles', 'HKCU:\Software\Microsoft\Office\15.0\Outlook\Profiles', 'HKCU:\Software\Microsoft\Office\16.0\Outlook\Profiles')
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem -Path $root | ForEach-Object {
      $accounts = Join-Path $_.PSPath '9375CFF0413111d3B88A00104B2A6676'
      if (Test-Path $accounts) {
        Get-ChildItem -Path $accounts | ForEach-Object {
          foreach ($n in 'New Signature', 'Reply-Forward Signature') {
            $val = $_.GetValue($n)
            if ($val -is [byte[]] -and [Convert]::ToBase64String($val) -eq [Convert]::ToBase64String($bytes)) { Remove-ItemProperty -Path $_.PSPath -Name $n }
          }
        }
      }
    }
  }
}

if ($Trigger -eq 'uninstall') {
  Remove-Setup
  Remove-Signature
  Write-Log 'SampCrew signature removed from this computer.'
  Show-Message 'The SampCrew signature and its automatic updates are removed from this computer.'
  exit 0
}

if ($Trigger -eq 'install') {
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  # Keep a copy of this script (with this computer's token) where only this Windows user can read it.
  [IO.File]::WriteAllText($ScriptPath, $env:SAMPCREW_SCRIPT, (New-Object Text.UTF8Encoding $true))
  Write-Launcher
  Set-Shortcut
}
if (-not (Test-Path $LauncherPath)) { Write-Launcher }

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
    $dir = $SigDir
    $files = Join-Path $dir ($SigName + '_files')
    New-Item -ItemType Directory -Force -Path $files | Out-Null
    # Images from an earlier version (an old banner, say) would otherwise pile up here.
    $keep = @($r.images | ForEach-Object { $_.name })
    Get-ChildItem -Path $files -File | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Force
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

try {
  Set-Schedule $r.mode
} catch {
  Write-Log ('Could not set up automatic updates: ' + $_.Exception.Message)
  Show-Message ('Your signature is in Outlook, but automatic updates could not be switched on: ' + $_.Exception.Message + [Environment]::NewLine + 'Use Sync SampCrew signature on the desktop to update it.') 48
}
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
    // The path goes through a variable so that a folder name with an apostrophe cannot break the PowerShell line.
    'set "SAMPCREW_SETUP=%~f0"',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:SAMPCREW_SETUP); $i=$s.IndexOf('#'+'#PS-BEGIN'); $env:SAMPCREW_SCRIPT=$s.Substring($i); Invoke-Expression ('& {' + $env:SAMPCREW_SCRIPT + '} -Trigger install')"`,
    'exit /b %errorlevel%',
  ].join('\r\n');
  return `${cmd}\r\n${ps.replace(/\r?\n/g, '\r\n')}`;
}
