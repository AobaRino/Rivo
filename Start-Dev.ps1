$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
npm.cmd run dev
