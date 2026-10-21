# Bring one team up in its own herdr workspace.
# usage: powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -Team <name> [-DryRun]
#
# The team is whatever role files sit in teams/<name>/agents/ - there is no
# separate roster list to keep in sync. Every seat runs:
#   claude --agent <team>-<role>
# so two teams' seats can never collide in herdr or in ~/.claude/agents.
# MCP servers, skills and plugins all come from the user's global config
# (~/.claude), so there is no per-seat settings file.
param([string]$Team, [switch]$DryRun, [switch]$Replace)

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Team) { throw "usage: seat-up.ps1 -Team <name> [-DryRun]  (see: node tools/muster.mjs team list)" }
if ($Team -notmatch '^[a-z][a-z0-9-]{1,31}$') { throw "invalid team name '$Team'" }

$TeamDir = Join-Path $Root "teams\$Team"
$AgentsDir = Join-Path $TeamDir 'agents'
if (-not (Test-Path $AgentsDir)) { throw "no teams/$Team/agents directory - run: node tools/muster.mjs team list" }

# Doctor is the gate: a team that is not ready must not be seated.
Push-Location $Root
try {
    node tools/muster.mjs team doctor $Team
    if ($LASTEXITCODE -ne 0) { throw "team '$Team' is not ready - fix what doctor reported above" }
} finally {
    Pop-Location
}

$Seats = @(Get-ChildItem $AgentsDir -Filter *.md |
           Sort-Object Name |
           ForEach-Object { $_.BaseName })
if ($Seats.Count -eq 0) { throw "teams/$Team/agents holds no .md role files" }

# The seat you talk to belongs in pane 1, so put it first if the team has one.
$first = $Seats | Where-Object { $_ -eq 'orchestrator' }
if ($first) { $Seats = @($first) + @($Seats | Where-Object { $_ -ne 'orchestrator' }) }

foreach ($s in $Seats) {
    $roleFile = Join-Path $HOME ".claude\agents\$Team-$s.md"
    if (-not (Test-Path $roleFile)) { throw "role '$s' is in teams/$Team/agents but not installed - run scripts/install.ps1 -Team $Team" }
}
Write-Host "team: $Team ($($Seats -join ', '))"

# Refuse to create a second workspace for a team that is already up: two sets
# of seats on one state directory race each other for the same task locks.
if (-not $DryRun -and -not $Replace -and (Get-Command herdr -ErrorAction SilentlyContinue)) {
    try {
        $existing = (herdr workspace list | ConvertFrom-Json).result.workspaces |
                    Where-Object { $_.label -eq $Team }
        if ($existing) {
            $running = (herdr agent list | ConvertFrom-Json).result.agents |
                       Where-Object { $_.workspace_id -eq $existing.workspace_id }
            if ($running) {
                Write-Host "team '$Team' is already up in workspace $($existing.workspace_id):" -ForegroundColor Yellow
                foreach ($a in $running) { Write-Host ("  {0,-24} {1}" -f $a.name, $a.agent_status) }
                throw "refusing to seat a second copy. Pass -Replace to force, or bring it down first."
            }
        }
    } catch {
        if ($_.Exception.Message -like 'refusing*') { throw }
        # a failed listing must not block the launch
    }
}

if ($DryRun) {
    Write-Host "  would: herdr workspace create --cwd $Root --label $Team --no-focus"
    $ws = 'wX'
} else {
    $ws = (herdr workspace create --cwd $Root --label $Team --no-focus |
           ConvertFrom-Json).result.workspace.workspace_id
    if (-not $ws) { throw 'workspace create returned no id' }
}
Write-Host "workspace $ws"

for ($i = 0; $i -lt $Seats.Count; $i++) {
    $seat = $Seats[$i]
    $agentName = "$Team-$seat"
    $pane = "$ws" + ":p$($i + 1)"

    if ($i -gt 0) {
        if ($DryRun) { Write-Host "  would: herdr pane split --pane $ws`:p1 --direction right --ratio 0.5" }
        else { herdr pane split --pane "$ws`:p1" --direction right --ratio 0.5 | Out-Null }
    }

    $hargs = @('agent', 'start', $agentName, '--kind', 'claude', '--pane', $pane,
               '--timeout', '120000', '--', '--agent', $agentName)

    if ($DryRun) {
        Write-Host "  would: herdr $($hargs -join ' ')"
        continue
    }
    Write-Host "seating $agentName in $pane"
    # agent start can exit non-zero on a SessionStart hook error even when the
    # agent did start, so the exit code is not the check - the listing below is.
    herdr @hargs 2>&1 | Out-Null
}

if ($DryRun) { Write-Host "`ndry run complete - nothing was started"; exit 0 }

Write-Host "`nverifying..."
$up = (herdr agent list | ConvertFrom-Json).result.agents |
      Where-Object { $_.workspace_id -eq $ws }
foreach ($s in $Seats) {
    $agentName = "$Team-$s"
    $a = $up | Where-Object { $_.name -eq $agentName }
    if ($a) { Write-Host ("  {0,-24} {1,-8} {2}" -f $agentName, $a.pane_id, $a.agent_status) }
    else    { Write-Host ("  {0,-24} NOT STARTED" -f $agentName) }
}
if ($up.Count -lt $Seats.Count) {
    Write-Host "`n$($Seats.Count - $up.Count) seat(s) did not start. Re-run a single seat with:" -ForegroundColor Yellow
    Write-Host "  herdr agent start $Team-<seat> --kind claude --pane $ws`:pN -- --agent $Team-<seat>"
    exit 1
}
Write-Host "`nall $($Seats.Count) seats up for team $Team"
