$Url = if ($env:THREEBOT_URL) { $env:THREEBOT_URL } else { "http://127.0.0.1:3780/" }
$edge = (Get-Command msedge.exe -ErrorAction SilentlyContinue)?.Source
if (-not $edge) {
  $edge = (Get-ChildItem "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe","C:\Program Files\Microsoft\Edge\Application\msedge.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if ($edge) {
  Start-Process $edge -ArgumentList "--app=$Url"
} else {
  Start-Process $Url
}