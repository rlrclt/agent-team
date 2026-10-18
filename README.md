# agent-team

A high-performance, machine-first team of independent AI coding agents running in dedicated terminal panes. Teammates talk to each other directly, enforce deterministic boundaries, and continuously learn from human feedback — without heavy frameworks or background daemons.

Each teammate runs as its own long-lived process in its own terminal pane via [herdr](https://github.com/herdrdev/herdr), holding its own context, role identity, and memory. They coordinate through an atomic filesystem state layer and fast CLI tools.

```
┌──────────────┐     tools/team.mjs send / herdr     ┌──────────────────┐
│ orchestrator │ ──────────────────────────────────► │ builder-frontend │
│  (pane 1)    │ ◄────────────────────────────────── │     (pane 2)     │
└──────┬───────┘          status / blocker           └────────┬─────────┘
       │                                                      │
       │                   ┌──────────────────────┐           │
       │                   │ state/               │           │
       └──────────────────►│  AGENTS.md contract  │◄──────────┘
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
   - Fast CLI queries (`node tools/team.mjs view <id>`) return ultra-dense constraints (~8 lines) instead of forcing agents to read 100-line Markdown files.
2. **Deterministic Scope Enforcement:**
   - Role boundaries (`builder-frontend` cannot touch backend APIs; `builder-backend` cannot touch UI) and Task boundaries (`allow` / `deny` globs) are validated programmatically at `log done`. Violations exit code 1 immediately.
3. **Continuous Learning (Playbook):**
   - Teach the team once (`node tools/team.mjs add-lesson <tag> "<rule>"`). The rule is auto-injected whenever an agent views a relevant task, and the Reviewer fails code that repeats past mistakes.
4. **Peer-to-Peer Interaction:**
   - Agents can message and delegate to peers directly (`node tools/team.mjs send <from> <to> "<msg>"`), with all exchanges logged to `events.jsonl` for auditability.
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
git clone https://github.com/rlrclt/agent-team.git
cd agent-team
```

### Step 2: Install Role Files to Claude
Copies the role definition files into `~/.claude/agents/`:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Force
```

### Step 3: Launch the Whole Team
Brings up all 6 seats in a split herdr workspace:
```powershell
# Check setup without starting
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 -DryRun

# Launch the live team
powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1
```

### Step 4: Dispatch Work
You communicate with the **Orchestrator** (Pane 1). Give it your high-level goal:
```powershell
herdr agent prompt orchestrator "Implement user registration flow in workspace/my-app"
```
The Orchestrator will:
1. Audit your request against contracts and clarify requirements.
2. Generate task JSON specs in `state/tasks/<id>.json`.
3. Dispatch to `builder-frontend` and `builder-backend` asynchronously.
4. Builders collaborate and report back.
5. `reviewer` and `qa` verify the work before it is marked complete.

---

## CLI Reference (`tools/team.mjs`)

Every command is fast, dependency-free, and machine-friendly:

```sh
# 1. Create a machine-readable task (Orchestrator)
node tools/team.mjs new-task 001 builder-frontend "Add dark mode toggle" \
  --allow "app/components/**,app/globals.css" \
  --deny "app/api/**,prisma/**" \
  --spec "Add button;Save cookie" \
  --verify "npm test"

# 2. View task spec with auto-injected rules (<10 lines)
node tools/team.mjs view 001
# Or get raw JSON:
node tools/team.mjs view 001 --json

# 3. Claim and release task locks (Atomic filesystem lock)
node tools/team.mjs claim 001 builder-frontend
node tools/team.mjs release 001 builder-frontend

# 4. Log progress with strict boundary enforcement
node tools/team.mjs log 001 builder-frontend done --note "Added button" --files "app/components/theme.tsx"
# Reviewer logging verdict:
node tools/team.mjs log 001 reviewer done --verdict PASS --note "All specs satisfied"

# 5. Peer messaging (Talk directly to another agent)
node tools/team.mjs send builder-frontend builder-backend "Need response type for /api/user"
node tools/team.mjs inbox builder-backend

# 6. Continuous Learning (Playbook)
node tools/team.mjs add-lesson auth "Use httpOnly cookies for session JWT" --forbid "localStorage"
node tools/team.mjs learn auth

# 7. Check global team status in 5 lines
node tools/team.mjs status
```

---

## Project Structure

```
agent-team/
├── agents/             # Master role definitions (.md)
│   ├── orchestrator.md
│   ├── builder-frontend.md
│   ├── builder-backend.md
│   ├── reviewer.md
│   ├── qa.md
│   └── runner.md
├── scripts/
│   ├── install.ps1     # Copies role files to ~/.claude/agents/
│   └── seat-up.ps1     # Starts herdr workspace with all seats
├── state/
│   ├── AGENTS.md       # Central team contract
│   ├── CONTRACT.md     # Feature-level API contracts
│   ├── events.jsonl    # Append-only state & messaging log
│   ├── learnings.jsonl # Machine-readable past human lessons
│   ├── locks/          # Atomic task directories
│   └── tasks/          # Task specs (JSON & Markdown)
├── tools/
│   └── team.mjs        # Core state, boundary guard & communication engine
└── workspace/          # Your application repositories (ignored by git)
```

---

## License

MIT — see [LICENSE](LICENSE).

