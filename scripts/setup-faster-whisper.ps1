$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runtime = Join-Path $root "runtime"
$pythonRoot = Join-Path $runtime "python"
$venv = Join-Path $runtime "faster-whisper"
$models = Join-Path $runtime "models"
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source

if (!$uv) {
  $wingetUv = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe"
  if (Test-Path $wingetUv) { $uv = $wingetUv }
}
if (!$uv) { throw "uv is required. Install it with: winget install --id astral-sh.uv -e" }

New-Item -ItemType Directory -Force -Path $runtime, $models | Out-Null
& $uv python install 3.12 --install-dir $pythonRoot --no-bin --no-registry --compile-bytecode
$python = Get-ChildItem -Path $pythonRoot -Recurse -Filter python.exe |
  Where-Object { $_.FullName -notlike "*\Lib\venv\*" } |
  Select-Object -First 1 -ExpandProperty FullName
if (!$python) { throw "Project Python installation failed." }

if (!(Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  & $uv venv $venv --python $python --seed
}
& $uv pip install --link-mode copy --python (Join-Path $venv "Scripts\python.exe") --requirements (Join-Path $root "runtime-requirements.txt")
& (Join-Path $venv "Scripts\python.exe") (Join-Path $root "tools\faster-whisper-cli.py") --download-model --model small
& (Join-Path $venv "Scripts\python.exe") (Join-Path $root "tools\faster-whisper-cli.py") --download-model --model large-v3-turbo
& (Join-Path $venv "Scripts\python.exe") (Join-Path $root "tools\faster-whisper-cli.py") --health --model small
& (Join-Path $venv "Scripts\python.exe") (Join-Path $root "tools\faster-whisper-cli.py") --health --model large-v3-turbo
