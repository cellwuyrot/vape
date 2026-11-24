$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$componentsPath = Join-Path $projectRoot 'components.json'
$reactBitsConfigPath = Join-Path $projectRoot 'components.reactbits.json'
$originalConfig = [System.IO.File]::ReadAllText($componentsPath)
$reactBitsConfig = [System.IO.File]::ReadAllText($reactBitsConfigPath)

Push-Location $projectRoot
try {
    [System.IO.File]::WriteAllText($componentsPath, $reactBitsConfig, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Installing the official React Bits Spotlight Card source into src/components/visuals...'
    & npx.cmd shadcn@latest add @react-bits/SpotlightCard-JS-CSS
    if ($LASTEXITCODE -ne 0) {
        throw "React Bits CLI failed with exit code $LASTEXITCODE"
    }
    Write-Host 'React Bits component files:'
    Get-ChildItem (Join-Path $projectRoot 'src/components/visuals') -Recurse -File |
        ForEach-Object { Write-Host (' - ' + $_.FullName) }
}
finally {
    [System.IO.File]::WriteAllText($componentsPath, $originalConfig, [System.Text.UTF8Encoding]::new($false))
    Pop-Location
}
