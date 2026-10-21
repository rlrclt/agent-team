# Multi-Team Architecture Design

Date: 2026-10-21
Status: draft — awaiting human approval

## Why

The repository currently supports exactly one team. Everything team-specific
hangs off fixed paths in `state/` (`events.jsonl`, `tasks/`, `locks/`,
`learnings.jsonl`) and every naming assumption is hardcoded:

- `tools/muster.mjs` hardcodes `STATE = <repo>/state` and a `ROSTER` array of six
  names inside `send()`.
- `scripts/seat-up.ps1` builds a herdr workspace labelled `<team>` from
  `agents/*.md`, with no notion of which team or which project workspace the
  team serves.
- `scripts/install.ps1` copies `agents/*.md` into `~/.claude/agents/`. Two teams
  that both ship a `builder.md` overwrite each other silently.
- `state/AGENTS.md` maintains a prose Roster table that must be hand-edited in
  lockstep with everything above.

The human hit this wall starting work on a second project (pbmobile, a web
game): a second team cannot exist without cloning the whole repository, and
clones drift.

Requirement, in the human's words: this must be a real system, orderly, not
ad-hoc. Teams are customized freely (no inheritance, no template engine), and
every operation names its team explicitly — there is no default team.

## Goals

1. One repository hosts any number of independent, isolated teams.
2. All per-team state can never collide between teams: each team owns its own
   event log, tasks, locks, and lessons.
3. Add / inspect / launch / audit a team through explicit CLI commands; the
   system verifies its own health before use.
4. Role files across teams cannot silently overwrite each other at install
   time.
5. The existing single team migrates intact, in one reversible command, and
   legacy paths keep working during no transition window (single source of
   truth after migration — no dual-path reading).

## Non-goals

- No template / inheritance system for roles. A new team starts empty and the
  human writes its role files (copying from an existing team by hand if they
  want).
- No queue, scheduler, or daemon. The multiplexer dispatch model stays.
- No multi-repo split. One repo, one tool, many teams.
- No web UI. CLI and files only.
- Teams do not talk to each other in v1 (no cross-team messaging).

## The team directory

One directory per team under `teams/`. The directory name is the team name:
lowercase letters, digits, hyphens (validated; `[a-z][a-z0-9-]{1,31}`),
and it is the identifier used in every command.

```
teams/
└── pbmobile/
    ├── team.json          # declared identity: name, workspace, status
    ├── agents/            # role files for this team (human-authored)
    ├── AGENTS.md          # team contract (edited per team)
    └── state/
        ├── events.jsonl   # this team's append-only log
        ├── learnings.jsonl
        └── tasks/         # task specs, .md and .json as today
        # locks/ is created on demand exactly as today
```

### team.json

Created by `team new`, owned by the CLI (hand edits allowed but `doctor`
validates it):

```json
{
  "name": "pbmobile",
  "workspace": "workspace/pbmobile",
  "status": "draft",
  "createdAt": "2026-10-21T09:00:00Z"
}
```

- `status`: `draft` → `ready`, set by `doctor` when the team passes. A `draft`
  team can be inspected but not seated or dispatched to.
- `workspace`: the project repository the team is responsible for, relative to
  the muster repo root (e.g. `workspace/pbmobile`). `doctor` requires the
  directory to exist and to be a git repo before `ready`.

### Role files and name collision

Every role file in a team directory must be named `<role>.md` as today, and
Claude Code's `--agent` lookup is global across `~/.claude/agents/`. So at
install time each team's role files are copied under a team-prefixed name:

```
~/.claude/agents/pbmobile-builder-frontend.md
~/.claude/agents/web-team-orchestrator.md
```

- The prefix is the team name; `install.ps1` refuses to proceed if it would
  overwrite a file whose name does not start with that same team's prefix
  (protects against two teams colliding, or a team file clobbering an
  unrelated personal agent). `-Force` overrides within the team's own prefix
  only.
- Inside the role file, the `name:` frontmatter must be the prefixed name and
  the file must log with the prefixed name. `install.ps1` rewrites the
  `name:` field during copy (single source: the unprefixed `agents/` file,
  prefix applied mechanically). Commands an agent runs reference its own name;
  role files are written with `<role>` placeholders, and the team contract
  tells each agent its name equals its role file name.
- `tools/muster.mjs` keeps state identity unprefixed: agent names in events,
  locks, and messages stay scoped by team directory, so `pbmobile` can have a
  plain `builder-frontend` internally while another team has its own. The
  prefix exists only where Claude Code and herdr resolve names.

### Naming rule, settled (one rule, three layers)

| Layer | Form | Why |
|---|---|---|
| Claude Code role file (`~/.claude/agents/`) | `<team>-<role>.md`, frontmatter `name` matches | global directory, no scoping |
| herdr seat / dispatch address | `<team>-<role>` | one multiplexer, many team workspaces |
| `tools/muster.mjs` state (events, locks, `send` from/to, verdict checks) | `<role>` | already scoped by `teams/<team>/state/` |

Consequences the implementation must honour:

- `send()` receives an unprefixed `<to>`, resolves the herdr address as
  `<team>-<to>` from its `--team` context, and logs the unprefixed pair. Its
  current hardcoded `ROSTER` array is deleted; the roster is read from
  `teams/<team>/agents/*.md`. A target with no role file is an error, not a
  warning.
- `log()`'s `agent === 'reviewer'` verdict check and `checkBoundary`'s
  `ROLE_FORBIDDEN[agent]` lookup keep working because agents log unprefixed.
  Both gain role-suffix resolution for prefixed input, so a seat that reports
  its installed name by mistake still hits the right rule instead of silently
  passing.
- Role files in `teams/<name>/agents/` name peers as plain roles and carry a
  `<team>` token where a command needs the team name. The installer is the
  single place that substitutes it (frontmatter `name`, `herdr agent prompt
  <role>` → `<team>-<role>`, `--team <team>`). A migrated or newly installed
  role file therefore reads as real, runnable commands. Handing the raw
  `agents/` file to Claude would produce wrong addresses — that is why
  `doctor` checks the installed copies rather than trusting the source.

## CLI surface (`tools/muster.mjs`)

New team-management group; all subcommands take the team from their argument,
never from a global default:

```sh
node tools/muster.mjs team list
node tools/muster.mjs team new <name> --workspace <relative-path>
node tools/muster.mjs team info <name>        # roster, status, workspace, pending work
node tools/muster.mjs team doctor <name>
node tools/muster.mjs team install [<name>]   # wrapper target for install.ps1
node tools/muster.mjs team import-legacy <name> --workspace <relative-path>
node tools/muster.mjs --team <name> status|view|claim|release|log|send|inbox|learn|add-lesson|ls|new-task
node tools/muster.mjs selftest                # sandboxed, needs no team
```

- `selftest` is the one exception: it builds its own temp sandbox teams and
  therefore takes no `--team`. Requiring a real team to test team creation
  would make the suite unrunnable on a fresh clone.

- `--team` is required for all work commands. Omitting it errors with the
  usage line; there is no fallback to "the one team" and no `state/` at repo
  root anymore.
- `team list` reads `teams/*/team.json` and prints name, status, workspace,
  counts of open tasks and held locks.
- `team new` creates the empty structure above and nothing else. A team with
  zero role files is `draft` by definition.
- `team info <name>` prints team.json plus the role files present, locked
  tasks, and last 5 events — the single command an agent runs to orient
  itself after context compaction.
- All existing task/state commands become team-scoped internally: the shared
  code resolves `STATE = teams/<team>/state` once at argument-parse time
  instead of the current fixed path. Functions keep their signatures; only
  path resolution and the new argument change.

## Role boundaries across teams

`ROLE_FORBIDDEN` in muster.mjs is keyed by unprefixed role (`builder-frontend`
etc.). Roles are pattern-matched by suffix: `pbmobile-builder-frontend` maps
to the `builder-frontend` rule via the known role-suffix list
(`orchestrator|builder-frontend|builder-backend|reviewer|qa|runner|designer|advisor`).
An unknown role (a custom role name a team invents) gets no automatic role
boundary — only the task-level allow/deny globs apply, and `doctor` prints a
warning reminding the human of that.

## `team doctor <name>`

Checks, in order, printing every failure before exiting nonzero (not
fail-fast — one pass, full report):

1. `teams/<name>/team.json` exists and parses; `name` matches the directory.
2. `agents/` holds at least two `.md` files and every file's frontmatter
   `name:` matches its filename without prefix.
3. Installed counterparts exist in `~/.claude/agents/<name>-<role>.md` for
   every role (warning if missing: "run install.ps1").
4. `agents/` files match nothing in another team's prefix set (collision
   check against every other team's roles).
5. `state/` contains events.jsonl (empty file is fine) and tasks/.
6. `workspace` path exists and is a git repo.
7. No locks held by an agent that has no role file in this team (stale-lock
   report, with the release command printed).

Passing checks 1–2 + 6 sets `status: ready` in team.json (idempotent).
`seat-up.ps1` refuses to seat a team that is not `ready`.

## seat-up.ps1

Gains a mandatory `-Team <name>` parameter (`-DryRun` retains its meaning):

- Reads `teams/<name>/agents/*.md` instead of repo-root `agents/`.
- Creates the herdr workspace labelled `<name>` (e.g. `pbmobile`), so multiple
  team workspaces coexist in herdr.
- Seats each role with `claude --agent <name>-<role>`, pane order
  orchestrator-first as today.
- Runs `node tools/muster.mjs team doctor <name>` first; a nonzero doctor aborts
  the launch before any pane is created.

## install.ps1

Becomes a thin PowerShell wrapper over `node tools/muster.mjs install [<team>]`,
so the copy, the collision rule, the `<team>` substitution and the frontmatter
rewrite live in one implementation that `selftest` can call and test. Reasons:
the logic is non-trivial (a silent overwrite is the failure mode this whole
design exists to prevent), selftest is already Node, and a second PowerShell
implementation would be a second place to get it wrong.

Per team, per role file, the installer:

1. Reads `teams/<name>/agents/<role>.md`.
2. Refuses if the target `<name>-<role>.md` exists and was not written by this
   team (collision guard). `-Force` re-copies within this team's own prefix
   only.
3. Substitutes the `<team>` token and sets frontmatter `name: <name>-<role>`.
4. Writes `~/.claude/agents/<name>-<role>.md`.

No parameter installs every team; `-Team <name>` installs one. The wrapper
keeps `-Force` and the summary output.

## state/AGENTS.md vs team AGENTS.md

The current repo-root contract becomes per-team: `teams/<name>/AGENTS.md`,
edited freely per team. The machine-readable source of the roster is
`agents/`; the Roster table in the contract exists for agents to read, and
`doctor` warns when it has drifted from the role files.

## Migration of the existing team

`node tools/muster.mjs team import-legacy web-team --workspace <path>` is one
command that leaves the team runnable, not merely moved.

0. Refuses if the tree is dirty under `state/` or `agents/` — a migration
   whose rollback is `git revert` is only a rollback if the tree was clean.
   Refuses a second run (legacy layout gone) or an existing `teams/web-team/`.
1. Creates `teams/web-team/` and moves (not copies) `state/events.jsonl`,
   `state/learnings.jsonl`, `state/LEARNINGS.md`, `state/tasks/*`, any
   `locks/`, and `state/AGENTS.md` → `teams/web-team/AGENTS.md`.
2. Moves repo-root `agents/*.md` → `teams/web-team/agents/`.
3. Rewrites the moved text in place, line-oriented and idempotent (re-running
   it on already-rewritten text changes nothing): `state/AGENTS.md` →
   `teams/web-team/AGENTS.md`, `state/tasks` → `teams/web-team/state/tasks`,
   every `node tools/muster.mjs` command gains `--team web-team` in the right
   position, `herdr agent prompt <role>` → `herdr agent prompt
   web-team-<role>`, and each role file's `Read state/AGENTS.md` →
   `Read teams/web-team/AGENTS.md`.
4. Writes `team.json` with the workspace rule below and no `status` —
   `doctor` decides `ready`.
5. Leaves no `state/` and no repo-root `agents/`; legacy invocations fail with
   the usage error.
6. Runs `doctor web-team` and prints its full report. A failing doctor exits
   nonzero after the move; the human fixes what it names and `status` stays
   `draft` until then.

## What a team owns (workspace rule)

One team = one project repository. `workspace` in `team.json` is a path
relative to the muster repo root and may point outside it via `../`
(e.g. `../pbmobile`) — that is how a real project repo is used. `workspace/`
inside this repo stays as the example/scratch location.

- `doctor` resolves the path, requires the directory to exist, and requires it
  to be a git repository before setting `ready`.
- Seats still launch with cwd at the muster repo root, because
  `node tools/muster.mjs` and `teams/<name>/...` resolve from there. Role files
  and task specs carry the project path; the pane does not chdir.
- Several repositories for one team is out of scope for v1. The honest answer
  is a second team, not a list-shaped schema nobody validated.

## Repository layout after migration

```
muster/
├── teams/
│   └── web-team/              # the migrated original team
│       ├── team.json
│       ├── agents/            # moved from agents/
│       ├── AGENTS.md          # contract from state/AGENTS.md
│       └── state/             # moved from state/
├── docs/                      # guides, rewritten for multi-team
├── scripts/                   # install.ps1, seat-up.ps1 (-Team) — thin wrappers
├── tools/muster.mjs
└── workspace/                 # example/scratch project repos
```

There is no `teams/base/`: a directory under `teams/` without `team.json` is
not a team and would make `team list` lie. The old role files survive in git
history, which is where a human copies them from when writing a new team.

`docs/creating-a-team.md` and the README are rewritten around the new
commands and the `teams/` directory. `docs/capability-scoping.md` survives
unchanged except for the launch-flag examples, which gain the prefix.

## What is deliberately left out (for later, named)

- Cross-team messaging and shared lessons.
- Per-team model/effort defaults beyond what role frontmatter already does.
- A `team remove` command (deleting a directory is the documented way).
- Windows-only scripts keep being Windows-only (PowerShell).

## Testing

`selftest` runs in a real temp sandbox: it copies `tools/muster.mjs`'s resolved
root into a temp dir with a synthetic `teams/` and points `ROOT`/`TEAMS` there,
rather than the current trick of rewriting `EVENTS` in place. Cases:

1. `team new` creates the layout; duplicate name refused; invalid name refused.
2. Scoped commands without `--team` fail.
3. `--team` on a nonexistent team fails with usage.
4. Claim/release/log isolation: events for team A never appear in team B's log.
5. doctor: draft (too few roles) fails; fails on bad workspace path; passes on
   a correctly prepared fixture team.
6. install: collision refused when a foreign `<team>-<role>.md` exists; `<team>`
   token and frontmatter `name` substituted on success — exercised by calling
   the same function `install.ps1` wraps, against the temp agents dir.
7. import-legacy: rewrites text idempotently (second apply is a no-op) and
   refuses a second run once the legacy layout is gone.

`install.ps1` itself has no separate test: it is a one-line wrapper over
`muster.mjs install`, which case 6 covers.

## Verdict requested from the human

Four decisions I made that you should check, because undoing any of them is
expensive later:

1. **`--team` is mandatory on every work command** — no default team, ever.
   Rejected: a "there is only one team, use it" fallback.
2. **Agent names are prefixed per team** in Claude Code and herdr
   (`pbmobile-builder-frontend`), unprefixed only inside a team's own state.
   Rejected: trusting two teams to never pick the same role name.
3. **One team owns one project repo** (`workspace` in team.json, may be
   `../something`). Rejected: a list of repos per team.
4. **`install.ps1` and `seat-up.ps1` become thin wrappers over Node
   subcommands**, so the risky logic is testable from `selftest`. Rejected:
   duplicating copy/collision logic in PowerShell.

Also note the migration precondition: it refuses to run on a dirty tree, so
you will commit current `state/` before `import-legacy` runs.
