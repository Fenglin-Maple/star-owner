param(
  [string]$OutputPath = (Join-Path $PSScriptRoot 'StarOwnerUpdater.exe'),
  [string]$TestVersionOverride = ''
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
$buildInfoSource = Join-Path $PSScriptRoot 'UpdaterBuildInfo.cs'
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$icon = Join-Path $root 'assets\star-note.ico'
$logo = Join-Path $root 'assets\star-note.png'
$applyHelper = Join-Path $root 'scripts\apply-portable-operation.ps1'
$recoveryHelper = Join-Path $root 'scripts\recover-portable-operation.ps1'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'StarOwnerUpdater.cs is missing.' }
if (-not (Test-Path -LiteralPath $standaloneSource -PathType Leaf)) { throw 'StandaloneUpdater.cs is missing.' }
if (-not (Test-Path -LiteralPath $buildInfoSource -PathType Leaf)) { throw 'UpdaterBuildInfo.cs is missing.' }
if ([string]$package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json contains an invalid updater version.' }
if ($TestVersionOverride -and $TestVersionOverride -notmatch '^\d+\.\d+\.\d+$') { throw 'TestVersionOverride must be a semantic version.' }
$compileVersion = if ($TestVersionOverride) { $TestVersionOverride } else { [string]$package.version }
$buildInfoText = Get-Content -LiteralPath $buildInfoSource -Raw -Encoding UTF8
$declaredVersion = [regex]::Match($buildInfoText, 'public const string Version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"').Groups[1].Value
if (-not $TestVersionOverride -and $declaredVersion -ne [string]$package.version) {
  throw "UpdaterBuildInfo.cs version $declaredVersion does not match package.json $($package.version)."
}
$compileBuildInfoSource = $buildInfoSource
$temporaryBuildInfo = ''
if ($TestVersionOverride) {
  $temporaryBuildInfo = Join-Path $env:TEMP "StarOwner-UpdaterBuildInfo-$PID-$([Guid]::NewGuid().ToString('N')).cs"
  $testBuildInfo = [regex]::Replace($buildInfoText, 'AssemblyVersion\("[0-9]+\.[0-9]+\.[0-9]+\.0"\)', ('AssemblyVersion("{0}.0")' -f $compileVersion))
  $testBuildInfo = [regex]::Replace($testBuildInfo, 'AssemblyFileVersion\("[0-9]+\.[0-9]+\.[0-9]+\.0"\)', ('AssemblyFileVersion("{0}.0")' -f $compileVersion))
  $testBuildInfo = [regex]::Replace($testBuildInfo, 'AssemblyInformationalVersion\("[0-9]+\.[0-9]+\.[0-9]+"\)', ('AssemblyInformationalVersion("{0}")' -f $compileVersion))
  $testBuildInfo = [regex]::Replace($testBuildInfo, 'public const string Version\s*=\s*"[0-9]+\.[0-9]+\.[0-9]+"', ('public const string Version = "{0}"' -f $compileVersion))
  [IO.File]::WriteAllText($temporaryBuildInfo, $testBuildInfo, (New-Object Text.UTF8Encoding($false)))
  $compileBuildInfoSource = $temporaryBuildInfo
}
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
  "/out:$output", $source, $standaloneSource, $compileBuildInfoSource
)
try {
  & $compiler @compilerArguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw "Could not build the native updater (exit $LASTEXITCODE)."
  }
} finally {
  if ($temporaryBuildInfo -and (Test-Path -LiteralPath $temporaryBuildInfo)) { Remove-Item -LiteralPath $temporaryBuildInfo -Force }
}
$fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($output)
if ([string]$fileVersion.ProductVersion -ne $compileVersion) {
  throw "Built updater version $($fileVersion.ProductVersion) does not match expected version $compileVersion."
}

Write-Host "Native updater: $output" -ForegroundColor Green
