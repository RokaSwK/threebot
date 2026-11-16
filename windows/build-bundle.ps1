# Builds the portable Windows bundle: Threebot.exe + app/ + runtime/node.exe.
#
#   powershell -ExecutionPolicy Bypass -File windows\build-bundle.ps1
#
# Output: dist\windows\Threebot-<version>-win64\ and Threebot-<version>-win64.zip
param(
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist\windows"),
  [string]$NodeExe = "",
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json).version
$name = "Threebot-$version-win64"
$bundle = Join-Path $OutDir $name

if (-not (Test-Path (Join-Path $repo "web\dist\index.html"))) {
  throw "web\dist is missing. Build the web app first: npm ci --prefix web; npm run build --prefix web"
}

if (-not $NodeExe) {
  $NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $NodeExe) { throw "node.exe not found on PATH; pass -NodeExe <path>" }
}

Write-Host "bundle: $bundle"
if (Test-Path $bundle) { Remove-Item -Recurse -Force $bundle }
New-Item -ItemType Directory -Force -Path (Join-Path $bundle "app"), (Join-Path $bundle "runtime") | Out-Null

# The app: the gateway with its dependencies, and the built web app.
$copy = @{
  "server"        = "app\server"
  "web\dist"      = "app\web\dist"
  "assets"        = "app\assets"
}
foreach ($from in $copy.Keys) {
  $to = Join-Path $bundle $copy[$from]
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  robocopy (Join-Path $repo $from) $to /E /NFL /NDL /NJH /NJS /NP /XD node_modules /XF *.test.mts *.test.mjs | Out-Null
  # robocopy uses 1-7 for success; 8 and above are real failures. PowerShell 5.1 does not turn
  # native exit codes into errors, so check explicitly or a broken bundle looks successful.
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $from with exit code $LASTEXITCODE" }
}
robocopy (Join-Path $repo "server\node_modules") (Join-Path $bundle "app\server\node_modules") /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed for server\\node_modules with exit code $LASTEXITCODE" }

foreach ($file in @("package.json", "README.md", "LICENSE", "NOTICE", "PRIVACY.md", ".env.example")) {
  $source = Join-Path $repo $file
  if (Test-Path $source) { Copy-Item $source (Join-Path $bundle "app\$file") -Force }
}
Set-Content -Path (Join-Path $bundle "app\VERSION") -Value $version -NoNewline

# The runtime and the launcher.
Copy-Item $NodeExe (Join-Path $bundle "runtime\node.exe") -Force
& (Join-Path $PSScriptRoot "launcher\build.ps1") -Out (Join-Path $bundle "Threebot.exe") -IconPng (Join-Path $repo "web\public\icon-512.png")
if (-not (Test-Path (Join-Path $bundle "Threebot.exe"))) { throw "launcher build did not produce Threebot.exe" }
Copy-Item (Join-Path $PSScriptRoot "launcher\threebot.ico") (Join-Path $bundle "threebot.ico") -Force
if (Test-Path (Join-Path $PSScriptRoot "README.txt")) {
  Copy-Item (Join-Path $PSScriptRoot "README.txt") (Join-Path $bundle "README.txt") -Force
}

$size = [math]::Round(((Get-ChildItem $bundle -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "built $bundle ($size MB)"

if (-not $SkipZip) {
  # Build the archive outside the output folder: zipping the folder that will hold the zip
  # makes the archive include itself.
  $zip = Join-Path $OutDir "$name.zip"
  # A unique staging name avoids clobbering another build's archive in the shared temp folder.
  $temp = Join-Path $env:TEMP "$name-$([guid]::NewGuid().ToString('N')).zip"
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
  Write-Host "zipping to $zip"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($bundle, $temp, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  Move-Item $temp $zip -Force
  Write-Host "zip: $([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB"
}
