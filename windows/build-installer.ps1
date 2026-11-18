# Builds the one-click Windows installer: Threebot-Setup-<version>.exe
# Requires Inno Setup 6 (ISCC.exe).
param(
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist\windows"),
  [string]$Version = "",
  [switch]$SkipBundle
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $Version = (Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json).version
}

# 1. Build bundle first if not skipped
if (-not $SkipBundle) {
  Write-Host "Building Windows bundle for version $Version..."
  & (Join-Path $PSScriptRoot "build-bundle.ps1") -OutDir $OutDir
}

$bundleDir = Join-Path $OutDir "Threebot-$Version-win64"
if (-not (Test-Path $bundleDir)) {
  throw "Bundle directory does not exist: $bundleDir"
}

# 2. Locate ISCC.exe
$iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $candidates = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    "C:\ProgramData\chocolatey\bin\iscc.exe",
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $iscc = $c; break }
  }
}

if (-not $iscc) {
  if (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Host "Inno Setup not found. Installing via Chocolatey..."
    choco install innosetup -y --no-progress
    $iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
  } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Inno Setup not found. Installing via winget..."
    winget install --id JR.InnoSetup -e --accept-source-agreements --accept-package-agreements --silent
    $iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
  }
}

if (-not $iscc -or -not (Test-Path $iscc)) {
  throw "Inno Setup compiler (ISCC.exe) not found. Please install Inno Setup 6 (https://jrsoftware.org/isdl.php) or run 'choco install innosetup'."
}

Write-Host "Compiling installer using $iscc..."
$issPath = Join-Path $PSScriptRoot "installer.iss"
& $iscc "/DMyAppVersion=$Version" "/DMySourceDir=$bundleDir" "/O$OutDir" $issPath
if ($LASTEXITCODE -ne 0) {
  throw "ISCC compilation failed with exit code $LASTEXITCODE"
}

$setupExe = Join-Path $OutDir "Threebot-Setup-$Version.exe"
if (-not (Test-Path $setupExe)) {
  throw "Installer not found at $setupExe"
}

$hash = (Get-FileHash $setupExe -Algorithm SHA256).Hash.ToLower()
$sizeMB = [math]::Round((Get-Item $setupExe).Length / 1MB, 1)
Write-Host "Built installer: $setupExe ($sizeMB MB)"
Write-Host "SHA-256: $hash"
