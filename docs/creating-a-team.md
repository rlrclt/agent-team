# Creating your own team

This repository hosts many teams. Nothing in the tooling is tied to the one that
ships with it — not the number of seats, not the role names, not the domain.
This is how to build a new one.

## The four pieces of a team

| Piece | File | What it decides |
|---|---|---|
| **Who exists** | `teams/<name>/agents/<role>.md` | one file per seat — its prompt and its tools |
| **How they behave** | `teams/<name>/AGENTS.md` | the contract every seat reads first |
| **What it owns** | `teams/<name>/team.json` | the project repo, and whether the team is usable |
| **How they start** | `scripts/seat-up.ps1 -Team <name>` | reads `agents/`, seats one pane per file |

There is no roster list to keep in sync. **Add a role file and the seat exists.
Delete one and it is gone.** `seat-up.ps1` derives the team from `agents/`.

## Build a team in five steps

### 1. Decide the roles

Start from the work, not from a template. Ask: what are the distinct jobs, and
which of them must be done by someone other than the person who did the last one?

The pair that earns its place in almost every team is **builder + reviewer**.
Everything after that is optional and should be added when the work demands it:

| Role | Add it when |
|---|---|
| `orchestrator` | you want to talk to one seat instead of relaying between many |
| `builder` | always — something has to write the code |
| `reviewer` | always — something has to check it, by someone who did not write it |
| `qa` | the change has user-visible behaviour worth exercising for real |
| `runner` | shell work (install, migrate, serve, test) would drown a builder's context |
| `designer` | there are visual decisions to settle before code is written |
| `advisor` | some decisions are expensive enough to want a second opinion |

Two seats is a legitimate team. Five is not a target.

### 2. Create the team directory

```powershell
node tools/team.mjs team new pbmobile ../pbmobile
```

This creates an empty team — `team.json`, `agents/`, and an empty `state/` — and
nothing else. It is `draft`: it cannot be seated until it passes `doctor`.

There is no template and no inheritance: `agents/` starts empty and you write
each role file yourself. Copying one from another team's `agents/` (or from this
repo's git history) is fine — it is just a file.

### 3. Write each role file

Create `teams/<name>/agents/<role>.md`. The `name:` field must match the
filename; the installer adds the team prefix.

```markdown
---
name: builder
description: One line telling the orchestrator when to dispatch here.
model: inherit
effort: low
---

# <Role>

<What this seat owns, in the imperative.>

**Read `teams/<team>/AGENTS.md` first, every session.**

## While working
- ...

## Finishing
node tools/team.mjs --team <team> log <task-id> <role> done --note "..." --files "a.ts"
node tools/team.mjs --team <team> release <task-id> <role>
```

Write `<team>` where the team name belongs. `team install` substitutes it, so the
installed copy reads `--team pbmobile` and `herdr agent prompt pbmobile-<seat>`.

Notes that matter:

- **Use the role's own name in the log commands.** Events are keyed by agent, and
  a mismatch makes the history unreadable.
- **Names are prefixed at install.** A team's `builder` is installed as
  `pbmobile-builder`, and that is the herdr address and the `--agent` name. State
  inside the team stays unprefixed.
- **`model: inherit`** keeps the seat on whatever model the session uses. Set a
  specific model only with a reason — a reviewer on a cheap model is a real
  trade, and a builder on one usually is not.
- **Leave `tools:` out** to grant every tool. An empty `tools:` grants *none*.
  See [capability-scoping.md](capability-scoping.md) before narrowing it.

### 4. Write the contract and point at the project

`teams/<name>/AGENTS.md` is the team's contract — the shared truth every seat
reads first. Start from another team's and edit it; the Roster table inside it
must name the roles you created.

`team.json` says which project repository the team owns. One team owns one repo,
relative to this repository's root; `../something` points outside it:

```json
{
  "name": "pbmobile",
  "workspace": "../pbmobile",
  "status": "draft",
  "createdAt": "2026-10-21T09:00:00Z"
}
```

The workspace must exist and be a git repository before the team can be `ready`.

### 5. Check, install, seat

```powershell
node tools/team.mjs team doctor pbmobile                           # must pass
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Team pbmobile
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -Team pbmobile -DryRun
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -Team pbmobile
```

`doctor` prints every failure in one pass and only sets `status: ready` when the
team is usable. `-DryRun` prints the exact commands without starting anything.
Use it the first time, and after any roster change.

`install.ps1` refuses to overwrite a file in `~/.claude/agents/` that it did not
write for this team, so a team can never clobber another team's seat or a
personal agent of yours.

## Teams never touch each other

| Shared thing | How it is kept separate |
|---|---|
| Event log, tasks, locks, lessons | each team has its own `teams/<name>/state/` |
| Role files | installed as `<team>-<role>.md` in `~/.claude/agents/` |
| herdr seats and workspaces | agent name `<team>-<role>`, workspace labelled `<team>` |
| Every command | `--team <name>` is mandatory; there is no default |

Forgetting `--team` is an error, never a guess at which team you meant.

## Worked example: a two-seat pair

The smallest useful team. No orchestrator — you talk to the builder directly.

```
teams/design/agents/builder.md    implements, claims, logs, releases
teams/design/agents/reviewer.md   audits the logged files, returns PASS or FAIL
teams/design/AGENTS.md            roster has two rows; no orchestrator rules
```

```powershell
node tools/team.mjs team doctor design
node tools/team.mjs team install design
scripts\seat-up.ps1 -Team design -DryRun
# team: design (builder, reviewer)
```

Then dispatch by hand:

```sh
herdr agent prompt design-builder "task 001 - <what to build>"
herdr agent prompt design-reviewer "review task 001 - files are in the log"
```

The builder still claims and logs through `tools/team.mjs`, so ownership and
history work exactly the same with two seats as with five.

## Worked example: a larger team

Add seats as the work splits, not up front. A common shape once a project is real:

| Role | Owns |
|---|---|
| `orchestrator` | intent, task files, dispatch, verification |
| `architect` | decides the shape of a change before anyone writes it |
| `builder-frontend` | UI, components, client state |
| `builder-backend` | endpoints, validation, persistence |
| `reviewer` | independent audit of whatever the builders logged |
| `qa` | exercises the running app against the spec |
| `runner` | shell: install, migrate, serve, test |

Two builders is the interesting case: give **each its own task file** and a
non-overlapping file boundary, or they will edit the same files and the reviewer
will fail both. The contract's scope rule is what makes this safe.

## Moving a single-team repository to this layout

If you are upgrading a repository that still has `state/` and `agents/` at its
root, one command migrates it and rewrites the prose to the new paths:

```sh
git status                       # must be clean under state/ and agents/
node tools/team.mjs team import-legacy web-team ../my-app
node tools/team.mjs team doctor web-team
```

The migration refuses to run on a dirty tree or a second time; `git revert` is
the way back.

## Changing the multiplexer

Only two places assume herdr: the `herdr agent prompt` / `herdr agent read`
commands in the team contract, and the launch calls in `scripts/seat-up.ps1`.
Replace those with your multiplexer's equivalents — send text to a pane, read a
pane, start a process in a pane — and the rest holds. The state layer never
touches the multiplexer; it is pure filesystem.

## Adding a queue, if you outgrow this

The state layer deliberately has no queue: work is dispatched by message and
tracked by claim plus event log. If you later want OpenRig-style `create / claim
/ handoff` with a waiting state, add it as a second command group in
`tools/team.mjs` writing to the same per-team `events.jsonl`, rather than a
second log. One log that can be grepped beats two that must be reconciled.

## Pitfalls

- **A role file that is not installed.** `seat-up.ps1` fails loudly with the seat
  name instead of starting a half-team. The fix is `install.ps1 -Team <name>`.
- **`name:` not matching the filename.** After install, the name is
  `<team>-<role>`; a mismatch seats the wrong prompt.
- **A role file with no contract read step.** The seat will be plausible and
  wrong — it will do the work but not claim it, so two seats can quietly
  duplicate an effort.
- **A workspace that is not a git repository.** `doctor` refuses to make the team
  `ready`, and `seat-up` refuses to start it.
- **Adding seats before the work needs them.** Every seat costs context on every
  turn. Split late.
