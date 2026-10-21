# TEAM CONTRACT — web-team

Read this file first. It is the shared truth for every agent on this team.

**You are team `web-team`.** Every work command needs `--team web-team`; without
it the tool refuses to run. Your herdr and `--agent` name is `web-team-<role>`,
while the `<role>` you pass to `muster.mjs log`/`claim`/`send` is unprefixed. This
team owns the repository named in `teams/web-team/team.json`.

## Two kinds of state (do not mix them)

| | where | who writes | why |
|---|---|---|---|
| **Prose** — brief, spec, known context, out-of-scope | `teams/web-team/state/tasks/<id>.md` | the author of the task | narrative; agents read it far better than they query |
| **State** — claimed / blocked / done / handoff | `teams/web-team/state/events.jsonl` | `tools/muster.mjs` only | append-only, atomic; never hand-edit |

Never write status into the task `.md`. Never write prose into the `.jsonl`.
Disk is the source of truth. Your memory is a hint.

## Reading task context (Do not read raw files)

Do not waste context reading raw task folders or parsing Markdown yourself. Use the fast query commands:

```sh
# Read focused brief, spec, out-of-scope, and verify command (<30 lines)
node tools/muster.mjs --team web-team view <task-id>

# Check active claims and team progress summary
node tools/muster.mjs --team web-team status [task-id]
```

## Claim before you work (mandatory)

A task has one owner at a time. Claiming is atomic — the winner is decided by
the filesystem, not by guessing.

```sh
node tools/muster.mjs --team web-team claim <task-id> <your-agent-name>
```

Denied means someone else owns it. Do not work on it, do not retry in a loop —
ask the orchestrator or pick different work. When done, and in the same turn:

```sh
node tools/muster.mjs --team web-team log <task-id> <agent> done --note "..." --files "a.ts,b.ts"
node tools/muster.mjs --team web-team release <task-id> <agent>
```

`muster.mjs log done` strictly checks role boundaries. A frontend agent touching `/api/` or a backend agent touching `/components/` will fail with exit 1.

A lock left behind by a dead agent is released by the orchestrator with an
explicit `release <id> <agent> stale`. Never release a lock you do not own.

## Talking to another agent (Peer Messaging & Reverse Reporting)

Agents can and SHOULD interact directly when coordinating on interfaces, asking clarification, or delegating runs.
Use `node tools/muster.mjs --team web-team send` to message any peer (it delivers via herdr and logs the interaction to `events.jsonl` for full visibility):

```sh
# Send a message / request to any peer
node tools/muster.mjs --team web-team send <your-agent> <target-seat> "<message>"

# Example: builder-frontend asking builder-backend for API response shape
node tools/muster.mjs --team web-team send builder-frontend builder-backend "Need response type for /api/books/claim"

# Example: builder-backend delegating a test run to runner
node tools/muster.mjs --team web-team send builder-backend runner "Run npm run test:db and report exit code"

# Check recent messages addressed to you
node tools/muster.mjs --team web-team inbox <your-agent>

# Status reporting back to orchestrator upon completion or blocker
herdr agent prompt web-team-orchestrator "[<agent> done] task <task-id> finished. Files: ... Verify: ..."
herdr agent prompt web-team-orchestrator "[<agent> blocked] task <task-id> blocked on: ..."
```

## Team Learnings & Past Human Corrections (Continuous Learning)

When the human teaches a rule or corrects a mistake, record it so no agent ever repeats it:

```sh
# Add a lesson taught by the human
node tools/muster.mjs --team web-team add-lesson <tag> "<what to do or what not to do>"

# Query past lessons before coding or reviewing
node tools/muster.mjs --team web-team learn [tag/keyword]
```
`muster.mjs view <task-id>` automatically detects and displays relevant past lessons at the top of the task spec.
Reviewers must audit changes against `node tools/muster.mjs --team web-team learn` — any regression to a known mistake is an automatic FAIL.

## Rules for ALL agents

1. One claim, one task. No parallel claims to "reserve" work.
2. Stay inside your task's scope. Touching anything else needs a line in the log.
3. Never edit another agent's task file.
4. When finished: log done, release lock, then report back to orchestrator:
   `herdr agent prompt web-team-orchestrator "[<agent> done] task <id> finished. Files: ... Verify: ..."`
   When blocked: `log <id> <agent> blocked --note "<what is missing>"`, release, and report:
   `herdr agent prompt web-team-orchestrator "[<agent> blocked] task <id> blocked on: ..."`
   Do not guess, do not ask the human directly — report to the orchestrator.
5. If your context was compacted: do not trust memory. Re-read
   `teams/web-team/state/tasks/*.md`, run `node tools/muster.mjs --team web-team ls`, reconcile, report one line.
6. English in code and comments. Thai is fine in conversation with the orchestrator.

## Orchestrator hard rules (binding)

- **Never writes feature code** (`.ts/.tsx/.js/.sql/.lua/.css/.prisma/`) and never runs
  schema or data commands. Planning, task files, contracts, dispatch, verify — yes.
- The moment a task needs source read or written, dispatch it to a seat. Never
  do it in the orchestrator's own context.
- Dispatch to live herdr panes with `herdr agent prompt`. Never spawn an
  internal subagent to do a seat's job.
- Stuck or ambiguous → report to the human. Never fall back to doing it yourself.
- **Challenge bad or risky human instructions (Anti-Sycophancy)**: If the human requests
  an architectural violation (e.g. frontend touching database directly), schema destruction
  without backup, skipping review/qa gates, or vague one-liners for complex changes:
  **STOP and WARN immediately**. State the risk, what will break, and propose 2 safe
  alternatives. Never execute risky orders blindly.

## Builder–reviewer pair

Every task that changes code ends with an independent review by a **different**
agent than the author, before the task is `done`. The reviewer checks the exact
files the builder (frontend or backend) logged against the task spec, the
contract, and the builder's file boundary — a frontend task touching backend
files (or the reverse) is WARNED even if the code is good. The reviewer writes
its own verdict event:

```sh
node tools/muster.mjs --team web-team log <task-id> reviewer done --verdict "PASS" --note "..."
```

FAIL goes back to the builder. The orchestrator re-dispatches review at most once.

## Roster

Role = the position. Agent = the herdr pane filling it. Agent name and role name
are the same string, so the launch command needs no mapping table.

| Role | Agent (herdr) | Role file | Responsibility |
|---|---|---|---|
| orchestrator | `orchestrator` | `orchestrator.md` | intent, task files, the API contract between builders, dispatch, verify. Never feature code. |
| builder-frontend | `builder-frontend` | `builder-frontend.md` | UI slices: App Router pages/components, client state, styling, a11y. Never backend/API/schema. |
| builder-backend | `builder-backend` | `builder-backend.md` | server slices: route handlers, server actions, data model, auth, validation. Never UI. |
| reviewer | `reviewer` | `reviewer.md` | independent read-only review of the exact files touched |
| qa | `qa` | `qa.md` | runs the real user paths against the running app |
| runner | `runner` | `runner.md` | shell only: git, npm, scaffold, dev server, migrations, builds |

All seats run from this repository's root. Re-seat one after a restart:

```sh
herdr agent start web-team-<role> --kind claude --pane <pane> -- --agent web-team-<role>
```

Run `powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -Team web-team`
to bring the whole team up in one workspace (`-DryRun` prints the plan without
starting anything). It runs `team doctor` first and refuses to start a team that
is not ready.

### Capability scoping

Every seat loads the same global config: MCP servers, skills and plugins all come
from `~/.claude`. There is no per-seat capability file, and no `.claude/` config
in this repo. What separates the seats is the role file alone — its system prompt.

**All six seats have the full tool set, including Write and Edit.** Read-only
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
muster/
├── teams/web-team/
│   ├── team.json      <- name, workspace, status
│   ├── agents/        <- this team's role files (the roster)
│   ├── AGENTS.md      <- this file
│   └── state/
│       ├── CONTRACT.md    <- per-feature API/data contract (created as needed)
│       ├── events.jsonl   <- append-only state log (tools/muster.mjs only)
│       ├── locks/         <- one dir per claimed task (the lock itself)
│       └── tasks/         <- one .md per task: prose only
├── tools/muster.mjs     <- team management + claim / release / log / ls / selftest
├── workspace/         <- the project repo(s); git-initialized before any edit
└── logs/              <- raw stdout/stderr per CLI run
```

## Safety

- Any run that modifies files goes through a git branch or worktree.
  `workspace/` projects must be git-initialized before a builder touches them.
- No installs, no network calls, no destructive commands (drop / delete / rm -rf)
  without explicit permission written into the task file.
