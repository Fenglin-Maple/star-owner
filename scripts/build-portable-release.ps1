param(
  [ValidateSet("none", "small", "medium", "all")]
  [string]$ModelBundle = "all",
  [switch]$SeparateModelAsset,
  [switch]$NoArchive
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distRoot = Join-Path $root "dist"
$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$splitModels = @()
if ($SeparateModelAsset) {
  if ($ModelBundle -in @("small", "all")) { $splitModels += "small" }
  if ($ModelBundle -in @("medium", "all")) { $splitModels += "medium" }
}
$folderSuffix = if ($splitModels.Count -gt 0) { "core" } else { $ModelBundle }
$folderName = "Star-Owner-v$($package.version)-win-x64-$folderSuffix"
$stage = Join-Path $distRoot $folderName

function Assert-InsideDist([string]$candidate) {
  $resolvedDist = [System.IO.Path]::GetFullPath($distRoot).TrimEnd('\')
  $resolved = [System.IO.Path]::GetFullPath($candidate)
  if (-not $resolved.StartsWith("$resolvedDist\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside dist: $resolved"
  }
}

function Write-ReleaseArchive([string]$archive, [string]$sourceRoot, [string]$item, [string]$label) {
  Assert-InsideDist $archive
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  & tar.exe -a -c -f $archive -C $sourceRoot $item
  if ($LASTEXITCODE -ne 0) { throw "Could not create $label ZIP." }
  $size = (Get-Item -LiteralPath $archive).Length
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  "$hash  $([System.IO.Path]::GetFileName($archive))" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
  if ($size -gt 1900MB) {
    Write-Warning "$label archive is larger than 1.9 GiB and is unsafe for GitHub Releases."
  }
  Write-Host "$label archive: $archive"
  Write-Host "$label SHA256: $hash"
}

function Write-RuntimeArchive([string]$archive) {
  Assert-InsideDist $archive
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  & tar.exe -a -c -f $archive -C $stage "runtime\python" "runtime\faster-whisper"
  if ($LASTEXITCODE -ne 0) { throw "Could not create runtime dependency ZIP." }
  $size = (Get-Item -LiteralPath $archive).Length
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  "$hash  $([System.IO.Path]::GetFileName($archive))" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
  if ($size -gt 1900MB) { Write-Warning "Runtime dependency archive is larger than 1.9 GiB and is unsafe for GitHub Releases." }
  Write-Host "Runtime dependency archive: $archive"
  Write-Host "Runtime dependency SHA256: $hash"
}

function Remove-GeneratedProjectCaches {
  foreach ($relative in @("tools\__pycache__", "scripts\__pycache__", "src\__pycache__")) {
    $candidate = Join-Path $root $relative
    if (Test-Path -LiteralPath $candidate) {
      Remove-Item -LiteralPath $candidate -Recurse -Force
    }
  }
}

function Set-PortableVenvHome([string]$stageRoot) {
  $config = Join-Path $stageRoot "runtime\faster-whisper\pyvenv.cfg"
  $python = Get-ChildItem -LiteralPath (Join-Path $stageRoot "runtime\python") -Recurse -Filter python.exe |
    Where-Object { $_.FullName -notlike "*\Lib\venv\*" } |
    Select-Object -First 1
  if (-not $python -or -not (Test-Path -LiteralPath $config)) {
    throw "Portable Python or pyvenv.cfg is missing from the staged runtime."
  }
  $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot).TrimEnd('\')
  $resolvedHome = [System.IO.Path]::GetFullPath($python.Directory.FullName)
  if (-not $resolvedHome.StartsWith("$resolvedStage\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable Python home is outside the staged release directory."
  }
  $relativeHome = $resolvedHome.Substring($resolvedStage.Length + 1)
  $content = Get-Content -LiteralPath $config -Raw -Encoding UTF8
  $content = [regex]::Replace($content, '(?m)^home\s*=.*$', "home = $relativeHome")
  Set-Content -LiteralPath $config -Value $content -Encoding UTF8 -NoNewline
}

Remove-GeneratedProjectCaches
& (Join-Path $PSScriptRoot "verify-release.ps1")
Remove-GeneratedProjectCaches

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Assert-InsideDist $stage
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$projectItems = @(
  "assets", "src", "templates", "tools", "scripts", "packaging", "LICENSE", "README.md", "DESIGN.md",
  "DEPLOYMENT.md", "AGENTS.md", "CODE_REVIEW.md", "THIRD_PARTY_NOTICES.md", "SECURITY.md",
  "package.json", "package-lock.json", "runtime-requirements.txt"
)
foreach ($relative in $projectItems) {
  Copy-Item -LiteralPath (Join-Path $root $relative) -Destination (Join-Path $stage $relative) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $root "packaging\Start-StarOwner.cmd") -Destination (Join-Path $stage "Start-StarOwner.cmd") -Force
Copy-Item -LiteralPath (Join-Path $root "node_modules") -Destination (Join-Path $stage "node_modules") -Recurse -Force

$runtimeTarget = Join-Path $stage "runtime"
New-Item -ItemType Directory -Path (Join-Path $runtimeTarget "models") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "runtime\python") -Destination (Join-Path $runtimeTarget "python") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "runtime\faster-whisper") -Destination (Join-Path $runtimeTarget "faster-whisper") -Recurse -Force
Set-PortableVenvHome $stage
if (-not $SeparateModelAsset -and $ModelBundle -in @("small", "all")) {
  Copy-Item -LiteralPath (Join-Path $root "runtime\models\small") -Destination (Join-Path $runtimeTarget "models\small") -Recurse -Force
}
if (-not $SeparateModelAsset -and $ModelBundle -in @("medium", "all")) {
  Copy-Item -LiteralPath (Join-Path $root "runtime\models\medium") -Destination (Join-Path $runtimeTarget "models\medium") -Recurse -Force
}

New-Item -ItemType Directory -Path (Join-Path $stage "workspace\users") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "workspace\.star-note") -Force | Out-Null

$manifest = [ordered]@{
  product = $package.productName
  version = $package.version
  platform = "win-x64"
  modelBundle = if ($splitModels.Count -gt 0) { "external" } else { $ModelBundle }
  requiredModelAssets = @($splitModels | ForEach-Object { "Star-Owner-v$($package.version)-model-$_.zip" })
  requiredRuntimeAssets = @("Star-Owner-v$($package.version)-runtime-win-x64.zip")
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  launcher = "Start-StarOwner.cmd"
  bundled = @("Electron", "Node dependencies", "FFmpeg", "yt-dlp", "Python 3.12", "faster-whisper", "CTranslate2", "CUDA runtime", "Mermaid") + $(if ($splitModels.Count -eq 0 -and $ModelBundle -ne "none") { @("ASR model: $ModelBundle") } else { @() })
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage "portable-manifest.json") -Encoding utf8

if (-not $NoArchive) {
  $archive = Join-Path $distRoot "$folderName.zip"
  Write-ReleaseArchive $archive $distRoot $folderName "Portable core"
  if ($SeparateModelAsset) {
    $runtimeArchive = Join-Path $distRoot "Star-Owner-v$($package.version)-runtime-win-x64.zip"
    Write-RuntimeArchive $runtimeArchive
  }
  foreach ($model in $splitModels) {
    $modelArchive = Join-Path $distRoot "Star-Owner-v$($package.version)-model-$model.zip"
    Write-ReleaseArchive $modelArchive $root "runtime\models\$model" "Model $model"
  }
}

Write-Host "Portable directory: $stage" -ForegroundColor Green
