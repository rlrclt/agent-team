# Launch the muster web dashboard and open the default browser.
# usage: powershell -ExecutionPolicy Bypass -File scripts/dashboard.ps1 -Team <name> [-Port <number>] [-NoBrowser] [-DryRun]
param(
    [string]$Team,
    [int]$Port = 3000,
    [switch]$NoBrowser,
    [switch]$DryRun
)

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Team) { throw "usage: dashboard.ps1 -Team <name> [-Port <number>] [-NoBrowser] [-DryRun]  (see: node tools/muster.mjs team list)" }
if ($Team -notmatch '^[a-z][a-z0-9-]{1,31}$') { throw "invalid team name '$Team'" }
if ($Port -lt 1 -or $Port -gt 65535) { throw "invalid port '$Port': must be between 1 and 65535" }

$TeamDir = Join-Path $Root "teams\$Team"
if (-not (Test-Path $TeamDir)) { throw "no teams/$Team directory - run: node tools/muster.mjs team list" }

$url = "http://localhost:$Port"

if ($DryRun) {
    Write-Host "  would: node tools/muster.mjs --team $Team dashboard --port $Port"
    if (-not $NoBrowser) {
        Write-Host "  would: open $url in default browser"
    }
    Write-Host "`ndry run complete - nothing was started"
    exit 0
}

Write-Host "starting dashboard for team '$Team' on $url ..."
if (-not $NoBrowser) {
    Start-Process $url
}

Push-Location $Root
try {
    node tools/muster.mjs --team $Team dashboard --port $Port
} finally {
    Pop-Location
}
