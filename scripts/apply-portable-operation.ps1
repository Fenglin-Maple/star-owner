param(
  [Parameter(Mandatory = $true)][ValidateSet('update', 'migrate')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$StagedRoot = '',
  [string]$SourceWorkspace = '',
  [string]$TargetVersion = '',
  [string]$OperationId = '',
  [string]$CancelFile = '',
  [int]$TestStepDelayMilliseconds = 0,
  [switch]$Relaunch
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$updates = Join-Path $root '.updates'
$resultFile = Join-Path $updates 'operation-result.json'
$journalFile = Join-Path $updates 'operation-journal.json'
$requestFile = Join-Path $updates 'operation-request.json'
$cancelFile = if ($CancelFile) { [IO.Path]::GetFullPath($CancelFile) } else { Join-Path $updates 'operation-cancel.json' }
$operationId = if ($OperationId) { $OperationId } else { "operation-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))" }
$backup = Join-Path $updates "operation-backup-$operationId"
$coreDirectories = @('assets', 'src', 'templates', 'scripts', 'tools', 'packaging', 'node_modules', 'runtime\git')
$coreFiles = @('package.json', 'package-lock.json', 'Start-StarOwner.cmd', 'portable-manifest.json', 'README.md', 'DESIGN.md', 'DESIGN_SHARED_KNOWLEDGE.md', 'DEPLOYMENT.md', 'AGENTS.md', 'CODE_REVIEW.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'runtime-requirements.txt', 'LICENSE')
$backedUpPaths = @()
$absentPaths = @()
$journalStatus = 'created'
$journalMessage = ''
$operationContext = @{}
$phase = 'prepare'
$currentItem = ''
$completedItems = 0
$totalItems = if ($Mode -eq 'update') { (($coreDirectories.Count + $coreFiles.Count) * 2) + 1 } else { 4 }
$progress = 0.01

function Write-JsonAtomic([string]$Path, $Payload) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $temporary = "$Path.tmp-$PID"
  $json = $Payload | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Test-CancelRequested {
  if (-not (Test-Path -LiteralPath $script:cancelFile -PathType Leaf)) { return $false }
  try {
    $cancel = Get-Content -LiteralPath $script:cancelFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return (-not $cancel.operationId) -or ([string]$cancel.operationId -eq $script:operationId)
  } catch {
    return $true
  }
}

function Assert-NotCancelled {
  if (Test-CancelRequested) { throw 'Operation canceled by the user.' }
}

function Invoke-TestStepDelay {
  if ($TestStepDelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $TestStepDelayMilliseconds }
}

function Update-Progress([string]$Phase, [string]$Item = '') {
  $script:phase = $Phase
  $script:currentItem = $Item
  $fraction = if ($script:totalItems -gt 0) { $script:completedItems / $script:totalItems } else { 0 }
  $script:progress = [Math]::Min(0.97, 0.05 + (0.92 * $fraction))
}

function Complete-ProgressItem {
  $script:completedItems++
  Update-Progress $script:phase $script:currentItem
}

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
  $payload['phase'] = if ($Status -eq 'succeeded') { 'complete' } else { 'rollback' }
  $payload['progress'] = 1
  $payload['completedItems'] = $script:completedItems
  $payload['totalItems'] = $script:totalItems
  Write-JsonAtomic $script:resultFile $payload
  if ($Status -in @('succeeded', 'cancelled', 'rolled-back')) {
    Remove-Item -LiteralPath $script:journalFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:requestFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:cancelFile -Force -ErrorAction SilentlyContinue
  }
}

function Write-Journal([string]$Status, [string]$Message = '') {
  $script:journalStatus = $Status
  $script:journalMessage = $Message
  New-Item -ItemType Directory -Force -Path $script:updates | Out-Null
  $payload = [ordered]@{
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
    phase = $script:phase
    item = $script:currentItem
    progress = $script:progress
    completedItems = $script:completedItems
    totalItems = $script:totalItems
    updatedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-JsonAtomic $script:journalFile $payload
}

function Save-JournalProgress {
  Write-Journal $script:journalStatus $script:journalMessage
}

function Wait-ForApplicationExit {
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    Assert-NotCancelled
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "The application process did not exit in time."
}

function Assert-SourceApplicationStopped([string]$WorkspacePath) {
  $sourceProject = [IO.Path]::GetFullPath((Split-Path -Parent $WorkspacePath)).TrimEnd('\')
  $running = @(Get-CimInstance Win32_Process | Where-Object {
    $command = if ($_.CommandLine) { ([string]$_.CommandLine).Replace('/', '\').ToLowerInvariant() } else { '' }
    $source = $sourceProject.Replace('/', '\').ToLowerInvariant()
    $_.ProcessId -ne $PID -and
    ([string]$_.Name).ToLowerInvariant() -in @('electron.exe', 'node.exe') -and
    $command -and
    ($command.Contains('"' + $source + '"') -or $command.Contains("'" + $source + "'") -or $command.Contains($source + '\'))
  })
  if ($running.Count -gt 0) {
    $processIds = ($running | ForEach-Object { [string]$_.ProcessId }) -join ', '
    throw "The source application is still running (PID $processIds). Close it before migration."
  }
}

function Backup-Path([string]$Relative) {
  Assert-NotCancelled
  $source = Join-Path $script:root $Relative
  $script:operationContext = @{ phase = 'backup'; item = $Relative; source = $source; backup = $script:backup }
  Update-Progress 'backup' $Relative
  Write-Journal 'backing-up' 'Creating a complete transaction backup.'
  if (-not (Test-Path -LiteralPath $source)) {
    if ($absentPaths -notcontains $Relative) { $script:absentPaths += $Relative }
    Complete-ProgressItem
    Save-JournalProgress
    return
  }
  $target = Join-Path $script:backup $Relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  if ($backedUpPaths -notcontains $Relative) { $script:backedUpPaths += $Relative }
  Assert-NotCancelled
  Complete-ProgressItem
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
  Update-Progress 'apply' ''
  Write-Journal 'applying' 'Backup complete; replacing application core files.'
  $script:operationContext = @{ phase = 'post-journal'; directoryCount = @($coreDirectories).Count; fileCount = @($coreFiles).Count; stage = $stage }
  foreach ($item in $coreDirectories) {
    Assert-NotCancelled
    $target = Join-Path $script:root $item
    $source = Join-Path $stage $item
    $script:operationContext = @{ phase = 'replace-directory'; item = $item; target = $target; source = $source }
    Update-Progress 'apply' $item
    Save-JournalProgress
    Invoke-TestStepDelay
    Assert-NotCancelled
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
    Assert-NotCancelled
    Complete-ProgressItem
    Save-JournalProgress
  }
  foreach ($item in $coreFiles) {
    Assert-NotCancelled
    $target = Join-Path $script:root $item
    $source = Join-Path $stage $item
    $script:operationContext = @{ phase = 'replace-file'; item = $item; target = $target; source = $source }
    Update-Progress 'apply' $item
    Save-JournalProgress
    Invoke-TestStepDelay
    Assert-NotCancelled
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Force }
    Assert-NotCancelled
    Complete-ProgressItem
    Save-JournalProgress
  }
  Update-Progress 'verify' 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath (Join-Path $script:root 'node_modules\electron\dist\electron.exe'))) { throw 'Updated Electron runtime is missing.' }
  Complete-ProgressItem
  Save-JournalProgress
}

function Apply-WorkspaceMigration {
  Assert-NotCancelled
  Update-Progress 'verify' 'orchestrator.sqlite'
  $source = [IO.Path]::GetFullPath($SourceWorkspace)
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Source workspace does not exist.' }
  Assert-SourceApplicationStopped $source
  $target = Join-Path $script:root 'workspace'
  if ($source.ToLowerInvariant() -eq $target.ToLowerInvariant()) { throw 'Source workspace is the current workspace.' }
  $database = Join-Path $source 'orchestrator.sqlite'
  if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw 'Source workspace database is missing.' }
  $header = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($database)[0..15])
  if ($header -ne "SQLite format 3`0") { throw 'Source workspace is not a valid SQLite database.' }
  Complete-ProgressItem
  Save-JournalProgress
  Backup-Path 'workspace'
  Assert-NotCancelled
  Update-Progress 'apply' 'workspace'
  Write-Journal 'applying' 'Target workspace backed up; migrating user data.'
  Invoke-TestStepDelay
  Assert-NotCancelled
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  Assert-NotCancelled
  Complete-ProgressItem
  Update-Progress 'verify' 'workspace\orchestrator.sqlite'
  Save-JournalProgress
  if (-not (Test-Path -LiteralPath (Join-Path $target 'orchestrator.sqlite'))) { throw 'Workspace migration did not produce a database.' }
  Complete-ProgressItem
  Save-JournalProgress
}

try {
  Assert-UnderRoot $root 'Project root' | Out-Null
  $script:phase = 'wait'
  $script:progress = 0.02
  Write-Journal 'waiting-for-exit' 'Waiting for Star Owner to exit and release its files.'
  Wait-ForApplicationExit
  Assert-NotCancelled
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  $script:progress = 0.05
  Update-Progress 'backup' ''
  Write-Journal 'backing-up' 'Creating a complete transaction backup.'
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
  $wasCancelled = Test-CancelRequested
  $script:phase = 'rollback'
  $script:currentItem = ''
  Write-Journal 'rolling-back' $operationError
  try {
    if ($Mode -eq 'update') {
      foreach ($item in ($coreDirectories + $coreFiles)) {
        $script:currentItem = $item
        Save-JournalProgress
        Restore-Path $item
      }
    } else {
      $script:currentItem = 'workspace'
      Save-JournalProgress
      Restore-Path 'workspace'
    }
    $finalStatus = if ($wasCancelled) { 'cancelled' } else { 'rolled-back' }
    $finalMessage = if ($wasCancelled) { 'Operation canceled and restored to its previous state.' } else { $operationError }
    Write-Result $finalStatus $finalMessage @{ backup = $backup; errorStack = $operationStack; errorPosition = $operationPosition; errorContext = $operationContext }
  } catch {
    $rollbackError = $_.Exception.Message
    Write-Result 'rollback-failed' ("$operationError | rollback: $rollbackError") @{ backup = $backup; errorStack = $operationStack; errorPosition = $operationPosition; errorContext = $operationContext }
  }
  exit 1
}
