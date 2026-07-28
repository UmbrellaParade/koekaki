[CmdletBinding()]
param(
    [string]$Version = '43.2.0',
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electronPackage = [System.IO.Path]::GetFullPath(
    (Join-Path $repoRoot 'node_modules\electron')
)
$expectedPackage = [System.IO.Path]::GetFullPath(
    (Join-Path $repoRoot 'node_modules\electron')
)
if ($electronPackage -ne $expectedPackage) {
    throw 'Unexpected Electron package path'
}
if (-not (Test-Path -LiteralPath (Join-Path $electronPackage 'package.json'))) {
    throw 'Run npm install before installing the Electron binary'
}

$distDir = Join-Path $electronPackage 'dist'
$electronExe = Join-Path $distDir 'electron.exe'
$pathFile = Join-Path $electronPackage 'path.txt'
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'koekaki-electron-*' |
    ForEach-Object {
        $stalePath = [System.IO.Path]::GetFullPath($_.FullName)
        $staleName = [System.IO.Path]::GetFileName($stalePath)
        if (
            $stalePath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
            $staleName -like 'koekaki-electron-*'
        ) {
            Remove-Item -LiteralPath $stalePath -Recurse -Force
        }
    }

if ((Test-Path -LiteralPath $electronExe) -and (Test-Path -LiteralPath $pathFile)) {
    [System.IO.File]::WriteAllText(
        $pathFile,
        'electron.exe',
        [System.Text.Encoding]::ASCII
    )
    Write-Output 'Electron binary is already installed'
    exit 0
}

$zipName = "electron-v$Version-win32-$Architecture.zip"
$releaseBase = "https://github.com/electron/electron/releases/download/v$Version"
$tempDir = [System.IO.Path]::GetFullPath(
    (Join-Path $tempRoot ('koekaki-electron-' + [Guid]::NewGuid().ToString('N')))
)
if (-not $tempDir.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected temporary directory'
}

New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
    $zipPath = Join-Path $tempDir $zipName
    $shasumsPath = Join-Path $tempDir 'SHASUMS256.txt'

    & curl.exe -L --fail --silent --show-error --retry 3 --output $zipPath "$releaseBase/$zipName"
    if ($LASTEXITCODE -ne 0) {
        throw 'Electron archive download failed'
    }
    & curl.exe -L --fail --silent --show-error --retry 3 --output $shasumsPath "$releaseBase/SHASUMS256.txt"
    if ($LASTEXITCODE -ne 0) {
        throw 'Electron checksum download failed'
    }

    $escapedName = [regex]::Escape($zipName)
    $checksumLine = Get-Content -LiteralPath $shasumsPath |
        Where-Object { $_ -match "^([a-fA-F0-9]{64})\s+\*?$escapedName$" } |
        Select-Object -First 1
    if (-not $checksumLine) {
        throw 'Official checksum was not found'
    }

    $expectedHash = ([regex]::Match($checksumLine, '^[a-fA-F0-9]{64}')).Value.ToLowerInvariant()
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw 'Electron archive checksum mismatch'
    }

    $extractDir = Join-Path $tempDir 'extracted'
    New-Item -ItemType Directory -Path $extractDir | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractDir)

    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
    Copy-Item -Path (Join-Path $extractDir '*') -Destination $distDir -Recurse -Force
    [System.IO.File]::WriteAllText(
        $pathFile,
        'electron.exe',
        [System.Text.Encoding]::ASCII
    )

    if (-not (Test-Path -LiteralPath $electronExe)) {
        throw 'Electron executable was not extracted'
    }

    Write-Output "Electron $Version win32-$Architecture installed and verified"
}
finally {
    if (
        (Test-Path -LiteralPath $tempDir) -and
        $tempDir.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        ([System.IO.Path]::GetFileName($tempDir) -like 'koekaki-electron-*')
    ) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}
