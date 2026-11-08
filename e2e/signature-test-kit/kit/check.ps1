# SampCrew signature test kit: checks what the setup file did on this PC and writes everything to
# SampCrew-signature-test-result.txt for SampCrew support. It only reads, except for starting the scheduled task once.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Out = Join-Path $Root 'SampCrew-signature-test-result.txt'
$ServerLog = Join-Path $Root 'server-log.txt'
$AppDir = Join-Path $env:LOCALAPPDATA 'SampCrew\Signature'
$SigDir = Join-Path $env:APPDATA 'Microsoft\Signatures'
$TaskName = 'SampCrew signature sync'
$lines = New-Object Collections.Generic.List[string]
$results = New-Object Collections.Generic.List[string]
function Note($Text) { $lines.Add($Text) }
function Check($Name, [bool]$Pass, $Detail = '') {
  $r = $(if ($Pass) { 'PASS' } else { 'FAIL' }) + '  ' + $Name + $(if ($Detail) { ' (' + $Detail + ')' } else { '' })
  $results.Add($r)
  Write-Host $r -ForegroundColor $(if ($Pass) { 'Green' } else { 'Red' })
}
function Starts-With([byte[]]$Bytes, [byte[]]$Prefix) {
  if ($Bytes.Length -lt $Prefix.Length) { return $false }
  for ($i = 0; $i -lt $Prefix.Length; $i++) { if ($Bytes[$i] -ne $Prefix[$i]) { return $false } }
  return $true
}
function Server-Calls { if (Test-Path $ServerLog) { @(Get-Content $ServerLog -Encoding UTF8 | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } }) } else { @() } }

Write-Host 'Checking the SampCrew signature on this PC...'
Write-Host ''

# The computer
$os = Get-WmiObject Win32_OperatingSystem -ErrorAction SilentlyContinue
Note ('Windows: ' + $(if ($os) { "$($os.Caption) $($os.Version)" } else { [Environment]::OSVersion.VersionString }))
Note ('PowerShell: ' + $PSVersionTable.PSVersion)
Note ('Language mode: ' + $ExecutionContext.SessionState.LanguageMode)
$outlookExe = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE' -ErrorAction SilentlyContinue).'(default)'
Note ('Outlook program: ' + $(if ($outlookExe -and (Test-Path $outlookExe)) { "$outlookExe, version $((Get-Item $outlookExe).VersionInfo.ProductVersion)" } else { 'not found in App Paths' }))
$newOutlook = (Get-ItemProperty 'HKCU:\Software\Microsoft\Office\16.0\Outlook\Preferences' -ErrorAction SilentlyContinue).UseNewOutlook
Note ('New Outlook switched on: ' + $(if ($newOutlook -eq 1) { 'yes (it keeps signatures in the cloud and ignores this file)' } else { 'no' }))
$versions = @('14.0', '15.0', '16.0' | Where-Object { Test-Path "HKCU:\Software\Microsoft\Office\$_\Outlook" })
Note ('Outlook settings found for: ' + $(if ($versions.Count) { $versions -join ', ' } else { 'none' }))
Check 'Outlook (classic) is set up for this Windows user' ($versions.Count -gt 0) ($versions -join ', ')
Note ''

# The files Outlook reads
$htm = Join-Path $SigDir 'SampCrew.htm'
$txt = Join-Path $SigDir 'SampCrew.txt'
$files = Join-Path $SigDir 'SampCrew_files'
$hasHtm = Test-Path $htm
Check 'Signature file SampCrew.htm is in the Signatures folder' $hasHtm $SigDir
if ($hasHtm) {
  $b = [IO.File]::ReadAllBytes($htm)
  Check 'SampCrew.htm is UTF-8 with a byte order mark' (Starts-With $b ([byte[]](0xEF, 0xBB, 0xBF))) "$($b.Length) bytes"
  $html = [Text.Encoding]::UTF8.GetString($b)
  $refs = @([regex]::Matches($html, 'src="(SampCrew_files/[^"]+)"') | ForEach-Object { $_.Groups[1].Value })
  $missing = @($refs | Where-Object { -not (Test-Path (Join-Path $SigDir ($_ -replace '/', '\'))) })
  Check 'Every image the signature uses is next to it' ($missing.Count -eq 0) $(if ($missing.Count) { 'missing ' + ($missing -join ', ') } else { "$($refs.Count) images" })
}
if (Test-Path $txt) {
  $t = [IO.File]::ReadAllBytes($txt)
  Check 'SampCrew.txt (plain text version) is UTF-16' (Starts-With $t ([byte[]](0xFF, 0xFE))) "$($t.Length) bytes"
} else { Check 'SampCrew.txt (plain text version) is in the Signatures folder' $false }
if (Test-Path $files) { Note ('Images: ' + ((Get-ChildItem $files | ForEach-Object { "$($_.Name) ($($_.Length) bytes)" }) -join ', ')) }
Note ''

# Outlook's default signature
foreach ($v in $versions) {
  $mail = Get-ItemProperty "HKCU:\Software\Microsoft\Office\$v\Common\MailSettings" -ErrorAction SilentlyContinue
  Check "Outlook $v default for new messages is SampCrew" ($mail.NewSignature -eq 'SampCrew') ([string]$mail.NewSignature)
  Check "Outlook $v default for replies is SampCrew" ($mail.ReplySignature -eq 'SampCrew') ([string]$mail.ReplySignature)
  $profiles = $(if ($v -eq '14.0') { 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows Messaging Subsystem\Profiles' } else { "HKCU:\Software\Microsoft\Office\$v\Outlook\Profiles" })
  if (Test-Path $profiles) {
    Get-ChildItem $profiles | ForEach-Object {
      $profName = $_.PSChildName
      $acc = Join-Path $_.PSPath '9375CFF0413111d3B88A00104B2A6676'
      if (Test-Path $acc) {
        Get-ChildItem $acc | ForEach-Object {
          $name = $_.GetValue('Account Name')
          if ($name -is [byte[]]) { $name = [Text.Encoding]::Unicode.GetString($name).TrimEnd([char]0) }
          if ($name) {
            $ns = $_.GetValue('New Signature'); $rs = $_.GetValue('Reply-Forward Signature')
            $show = { param($x) if ($x -is [byte[]]) { 'binary "' + [Text.Encoding]::Unicode.GetString($x).TrimEnd([char]0) + '"' } elseif ($x) { 'text "' + $x + '"' } else { 'not set' } }
            Note ("Outlook $v profile '$profName', account '$name': new = " + (& $show $ns) + ', reply = ' + (& $show $rs) + ', kind of Account Name = ' + $(if ($_.GetValue('Account Name') -is [byte[]]) { 'binary' } else { 'text' }))
          }
        }
      }
    }
  } else { Note "Outlook $v has no mail profile yet (open Outlook once and add an account)." }
}
Note ''

# The sync on this PC
Check 'The sync is installed in %LOCALAPPDATA%\SampCrew\Signature' (Test-Path (Join-Path $AppDir 'sync.ps1'))
Check 'The hidden launcher is there' (Test-Path (Join-Path $AppDir 'run-hidden.vbs'))
Check 'The "Sync SampCrew signature" shortcut is on the desktop' (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sync SampCrew signature.lnk'))
$state = $null
if (Test-Path (Join-Path $AppDir 'state.json')) { $state = Get-Content (Join-Path $AppDir 'state.json') -Raw | ConvertFrom-Json }
Check 'The sync remembered the version it installed' ($state -and $state.version) ([string]$state.version)

$taskXml = (& schtasks.exe /Query /TN $TaskName /XML 2>&1 | Out-String)
$hasTask = $LASTEXITCODE -eq 0
Check 'The scheduled task "SampCrew signature sync" exists' $hasTask
if ($hasTask) {
  Check 'The task also runs on battery' ($taskXml -match '<DisallowStartIfOnBatteries>false')
  Check 'The task catches up after the PC was off or asleep' ($taskXml -match '<StartWhenAvailable>true')
  Check 'The task repeats every 30 minutes' ($taskXml -match '<Interval>PT30M')
  Check 'The task starts with no window (wscript launcher)' ($taskXml -match '<Command>wscript.exe')
  $before = (Server-Calls | Where-Object { $_.call -eq 'sync' -and $_.trigger -eq 'scheduled' }).Count
  Write-Host 'Starting the scheduled task once and waiting up to 45 seconds for it to call the test server...'
  & schtasks.exe /Run /TN $TaskName 2>&1 | Out-Null
  $ran = $false
  for ($i = 0; $i -lt 45 -and -not $ran; $i++) {
    Start-Sleep -Seconds 1
    $ran = (Server-Calls | Where-Object { $_.call -eq 'sync' -and $_.trigger -eq 'scheduled' }).Count -gt $before
  }
  Check 'The scheduled task ran the sync in the background' $ran $(if (-not $ran) { 'is the test server window still open?' } else { '' })
}
Note ''

# What the test server saw
$calls = Server-Calls
$install = @($calls | Where-Object { $_.call -eq 'sync' -and $_.trigger -eq 'install' })
$reports = @($calls | Where-Object { $_.call -eq 'report' })
Check 'The setup file reached the test server' ($install.Count -gt 0)
Check 'The setup file reported success' (@($reports | Where-Object { $_.ok }).Count -gt 0) $(($reports | Where-Object { -not $_.ok } | ForEach-Object { $_.error }) -join '; ')
Note 'Test server log:'
if (Test-Path $ServerLog) { Get-Content $ServerLog -Encoding UTF8 | ForEach-Object { Note ('  ' + $_) } }
Note ''
Note 'Sync log on this PC:'
if (Test-Path (Join-Path $AppDir 'sync.log')) { Get-Content (Join-Path $AppDir 'sync.log') -Tail 40 | ForEach-Object { Note ('  ' + $_) } }

$failed = @($results | Where-Object { $_.StartsWith('FAIL') }).Count
$header = @(
  'SampCrew Outlook signature test',
  ('Checked ' + (Get-Date).ToString('yyyy-MM-dd HH:mm') + ' on ' + $env:COMPUTERNAME),
  $(if ($failed) { "$failed check(s) FAILED" } else { 'All checks passed' }),
  '',
  'In Outlook (fill in): signature shows on a new email? yes / no    on a reply? yes / no    logo and photo show? yes / no',
  ''
)
($header + $results + '' + $lines) | Set-Content -Path $Out -Encoding UTF8
Write-Host ''
if ($failed) { Write-Host "$failed check(s) failed." -ForegroundColor Red } else { Write-Host 'All checks passed.' -ForegroundColor Green }
Write-Host "The full result is in $Out"
