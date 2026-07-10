param(
  [ValidateSet("none", "small", "all")]
  [string]$ModelBundle = "small",
  [switch]$NoArchive
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distRoot = Join-Path $root "dist"
$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$folderName = "StarNote-BiliNote-v$($package.version)-win-x64-$ModelBundle"
$stage = Join-Path $distRoot $folderName

function Assert-InsideDist([string]$candidate) {
  $resolvedDist = [System.IO.Path]::GetFullPath($distRoot).TrimEnd('\')
  $resolved = [System.IO.Path]::GetFullPath($candidate)
  if (-not $resolved.StartsWith("$resolvedDist\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside dist: $resolved"
  }
}

& (Join-Path $PSScriptRoot "verify-release.ps1")

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Assert-InsideDist $stage
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$projectItems = @(
  "assets", "src", "templates", "tools", "scripts", "packaging", "LICENSE", "README.md", "DESIGN.md",
  "DEPLOYMENT.md", "AGENTS.md", "THIRD_PARTY_NOTICES.md", "SECURITY.md",
  "package.json", "package-lock.json", "runtime-requirements.txt"
)
foreach ($relative in $projectItems) {
  Copy-Item -LiteralPath (Join-Path $root $relative) -Destination (Join-Path $stage $relative) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $root "packaging\Start-StarNote.cmd") -Destination (Join-Path $stage "Start-StarNote.cmd") -Force
Copy-Item -LiteralPath (Join-Path $root "node_modules") -Destination (Join-Path $stage "node_modules") -Recurse -Force

$runtimeTarget = Join-Path $stage "runtime"
New-Item -ItemType Directory -Path (Join-Path $runtimeTarget "models") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "runtime\python") -Destination (Join-Path $runtimeTarget "python") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "runtime\faster-whisper") -Destination (Join-Path $runtimeTarget "faster-whisper") -Recurse -Force
if ($ModelBundle -in @("small", "all")) {
  Copy-Item -LiteralPath (Join-Path $root "runtime\models\small") -Destination (Join-Path $runtimeTarget "models\small") -Recurse -Force
}
if ($ModelBundle -eq "all") {
  Copy-Item -LiteralPath (Join-Path $root "runtime\models\large-v3-turbo") -Destination (Join-Path $runtimeTarget "models\large-v3-turbo") -Recurse -Force
}

New-Item -ItemType Directory -Path (Join-Path $stage "workspace\users") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "workspace\.star-note") -Force | Out-Null

$manifest = [ordered]@{
  product = "Star Note BiliNote"
  version = $package.version
  platform = "win-x64"
  modelBundle = $ModelBundle
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  launcher = "Start-StarNote.cmd"
  bundled = @("Electron", "Node dependencies", "FFmpeg", "yt-dlp", "Python 3.12", "faster-whisper", "CTranslate2", "CUDA runtime", "Mermaid")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage "portable-manifest.json") -Encoding utf8

if (-not $NoArchive) {
  $archive = Join-Path $distRoot "$folderName.zip"
  Assert-InsideDist $archive
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  & tar.exe -a -c -f $archive -C $distRoot $folderName
  if ($LASTEXITCODE -ne 0) { throw "Could not create portable ZIP." }
  $size = (Get-Item -LiteralPath $archive).Length
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  "$hash  $folderName.zip" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
  if ($size -gt 1900MB) {
    Write-Warning "Archive is larger than 1.9 GiB. Publish core and model archives separately for GitHub Releases."
  }
  Write-Host "Portable archive: $archive"
  Write-Host "SHA256: $hash"
}

Write-Host "Portable directory: $stage" -ForegroundColor Green
