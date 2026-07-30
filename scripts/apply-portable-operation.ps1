param(
  [Parameter(Mandatory = $true)][ValidateSet('update', 'migrate')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$StagedRoot = '',
  [string]$SourceWorkspace = '',
  [string]$TargetVersion = '',
  [switch]$Relaunch
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$updates = Join-Path $root '.updates'
$resultFile = Join-Path $updates 'operation-result.json'
$operationId = "operation-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))"
$backup = Join-Path $updates "operation-backup-$operationId"

function Assert-UnderRoot([string]$Path, [string]$Label) {
  $full = [IO.Path]::GetFullPath($Path)
  $rootPrefix = $root.TrimEnd('\') + '\'
  if (($full -ne $root) -and (-not $full.ToLowerInvariant().StartsWith($rootPrefix.ToLowerInvariant()))) {
    throw "$Label is outside the project root."
  }
  return $full
}

function Write-Result([string]$Status, [string]$Message, [hashtable]$Extra = @{}) {
  New-Item -ItemType Directory -Force -Path $updates | Out-Null
  $payload = [ordered]@{
    operationId = $operationId
    mode = $Mode
    status = $Status
    message = $Message
    targetVersion = $TargetVersion
    finishedAt = [DateTime]::UtcNow.ToString('o')
  }
  foreach ($entry in $Extra.GetEnumerator()) { $payload[$entry.Key] = $entry.Value }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultFile -Encoding UTF8
}

function Wait-ForApplicationExit {
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "The application process did not exit in time."
}

function Backup-Path([string]$Relative) {
  $source = Join-Path $root $Relative
  if (-not (Test-Path -LiteralPath $source)) { return }
  $target = Join-Path $backup $Relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

function Restore-Path([string]$Relative) {
  $target = Join-Path $root $Relative
  $source = Join-Path $backup $Relative
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  if (Test-Path -LiteralPath $source) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  }
}

function Apply-CoreUpdate {
  $stage = Assert-UnderRoot $StagedRoot 'Staged package'
  if (-not (Test-Path -LiteralPath (Join-Path $stage 'package.json'))) { throw 'Staged package.json is missing.' }
  $coreDirectories = @('assets', 'src', 'scripts', 'tools', 'node_modules')
  $coreFiles = @('package.json', 'package-lock.json', 'Start-StarOwner.cmd', 'portable-manifest.json', 'README.md', 'DESIGN.md', 'DEPLOYMENT.md', 'LICENSE', 'NOTICE')
  foreach ($item in ($coreDirectories + $coreFiles)) { Backup-Path $item }
  foreach ($item in $coreDirectories) {
    $target = Join-Path $root $item
    $source = Join-Path $stage $item
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
  }
  foreach ($item in $coreFiles) {
    $target = Join-Path $root $item
    $source = Join-Path $stage $item
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Force }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\electron\dist\electron.exe'))) { throw 'Updated Electron runtime is missing.' }
}

function Apply-WorkspaceMigration {
  $source = [IO.Path]::GetFullPath($SourceWorkspace)
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Source workspace does not exist.' }
  $target = Join-Path $root 'workspace'
  if ($source.ToLowerInvariant() -eq $target.ToLowerInvariant()) { throw 'Source workspace is the current workspace.' }
  $database = Join-Path $source 'orchestrator.sqlite'
  if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw 'Source workspace database is missing.' }
  $header = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($database)[0..15])
  if ($header -ne "SQLite format 3`0") { throw 'Source workspace is not a valid SQLite database.' }
  Backup-Path 'workspace'
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $target 'orchestrator.sqlite'))) { throw 'Workspace migration did not produce a database.' }
}

try {
  Assert-UnderRoot $root 'Project root' | Out-Null
  Wait-ForApplicationExit
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  if ($Mode -eq 'update') { Apply-CoreUpdate } else { Apply-WorkspaceMigration }
  $successMessage = if ($Mode -eq 'update') { "Updated to v$TargetVersion." } else { 'Workspace migrated successfully.' }
  Write-Result 'succeeded' $successMessage @{ backup = $backup }
  if ($Relaunch) {
    $launcher = Join-Path $root 'Start-StarOwner.cmd'
    if (Test-Path -LiteralPath $launcher) { Start-Process -FilePath $launcher -WorkingDirectory $root -WindowStyle Hidden }
  }
} catch {
  try {
    if ($Mode -eq 'update') {
      foreach ($item in @('assets', 'src', 'scripts', 'tools', 'node_modules', 'package.json', 'package-lock.json', 'Start-StarOwner.cmd', 'portable-manifest.json', 'README.md', 'DESIGN.md', 'DEPLOYMENT.md', 'LICENSE', 'NOTICE')) { Restore-Path $item }
    } else { Restore-Path 'workspace' }
    Write-Result 'rolled-back' $_.Exception.Message @{ backup = $backup }
  } catch {
    Write-Result 'rollback-failed' ("$($_.Exception.Message) | rollback: $($_.Exception.Message)") @{ backup = $backup }
  }
  exit 1
}
