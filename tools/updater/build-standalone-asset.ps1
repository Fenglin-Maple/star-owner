param(
  [string]$OutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'dist'),
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $package.version -or [string]$package.version -notmatch '^\d+\.\d+\.\d+$') {
  throw 'package.json contains an invalid release version.'
}
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot 'build-updater.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Could not build the standalone updater.' }
}

$source = Join-Path $PSScriptRoot 'StarOwnerUpdater.exe'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'StarOwnerUpdater.exe is missing.' }
$fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($source)
if ([string]$fileVersion.ProductVersion -ne [string]$package.version) {
  throw "StarOwnerUpdater.exe version $($fileVersion.ProductVersion) does not match package.json $($package.version)."
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$asset = Join-Path $outputRoot "Star-Owner-Updater-v$($package.version)-win-x64.exe"
Copy-Item -LiteralPath $source -Destination $asset -Force
$stream = [IO.File]::OpenRead($asset)
try {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
  finally { $sha.Dispose() }
} finally {
  $stream.Dispose()
}
"$hash  $([IO.Path]::GetFileName($asset))" | Set-Content -LiteralPath "$asset.sha256" -Encoding ascii

Write-Host "Standalone updater: $asset"
Write-Host "Standalone updater SHA256: $hash"
