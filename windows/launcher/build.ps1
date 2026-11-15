# Builds Threebot.exe: the launcher with Threebot's icon baked in as a Windows resource.
# Needs Go (pure Go, no Visual Studio) and the repo's PNG icon.
#
#   powershell -ExecutionPolicy Bypass -File windows\launcher\build.ps1 -Out E:\tmp\Threebot.exe
param(
  [string]$Out = "$PSScriptRoot\Threebot.exe",
  [string]$IconPng = "$PSScriptRoot\..\..\web\public\icon-512.png"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$ico = Join-Path $PSScriptRoot "threebot.ico"
if (-not (Test-Path $ico) -or (Get-Item $IconPng).LastWriteTime -gt (Get-Item $ico).LastWriteTime) {
  Write-Host "icon: $IconPng -> $ico"
  go run ./cmd/mkico -in $IconPng -out $ico
}

$rsrc = Join-Path $env:USERPROFILE "go\bin\rsrc.exe"
if (-not (Test-Path $rsrc)) {
  Write-Host "installing rsrc (icon resource compiler)"
  go install github.com/akavel/rsrc@latest
}

& $rsrc -ico $ico -arch amd64 -o rsrc_windows_amd64.syso
try {
  $env:CGO_ENABLED = "0"
  go build -trimpath -ldflags "-s -w -H windowsgui" -o $Out .
  Write-Host "built $Out ($((Get-Item $Out).Length / 1KB -as [int]) KB)"
} finally {
  Remove-Item rsrc_windows_amd64.syso -ErrorAction SilentlyContinue
}
