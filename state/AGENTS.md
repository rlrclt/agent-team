# TEAM CONTRACT — agent-team

Read this file first. It is the shared truth for every agent on this team.

## Two kinds of state (do not mix them)

| | where | who writes | why |
|---|---|---|---|
| **Prose** — brief, spec, known context, out-of-scope | `state/tasks/<id>.md` | the author of the task | narrative; agents read it far better than they query |
| **State** — claimed / blocked / done / handoff | `state/events.jsonl` | `tools/team.mjs` only | append-only, atomic; never hand-edit |

Never write status into the task `.md`. Never write prose into the `.jsonl`.
Disk is the source of truth. Your memory is a hint.

## Claim before you work (mandatory)

A task has one owner at a time. Claiming is atomic — the winner is decided by
the filesystem, not by guessing.

```sh
node tools/team.mjs claim <task-id> <your-agent-name>
```

Denied means someone else owns it. Do not work on it, do not retry in a loop —
ask the orchestrator or pick different work. When done, and in the same turn:

```sh
node tools/team.mjs log <task-id> <agent> done --note "..." --files "a.ts,b.ts"
node tools/team.mjs release <task-id> <agent>
```

A lock left behind by a dead agent is released by the orchestrator with an
explicit `release <id> <agent> stale`. Never release a lock you do not own.

## Talking to another agent

Send and wait on the herdr pane — do not poll files waiting for an answer.

```sh
herdr agent prompt <name> "<message>" --wait --until idle --timeout 600000
herdr agent wait <name> --until done --until blocked --timeout 600000
herdr agent read <name>
```

`--wait` returns when the peer's turn ends. Without `--wait` the message is
queued and returns immediately. `herdr agent read` shows what it replied.

`wait` returns as soon as the peer goes **blocked** (it needs you) or **done**.
Treat a timeout as "still working", not as failure. A peer that is blocked is
waiting on a human decision — route it to the orchestrator, do not guess.

## Rules for ALL agents

1. One claim, one task. No parallel claims to "reserve" work.
2. Stay inside your task's scope. Touching anything else needs a line in the log.
3. Never edit another agent's task file.
4. Blocked → `log <id> <agent> blocked --note "<what is missing>"`, release, and
   say what you need. Do not guess, do not ask the human directly — the
   orchestrator relays.
5. If your context was compacted: do not trust memory. Re-read
   `state/tasks/*.md`, run `node tools/team.mjs ls`, reconcile, report one line.
6. English in code and comments. Thai is fine in conversation with the orchestrator.

## Orchestrator hard rules (binding)

- **Never writes feature code** (`.ts/.tsx/.js/.sql/.lua/`) and never runs
  schema or data commands. Planning, task files, contracts, dispatch, verify — yes.
- The moment a task needs source read or written, dispatch it to a seat. Never
  do it in the orchestrator's own context.
- Dispatch to live herdr panes with `herdr agent prompt`. Never spawn an
  internal subagent to do a seat's job.
- Stuck or ambiguous → report to the human. Never fall back to doing it yourself.

## Builder–reviewer pair

Every task that changes code ends with an independent review by a **different**
agent than the author, before the task is `done`. The reviewer checks the exact
files the builder logged and writes its own verdict event:

```sh
node tools/team.mjs log <task-id> reviewer done --verdict "PASS" --note "..."
```

FAIL goes back to the builder. The orchestrator re-dispatches review at most once.

## Roster

Role = the position. Agent = the herdr pane filling it. Agent name and role name
are the same string, so the launch command needs no mapping table.

| Role | Agent (herdr) | Role file | Responsibility |
|---|---|---|---|
| orchestrator | `orchestrator` | `orchestrator.md` | intent, task files, dispatch, verify. Never feature code. |
| builder | `builder` | `builder.md` | implements the slice inside its scope |
| reviewer | `reviewer` | `reviewer.md` | independent read-only review of the exact files touched |
| qa | `qa` | `qa.md` | runs the real user paths against the running app |
| runner | `runner` | `runner.md` | shell only: git, npm, dev server, migrations, tests |

All seats run from this repository's root. Re-seat one after a restart:

```sh
herdr agent start <role> --kind claude --pane <pane> -- --agent <role>
```

Run `powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1` to bring the
whole team up in one workspace (`-DryRun` prints the plan without starting anything).

### Capability scoping

Every seat loads the same global config: MCP servers, skills and plugins all come
from `~/.claude`. There is no per-seat capability file, and no `.claude/` config
in this repo. What separates the seats is the role file alone — its system prompt.

**All five seats have the full tool set, including Write and Edit.** Read-only
roles (reviewer, qa) and the orchestrator's "never writes feature code" rule are
**discipline, not enforcement**. They are instructions in the role file, and a
seat that ignores them will not be stopped by the harness. Treat a violation as a
process failure and report it; do not assume the tooling prevented it.

This is a deliberate trade: it was chosen over per-seat tool allowlists so that
every seat can use MCP tools, skills and plugins without per-seat configuration.

MCP servers cannot be scoped per seat through a role file either way — `--agent`
does not read an agent file's `mcpServers` (Claude Code issue #44183). If you
later want a seat to have no MCP, it must come from launch flags
(`--strict-mcp-config`), not from the role file.

## Layout

```
agent-team/
├── state/
│   ├── AGENTS.md      <- this file
│   ├── CONTRACT.md    <- per-feature API/data contract (created as needed)
│   ├── events.jsonl   <- append-only state log (tools/team.mjs only)
│   ├── locks/         <- one dir per claimed task (the lock itself)
│   └── tasks/         <- one .md per task: prose only
├── tools/team.mjs     <- claim / release / log / ls / selftest
├── workspace/         <- the project repo(s); git-initialized before any edit
└── logs/              <- raw stdout/stderr per CLI run
```

## Safety

- Any run that modifies files goes through a git branch or worktree.
  `workspace/` projects must be git-initialized before a builder touches them.
- No installs, no network calls, no destructive commands (drop / delete / rm -rf)
  without explicit permission written into the task file.
