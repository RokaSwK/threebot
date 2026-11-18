# Install Threebot on Windows:  irm https://raw.githubusercontent.com/RokaSwK/threebot/main/install.ps1 | iex
# (Or download Threebot-Setup-<version>.exe from the releases for a one-click install.)
# Downloads a release, checks its SHA-256, installs it in %THREEBOT_HOME%\runtime\versions.
$ErrorActionPreference = "Stop"
$Repo = "RokaSwK/threebot"
$HomeDir = if ($env:THREEBOT_HOME) { $env:THREEBOT_HOME } else { Join-Path $env:USERPROFILE ".threebot" }
$BinDir = if ($env:THREEBOT_INSTALL_BIN_DIR) { $env:THREEBOT_INSTALL_BIN_DIR } else { Join-Path $env:USERPROFILE ".local\bin" }
$BaseUrl = if ($env:THREEBOT_RELEASE_BASE_URL) { $env:THREEBOT_RELEASE_BASE_URL } else { "https://github.com/$Repo/releases/download" }

function Say($msg) { Write-Host $msg }
function Die($msg) { Write-Error "threebot install: $msg"; exit 1 }

# Node check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js 22.18 or newer is required: https://nodejs.org" }
$nodeVer = (node -e "process.stdout.write(process.versions.node)").Trim()
$parts = $nodeVer.Split(".")
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 18)) { Die "Node.js 22.18 or newer is required; this is v$nodeVer" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die "npm is required (it comes with Node.js)" }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Die "tar is required (ships with Windows 10+)" }

$Version = $env:THREEBOT_VERSION
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "threebot-install-$(Get-Random)")
try {
  if (-not $Version) {
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    $Version = ($latest.tag_name -replace '^v','')
  }
  if (-not $Version) { Die "couldn't read the latest release" }
  $Version = $Version.TrimStart("v")
  $archive = "threebot-$Version.tar.gz"
  Say "Downloading Threebot $Version"
  Invoke-WebRequest -Uri "$BaseUrl/v$Version/$archive" -OutFile (Join-Path $tmp $archive) -UseBasicParsing
  Invoke-WebRequest -Uri "$BaseUrl/v$Version/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS") -UseBasicParsing

  $expectedLine = (Get-Content (Join-Path $tmp "SHA256SUMS")) | Where-Object { $_ -match [regex]::Escape($archive) } | Select-Object -First 1
  if (-not $expectedLine) { Die "SHA256SUMS has no entry for $archive" }
  $expected = ($expectedLine -split '\s+')[0]
  $actual = (Get-FileHash (Join-Path $tmp $archive) -Algorithm SHA256).Hash.ToLower()
  if ($expected.ToLower() -ne $actual) { Die "checksum mismatch for $archive (expected $expected, got $actual)" }

  $versions = Join-Path $HomeDir "runtime\versions"
  $target = Join-Path $versions $Version
  New-Item -ItemType Directory -Force -Path $versions | Out-Null
  if (-not (Test-Path (Join-Path $target ".install-complete"))) {
    $staging = New-Item -ItemType Directory -Path (Join-Path $versions ".staging-$(Get-Random)")
    tar -xzf (Join-Path $tmp $archive) -C $staging --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw "Release extraction failed" }
    Say "Installing server dependencies"
    Push-Location (Join-Path $staging "server")
    try {
      npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error
      if ($LASTEXITCODE -ne 0) { throw "Server dependency installation failed" }
    } finally { Pop-Location }
    (Get-Date) | Out-File (Join-Path $staging ".install-complete")
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Rename-Item $staging $target
  }

  $runtime = Join-Path $HomeDir "runtime"
  $current = Join-Path $runtime "current"
  if (Test-Path $current) {
    $prev = (Get-Item $current).Target
    if ($prev -and $prev -ne $target) {
      $previous = Join-Path $runtime "previous"
      if (Test-Path $previous) { Remove-Item -Force $previous }
      cmd /c "mklink /J `"$previous`" `"$prev`"" | Out-Null
    }
  }
  if (Test-Path $current) { Remove-Item -Force $current }
  cmd /c "mklink /J `"$current`" `"$target`"" | Out-Null

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $nodeExe = (Get-Command node).Source
  $launcher = Join-Path $BinDir "threebot.cmd"
  @"
@echo off
set THREEBOT_HOME=$HomeDir
"$nodeExe" "%THREEBOT_HOME%\runtime\current\server\cli.mjs" %*
"@ | Out-File -Encoding ASCII $launcher
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ';') -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
  }
  if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$BinDir;$env:Path" }
  Say ""
  Say "Threebot $Version is installed."
  Say "Next: run `threebot up` to connect it to T3 Code and start it in the background."
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}