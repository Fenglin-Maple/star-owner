param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$updates = Join-Path $root '.updates'
$journalFile = Join-Path $updates 'operation-journal.json'
$requestFile = Join-Path $updates 'operation-request.json'
$resultFile = Join-Path $updates 'operation-result.json'

if (-not (Test-Path -LiteralPath $journalFile -PathType Leaf)) { exit 0 }

function Assert-Under([string]$Parent, [string]$Candidate, [string]$Label) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $prefix = $parentFull + '\'
  if (($candidateFull -ne $parentFull) -and (-not $candidateFull.ToLowerInvariant().StartsWith($prefix.ToLowerInvariant()))) {
    throw "$Label is outside its managed root."
  }
  return $candidateFull
}

function Remove-ManagedPath([string]$Target) {
  $safe = Assert-Under $root $Target 'Recovery target'
  if ($safe -eq $root) { throw 'Refusing to remove the project root.' }
  if (Test-Path -LiteralPath $safe) { Remove-Item -LiteralPath $safe -Recurse -Force }
}

try {
  $journal = Get-Content -LiteralPath $journalFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $journal.operationId -or -not $journal.mode) { throw 'Operation journal is incomplete.' }
  if ($journal.projectRoot -and ([IO.Path]::GetFullPath([string]$journal.projectRoot) -ne $root)) { throw 'Operation journal belongs to another project root.' }
  $backup = Assert-Under $updates ([string]$journal.backup) 'Operation backup'
  $backedUp = @($journal.backedUpPaths | ForEach-Object { [string]$_ })
  $absent = @($journal.absentPaths | ForEach-Object { [string]$_ })
  $changedState = [string]$journal.status -in @('applying', 'rolling-back')
  if ($changedState -and -not ($journal.PSObject.Properties.Name -contains 'backedUpPaths')) {
    throw 'Operation journal predates safe recovery metadata; automatic recovery was stopped.'
  }
  if ($changedState) {
    $restoreItems = if ([string]$journal.mode -eq 'migrate') { @('workspace') } else { @($backedUp + $absent | Select-Object -Unique) }
    foreach ($relative in $restoreItems) {
      if ([IO.Path]::IsPathRooted($relative) -or $relative.Split('\') -contains '..') { throw "Unsafe recovery entry: $relative" }
      $target = Assert-Under $root (Join-Path $root $relative) 'Recovery target'
      $source = Assert-Under $backup (Join-Path $backup $relative) 'Recovery backup entry'
      if ($backedUp -contains $relative) {
        if (-not (Test-Path -LiteralPath $source)) { throw "Backup is missing for $relative." }
        Remove-ManagedPath $target
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
      } elseif ($absent -contains $relative) {
        Remove-ManagedPath $target
      }
    }
  }
  [ordered]@{
    operationId = [string]$journal.operationId
    mode = [string]$journal.mode
    status = 'rolled-back'
    message = 'Recovered an interrupted update or migration before launch.'
    recoveredAt = [DateTime]::UtcNow.ToString('o')
    backup = $backup
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultFile -Encoding UTF8
  Remove-Item -LiteralPath $journalFile -Force
  Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  [ordered]@{
    status = 'recovery-failed'
    message = $_.Exception.Message
    recoveredAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultFile -Encoding UTF8
  Write-Error "Star Owner update recovery failed: $($_.Exception.Message)"
  exit 1
}
