$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    Write-Host 'Opening OriginKit sign-in in your browser...'
    & npx.cmd originkit@latest login
    if ($LASTEXITCODE -ne 0) { throw "OriginKit login failed with exit code $LASTEXITCODE" }

    Write-Host 'Requesting the official Hero 58 section...'
    & npx.cmd originkit@latest add hero-58
    if ($LASTEXITCODE -ne 0) { throw "OriginKit add failed with exit code $LASTEXITCODE" }

    Write-Host 'Installed OriginKit files:'
    $originKitPath = Join-Path $projectRoot 'src/components/originkit'
    if (Test-Path $originKitPath) {
        Get-ChildItem $originKitPath -Recurse -File | ForEach-Object { Write-Host (' - ' + $_.FullName) }
    }
    else {
        Write-Warning 'CLI succeeded but src/components/originkit was not found; inspect components.json and CLI output.'
    }
}
finally {
    Pop-Location
}
