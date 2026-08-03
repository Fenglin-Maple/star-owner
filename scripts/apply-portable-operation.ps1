param(
  [Parameter(Mandatory = $true)][ValidateSet('update', 'migrate')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$StagedRoot = '',
  [string]$SourceWorkspace = '',
  [string]$TargetVersion = '',
  [string]$OperationId = '',
  [switch]$Relaunch
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$updates = Join-Path $root '.updates'
$resultFile = Join-Path $updates 'operation-result.json'
$journalFile = Join-Path $updates 'operation-journal.json'
$requestFile = Join-Path $updates 'operation-request.json'
$operationId = if ($OperationId) { $OperationId } else { "operation-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))" }
$backup = Join-Path $updates "operation-backup-$operationId"
$coreDirectories = @('assets', 'src', 'templates', 'scripts', 'tools', 'packaging', 'node_modules', 'runtime\git')
$coreFiles = @('package.json', 'package-lock.json', 'Start-StarOwner.cmd', 'portable-manifest.json', 'README.md', 'DESIGN.md', 'DESIGN_SHARED_KNOWLEDGE.md', 'DEPLOYMENT.md', 'AGENTS.md', 'CODE_REVIEW.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'runtime-requirements.txt', 'LICENSE')
$backedUpPaths = @()
$absentPaths = @()
$journalStatus = 'created'
$journalMessage = ''
$operationContext = @{}

function Assert-UnderRoot([string]$Path, [string]$Label) {
  $full = [IO.Path]::GetFullPath($Path)
  $rootPrefix = $root.TrimEnd('\') + '\'
  if (($full -ne $root) -and (-not $full.ToLowerInvariant().StartsWith($rootPrefix.ToLowerInvariant()))) {
    throw "$Label is outside the project root."
  }
  return $full
}

function Write-Result([string]$Status, [string]$Message, [hashtable]$Extra = @{}) {
  New-Item -ItemType Directory -Force -Path $script:updates | Out-Null
  $payload = [ordered]@{
    operationId = $script:operationId
    mode = $Mode
    status = $Status
    message = $Message
    targetVersion = $TargetVersion
    finishedAt = [DateTime]::UtcNow.ToString('o')
  }
  foreach ($entry in $Extra.GetEnumerator()) { $payload[$entry.Key] = $entry.Value }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:resultFile -Encoding UTF8
  if ($Status -in @('succeeded', 'rolled-back')) {
    Remove-Item -LiteralPath $script:journalFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:requestFile -Force -ErrorAction SilentlyContinue
  }
}

function Write-Journal([string]$Status, [string]$Message = '') {
  $script:journalStatus = $Status
  $script:journalMessage = $Message
  New-Item -ItemType Directory -Force -Path $script:updates | Out-Null
  [ordered]@{
    operationId = $script:operationId
    mode = $Mode
    status = $Status
    message = $Message
    projectRoot = $script:root
    stagedRoot = $StagedRoot
    sourceWorkspace = $SourceWorkspace
    targetVersion = $TargetVersion
    backup = $script:backup
    backedUpPaths = @($script:backedUpPaths)
    absentPaths = @($script:absentPaths)
    updatedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:journalFile -Encoding UTF8
}

function Save-JournalProgress {
  Write-Journal $script:journalStatus $script:journalMessage
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
  $source = Join-Path $script:root $Relative
  $script:operationContext = @{ phase = 'backup'; item = $Relative; source = $source; backup = $script:backup }
  if (-not (Test-Path -LiteralPath $source)) {
    if ($absentPaths -notcontains $Relative) { $script:absentPaths += $Relative }
    Save-JournalProgress
    return
  }
  $target = Join-Path $script:backup $Relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  if ($backedUpPaths -notcontains $Relative) { $script:backedUpPaths += $Relative }
  Save-JournalProgress
}

function Restore-Path([string]$Relative) {
  $target = Join-Path $script:root $Relative
  $source = Join-Path $script:backup $Relative
  if ($script:backedUpPaths -contains $Relative) {
    if (-not (Test-Path -LiteralPath $source)) { throw "Backup is missing for $Relative." }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  } elseif ($script:absentPaths -contains $Relative) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
}

function Apply-CoreUpdate {
  $stage = Assert-UnderRoot $StagedRoot 'Staged package'
  if (-not (Test-Path -LiteralPath (Join-Path $stage 'package.json'))) { throw 'Staged package.json is missing.' }
  foreach ($item in ($coreDirectories + $coreFiles)) { Backup-Path $item }
  $script:operationContext = @{ phase = 'post-backup'; directoryCount = @($coreDirectories).Count; fileCount = @($coreFiles).Count; stage = $stage; journalFile = $script:journalFile }
  Write-Journal 'applying' 'Backup complete; replacing application files.'
  $script:operationContext = @{ phase = 'post-journal'; directoryCount = @($coreDirectories).Count; fileCount = @($coreFiles).Count; stage = $stage }
  foreach ($item in $coreDirectories) {
    $target = Join-Path $script:root $item
    $source = Join-Path $stage $item
    $script:operationContext = @{ phase = 'replace-directory'; item = $item; target = $target; source = $source }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
  }
  foreach ($item in $coreFiles) {
    $target = Join-Path $script:root $item
    $source = Join-Path $stage $item
    $script:operationContext = @{ phase = 'replace-file'; item = $item; target = $target; source = $source }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Force }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:root 'node_modules\electron\dist\electron.exe'))) { throw 'Updated Electron runtime is missing.' }
}

function Apply-WorkspaceMigration {
  $source = [IO.Path]::GetFullPath($SourceWorkspace)
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Source workspace does not exist.' }
  $target = Join-Path $script:root 'workspace'
  if ($source.ToLowerInvariant() -eq $target.ToLowerInvariant()) { throw 'Source workspace is the current workspace.' }
  $database = Join-Path $source 'orchestrator.sqlite'
  if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw 'Source workspace database is missing.' }
  $header = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($database)[0..15])
  if ($header -ne "SQLite format 3`0") { throw 'Source workspace is not a valid SQLite database.' }
  Backup-Path 'workspace'
  Write-Journal 'applying' 'Backup complete; migrating the workspace.'
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $target 'orchestrator.sqlite'))) { throw 'Workspace migration did not produce a database.' }
}

try {
  Assert-UnderRoot $root 'Project root' | Out-Null
  Write-Journal 'waiting-for-exit' 'Waiting for the application to exit.'
  Wait-ForApplicationExit
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  Write-Journal 'backing-up' 'Backing up existing files.'
  if ($Mode -eq 'update') { Apply-CoreUpdate } else { Apply-WorkspaceMigration }
  $successMessage = if ($Mode -eq 'update') { "Updated to v$TargetVersion." } else { 'Workspace migrated successfully.' }
  Write-Result 'succeeded' $successMessage @{ backup = $backup }
  if ($Relaunch) {
    $launcher = Join-Path $root 'Start-StarOwner.cmd'
    if (Test-Path -LiteralPath $launcher) { Start-Process -FilePath $launcher -WorkingDirectory $root -WindowStyle Hidden }
  }
} catch {
  $operationError = $_.Exception.Message
  $operationStack = $_.ScriptStackTrace
  $operationPosition = $_.InvocationInfo.PositionMessage
  Write-Journal 'rolling-back' $operationError
  try {
    if ($Mode -eq 'update') {
      foreach ($item in ($coreDirectories + $coreFiles)) { Restore-Path $item }
    } else { Restore-Path 'workspace' }
    Write-Result 'rolled-back' $operationError @{ backup = $backup; errorStack = $operationStack; errorPosition = $operationPosition; errorContext = $operationContext }
  } catch {
    $rollbackError = $_.Exception.Message
    Write-Result 'rollback-failed' ("$operationError | rollback: $rollbackError") @{ backup = $backup; errorStack = $operationStack; errorPosition = $operationPosition; errorContext = $operationContext }
  }
  exit 1
}
