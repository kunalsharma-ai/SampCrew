# SampCrew signature test kit: a stand-in for the SampCrew server on this computer only (127.0.0.1).
#
# It answers the same three calls the real server answers for the Windows sync, with a signature drawn by the real
# SampCrew renderer (data\sync.json), so the setup file can be tried on a PC with Outlook before SampCrew is hosted.
# Every call is written to server-log.txt. Close this window to stop it.
param([int]$Port = 47800)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Data = Get-Content -Path (Join-Path $Here 'data\sync.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Token = (Get-Content -Path (Join-Path $Here 'data\token.txt') -Raw).Trim()
$Mode = 'auto'
$LogFile = Join-Path $Root 'server-log.txt'
$Latin1 = [Text.Encoding]::GetEncoding(28591)
$Utf8 = New-Object Text.UTF8Encoding $false

function Write-Entry($Entry) {
  $Entry.time = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Add-Content -Path $LogFile -Value ($Entry | ConvertTo-Json -Compress -Depth 5) -Encoding UTF8
}
function Send($Stream, [int]$Status, [string]$Reason, [string]$Type, [byte[]]$Body) {
  $head = "HTTP/1.1 $Status $Reason`r`nContent-Type: $Type`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
  $h = $Latin1.GetBytes($head)
  $Stream.Write($h, 0, $h.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}
function Send-Json($Stream, [int]$Status, $Object) {
  $reason = @{ 200 = 'OK'; 401 = 'Unauthorized'; 404 = 'Not Found'; 400 = 'Bad Request' }[$Status]
  Send $Stream $Status $reason 'application/json; charset=utf-8' ($Utf8.GetBytes(($Object | ConvertTo-Json -Compress -Depth 6)))
}

function Read-Request($Stream) {
  $buf = New-Object byte[] 65536
  $ms = New-Object IO.MemoryStream
  $end = -1
  while ($end -lt 0) {
    $n = $Stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { return $null }
    $ms.Write($buf, 0, $n)
    $end = $Latin1.GetString($ms.ToArray()).IndexOf("`r`n`r`n")
  }
  $all = $ms.ToArray()
  $lines = $Latin1.GetString($all, 0, $end) -split "`r`n"
  $first = $lines[0] -split ' '
  $headers = @{}
  foreach ($l in $lines[1..($lines.Length - 1)]) { $i = $l.IndexOf(':'); if ($i -gt 0) { $headers[$l.Substring(0, $i).Trim().ToLower()] = $l.Substring($i + 1).Trim() } }
  $length = 0
  if ($headers['content-length']) { $length = [int]$headers['content-length'] }
  if ($headers['expect'] -eq '100-continue' -and $length -gt 0 -and $all.Length -eq $end + 4) {
    $c = $Latin1.GetBytes("HTTP/1.1 100 Continue`r`n`r`n"); $Stream.Write($c, 0, $c.Length); $Stream.Flush()
  }
  $body = New-Object IO.MemoryStream
  $body.Write($all, $end + 4, $all.Length - $end - 4)
  while ($body.Length -lt $length) {
    $n = $Stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $body.Write($buf, 0, $n)
  }
  return @{ Method = $first[0]; Path = $first[1]; Headers = $headers; Body = $Utf8.GetString($body.ToArray()) }
}

$listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch {
  Write-Host "Port $Port is in use. Close any other SampCrew test server window and start again." -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
$Host.UI.RawUI.WindowTitle = 'SampCrew test server'
Write-Host "SampCrew test server is running on http://127.0.0.1:$Port"
Write-Host 'Leave this window open until the test is finished, then close it.'
Write-Host ''

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 15000
    $req = Read-Request $stream
    if (-not $req) { continue }
    $authorised = $req.Headers['authorization'] -eq "Bearer $Token"
    $path = $req.Path
    if (-not $authorised) {
      Write-Entry @{ call = $path; result = 401 }
      Write-Host "$($req.Method) $path -> refused (wrong token)" -ForegroundColor Yellow
      Send-Json $stream 401 @{ error = @{ code = 'unauthorized'; message = 'This computer is not connected' } }
    } elseif ($req.Method -eq 'POST' -and $path -eq '/api/v1/signature-agent/sync') {
      $in = $req.Body | ConvertFrom-Json
      if ($in.trigger -ne 'install' -and $in.currentVersion -eq $Data.version) {
        $out = @{ status = 'unchanged'; version = $Data.version; mode = $Mode }
      } else {
        $out = @{ status = 'update'; version = $Data.version; mode = $Mode; name = 'SampCrew'; html = $Data.html; text = $Data.text; images = $Data.images }
      }
      Write-Entry @{ call = 'sync'; trigger = $in.trigger; computerName = $in.computerName; outlookVersions = $in.outlookVersions; agentVersion = $in.agentVersion; answered = $out.status }
      Write-Host "sync ($($in.trigger)) from $($in.computerName), Outlook $(($in.outlookVersions) -join ', ') -> $($out.status)"
      Send-Json $stream 200 $out
    } elseif ($req.Method -eq 'POST' -and $path -eq '/api/v1/signature-agent/report') {
      $in = $req.Body | ConvertFrom-Json
      Write-Entry @{ call = 'report'; ok = $in.ok; error = $in.error; version = $in.version; outlookVersions = $in.outlookVersions }
      if ($in.ok) { Write-Host 'report: signature written' -ForegroundColor Green } else { Write-Host "report: FAILED - $($in.error)" -ForegroundColor Red }
      Send-Json $stream 200 @{ ok = $true }
    } elseif ($req.Method -eq 'GET' -and $path -match '^/api/v1/signature-agent/images/(photo|logo|banner)$') {
      $kind = $Matches[1]
      $file = Get-ChildItem -Path (Join-Path $Here 'data\images') -Filter "$kind.*" | Select-Object -First 1
      if ($file) {
        $type = @{ '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.gif' = 'image/gif' }[$file.Extension]
        Write-Entry @{ call = "image $kind"; bytes = $file.Length }
        Write-Host "image $kind ($($file.Length) bytes)"
        Send $stream 200 'OK' $type ([IO.File]::ReadAllBytes($file.FullName))
      } else {
        Send-Json $stream 404 @{ error = @{ code = 'not_found'; message = 'No such image' } }
      }
    } else {
      Write-Entry @{ call = $path; result = 404 }
      Send-Json $stream 404 @{ error = @{ code = 'not_found'; message = 'Not found' } }
    }
  } catch {
    Write-Host ('Error: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Entry @{ call = 'server error'; error = $_.Exception.Message }
  } finally {
    $client.Close()
  }
}
