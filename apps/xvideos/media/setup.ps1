<#
Builds digital\x-requirements for the X Videos media service on this machine (Windows, NVIDIA GPU, Python 3.12).

    powershell -File apps\xvideos\media\setup.ps1 [-Clip <a video file>] [-SkipOllama] [-SkipCheck]

  x-requirements\env       Python 3.12 venv: GPU Paddle + PaddleOCR, faster-whisper (requirements.txt, pinned by requirements.lock.txt)
  x-requirements\models    PaddleOCR detection + Devanagari recognition, Whisper large-v3 (setup_models.py)
  x-requirements\cache     the media service's temporary frames
  qwen3:14b                pulled into Ollama's own store (other tools on this PC share it)

Then it checks the GPU, OCR and Whisper load, and reads the screen of -Clip when given. Safe to run again: what is
already in place is kept.
#>
param([string]$Clip = "", [switch]$SkipOllama, [switch]$SkipCheck)
$ErrorActionPreference = "Stop"

$media = $PSScriptRoot
# media -> xvideos -> apps -> backend -> digital
$digital = (Resolve-Path (Join-Path $media "..\..\..\..")).Path
$req = Join-Path $digital "x-requirements"
$envDir = Join-Path $req "env"
$py = Join-Path $envDir "Scripts\python.exe"

function Assert-Ok([string]$what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

Write-Host "x-requirements: $req"
foreach ($d in "models\paddle", "models\whisper", "cache") { New-Item -ItemType Directory -Force -Path (Join-Path $req $d) | Out-Null }

foreach ($tool in "ffmpeg", "ffprobe") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH (winget install Gyan.FFmpeg)" }
}

function Get-PyVersion([string[]]$cmd) {
    $out = & $cmd[0] @($cmd | Select-Object -Skip 1) -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    return ($out | Select-Object -Last 1)
}

if (-not (Test-Path $py)) {
    Write-Host "1/4 creating the Python 3.12 environment"
    # The interpreter is checked before the venv is made, so a wrong one leaves nothing behind
    $base = if (Get-Command py -ErrorAction SilentlyContinue) { @("py", "-3.12") } else { @("python") }
    $found = Get-PyVersion $base
    if ($found -ne "3.12") { throw "Python 3.12 is needed ($($base -join ' ') is '$found'); install it from python.org" }
    & $base[0] @($base | Select-Object -Skip 1) -m venv $envDir
    Assert-Ok "creating the venv"
} else {
    Write-Host "1/4 Python environment in place"
}
$version = Get-PyVersion @($py)
if ($version -ne "3.12") { throw "x-requirements\env is Python $version; it must be 3.12 (delete it and run again)" }

Write-Host "2/4 installing packages (the first time downloads about 3 GB)"
& $py -m pip install --disable-pip-version-check -r (Join-Path $media "requirements.txt") -c (Join-Path $media "requirements.lock.txt")
Assert-Ok "pip install"

Write-Host "3/4 models"
& $py -I (Join-Path $media "setup_models.py") $req
Assert-Ok "setup_models.py"

if (-not $SkipOllama) {
    Write-Host "4/4 qwen3:14b in Ollama"
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { throw "Ollama is not installed (https://ollama.com/download)" }
    & ollama pull qwen3:14b
    Assert-Ok "ollama pull qwen3:14b"
} else {
    Write-Host "4/4 Ollama skipped"
}

if (-not $SkipCheck) {
    Write-Host "check: GPU, OCR and Whisper load$(if ($Clip) { ', then the screen of one clip is read' })"
    $checkArgs = @("-I", (Join-Path $media "headline.py"), "--check")
    if ($Clip) { $checkArgs += $Clip }
    & $py @checkArgs
    Assert-Ok "the check"
}
Write-Host "x-requirements ready"
