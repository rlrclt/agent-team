# muster

A high-performance, machine-first team of independent AI coding agents running in dedicated terminal panes. Teammates talk to each other directly, enforce deterministic boundaries, and continuously learn from human feedback — without heavy frameworks or background daemons.

One repository hosts any number of **independent teams**. Each team lives in `teams/<name>/` with its own agents, contract, task queue, event log and lessons, so two teams can never see or overwrite each other's work.

Each teammate runs as its own long-lived process in its own terminal pane via [herdr](https://github.com/herdrdev/herdr), holding its own context, role identity, and memory. They coordinate through an atomic filesystem state layer and fast CLI tools.

```
┌──────────────┐     tools/muster.mjs send / herdr     ┌──────────────────┐
│ orchestrator │ ──────────────────────────────────► │ builder-frontend │
│  (pane 1)    │ ◄────────────────────────────────── │     (pane 2)     │
└──────┬───────┘          status / blocker           └────────┬─────────┘
       │                                                      │
       │                ┌──────────────────────┐              │
       │                │ teams/<name>/state/  │              │
       └───────────────►│  AGENTS.md contract  │◄─────────────┘
                        │  tasks/*.json specs  │
                        │  learnings.jsonl     │
                        │  events.jsonl state  │
                        │  locks/   ownership  │
                        └──────────────────────┘
```

---

## Key Features & Philosophy

1. **Machine-First & Token-Efficient:**
   - Tasks and Playbooks are structured JSON / JSONL (`state/tasks/*.json`, `state/learnings.jsonl`).
   - Fast CLI queries (`node tools/muster.mjs view <id>`) return ultra-dense constraints (~8 lines) instead of forcing agents to read 100-line Markdown files.
2. **Deterministic Scope Enforcement:**
   - Role boundaries (`builder-frontend` cannot touch backend APIs; `builder-backend` cannot touch UI) and Task boundaries (`allow` / `deny` globs) are validated programmatically at `log done`. Violations exit code 1 immediately.
3. **Continuous Learning (Playbook):**
   - Teach the team once (`node tools/muster.mjs add-lesson <tag> "<rule>"`). The rule is auto-injected whenever an agent views a relevant task, and the Reviewer fails code that repeats past mistakes.
4. **Peer-to-Peer Interaction:**
   - Agents can message and delegate to peers directly (`node tools/muster.mjs send <from> <to> "<msg>"`), with all exchanges logged to `events.jsonl` for auditability.
5. **Anti-Sycophancy (Human Challenge Gate):**
   - The Orchestrator actively challenges the human when instructions violate architecture, skip review/QA, or risk data loss, offering safe alternatives rather than blindly complying.
6. **Zero-Daemon / Zero-Dependency:**
   - State coordination uses plain Node.js standard libraries (`node:fs`, `node:path`, `node:child_process`). No database setup, no background daemons.

---

## The 6 Teammates

| Role | Herdr Pane | Role File | Scope & Responsibility |
|---|---|---|---|
| `orchestrator` | `p1` | `agents/orchestrator.md` | Requirements, API contracts, task generation, gatekeeping. **Never writes feature code.** |
| `builder-frontend` | `p2` | `agents/builder-frontend.md` | UI slices: App Router pages, components, CSS, a11y. **Never touches API, DB, or server.** |
| `builder-backend` | `p3` | `agents/builder-backend.md` | Server slices: route handlers, server actions, schemas, auth. **Never touches UI or styling.** |
| `qa` | `p4` | `agents/qa.md` | Evidence-based manual/user-path testing against running apps. **Never edits code.** |
| `reviewer` | `p5` | `agents/reviewer.md` | Read-only code review. Audits spec, boundaries, and past learnings. Gives PASS/FAIL. |
| `runner` | `p6` | `agents/runner.md` | Shell execution: git, npm, scaffold, dev servers, migrations, builds. |

---

## Quickstart (คู่มือการติดตั้งและใช้งาน)

### Prerequisites (สิ่งที่ต้องมีในเครื่อง)
* **Windows** (Native PowerShell) or macOS/Linux.
* **Node.js 22+** (on PATH).
* **[herdr](https://github.com/herdrdev/herdr)** (v0.9.5+ on PATH).
* **[Claude Code CLI](https://claude.com/claude-code)** (`claude` on PATH, signed in).

### Step 1: Clone Repository
```powershell
git clone https://github.com/rlrclt/muster.git
cd muster
```

### Step 2: Pick or Create a Team

One repository hosts many teams. Each team lives in `teams/<name>/` and owns its
own agents, contract and state — teams can never see or overwrite each other's
work.

```powershell
# See what exists
node tools/muster.mjs team list

# Create a new team (empty; you write its role files)
node tools/muster.mjs team new pbmobile ../pbmobile

# Or inspect the team that ships with this repo
node tools/muster.mjs team info web-team
```

A new team starts as `draft`. It becomes `ready` only when `doctor` passes — two
role files, a git-initialized workspace, and a valid `team.json`.

### Step 3: Install Role Files to Claude
Copies each team's role files into `~/.claude/agents/`, prefixed with the team
name (`web-team-orchestrator.md`), so two teams can never overwrite each other:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Team web-team
```

### Step 4: Check and Launch the Team
```powershell
# Health check: workspace, role files, installed copies, stale locks
node tools/muster.mjs team doctor web-team

# See the launch plan without starting anything
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -Team web-team -DryRun

# Launch the live team in its own herdr workspace
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -Team web-team
```
`seat-up.ps1` runs `doctor` first and refuses to start a team that is not `ready`.

### Step 5: Dispatch Work
You communicate with the **Orchestrator** (Pane 1). Every herdr address carries
the team prefix:
```powershell
herdr agent prompt web-team-orchestrator "Implement user registration flow in ../my-app"
```
The Orchestrator will:
1. Audit your request against contracts and clarify requirements.
2. Generate task JSON specs in `teams/web-team/state/tasks/<id>.json`.
3. Dispatch to `web-team-builder-frontend` and `web-team-builder-backend`.
4. Builders collaborate and report back.
5. `reviewer` and `qa` verify the work before it is marked complete.

---

## CLI Reference (`tools/muster.mjs`)

Every command is fast, dependency-free, and machine-friendly. Work commands need
`--team <name>`; there is no default team.

```sh
# 0. Team management
node tools/muster.mjs team list
node tools/muster.mjs team new pbmobile ../pbmobile
node tools/muster.mjs team info pbmobile
node tools/muster.mjs team doctor pbmobile

# 1. Create a machine-readable task (Orchestrator)
node tools/muster.mjs --team pbmobile new-task 001 builder-frontend "Add dark mode toggle" \
  --allow "app/components/**,app/globals.css" \
  --deny "app/api/**,prisma/**" \
  --spec "Add button;Save cookie" \
  --verify "npm test"

# 2. View task spec with auto-injected rules (<10 lines)
node tools/muster.mjs --team pbmobile view 001
# Or get raw JSON:
node tools/muster.mjs --team pbmobile view 001 --json

# 3. Claim and release task locks (Atomic filesystem lock)
node tools/muster.mjs --team pbmobile claim 001 builder-frontend
node tools/muster.mjs --team pbmobile release 001 builder-frontend

# 4. Log progress with strict boundary enforcement
node tools/muster.mjs --team pbmobile log 001 builder-frontend done --note "Added button" --files "app/components/theme.tsx"
# Reviewer logging verdict:
node tools/muster.mjs --team pbmobile log 001 reviewer done --verdict PASS --note "All specs satisfied"

# 5. Peer messaging (Talk directly to another agent)
node tools/muster.mjs --team pbmobile send builder-frontend builder-backend "Need response type for /api/user"
node tools/muster.mjs --team pbmobile inbox builder-backend

# 6. Continuous Learning (Playbook)
node tools/muster.mjs --team pbmobile add-lesson auth "Use httpOnly cookies for session JWT" --forbid "localStorage"
node tools/muster.mjs --team pbmobile learn auth

# 7. Check team status in 5 lines
node tools/muster.mjs --team pbmobile status
node tools/muster.mjs --team pbmobile ls
```

---

## Project Structure

```
muster/
├── teams/
│   └── web-team/           # one directory per team; the name is the team id
│       ├── team.json       # name, workspace, status (draft | ready)
│       ├── agents/         # role definitions (.md) — the roster
│       ├── AGENTS.md       # this team's contract
│       └── state/
│           ├── events.jsonl    # append-only state & messaging log
│           ├── learnings.jsonl # machine-readable past human lessons
│           ├── locks/          # atomic task directories (created on demand)
│           └── tasks/          # task specs (JSON & Markdown)
├── scripts/
│   ├── install.ps1     # Wrapper over `team install`; copies to ~/.claude/agents/
│   └── seat-up.ps1     # -Team <name>; doctor gate, then start the herdr workspace
├── tools/
│   └── muster.mjs        # teams, state, boundary guard & communication engine
└── workspace/          # example project repos (git-ignored)
```

Adding a team does not change this repo's code: `team new` creates `teams/<name>/`,
and `seat-up.ps1` seats whatever role files are in its `agents/`.

---

## License

MIT — see [LICENSE](LICENSE).

