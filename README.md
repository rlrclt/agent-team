# agent-team

A team of independent coding agents that **talk to each other directly** — not
subagents of one parent session.

Each teammate is its own long-lived process in its own terminal pane, with its
own context, its own identity, and its own task history. They coordinate through
a shared state directory on disk and message each other over the multiplexer CLI.

The point is that work outlives a single turn. A subagent dies when its parent's
turn ends; a seat keeps its name and its context across restarts, so the next
piece of work goes back to the same teammate.

```
┌──────────────┐   herdr agent prompt / wait   ┌──────────────┐
│ orchestrator │ ────────────────────────────► │   builder    │
│  (pane 1)    │ ◄──────────────────────────── │   (pane 2)   │
└──────┬───────┘        done / blocked         └──────┬───────┘
       │                                              │
       │         ┌──────────────────────┐             │
       └────────►│ state/               │◄────────────┘
                 │  AGENTS.md  contract │
                 │  tasks/*.md  prose   │
                 │  events.jsonl  state │
                 │  locks/    ownership │
                 └──────────────────────┘
```

## What you get

| Piece | What it does |
|---|---|
| `tools/team.mjs` | atomic claim / release / log / ls / selftest — no daemon, no dependency |
| `state/AGENTS.md` | the team contract every teammate reads first |
| `agents/*.md` | example role files: orchestrator, builder, reviewer, qa, runner |
| `scripts/install.ps1` | copies the role files into `~/.claude/agents/` |
| `scripts/seat-up.ps1` | brings the whole team up in one workspace |

## Requirements

- A terminal multiplexer that can drive agent panes. Built and tested against
  [herdr](https://github.com/herdrdev/herdr); the model is generic but the
  commands in `seat-up.ps1` and the contract are herdr-shaped.
- [Claude Code](https://claude.com/claude-code) (`claude`) on PATH.
- Node.js 22+ (for `tools/team.mjs`). No npm install — it is dependency-free.

## Quickstart

```powershell
git clone https://github.com/rlrclt/agent-team.git
cd agent-team

# 1. put the role files where Claude Code looks for them
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

# 2. check the plan, then bring the team up
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1

# 3. give the orchestrator work — it dispatches from there
herdr agent prompt orchestrator "Add a dark-mode toggle to <repo>."
herdr agent read orchestrator
```

You talk to the orchestrator. It writes a task file, dispatches to the seat that
owns the work, and reports back. You do not relay messages between teammates.

## Design decisions

**Prose and state live in different files.** A task's brief, spec and
out-of-scope notes are markdown — humans and models both read narrative better
than they query. Status is an append-only JSONL log written only through
`tools/team.mjs`. Mixing the two is what lets two teammates append the same
result twice.

**Claiming is atomic.** `mkdir state/locks/<id>` either wins or throws `EEXIST`.
The filesystem decides the owner, not a protocol. Verified: eight processes
racing for one claim produce exactly one winner.

**No database, no daemon.** At this scale SQLite buys query power nobody needs
yet and taxes every read with a subprocess. If the log ever outgrows grepping,
`events.jsonl` imports into SQLite in one pass.

**Talking beats polling.** `herdr agent wait --until done --until blocked` returns
the moment a teammate finishes or gets stuck. That is what makes this a team
rather than a message queue.

## How to build a different team

Nothing here is tied to five seats or to these five roles. To reshape it:

1. **Change the roster** in `state/AGENTS.md` and add role files to `agents/`.
   A two-seat pair (builder + reviewer) works as well as a large team.
2. **Split a role.** A frontend builder and a backend builder are two seats with
   two role files; the contract does not care.
3. **Change the state root.** `tools/team.mjs` resolves everything relative to
   itself, so moving the repo moves the state.
4. **Swap the multiplexer.** Replace the two `herdr` calls in the contract with
   your multiplexer's equivalents; nothing else assumes herdr.

Read [`docs/capability-scoping.md`](docs/capability-scoping.md) before you try to
give seats different tools, MCP servers, or plugins. Several obvious approaches
silently do nothing.

## License

MIT — see [LICENSE](LICENSE).
