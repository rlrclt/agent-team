# TEAM CONTRACT — muster-dev

Read this file first. It is the shared truth for every agent on this team.

**You are team `muster-dev`.** Every work command needs `--team muster-dev`; without it
the tool refuses to run. Your herdr and `--agent` name is `muster-dev-<role>`,
while the `<role>` you pass to `muster.mjs log`/`claim`/`send` is unprefixed.
This team owns the repository named in `teams/muster-dev/team.json` — for this team
that is muster itself.

## Re-orienting after a restart

Do not guess, and do not trust memory. One command tells you who you are, what
you hold, and who is waiting:

```sh
node tools/muster.mjs --team muster-dev brief <your-role>
```

## Two kinds of state (do not mix them)

| | where | who writes | why |
|---|---|---|---|
| **Prose** — brief, spec, out-of-scope | `teams/muster-dev/state/tasks/<id>.md` | the author of the task | narrative; agents read it far better than they query |
| **State** — claimed / blocked / done | `teams/muster-dev/state/events.jsonl` | `tools/muster.mjs` only | append-only, atomic; never hand-edit |

Never write status into the task `.md`. Never write prose into the `.jsonl`.
Disk is the source of truth.

## Claim before you work (mandatory)

```sh
node tools/muster.mjs --team muster-dev claim <task-id> <your-role>
```

Claiming is atomic; the winner is decided by the filesystem. Denied means
someone else owns it — pick other work, do not retry in a loop.

When done, in the same turn:

```sh
node tools/muster.mjs --team muster-dev log <task-id> <role> done --note "..." --files "a.ts,b.ts"
node tools/muster.mjs --team muster-dev release <task-id> <role>
```

`log done` checks both the task's `allow`/`deny` globs and the role baseline;
a violation exits 1.

A lock left by a dead agent is cleared by the orchestrator with an explicit
`release <id> <agent> stale`. Never release a lock you do not own.

## The file boundary is the team's main safety mechanism

| Role | May touch |
|---|---|
| `builder-core` | `tools/muster.mjs` |
| `builder-shell` | `scripts/**`, `README.md`, `docs/**` |
| `orchestrator` | task files only — never code |
| `reviewer` | nothing; read-only |

Two builders exist because two filesets exist, not because the work is large.
If a task needs both, it is two tasks.

## Talking to another agent

A message that hands out work must cite the task it belongs to, so it can be
tracked:

```sh
node tools/muster.mjs --team muster-dev send <your-role> <target-role> "<message>" --task <task-id>
node tools/muster.mjs --team muster-dev inbox <your-role>
node tools/muster.mjs --team muster-dev orphans      # should always be empty
```

Report to the orchestrator when done or blocked:
`herdr agent prompt muster-dev-orchestrator "[<role> done] task <id> ..."`

## Learnings

```sh
node tools/muster.mjs --team muster-dev add-lesson <tag> "<rule>" [--forbid "a,b"]
node tools/muster.mjs --team muster-dev learn [tag]
```

`view <task-id>` injects matching lessons automatically. Reviewers must fail a
change that repeats a recorded mistake.

## Invariants this project must keep

muster exists to run isolated teams. Any change that weakens these is wrong,
even if it is convenient:

1. No state shared between teams; every path comes from `resolveTeam()`.
2. `--team` is mandatory; there is no default team.
3. Installing one team cannot overwrite another team's file in
   `~/.claude/agents/`.
4. An installed role file starts with `---` on line one, or Claude Code's
   `--agent` loader ignores it.
5. User input never becomes a shell string; use an argv array.
6. A lock is always recoverable, including one with no owner file.
7. `selftest` covers new behaviour and passes before a task is logged done.

## Orchestrator hard rules

- Never writes code. Dispatch to the owning builder.
- Splits work along the file boundary, never by "amount of work".
- Challenges a request that breaks an invariant above, with two safe
  alternatives, instead of executing it.
- Re-dispatches review at most once after a FAIL.
