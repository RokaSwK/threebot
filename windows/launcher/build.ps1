# Builds Threebot.exe: the launcher with Threebot's icon and version info baked into the binary.
# Needs Go (pure Go, no Visual Studio) and the repo's PNG icon. The version comes from package.json,
# so Explorer never shows a stale one.
#
#   powershell -ExecutionPolicy Bypass -File windows\launcher\build.ps1 -Out E:\tmp\Threebot.exe
param(
  [string]$Out = "$PSScriptRoot\Threebot.exe",
  [string]$IconPng = "$PSScriptRoot\..\..\web\public\icon-512.png"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$goBin = Join-Path $env:USERPROFILE "go\bin"
$version = (Get-Content (Join-Path $PSScriptRoot "..\..\package.json") -Raw | ConvertFrom-Json).version
$parts = @($version.Split('.') + @('0', '0', '0'))[0..3] | ForEach-Object { [int]$_ }

$ico = Join-Path $PSScriptRoot "threebot.ico"
if (-not (Test-Path $ico) -or (Get-Item $IconPng).LastWriteTime -gt (Get-Item $ico).LastWriteTime) {
  Write-Host "icon: $IconPng -> $ico"
  go run ./cmd/mkico -in $IconPng -out $ico
  if ($LASTEXITCODE -ne 0) { throw "mkico failed with exit code $LASTEXITCODE" }
}

$vi = Join-Path $goBin "goversioninfo.exe"
if (-not (Test-Path $vi)) {
  Write-Host "installing goversioninfo (icon + version resource compiler)"
  go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
  if ($LASTEXITCODE -ne 0) { throw "go install goversioninfo failed with exit code $LASTEXITCODE" }
}

# Only one .syso may be linked: Go merges every .rsrc section into one, so emitting an icon
# resource with rsrc and a version resource with goversioninfo fails with "too many .rsrc
# sections". goversioninfo writes both into a single resource section.
$syso = "rsrc_windows_amd64.syso"
try {
  & $vi -o $syso -icon $ico `
    -ver-major $parts[0] -ver-minor $parts[1] -ver-patch $parts[2] -ver-build $parts[3] `
    -product-ver-major $parts[0] -product-ver-minor $parts[1] -product-ver-patch $parts[2] -product-ver-build $parts[3] `
    -file-version $version -product-version $version versioninfo.json
  if ($LASTEXITCODE -ne 0) { throw "goversioninfo failed with exit code $LASTEXITCODE" }

  $env:CGO_ENABLED = "0"
  go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$version" -o $Out .
  if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
  Write-Host "built $Out ($((Get-Item $Out).Length / 1KB -as [int]) KB, version $version)"
} finally {
  Remove-Item (Join-Path $PSScriptRoot $syso) -ErrorAction SilentlyContinue
}
