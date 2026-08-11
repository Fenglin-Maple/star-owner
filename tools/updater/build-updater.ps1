param(
  [string]$OutputPath = (Join-Path $PSScriptRoot 'StarOwnerUpdater.exe')
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  throw 'The Windows .NET Framework C# compiler is unavailable.'
}

$source = Join-Path $PSScriptRoot 'StarOwnerUpdater.cs'
$standaloneSource = Join-Path $PSScriptRoot 'StandaloneUpdater.cs'
$icon = Join-Path $root 'assets\star-note.ico'
$logo = Join-Path $root 'assets\star-note.png'
$applyHelper = Join-Path $root 'scripts\apply-portable-operation.ps1'
$recoveryHelper = Join-Path $root 'scripts\recover-portable-operation.ps1'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'StarOwnerUpdater.cs is missing.' }
if (-not (Test-Path -LiteralPath $standaloneSource -PathType Leaf)) { throw 'StandaloneUpdater.cs is missing.' }
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'assets\star-note.ico is missing.' }
if (-not (Test-Path -LiteralPath $logo -PathType Leaf)) { throw 'assets\star-note.png is missing.' }
if (-not (Test-Path -LiteralPath $applyHelper -PathType Leaf)) { throw 'apply-portable-operation.ps1 is missing.' }
if (-not (Test-Path -LiteralPath $recoveryHelper -PathType Leaf)) { throw 'recover-portable-operation.ps1 is missing.' }

$output = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
$compilerArguments = @(
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', "/win32icon:$icon",
  '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Management.dll',
  '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
  "/resource:$applyHelper,StarOwnerUpdater.apply-portable-operation.ps1",
  "/resource:$recoveryHelper,StarOwnerUpdater.recover-portable-operation.ps1",
  "/resource:$logo,StarOwnerUpdater.star-note.png",
  "/out:$output", $source, $standaloneSource
)
& $compiler @compilerArguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
  throw "Could not build the native updater (exit $LASTEXITCODE)."
}

Write-Host "Native updater: $output" -ForegroundColor Green
