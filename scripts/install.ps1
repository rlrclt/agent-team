# Copy the team role files into the user's Claude Code agents directory.
# usage: powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-Team <name>] [-Force]
#
# Thin wrapper: the copy, the <team> token substitution, the frontmatter
# rewrite and the collision guard all live in `node tools/team.mjs team
# install`, so selftest covers them. This script only forwards flags.
param([string]$Team, [switch]$Force)

$Repo = Split-Path -Parent $PSScriptRoot
$nodeArgs = @('tools/team.mjs', 'team', 'install')
if ($Team) { $nodeArgs += $Team }
if ($Force) {
    Write-Host "note: -Force is handled by team.mjs; re-running install refreshes owned files." -ForegroundColor DarkGray
}

Push-Location $Repo
try {
    node @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw "install failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host @"

Installed role files are prefixed with the team name (e.g. web-team-orchestrator.md)
so two teams' roles can never overwrite each other.

Note: a running Claude Code session does not notice a newly created agents
directory. If ~/.claude/agents did not exist before, restart your sessions.
"@
