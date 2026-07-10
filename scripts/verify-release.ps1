$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne "star-owner" -or -not $package.productName -or -not $package.version) {
  throw "package.json UTF-8 metadata validation failed."
}

function Require-Path([string]$relative) {
  $target = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $target)) {
    throw "Required release input is missing: $relative"
  }
}

$required = @(
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "DEPLOYMENT.md",
  "AGENTS.md",
  "runtime-requirements.txt",
  "package.json",
  "package-lock.json",
  "node_modules\electron\dist\electron.exe",
  "node_modules\ffmpeg-static\ffmpeg.exe",
  "node_modules\yt-dlp-exec\bin\yt-dlp.exe",
  "node_modules\mermaid\dist\mermaid.min.js",
  "node_modules\mammoth\package.json",
  "node_modules\pdf-parse\package.json",
  "runtime\python\cpython-3.12.13-windows-x86_64-none\python.exe",
  "runtime\faster-whisper\Lib\site-packages\faster_whisper",
  "runtime\models\small\model.bin"
)
$required | ForEach-Object { Require-Path $_ }

$scanRoots = @("src", "scripts", "tools", "templates", "packaging")
$scanFiles = foreach ($relative in $scanRoots) {
  Get-ChildItem -LiteralPath (Join-Path $root $relative) -Recurse -File
}
$scanFiles = $scanFiles | Where-Object { $_.Name -ne "verify-release.ps1" }
$scanFiles += Get-Item (Join-Path $root "README.md"), (Join-Path $root "DESIGN.md"), (Join-Path $root "DEPLOYMENT.md"), (Join-Path $root "AGENTS.md")
$forbidden = $scanFiles | Select-String -Pattern "[A-Za-z]:\\(Users|AIcode)\\|C:/Users/|D:/AIcode/|AppData\\Local\\Temp" -ErrorAction SilentlyContinue
if ($forbidden) {
  $details = ($forbidden | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }) -join [Environment]::NewLine
  throw "Machine-specific absolute paths were found:`n$details"
}

$javascript = Get-ChildItem -LiteralPath (Join-Path $root "src"), (Join-Path $root "scripts"), (Join-Path $root "tools") -Recurse -File -Filter "*.js"
foreach ($file in $javascript) {
  & node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($file.FullName)" }
}

Push-Location $root
try {
  & npm run smoke
  if ($LASTEXITCODE -ne 0) { throw "Smoke test failed." }
  & npm run test:scheduler
  if ($LASTEXITCODE -ne 0) { throw "Scheduler test failed." }
  & npm run test:rag
  if ($LASTEXITCODE -ne 0) { throw "RAG assistant test failed." }
  & npm audit --audit-level=high
  if ($LASTEXITCODE -ne 0) { throw "npm audit reported a high-severity issue." }
} finally {
  Pop-Location
}

Write-Host "Release verification passed." -ForegroundColor Green
