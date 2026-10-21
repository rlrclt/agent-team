# Multi-Team Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-team repository into a multi-team system where each team owns an isolated state directory, every command names its team explicitly, and one command migrates the existing team intact.

**Architecture:** Per-team directories under `teams/<name>/` hold `team.json`, `agents/`, `AGENTS.md`, and `state/`. `tools/team.mjs` gains a `--team` flag that resolves state paths once at parse time, plus a `team` command group (`list`, `new`, `info`, `install`, `doctor`, `import-legacy`). The PowerShell scripts become thin wrappers over Node subcommands so the risky logic is testable from `selftest`.

**Tech Stack:** Node.js 22+ standard library only (`node:fs`, `node:path`, `node:child_process`). PowerShell 5.1 for the two wrapper scripts. No dependencies.

**Spec:** `docs/specs/2026-10-21-multi-team-architecture.md`

## Global Constraints

- Team name pattern: `[a-z][a-z0-9-]{1,31}`. Directory name equals team name.
- `--team` is mandatory for every work command (`status`, `view`, `claim`, `release`, `log`, `send`, `inbox`, `learn`, `add-lesson`, `ls`, `new-task`). There is no default team. `selftest` is the exception: it runs in its own sandbox and takes no `--team`.
- Status values: `draft` and `ready` only. `team doctor` sets `ready`.
- Claude Code role file name: `<team>-<role>.md`; frontmatter `name` matches.
- herdr dispatch address: `<team>-<role>`.
- State identity inside a team's own state: unprefixed `<role>`.
- Zero dependencies. `node:` standard library only.
- English in code and comments.
- Existing behavior that must not regress: atomic claim via `mkdir`, boundary enforcement at `log done`, reviewer verdict requirement, append-only event log.

## Review Focus

1. **A command run without `--team`** — a person typing from memory must get a clear usage error, never a silent operation against another team's state.
2. **Two teams with the same role name** — installing the second must be refused by name, never a silent overwrite in `~/.claude/agents/`.
3. **`import-legacy` on a dirty tree or a second run** — must refuse before touching anything.
4. **A team whose `workspace` does not exist** — `doctor` must report it and must not set `ready`; `seat-up` must then refuse to launch.
5. **Event log bleed between teams** — one team's `log`/`send`/`claim` must never write into another team's `events.jsonl`; `selftest` proves it.

---

### Task 1: Team path resolution and the `--team` flag

**Files:**
- Modify: `tools/team.mjs:15-27` (constants), `:521-536` (dispatch)
- Modify: `tools/team.mjs` — every function that references `STATE`, `LOCKS`, `EVENTS`, `LEARNINGS_JSONL`, `LEARNINGS_MD`

**Interfaces:**
- Produces: `resolveTeam(name) -> { dir, state, locks, events, learningsJsonl, learningsMd }`, `TEAM` module-level variable set once at parse time, `requireTeam()` which dies with usage when `--team` is missing.
- Produces: `listTeamNames() -> string[]` — reads `teams/*/team.json`.

- [ ] **Step 1: Write the failing test inside `selftest`**

Add to `selftest()` before its cleanup, using a temp root. Create `mkSandbox()` first:

```js
function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-selftest-'));
  fs.mkdirSync(path.join(dir, 'teams', 'alpha', 'state', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'teams', 'beta', 'state', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teams', 'alpha', 'team.json'), JSON.stringify({ name: 'alpha', workspace: '.', status: 'draft' }));
  fs.writeFileSync(path.join(dir, 'teams', 'beta', 'team.json'), JSON.stringify({ name: 'beta', workspace: '.', status: 'draft' }));
  return dir;
}
```

Assertions (use the existing `assert` helper):

```js
// no team named => usage error
process.exit = () => { throw new Error('exited'); };
console.error = () => {};
let noTeam = false;
TEAM = null;
try { requireTeam(); } catch { noTeam = true; }
process.exit = realExit; console.error = realErr;
assert(noTeam, 'a work command without --team did not fail');

// unknown team => usage error
let badTeam = false;
process.exit = () => { throw new Error('exited'); };
console.error = () => {};
try { resolveTeam('nope'); } catch { badTeam = true; }
process.exit = realExit; console.error = realErr;
assert(badTeam, 'unknown team did not fail');

// resolution is per team
const sb = mkSandbox();
const a = resolveTeam('alpha', sb), b = resolveTeam('beta', sb);
assert(a.events !== b.events, 'two teams resolved to the same event log');
assert(a.events.endsWith(path.join('teams', 'alpha', 'state', 'events.jsonl')), 'alpha event path wrong');
fs.rmSync(sb, { recursive: true, force: true });
```

- [ ] **Step 2: Run `node tools/team.mjs selftest` and verify it fails**

Expected: `ReferenceError: requireTeam is not defined` or a `selftest` failure. It must not print `SELFTEST PASS`.

- [ ] **Step 3: Implement resolution and the flag**

Replace the fixed constants with a resolver. Keep `ROOT`. Add `TEAMS = path.join(ROOT, 'teams')`.

```js
function resolveTeam(name, root = TEAMS) {
  if (!name) die('missing --team <name>. run: node tools/team.mjs team list');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) die(`invalid team name '${name}' (expected [a-z][a-z0-9-]{1,31})`);
  const dir = path.join(root, name);
  if (!fs.existsSync(path.join(dir, 'team.json'))) die(`team not found: ${name}. run: node tools/team.mjs team list`);
  const state = path.join(dir, 'state');
  return {
    dir, state,
    locks: path.join(state, 'locks'),
    events: path.join(state, 'events.jsonl'),
    learningsJsonl: path.join(state, 'learnings.jsonl'),
    learningsMd: path.join(state, 'LEARNINGS.md'),
  };
}
let TEAM = null;
const requireTeam = () => TEAM || die('missing --team <name>. run: node tools/team.mjs team list');
```

At dispatch, extract `--team <name>` from `rest` before the command switch, set `TEAM = resolveTeam(name)`, then call the command with the remaining args:

```js
const argv = process.argv.slice(2);
const ti = argv.indexOf('--team');
if (ti !== -1) { TEAM = resolveTeam(argv[ti + 1]); argv.splice(ti, 2); }
const [cmd, ...rest] = argv;
```

Every work command calls `requireTeam()` first. Replace each use of the old constants with the resolved field: `EVENTS` → `requireTeam().events`, `LOCKS` → `requireTeam().locks`, `STATE` → `requireTeam().state`, `LEARNINGS_JSONL` → `requireTeam().learningsJsonl`, `LEARNINGS_MD` → `requireTeam().learningsMd`. Note that `mkSandbox` tests pass a root explicitly; keep the `root` parameter for that reason.

Add `import os from 'node:os';` for `mkdtempSync`.

**The existing selftest body must be re-pointed at the sandbox in this same
task** — otherwise every claim/release/log assertion below the new ones dies
on `requireTeam()`. At the top of `selftest()`, before any assertion, build a
sandbox and point `TEAM` at its `alpha` team:

```js
const sb = mkSandbox();
const savedTEAM = TEAM;
TEAM = resolveTeam('alpha', sb);
```

and in the cleanup block restore `TEAM = savedTEAM;` then
`fs.rmSync(sb, { recursive: true, force: true });`. The old trick of snapshotting
`EVENTS` and restoring it is deleted along with the fixed paths: the sandbox
already keeps the real log untouched.

- [ ] **Step 4: Run `node tools/team.mjs selftest` and verify it passes**

Expected: `SELFTEST PASS`. Then run `node tools/team.mjs status` and expect the usage error.

- [ ] **Step 5: Commit**

```bash
git add tools/team.mjs
git commit -m "feat: resolve team state per --team, require the flag"
```

---

### Task 2: The `team list` / `new` / `info` commands

**Files:**
- Modify: `tools/team.mjs` — add `teamList()`, `teamNew()`, `teamInfo()`, extend the dispatch switch with a `team` group.

**Interfaces:**
- Consumes: `resolveTeam`, `TEAMS` from Task 1.
- Produces: `teamList()` prints one line per team: `<name> <status> <workspace> tasks=<n> locks=<n>`.
- Produces: `teamNew(name, workspace)` creates the directory layout and `team.json` with `status: 'draft'`.
- Produces: `teamInfo(name)` prints `team.json` fields, the role files, the held locks, and the last 5 events.

- [ ] **Step 1: Write the failing test**

```js
// team new creates a draft team with the full layout
const sb2 = mkSandbox();
teamNew('gamma', 'workspace/gamma', sb2);
const gj = JSON.parse(fs.readFileSync(path.join(sb2, 'teams', 'gamma', 'team.json'), 'utf8'));
assert(gj.status === 'draft', 'new team was not draft');
assert(fs.existsSync(path.join(sb2, 'teams', 'gamma', 'agents')), 'agents/ not created');
assert(fs.existsSync(path.join(sb2, 'teams', 'gamma', 'state', 'tasks')), 'state/tasks not created');
assert(fs.existsSync(path.join(sb2, 'teams', 'gamma', 'state', 'events.jsonl')), 'events.jsonl not created');

// duplicate refused
let dup = false;
process.exit = () => { throw new Error('exited'); };
console.error = () => {};
try { teamNew('gamma', 'workspace/gamma', sb2); } catch { dup = true; }
process.exit = realExit; console.error = realErr;
assert(dup, 'duplicate team name was accepted');

// invalid name refused
let badName = false;
process.exit = () => { throw new Error('exited'); };
console.error = () => {};
try { teamNew('Bad Name', 'x', sb2); } catch { badName = true; }
process.exit = realExit; console.error = realErr;
assert(badName, 'invalid team name was accepted');
fs.rmSync(sb2, { recursive: true, force: true });
```

- [ ] **Step 2: Run and verify it fails**

Run: `node tools/team.mjs selftest`
Expected: fails, `teamNew is not defined`.

- [ ] **Step 3: Implement the three commands**

`teamNew(name, workspace, root = TEAMS)` validates the name with the same regex, dies on an existing directory, then `mkdirSync` for `teams/<name>/{agents,state/tasks}` and writes `team.json` and an empty `events.jsonl`. `teamList(root = TEAMS)` reads every `teams/*/team.json`. `teamInfo(name)` reuses `resolveTeam` then prints fields plus `fs.readdirSync(agents)` and the last 5 events.

Dispatch:

```js
case 'team': {
  const [sub, ...a] = rest;
  if (sub === 'list') teamList();
  else if (sub === 'new') teamNew(a[0], a[1]);
  else if (sub === 'info') teamInfo(a[0]);
  else die('usage: team.mjs team list|new <name> <workspace>|info <name>');
  break;
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `node tools/team.mjs selftest`
Expected: `SELFTEST PASS`.

- [ ] **Step 5: Commit**

```bash
git add tools/team.mjs
git commit -m "feat: team list, new, info commands"
```

---

### Task 3: Roster-driven dispatch and `team doctor`

**Files:**
- Modify: `tools/team.mjs` — `send()` (delete `ROSTER` at `:362`), `log()` role-suffix resolution, `checkBoundary` role-suffix resolution, add `teamDoctor()`.

**Interfaces:**
- Consumes: `resolveTeam`, `teamList`, `mkSandbox` (selftest).
- Produces: `rolesOf(teamDir) -> string[]` reading `agents/*.md`.
- Produces: `teamDoctor(name) -> { ok: boolean, problems: string[] }` — prints every problem, sets `status: 'ready'` in `team.json` when checks 1, 2 and 6 pass.
- Produces: `roleKey(agent) -> string` — strips a known `<team>-` prefix via the suffix list.

- [ ] **Step 1: Write the failing test**

```js
// roster is read from agents/, not hardcoded
const sb3 = mkSandbox();
fs.mkdirSync(path.join(sb3, 'teams', 'alpha', 'agents'), { recursive: true });
fs.writeFileSync(path.join(sb3, 'teams', 'alpha', 'agents', 'builder.md'), '---\nname: builder\n---\n');
fs.writeFileSync(path.join(sb3, 'teams', 'alpha', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
const roles = rolesOf(path.join(sb3, 'teams', 'alpha'));
assert(roles.includes('builder') && roles.includes('reviewer'), 'rolesOf did not read agents/');

// unknown send target is an error
let badTarget = false;
process.exit = () => { throw new Error('exited'); };
console.error = () => {};
try { assertRosterTarget('ghost', roles); } catch { badTarget = true; }
process.exit = realExit; console.error = realErr;
assert(badTarget, 'send to a non-roster target was not refused');
```

`assertRosterTarget(target, roles)` is the small guard `send()` calls before
dispatching; it dies with `unknown agent '<x>' - roles: ...` when the target is
absent from `roles`.

```js
// role suffix resolution
assert(roleKey('alpha-builder') === 'builder', 'prefixed role not resolved');
assert(roleKey('builder') === 'builder', 'plain role changed');

// doctor refuses a draft team with no workspace
const d1 = teamDoctor('alpha', sb3);
assert(!d1.ok, 'doctor passed a team with no agents and no workspace');

fs.rmSync(sb3, { recursive: true, force: true });
```

- [ ] **Step 2: Run and verify it fails**

Expected: `rolesOf is not defined`.

- [ ] **Step 3: Implement roster reading, suffix resolution, doctor**

`rolesOf(teamDir)` lists `agents/*.md` and returns basenames. `roleKey(agent)` splits on `-` and, if the remainder matches a known role suffix list (`orchestrator|builder-frontend|builder-backend|reviewer|qa|runner|designer|advisor`), returns that suffix; otherwise returns the input unchanged. `send()` calls `requireTeam()`, replaces the hardcoded array with `rolesOf(TEAM.dir)`, and dispatches `herdr agent prompt <team>-<to>`.

`teamDoctor(name, root = TEAMS)` runs the seven checks from the spec,
collecting problems instead of dying, printing each as `FAIL: <check>`.
Checks 3 and 4 compare installed `<name>-<role>.md` files and other teams'
prefix sets; check 7 reports locks whose owner has no role file. It also
prints a non-fatal `WARN:` when a role in `agents/` does not appear in the
`AGENTS.md` Roster table, and when a custom role name has no automatic
boundary rule. On passes of 1, 2, 6 it rewrites `status: 'ready'` (preserving
other fields) and returns `{ ok, problems }`.

- [ ] **Step 4: Run and verify it passes**

Run: `node tools/team.mjs selftest`
Expected: `SELFTEST PASS`.

- [ ] **Step 5: Commit**

```bash
git add tools/team.mjs
git commit -m "feat: roster from agents/, doctor checks, prefixed herdr dispatch"
```

---

### Task 4: `team install` and the PowerShell wrappers

**Files:**
- Modify: `tools/team.mjs` — add `installTeam()`.
- Modify: `scripts/install.ps1` — thin wrapper.
- Modify: `scripts/seat-up.ps1` — `-Team` parameter, doctor gate, prefixed agent launch, team-labelled workspace.

**Interfaces:**
- Consumes: `rolesOf`, `teamDoctor`, `resolveTeam`.
- Produces: `installTeam(name, dest, force, root = TEAMS) -> { copied: number, skipped: number, refused: string[] }`.
- Produces: `install.ps1 -Team <name> [-Force]`; no `-Team` installs every team.
- Produces: `seat-up.ps1 -Team <name> [-DryRun]` — mandatory `-Team`.

- [ ] **Step 1: Write the failing test**

```js
// install writes prefixed copies and rewrites the name field
const sb4 = mkSandbox();
fs.mkdirSync(path.join(sb4, 'teams', 'alpha', 'agents'), { recursive: true });
fs.writeFileSync(path.join(sb4, 'teams', 'alpha', 'agents', 'builder.md'),
  '---\nname: builder\n---\nnode tools/team.mjs --team <team> status\n');
const dest = path.join(sb4, 'claude-agents');
fs.mkdirSync(dest, { recursive: true });
const res = installTeam('alpha', dest, false, sb4);
assert(res.copied === 1, 'install did not copy');
const out = fs.readFileSync(path.join(dest, 'alpha-builder.md'), 'utf8');
assert(out.includes('name: alpha-builder'), 'frontmatter name not prefixed');
assert(out.includes('--team alpha'), '<team> token not substituted');
assert(!out.includes('<team>'), 'token left unsubstituted');

// foreign file with the same target name is refused, not overwritten
fs.writeFileSync(path.join(dest, 'alpha-builder.md'), 'someone else\n');
let refused = false;
process.exit = () => { throw new Error('exited'); };
console.error = () => {};
try { installTeam('alpha', dest, false, sb4); } catch { refused = true; }
process.exit = realExit; console.error = realErr;
assert(refused, 'foreign file was overwritten');

// -Force overwrites its own prefix
const res2 = installTeam('alpha', dest, true, sb4);
assert(res2.copied === 1, '-Force did not overwrite own prefix');
fs.rmSync(sb4, { recursive: true, force: true });
```

- [ ] **Step 2: Run and verify it fails**

Expected: `installTeam is not defined`.

- [ ] **Step 3: Implement**

`installTeam` for each role file: target `path.join(dest, name + '-' + role +
'.md')`; if it exists, die unless `force` AND the file carries this team's
first-line marker `<!-- agent-team: <name> -->` (so `-Force` never clobbers a
foreign or personal agent); substitute `<team>` → team name and rewrite the
frontmatter `name:` line; write, marker first.

Rewrite `scripts/install.ps1` to parse `-Team` and `-Force`, then call `node tools/team.mjs team install <name>` (or no arg for all). Rewrite `scripts/seat-up.ps1`: `param([string]$Team, [switch]$DryRun)`, require `-Team`, read `teams/$Team/agents`, run `node tools/team.mjs team doctor $Team` and abort on nonzero, create workspace labelled `$Team`, launch with `--agent $Team-<role>`.

- [ ] **Step 4: Run and verify it passes**

Run: `node tools/team.mjs selftest`
Expected: `SELFTEST PASS`.
Then `powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -DryRun` and expect the `-Team` usage error.

- [ ] **Step 5: Commit**

```bash
git add tools/team.mjs scripts/install.ps1 scripts/seat-up.ps1
git commit -m "feat: prefixed install with collision guard, team-scoped seat-up"
```

---

### Task 5: `import-legacy` migration

**Files:**
- Modify: `tools/team.mjs` — add `importLegacy()`, `rewriteLegacyText()`.

**Interfaces:**
- Consumes: `resolveTeam`, `teamDoctor`.
- Produces: `importLegacy(name, workspace, root)` — refuses on a dirty tree, a second run, or an existing target; moves, rewrites, and prints the doctor report.
- Produces: `rewriteLegacyText(text, name) -> string` — pure, idempotent.

- [ ] **Step 1: Write the failing test**

```js
// rewrite is idempotent and covers the four forms
const src = [
  'Read `state/AGENTS.md` first.',
  'node tools/team.mjs claim 001 builder',
  'node tools/team.mjs --team <team> status',
  'herdr agent prompt orchestrator "hi"',
].join('\n');
const once = rewriteLegacyText(src, 'web-team');
assert(once.includes('teams/web-team/AGENTS.md'), 'contract path not rewritten');
assert(once.includes('--team web-team claim'), 'command not team-scoped');
assert(once.includes('herdr agent prompt web-team-orchestrator'), 'herdr address not prefixed');
assert(rewriteLegacyText(once, 'web-team') === once, 'rewrite is not idempotent');
```

- [ ] **Step 2: Run and verify it fails**

Expected: `rewriteLegacyText is not defined`.

- [ ] **Step 3: Implement**

`rewriteLegacyText` applies, in order: `state/AGENTS.md` → `teams/<name>/AGENTS.md`; `state/tasks` → `teams/<name>/state/tasks`; every `node tools/team.mjs ` occurrence gains `--team <name> ` immediately after `team.mjs ` unless `--team` already follows; `herdr agent prompt <role>` → `herdr agent prompt <name>-<role>` for roles in the suffix list; and `<team>` tokens left in role files become `<name>`.

`importLegacy` implements the spec's steps 0–6: check `git status --porcelain` under `state/` and `agents/`; refuse if `state/` or `agents/` is missing or `teams/<name>` exists; `mkdirSync`; `fs.renameSync` each item (falling back to copy+unlink across devices); rewrite text in each moved `.md`; write `team.json` with the given workspace; then run `teamDoctor(name)` and print it, exiting nonzero when not ok.

- [ ] **Step 4: Run and verify it passes**

Run: `node tools/team.mjs selftest`
Expected: `SELFTEST PASS`.

- [ ] **Step 5: Commit**

```bash
git add tools/team.mjs
git commit -m "feat: idempotent legacy migration"
```

---

### Task 6: Migrate the real team and update docs

**Files:**
- Run: `node tools/team.mjs team import-legacy web-team --workspace <path>`
- Modify: `README.md`, `docs/creating-a-team.md`, `docs/capability-scoping.md`
- Add: `teams/web-team/team.json`, moved `teams/web-team/{agents,AGENTS.md,state}`

**Interfaces:**
- Consumes every earlier task.

- [ ] **Step 1: Confirm the tree is clean**

Run: `git status --porcelain`
Expected: only `docs/specs/` and the plan (commit those first if needed). The migration refuses a dirty `state/` or `agents/`.

- [ ] **Step 2: Run the migration**

Run: `node tools/team.mjs team import-legacy web-team --workspace <the real project path>`
Expected: files moved, rewrite applied, doctor report printed. If doctor fails, fix what it names and re-run `team doctor web-team`.

- [ ] **Step 3: Verify the seeded state survived**

Run: `node tools/team.mjs --team web-team ls` and `node tools/team.mjs --team web-team status`
Expected: tasks 001 and 002 listed; the 15+ historical events still readable; no lock held.

- [ ] **Step 4: Update docs**

README: replace the single-team quickstart with `team new` / `team doctor` / `seat-up.ps1 -Team`. `docs/creating-a-team.md`: the three pieces become `teams/<name>/agents/`, `teams/<name>/AGENTS.md`, `seat-up.ps1 -Team`. `docs/capability-scoping.md`: launch examples gain the `<team>-` prefix.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: migrate the original team to teams/web-team, rewrite docs"
```

---

### Task 7: Sandbox isolation test and final verification

**Files:**
- Modify: `tools/team.mjs` — extend `selftest()` with the isolation cases.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing isolation test**

```js
// events never bleed between teams
const sb5 = mkSandbox();
const ev = path.join(sb5, 'teams', 'alpha', 'state', 'events.jsonl');
fs.writeFileSync(ev, '');
const origEvents = TEAM;
TEAM = resolveTeam('alpha', sb5);
logEvent({ task: 't1', agent: 'builder', event: 'claim' });
const alphaLog = fs.readFileSync(ev, 'utf8');
const betaLog = fs.readFileSync(path.join(sb5, 'teams', 'beta', 'state', 'events.jsonl'), 'utf8');
assert(alphaLog.includes('t1'), 'alpha log missing its own event');
assert(!betaLog.includes('t1'), 'event leaked into beta');
TEAM = origEvents;
fs.rmSync(sb5, { recursive: true, force: true });
```

- [ ] **Step 2: Run and verify the current suite still passes**

Run: `node tools/team.mjs selftest`
Expected: `SELFTEST PASS` (the isolation assertion forces `logEvent` to use `requireTeam()`; if it still closes over a constant, this fails).

- [ ] **Step 3: Fix any remaining fixed-path leaks**

Grep for the old constant names and ensure none remain:

Run: `grep -n "EVENTS\|LOCKS\|STATE\|LEARNINGS_JSONL\|LEARNINGS_MD" tools/team.mjs`
Expected: only the resolver and the selftest sandbox reference them.

- [ ] **Step 4: Full verification**

Run: `node tools/team.mjs selftest`
Run: `node tools/team.mjs team list`
Run: `node tools/team.mjs team doctor web-team`
Expected: `SELFTEST PASS`, the team listed, doctor ok.

- [ ] **Step 5: Commit**

```bash
git add tools/team.mjs
git commit -m "test: prove per-team state isolation"
```
