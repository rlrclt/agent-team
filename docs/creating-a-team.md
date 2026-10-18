# Creating your own team

This repository ships one example team. Nothing in the tooling is tied to it —
not the number of seats, not the role names, not the domain. This is how to
build a different one.

## The three pieces of a team

| Piece | File | What it decides |
|---|---|---|
| **Who exists** | `agents/<role>.md` | one file per seat — its prompt and its tools |
| **How they behave** | `state/AGENTS.md` | the contract every seat reads first |
| **How they start** | `scripts/seat-up.ps1` | reads `agents/`, seats one pane per file |

There is no roster list to keep in sync. **Add a role file and the seat exists.
Delete one and it is gone.** `seat-up.ps1` derives the team from `agents/`.

## Build a team in four steps

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

### 2. Write each role file

Create `agents/<role>.md`. The `name:` field must match the filename.

```markdown
---
name: builder
description: One line telling the orchestrator when to dispatch here.
model: inherit
effort: low
---

# <Role>

<What this seat owns, in the imperative.>

**Read `state/AGENTS.md` first, every session.**

## While working
- ...

## Finishing
node tools/team.mjs log <task-id> <role> done --note "..." --files "a.ts"
node tools/team.mjs release <task-id> <role>
```

Notes that matter:

- **Use the role's own name in the log commands.** Events are keyed by agent, and
  a mismatch makes the history unreadable.
- **`model: inherit`** keeps the seat on whatever model the session uses. Set a
  specific model only with a reason — a reviewer on a cheap model is a real
  trade, and a builder on one usually is not.
- **Leave `tools:` out** to grant every tool. An empty `tools:` grants *none*.
  See [capability-scoping.md](capability-scoping.md) before narrowing it.

### 3. Update the contract

Edit `state/AGENTS.md`:

1. The **Roster** table — one row per role you created.
2. The **Orchestrator hard rules** — if you renamed or dropped the orchestrator,
   this section must move to whichever seat plays that part, or be deleted.
3. The **Builder–reviewer pair** section — keep it if you kept both roles. If you
   dropped the reviewer, say explicitly what replaces the check, rather than
   leaving a rule that names a seat that does not exist.

The contract is what stops two seats doing the same work or nobody doing it. A
contract that names seats you deleted is worse than no contract.

### 4. Install and seat

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -DryRun   # see the plan
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1
```

`-DryRun` prints the exact commands without starting anything. Use it the first
time, and after any roster change.

## Worked example: a two-seat pair

The smallest useful team. No orchestrator — you talk to the builder directly.

```
agents/builder.md     implements, claims, logs, releases
agents/reviewer.md    audits the logged files, returns PASS or FAIL
state/AGENTS.md       roster has two rows; drop the orchestrator hard rules
```

```powershell
scripts\seat-up.ps1 -DryRun
# team: builder, reviewer
```

Then dispatch by hand:

```sh
herdr agent prompt builder "task 001 - <what to build>"
herdr agent prompt reviewer "review task 001 - files are in the log"
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

## Changing the multiplexer

Only two places assume herdr: the `herdr agent prompt` / `herdr agent read`
commands in `state/AGENTS.md`, and the launch calls in `scripts/seat-up.ps1`.
Replace those with your multiplexer's equivalents — send text to a pane, read a
pane, start a process in a pane — and the rest holds. The state layer never
touches the multiplexer; it is pure filesystem.

## Adding a queue, if you outgrow this

The state layer deliberately has no queue: work is dispatched by message and
tracked by claim plus event log. If you later want OpenRig-style `create / claim
/ handoff` with a waiting state, add it as a second command group in
`tools/team.mjs` writing to the same `events.jsonl`, rather than a second log.
One log that can be grepped beats two that must be reconciled.

## Pitfalls

- **A role file that is not installed.** `seat-up.ps1` fails loudly with the seat
  name instead of starting a half-team. The fix is always `install.ps1`.
- **`name:` not matching the filename.** `herdr agent start <role> --agent <role>`
  looks up the file by that name; a mismatch seats the wrong prompt.
- **A role file with no `state/AGENTS.md` read step.** The seat will be
  plausible and wrong — it will do the work but not claim it, so two seats can
  quietly duplicate an effort.
- **Adding seats before the work needs them.** Every seat costs context on every
  turn. Split late.
