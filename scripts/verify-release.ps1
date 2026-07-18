$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne "star-owner" -or -not $package.productName -or -not $package.version) {
  throw "package.json UTF-8 metadata validation failed."
}
if (-not $package.dependencyReleaseVersion -or $package.dependencyReleaseVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "package.json dependencyReleaseVersion must be an explicit semantic version."
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
  "node_modules\mermaid\dist\mermaid.min.js",
  "node_modules\mammoth\package.json",
  "node_modules\pdf-parse\package.json",
  "runtime\python\cpython-3.12.13-windows-x86_64-none\python.exe",
  "runtime\faster-whisper\Lib\site-packages\faster_whisper",
  "runtime\faster-whisper\Lib\site-packages\imageio_ffmpeg\binaries",
  "runtime\faster-whisper\Lib\site-packages\yt_dlp",
  "runtime\vc-runtime\concrt140.dll",
  "runtime\vc-runtime\msvcp140.dll",
  "runtime\vc-runtime\msvcp140_codecvt_ids.dll",
  "runtime\vc-runtime\vcruntime140.dll",
  "runtime\vc-runtime\vcruntime140_1.dll",
  "runtime\models\small\model.bin",
  "runtime\models\medium\model.bin"
)
$required | ForEach-Object { Require-Path $_ }
$vcRuntimeHashes = @{
  "concrt140.dll" = "6CBEB6622C28EB8CD2181B3C2CD083D8553075DAE207A65F2E6A4690B2F0CE4C"
  "msvcp140.dll" = "410AC52E5D6F6764B19D7ADDA8F325BC18749BA5DE4EC9752A03D618F3E2B922"
  "msvcp140_codecvt_ids.dll" = "516BFBBD5D759D09C4254F51084A0212E5163ACEDD9769180532A9F12C878731"
  "vcruntime140.dll" = "6E9523D0F77936934CC79C514FB4FE5FEC3E1FFACC5C8083B69640BDEED124FB"
  "vcruntime140_1.dll" = "3667CA2D06F0AD84409A5711602C2E745D3C52889FC3E7FE99C87841DF9DDCB7"
}
foreach ($entry in $vcRuntimeHashes.GetEnumerator()) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $root "runtime\vc-runtime\$($entry.Key)") -Algorithm SHA256).Hash
  if ($actual -ne $entry.Value) { throw "Project-local VC++ runtime hash mismatch: $($entry.Key)" }
}
$ffmpegBinary = Get-ChildItem -LiteralPath (Join-Path $root "runtime\faster-whisper\Lib\site-packages\imageio_ffmpeg\binaries") -File -Filter "ffmpeg-*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ffmpegBinary) { throw "Required project-local imageio-ffmpeg binary is missing." }

$scanRoots = @("src", "scripts", "tools", "templates", "packaging")
$scanFiles = foreach ($relative in $scanRoots) {
  Get-ChildItem -LiteralPath (Join-Path $root $relative) -Recurse -File
}
$scanFiles = $scanFiles | Where-Object {
  $_.Name -ne "verify-release.ps1" -and
  $_.Extension -ne ".pyc" -and
  $_.FullName -notmatch "[\\/]__pycache__[\\/]"
}
$scanFiles += @(
  "README.md", "DESIGN.md", "DEPLOYMENT.md", "AGENTS.md", "SECURITY.md", "CODE_REVIEW.md",
  "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "runtime-requirements.txt"
) | ForEach-Object { Get-Item -LiteralPath (Join-Path $root $_) }
$forbidden = $scanFiles | Select-String -Pattern "[A-Za-z]:\\(Users|AIcode)\\|C:/Users/|D:/AIcode/|AppData\\Local\\Temp" -ErrorAction SilentlyContinue
if ($forbidden) {
  $details = ($forbidden | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }) -join [Environment]::NewLine
  throw "Machine-specific absolute paths were found:`n$details"
}

$lockVersion = & node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if (p.version !== l.version || p.version !== l.packages?.['']?.version) process.exit(2); process.stdout.write(p.version);"
if ($LASTEXITCODE -ne 0 -or $lockVersion -ne $package.version) {
  throw "package.json and package-lock.json versions do not match."
}

$javascript = Get-ChildItem -LiteralPath (Join-Path $root "src"), (Join-Path $root "scripts"), (Join-Path $root "tools") -Recurse -File -Filter "*.js"
foreach ($file in $javascript) {
  & node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($file.FullName)" }
}
$python = Join-Path $root "runtime\faster-whisper\Scripts\python.exe"
& $python -m py_compile (Join-Path $root "tools\faster-whisper-cli.py") (Join-Path $root "tools\faster-whisper-service.py") (Join-Path $root "scripts\asr-format-test.py") (Join-Path $root "scripts\generate-icon.py")
if ($LASTEXITCODE -ne 0) { throw "Python syntax check failed." }

Push-Location $root
try {
  & npm run smoke
  if ($LASTEXITCODE -ne 0) { throw "Smoke test failed." }
  & npm run test:scheduler
  if ($LASTEXITCODE -ne 0) { throw "Scheduler test failed." }
  & npm run test:rag
  if ($LASTEXITCODE -ne 0) { throw "RAG assistant test failed." }
  & npm run test:internal-agent
  if ($LASTEXITCODE -ne 0) { throw "Internal agent test failed." }
  & npm run test:task-attempt
  if ($LASTEXITCODE -ne 0) { throw "Task attempt rollback test failed." }
  & npm run test:document-lifecycle
  if ($LASTEXITCODE -ne 0) { throw "Document lifecycle test failed." }
  & npm run test:video-cache
  if ($LASTEXITCODE -ne 0) { throw "Video cache test failed." }
  & npm run test:security
  if ($LASTEXITCODE -ne 0) { throw "Security policy test failed." }
  & npm run test:knowledge-api
  if ($LASTEXITCODE -ne 0) { throw "Read-only knowledge API test failed." }
  & npm run test:hardware
  if ($LASTEXITCODE -ne 0) { throw "ASR hardware capability test failed." }
  & npm run test:image-clipboard
  if ($LASTEXITCODE -ne 0) { throw "Image clipboard security test failed." }
  & npm run test:persistence
  if ($LASTEXITCODE -ne 0) { throw "SQLite persistence test failed." }
  & npm run test:collection-sync
  if ($LASTEXITCODE -ne 0) { throw "Collection sync test failed." }
  & npm run test:bili-client
  if ($LASTEXITCODE -ne 0) { throw "Bilibili client test failed." }
  & npm run test:asr-format
  if ($LASTEXITCODE -ne 0) { throw "ASR sentence timestamp format test failed." }
  & npm run test:media-edge
  if ($LASTEXITCODE -ne 0) { throw "Media edge-case test failed." }
  & npm run test:analytics
  if ($LASTEXITCODE -ne 0) { throw "Analytics failure accounting test failed." }
  & npm run test:asr-service
  if ($LASTEXITCODE -ne 0) { throw "Persistent GPU ASR service test failed." }
  & npm audit --audit-level=high
  if ($LASTEXITCODE -ne 0) { throw "npm audit reported a high-severity issue." }
} finally {
  Pop-Location
}

Write-Host "Release verification passed." -ForegroundColor Green
