#!/usr/bin/env node
// muster state layer: atomic claim + append-only event log + machine JSON tasks + peer messaging + learnings.
// usage: node tools/muster.mjs claim <task-id> <agent>
//        node tools/muster.mjs release <task-id> <agent> [reason]
//        node tools/muster.mjs log <task-id> <agent> <event> [--note ..] [--files ..] [--verdict ..] [--override-boundary ..]
//        node tools/muster.mjs new-task <id> <role> "<goal>" [--allow ".."] [--deny ".."] [--spec ".."] [--verify ".."]
//        node tools/muster.mjs view <task-id> [--json] [--raw]
//        node tools/muster.mjs status [task-id]
//        node tools/muster.mjs send <from-agent> <to-agent> "<message>"
//        node tools/muster.mjs inbox <agent>
//        node tools/muster.mjs learn [tag/keyword]
//        node tools/muster.mjs add-lesson <tag> "<lesson text>" [--forbid "a,b"]
//        node tools/muster.mjs ls
//        node tools/muster.mjs selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEAMS = path.join(ROOT, 'teams');

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const die = (m) => { console.error(m); process.exit(1); };

const TEAM_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

function resolveTeam(name, root = TEAMS) {
  if (!name) die('missing --team <name>. run: node tools/muster.mjs team list');
  if (!TEAM_NAME_RE.test(name)) {
    die(`invalid team name '${name}' (expected [a-z][a-z0-9-]{1,31})`);
  }
  const dir = path.join(root, name);
  if (!fs.existsSync(path.join(dir, 'team.json'))) {
    die(`team not found: ${name}. run: node tools/muster.mjs team list`);
  }
  const state = path.join(dir, 'state');
  return {
    dir,
    state,
    locks: path.join(state, 'locks'),
    events: path.join(state, 'events.jsonl'),
    learningsJsonl: path.join(state, 'learnings.jsonl'),
    learningsMd: path.join(state, 'LEARNINGS.md'),
  };
}

// Set once at argument parse time; every work command reads it through requireTeam().
let TEAM = null;
const requireTeam = () => TEAM || die('missing --team <name>. run: node tools/muster.mjs team list');


function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^\\/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

const ROLE_FORBIDDEN = {
  'builder-frontend': [
    /(?:^|[\\/])(app[\\/]api|api|actions|prisma|models|db|migrations)[\\/]/i,
    /\.(sql|prisma)$/i,
  ],
  'builder-backend': [
    /(?:^|[\\/])(components|styles|public)[\\/]/i,
    /(?:^|[\\/])app[\\/].*[\\/](page|layout|loading|error|not-found)\.tsx?$/i,
    /\.(css|scss|sass)$/i,
  ],
  'reviewer': [/.*/],
  'orchestrator': [/.*/],
  'qa': [/.*/],
};

// Baselines for the built-in roles. A team may invent its own roles, but then
// the built-in rules cannot know them — so a custom role is enforced from its
// own name: `<x>-core` never touches scripts/, `<x>-shell` never touches the
// CLI. That keeps a role split by file enforceable without a config file.
const CUSTOM_ROLE_RULES = [
  { match: /-core$/, forbid: [/(?:^|[\\/])(scripts|docs)[\\/]/i] },
  { match: /-shell$/, forbid: [/^tools[\\/]|(?:^|[\\/])tools[\\/][^\\/]*\.mjs$/i] },
];

function patternsFor(agent) {
  const key = roleKey(agent);
  if (ROLE_FORBIDDEN[key]) return ROLE_FORBIDDEN[key];
  const custom = CUSTOM_ROLE_RULES.find((r) => r.match.test(key));
  return custom ? custom.forbid : null;
}

function checkBoundary(agent, filesStr, override, taskId) {
  if (!filesStr || override) return;
  const files = filesStr.split(',').map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);

  // 1. Task-level deterministic allow/deny check (from task JSON if available)
  if (taskId) {
    const taskFile = findTaskFile(taskId);
    if (taskFile && taskFile.endsWith('.json')) {
      try {
        const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        if (task.boundary) {
          const { allow, deny } = task.boundary;
          for (const f of files) {
            if (deny && deny.length > 0) {
              for (const pat of deny) {
                if (globToRegex(pat).test(f)) {
                  die(`BOUNDARY VIOLATION: Task ${taskId} denies touching '${f}' (pattern: ${pat}). (Use --override-boundary "reason" if authorized)`);
                }
              }
            }
            if (allow && allow.length > 0) {
              const allowed = allow.some((pat) => globToRegex(pat).test(f));
              if (!allowed) {
                die(`BOUNDARY VIOLATION: '${f}' is not in Task ${taskId} allow list: [${allow.join(', ')}].`);
              }
            }
          }
        }
      } catch (err) {
        if (err.message && err.message.startsWith('BOUNDARY VIOLATION')) throw err;
      }
    }
  }

  // 2. Role-level baseline boundary check
  const patterns = patternsFor(agent);
  if (!patterns) return;
  for (const f of files) {
    for (const pat of patterns) {
      if (pat.test(f)) {
        die(`BOUNDARY VIOLATION: ${agent} cannot touch ${f}. (If approved, pass --override-boundary "reason")`);
      }
    }
  }
}

// One JSON object per line, appended with O_APPEND. Lines stay far under the
// 4KB NTFS atomic-append window, so concurrent writers cannot interleave.
function logEvent(ev) {
  fs.appendFileSync(requireTeam().events, JSON.stringify({ ts: now(), ...ev }) + '\n');
}

function ownerOf(id) {
  try { return fs.readFileSync(path.join(requireTeam().locks, id, 'owner'), 'utf8').trim(); }
  catch { return null; }
}

function claim(id, agent) {
  try {
    fs.mkdirSync(requireTeam().locks, { recursive: true });
    fs.mkdirSync(path.join(requireTeam().locks, id)); // atomic: throws EEXIST if another agent got it
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const held = ownerOf(id);
    die(`claim denied: ${id} is held by ${held ?? 'unknown'}${held === agent ? ' (you)' : ''}\n` +
        `if that holder is dead, release it: node tools/muster.mjs release ${id} ${agent} stale`);
  }
  fs.writeFileSync(path.join(requireTeam().locks, id, 'owner'), agent);
  logEvent({ task: id, agent, event: 'claim' });
  console.log(`claimed ${id} by ${agent}`);
}

function release(id, agent, reason = '') {
  const held = ownerOf(id);
  if (!held) {
    // A crash between mkdir and the owner write leaves a lock nobody owns.
    // `stale` is the recovery path the claim error message advertises.
    if (reason !== 'stale') die(`release denied: ${id} is not claimed`);
    fs.rmSync(path.join(requireTeam().locks, id), { recursive: true, force: true });
    logEvent({ task: id, agent, event: 'release', note: 'stale (no owner file)' });
    return console.log(`released ${id} (stale, had no owner)`);
  }
  if (held !== agent && reason !== 'stale') die(`release denied: ${id} is held by ${held}, not ${agent}`);
  fs.rmSync(path.join(requireTeam().locks, id), { recursive: true });
  logEvent({ task: id, agent, event: 'release', note: reason });
  console.log(`released ${id}`);
}

// Roles whose `done` closes work someone else wrote, and so needs a review.
const BUILDER_ROLES = ['builder-frontend', 'builder-backend', 'builder-core', 'builder-shell', 'builder', 'runner', 'qa'];

// A builder may only close a task another seat has reviewed with PASS.
function requireReview(id, agent, flags) {
  const key = roleKey(agent);
  if (!BUILDER_ROLES.includes(key) && !/-core$|-shell$/.test(key)) return;

  const reviewer = flags['reviewed-by'];
  if (!reviewer) {
    die(`${agent} cannot close ${id} without --reviewed-by <reviewer>.\n` +
        `  dispatch the review first: herdr agent prompt ${requireTeamName()}-<reviewer> "Review task ${id}"\n` +
        `  then close with: log ${id} ${agent} done ... --reviewed-by <reviewer>`);
  }
  if (roleKey(reviewer) === key) die(`${agent} cannot approve its own work (--reviewed-by ${reviewer})`);

  const passed = loadEvents().some((e) =>
    String(e.task) === String(id) &&
    roleKey(e.agent) === roleKey(reviewer) &&
    e.event === 'done' && String(e.verdict).toUpperCase() === 'PASS');
  if (!passed) die(`no PASS from '${reviewer}' recorded for task ${id}. Review it first:\n` +
                   `  log ${id} ${reviewer} done --verdict PASS --note "..."`);
}

function log(id, agent, event, flags) {
  if (event === 'done') {
    if (flags.files) {
      checkBoundary(agent, flags.files, flags['override-boundary'], id);
    }
    if (roleKey(agent) === 'reviewer') {
      const v = flags.verdict ? flags.verdict.toUpperCase() : '';
      if (v !== 'PASS' && v !== 'FAIL') {
        die('reviewer done requires --verdict PASS or --verdict FAIL');
      }
    } else {
      requireReview(id, agent, flags);
    }
  }
  logEvent({ task: id, agent, event, ...flags });
  console.log('logged');
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w[\w-]*)$/.exec(argv[i]);
    if (m) {
      const key = m[1];
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        out[key] = argv[++i];
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function findTaskFile(id) {
  if (!id) die('usage: muster.mjs view <task-id>');
  const tasksDir = path.join(requireTeam().state, 'tasks');
  if (!fs.existsSync(tasksDir)) return null;

  for (const ext of ['.json', '.md']) {
    const target = id.endsWith(ext) ? id : `${id}${ext}`;
    const direct = path.join(tasksDir, target);
    if (fs.existsSync(direct)) return direct;
  }

  const files = fs.readdirSync(tasksDir).filter((f) => !f.startsWith('TEMPLATE.'));
  const match = files.find((f) =>
    f.startsWith(`${id}.json`) ||
    f.startsWith(`${id}-`) ||
    f.startsWith(`${id}.md`) ||
    f === id
  );
  return match ? path.join(tasksDir, match) : null;
}

function loadLessons() {
  if (fs.existsSync(requireTeam().learningsJsonl)) {
    return fs.readFileSync(requireTeam().learningsJsonl, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  }
  if (!fs.existsSync(requireTeam().learningsMd)) return [];
  return fs.readFileSync(requireTeam().learningsMd, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ['))
    .map((l) => {
      const m = /^- \[([^\]]+)\]\s*(.+)$/.exec(l);
      return m ? { tag: m[1], rule: m[2], forbid: [] } : null;
    })
    .filter(Boolean);
}

function newTask(id, role, goal, flags) {
  if (!id || !role || !goal) {
    die('usage: muster.mjs new-task <id> <role> "<goal>" [--allow "a/**,b/**"] [--deny "c/**"] [--spec "s1;s2"] [--verify ".."]');
  }
  const tasksDir = path.join(requireTeam().state, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskFile = path.join(tasksDir, `${id}.json`);
  if (fs.existsSync(taskFile)) die(`task ${id} already exists`);

  const allow = flags.allow ? flags.allow.split(',').map((s) => s.trim()) : [];
  const deny = flags.deny ? flags.deny.split(',').map((s) => s.trim()) : [];
  const spec = flags.spec ? flags.spec.split(';').map((s) => s.trim()) : [goal];
  const verify = flags.verify || 'npm test';

  const task = {
    id,
    role,
    goal,
    boundary: { allow, deny },
    spec,
    verify,
  };

  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2) + '\n');
  logEvent({ task: id, agent: 'orchestrator', event: 'task_created', role, goal });
  console.log(`task created: ${taskFile}`);
}

function view(id, flags) {
  const file = findTaskFile(id);
  if (!file) die(`task not found: ${id}`);
  const content = fs.readFileSync(file, 'utf8');

  // 1. Structured JSON task handling
  if (file.endsWith('.json')) {
    const task = JSON.parse(content);
    if (flags.json || flags.raw) {
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    const out = [
      `TASK: ${task.id} | ROLE: ${task.role}`,
      `GOAL: ${task.goal}`,
      `ALLOW: ${(task.boundary?.allow || []).join(', ') || '*'}`,
      `DENY: ${(task.boundary?.deny || []).join(', ') || 'none'}`,
      'SPEC:',
      ...(task.spec || []).map((s, i) => `  ${i + 1}. ${s}`),
      `VERIFY: ${task.verify || 'none'}`,
    ];

    const scanText = `${task.id} ${task.role} ${task.goal} ${(task.spec || []).join(' ')}`.toLowerCase();
    const matched = loadLessons().filter((l) => scanText.includes(l.tag.toLowerCase()));
    if (matched.length > 0) {
      out.push('RULES:');
      for (const m of matched) {
        const f = m.forbid && m.forbid.length ? ` (forbid: ${m.forbid.join(',')})` : '';
        out.push(`  - [${m.tag}] ${m.rule}${f}`);
      }
    }
    console.log(out.join('\n'));
    return;
  }

  // 2. Fallback Markdown task handling
  if (flags.raw) {
    console.log(content);
    return;
  }
  const lines = content.split('\n');
  const out = [];
  let capture = false;
  let currentHeader = '';

  for (const line of lines) {
    if (line.startsWith('# ')) {
      out.push(line);
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      currentHeader = h2[1].trim();
      capture = ['Brief', 'Spec', 'Out of scope', 'Verify'].includes(currentHeader);
      if (capture) out.push(`\n## ${currentHeader}`);
      continue;
    }
    if (capture) out.push(line);
  }

  const textToScan = `${lines[0] || ''} ${content}`.toLowerCase();
  const matchedLessons = loadLessons().filter((l) => textToScan.includes(l.tag.toLowerCase()));
  if (matchedLessons.length > 0) {
    out.push('\n## ⚠️ Relevant Past Lessons:');
    for (const lm of matchedLessons) {
      const f = lm.forbid && lm.forbid.length ? ` (forbid: ${lm.forbid.join(',')})` : '';
      out.push(`- [${lm.tag}] ${lm.rule}${f}`);
    }
  }

  console.log(out.join('\n').trim());
}

function loadEvents() {
  if (!fs.existsSync(requireTeam().events)) return [];
  return fs.readFileSync(requireTeam().events, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// --- team management ---------------------------------------------------

const ROLES = ['orchestrator', 'builder-frontend', 'builder-backend', 'reviewer', 'qa', 'runner', 'designer', 'advisor'];

// agents/ holds the roster: one file per seat, filename is the role.
function rolesOf(teamDir) {
  const agents = path.join(teamDir, 'agents');
  if (!fs.existsSync(agents)) return [];
  return fs.readdirSync(agents)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

// A seat may report its installed name (`alpha-builder`). Strip the team
// prefix so role rules still apply instead of silently passing. Custom roles
// are matched by the boundary suffixes they encode (see CUSTOM_ROLE_RULES).
function roleKey(agent) {
  if (!agent) return agent;
  if (ROLES.includes(agent)) return agent;
  for (const role of ROLES) {
    if (agent.endsWith('-' + role)) return role;
  }
  const custom = CUSTOM_ROLE_RULES.find((r) => r.match.test(agent));
  if (custom) {
    // `alpha-builder-core` -> `builder-core`
    const m = /^.+?-([a-z0-9]+-[a-z0-9-]+)$/i.exec(agent);
    if (m && custom.match.test(m[1])) return m[1];
  }
  return agent;
}

function assertRosterTarget(target, roles) {
  if (!roles.includes(target)) {
    die(`unknown agent '${target}' - roles: ${roles.join(', ') || 'none'}`);
  }
}

function teamNames(root = TEAMS) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'team.json')))
    .sort();
}

function teamList(root = TEAMS) {
  const names = teamNames(root);
  if (names.length === 0) return console.log('no teams. run: node tools/muster.mjs team new <name> --workspace <path>');
  for (const name of names) {
    const t = JSON.parse(fs.readFileSync(path.join(root, name, 'team.json'), 'utf8'));
    const tasksDir = path.join(root, name, 'state', 'tasks');
    const locksDir = path.join(root, name, 'state', 'locks');
    const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => !f.startsWith('TEMPLATE.')).length : 0;
    const locks = fs.existsSync(locksDir) ? fs.readdirSync(locksDir).length : 0;
    console.log(`${name} ${t.status || 'draft'} ${t.workspace || '-'} tasks=${tasks} locks=${locks}`);
  }
}

function teamNew(name, workspace, root = TEAMS) {
  if (!name || !workspace) die('usage: node tools/muster.mjs team new <name> --workspace <path>');
  if (!TEAM_NAME_RE.test(name)) die(`invalid team name '${name}' (expected [a-z][a-z0-9-]{1,31})`);
  const dir = path.join(root, name);
  if (fs.existsSync(path.join(dir, 'team.json'))) die(`team already exists: ${name}`);
  fs.mkdirSync(path.join(dir, 'state', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({
    name,
    workspace,
    status: 'draft',
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'state', 'events.jsonl'), '');
  console.log(`team created: ${dir}`);
}

function teamInfo(name) {
  const dir = path.join(TEAMS, name);
  if (!fs.existsSync(path.join(dir, 'team.json'))) die(`team not found: ${name}`);
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'team.json'), 'utf8'));
  const agents = fs.existsSync(path.join(dir, 'agents'))
    ? fs.readdirSync(path.join(dir, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
    : [];
  console.log(`TEAM: ${t.name} | STATUS: ${t.status} | WORKSPACE: ${t.workspace}`);
  console.log(`ROLES: ${agents.join(', ') || 'none'}`);
  const locksDir = path.join(dir, 'state', 'locks');
  const locks = fs.existsSync(locksDir) ? fs.readdirSync(locksDir) : [];
  console.log(`LOCKS: ${locks.length ? locks.join(', ') : 'none'}`);
  const events = fs.existsSync(path.join(dir, 'state', 'events.jsonl'))
    ? fs.readFileSync(path.join(dir, 'state', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
  console.log('RECENT:');
  for (const line of events.slice(-5)) console.log('  ' + line);
}

function teamDoctor(name, root = TEAMS) {
  const problems = [];
  const dir = path.join(root, name);
  const fail = (m) => { problems.push(m); console.log(`FAIL: ${m}`); };
  const warn = (m) => console.log(`WARN: ${m}`);

  // 1. team.json parses and matches the directory name
  let t = null;
  try {
    t = JSON.parse(fs.readFileSync(path.join(dir, 'team.json'), 'utf8'));
    if (t.name !== name) fail(`team.json name '${t.name}' does not match directory '${name}'`);
  } catch {
    fail(`teams/${name}/team.json missing or unreadable`);
  }

  // 2. agents/ has at least two roles, each frontmatter name matching its file
  const roles = rolesOf(dir);
  if (roles.length < 2) fail(`agents/ needs at least two role files, found ${roles.length}`);
  for (const role of roles) {
    const text = fs.readFileSync(path.join(dir, 'agents', `${role}.md`), 'utf8');
    const m = /^---[\s\S]*?^name:\s*(\S+)/m.exec(text);
    if (m && m[1] !== role) fail(`agents/${role}.md declares name '${m[1]}'`);
  }
  for (const role of roles) {
    if (!patternsFor(role)) warn(`role '${role}' has no automatic boundary rule; only task allow/deny applies`);
  }

  // 3. installed counterparts
  const installedDir = path.join(os.homedir(), '.claude', 'agents');
  for (const role of roles) {
    if (!fs.existsSync(path.join(installedDir, `${name}-${role}.md`))) {
      warn(`${name}-${role} is not installed (run scripts/install.ps1 -Team ${name})`);
    }
  }

  // 4. another team's installed name cannot equal one of ours. Installed names
  // are `<team>-<role>`, so a clash needs nested names: team `web` with role
  // `team-orchestrator` and team `web-team` with role `orchestrator` both
  // install `web-team-orchestrator`.
  const ours = new Set(roles.map((r) => `${name}-${r}`));
  for (const other of teamNames(root)) {
    if (other === name) continue;
    for (const role of rolesOf(path.join(root, other))) {
      const theirs = `${other}-${role}`;
      if (ours.has(theirs)) fail(`installed name '${theirs}' also comes from team '${other}' (role '${role}')`);
    }
  }

  // 5. state/ layout
  if (!fs.existsSync(path.join(dir, 'state', 'events.jsonl'))) fail('state/events.jsonl missing');
  if (!fs.existsSync(path.join(dir, 'state', 'tasks'))) fail('state/tasks/ missing');

  // 6. workspace exists and is a git repo
  if (t && t.workspace) {
    const ws = path.resolve(path.dirname(root), t.workspace);
    if (!fs.existsSync(ws)) fail(`workspace '${t.workspace}' does not exist`);
    else if (!fs.existsSync(path.join(ws, '.git'))) fail(`workspace '${t.workspace}' is not a git repository`);
  } else if (t) {
    fail('team.json has no workspace');
  }

  // 7. stale locks: held by an agent with no role file
  const locksDir = path.join(dir, 'state', 'locks');
  if (fs.existsSync(locksDir)) {
    for (const task of fs.readdirSync(locksDir)) {
      const owner = teamOwnerOf(dir, task);
      if (owner && !roles.includes(owner)) {
        warn(`lock ${task} held by '${owner}' which has no role file; release with: node tools/muster.mjs --team ${name} release ${task} ${owner} stale`);
      }
    }
  }

  // Roster table drift (warning only)
  const contract = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(contract)) {
    const text = fs.readFileSync(contract, 'utf8');
    for (const role of roles) {
      if (!text.includes(role)) warn(`AGENTS.md Roster does not mention '${role}'`);
    }
  }

  const ok = problems.length === 0;
  if (ok && t && t.status !== 'ready') {
    t.status = 'ready';
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(t, null, 2) + '\n');
    console.log('status: ready');
  }
  console.log(ok ? `doctor: ${name} is healthy` : `doctor: ${name} has ${problems.length} problem(s)`);
  return { ok, problems };
}

function teamOwnerOf(teamDir, task) {
  try { return fs.readFileSync(path.join(teamDir, 'state', 'locks', task, 'owner'), 'utf8').trim(); }
  catch { return null; }
}

const MARKER = (name) => `<!-- muster: ${name} -->`;
// The marker must NOT be the first line: Claude Code's --agent loader only
// reads a file whose first line is the `---` frontmatter fence. It sits at the
// end instead.
const ownedBy = (text, name) =>
  text.includes(MARKER(name)) || text.includes(`<!-- agent-team: ${name} -->`);

function installTeam(name, dest, force, root = TEAMS) {
  const dir = path.join(root, name);
  if (!fs.existsSync(path.join(dir, 'team.json'))) die(`team not found: ${name}`);
  const roles = rolesOf(dir);
  if (roles.length === 0) die(`team ${name} has no role files in agents/`);
  fs.mkdirSync(dest, { recursive: true });

  let copied = 0, skipped = 0;
  const refused = [];
  for (const role of roles) {
    const src = path.join(dir, 'agents', `${role}.md`);
    const target = path.join(dest, `${name}-${role}.md`);
    let text = fs.readFileSync(src, 'utf8');

    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target, 'utf8');
      const ours = ownedBy(existing, name);
      if (!ours) { refused.push(target); continue; }
      if (!force) { skipped++; continue; }
    }

    // Name first, then the <team> token everywhere else.
    // \r?\n: git checks role files out with CRLF on Windows.
    text = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, (fm) =>
      fm.replace(/^name:\s*\S+/m, `name: ${name}-${role}`));
    text = text.split('<team>').join(name);
    fs.writeFileSync(target, text.trimEnd() + '\n' + MARKER(name) + '\n');
    copied++;
  }

  for (const t of refused) console.error(`  refused  ${path.basename(t)}  (not installed by team '${name}')`);
  console.log(`install ${name}: ${copied} copied, ${skipped} skipped${refused.length ? `, ${refused.length} refused` : ''}`);
  if (refused.length) die(`refusing to overwrite ${refused.length} file(s) not owned by team '${name}'`);
  return { copied, skipped, refused };
}

function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (/^--\w/.test(argv[i])) {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function teamInstallCmd(names, dest, force) {
  const target = dest || path.join(os.homedir(), '.claude', 'agents');
  const teams = names.length ? names : teamNames();
  if (teams.length === 0) die('no teams to install');
  for (const n of teams) installTeam(n, target, force);
}

// Pure and idempotent: applying it to already-rewritten text changes nothing.
function rewriteLegacyText(text, name) {
  let out = text;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const once = (re) => new RegExp(re, 'g');

  // The two top-level prose files move beside the team, not inside state/.
  out = out.replace(once(`(?<!teams\\/${esc(name)}\\/)state\\/AGENTS\\.md`), `teams/${name}/AGENTS.md`);
  out = out.replace(once(`(?<!teams\\/${esc(name)}\\/)state\\/CONTRACT\\.md`), `teams/${name}/CONTRACT.md`);
  // Everything else under state/ keeps its shape, one level deeper.
  out = out.replace(once(`(?<!teams\\/${esc(name)}\\/)state\\/`), `teams/${name}/state/`);

  // Every muster.mjs command gains --team, unless it already has one.
  out = out.replace(/node tools\/(?:team|muster)\.mjs (?!team )(?!--team )(?!selftest)([a-z][\w-]*)/g,
    (all, sub) => `node tools/muster.mjs --team ${name} ${sub}`);

  // herdr addresses gain the team prefix.
  for (const role of ROLES) {
    out = out.replace(new RegExp(`herdr agent prompt (?<!${esc(name)}-)${esc(role)}(?!-)`, 'g'),
      `herdr agent prompt ${name}-${role}`);
  }
  // A placeholder seat needs the prefix too. Runs after the <team> token is
  // already substituted in migrated text, so it uses the team name directly.
  out = out.replace(/herdr agent prompt <seat>/g, `herdr agent prompt ${name}-<seat>`);

  // Placeholder tokens left in role files.
  out = out.split('<team>').join(name);

  return out;
}

function importLegacy(name, workspace) {
  if (!name || !workspace) die('usage: node tools/muster.mjs team import-legacy <name> <workspace>');
  if (!TEAM_NAME_RE.test(name)) die(`invalid team name '${name}'`);

  const legacyState = path.join(ROOT, 'state');
  const legacyAgents = path.join(ROOT, 'agents');
  const target = path.join(TEAMS, name);

  if (fs.existsSync(target)) die(`teams/${name} already exists - nothing to migrate`);
  if (!fs.existsSync(legacyState) || !fs.existsSync(legacyAgents)) {
    die('no legacy state/ or agents/ at the repo root - migration already ran or this is a fresh clone');
  }
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    const dirty = execSync('git status --porcelain state agents', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (dirty) {
      die('commit or stash changes under state/ and agents/ first:\n' + dirty);
    }
  }

  fs.mkdirSync(path.join(target, 'state'), { recursive: true });
  moveDir(legacyAgents, path.join(target, 'agents'));

  // The two prose files move beside the team, not inside state/.
  for (const doc of ['AGENTS.md', 'CONTRACT.md']) {
    const from = path.join(legacyState, doc);
    if (!fs.existsSync(from)) continue;
    fs.writeFileSync(path.join(target, doc), fs.readFileSync(from, 'utf8'));
    fs.rmSync(from);
  }

  for (const item of fs.readdirSync(legacyState)) {
    const from = path.join(legacyState, item);
    const to = path.join(target, 'state', item);
    moveDir(from, to);
  }
  fs.rmSync(legacyState, { recursive: true, force: true });

  // Rewrite prose in the moved files.
  for (const doc of ['AGENTS.md', 'CONTRACT.md']) {
    const p = path.join(target, doc);
    if (fs.existsSync(p)) fs.writeFileSync(p, rewriteLegacyText(fs.readFileSync(p, 'utf8'), name));
  }
  for (const role of rolesOf(target)) {
    const f = path.join(target, 'agents', `${role}.md`);
    fs.writeFileSync(f, rewriteLegacyText(fs.readFileSync(f, 'utf8'), name));
  }
  const tasksDir = path.join(target, 'state', 'tasks');
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(tasksDir, f);
      fs.writeFileSync(p, rewriteLegacyText(fs.readFileSync(p, 'utf8'), name));
    }
  }

  fs.writeFileSync(path.join(target, 'team.json'), JSON.stringify({
    name,
    workspace,
    status: 'draft',
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  if (!fs.existsSync(path.join(target, 'state', 'events.jsonl'))) {
    fs.writeFileSync(path.join(target, 'state', 'events.jsonl'), '');
  }
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  console.log(`migrated legacy state into teams/${name}`);
  const r = teamDoctor(name);
  if (!r.ok) process.exit(1);
}

function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function teamCmd(args) {
  const [sub, ...a] = args;
  const flags = parseFlags(a);
  const pos = positional(a);
  if (sub === 'list') teamList();
  else if (sub === 'new') teamNew(pos[0], flags.workspace || pos[1]);
  else if (sub === 'info') teamInfo(pos[0]);
  else if (sub === 'doctor') {
    const r = teamDoctor(pos[0]);
    if (!r.ok) process.exit(1);
  }
  else if (sub === 'install') teamInstallCmd(pos, flags.dest, !!flags.force);
  else if (sub === 'import-legacy') importLegacy(pos[0], flags.workspace || 'workspace');
  else die('usage: muster.mjs team list|new <name> --workspace <path>|info <name>|doctor <name>|install [<name>]|import-legacy <name> --workspace <path>');
}

function status(id) {
  const events = loadEvents();
  const locks = fs.existsSync(requireTeam().locks) ? fs.readdirSync(requireTeam().locks) : [];

  if (id) {
    const held = ownerOf(id);
    const taskEvents = events.filter((e) => String(e.task) === String(id));
    console.log(`Task: ${id}`);
    console.log(`Lock: ${held ? `HELD by ${held}` : 'OPEN'}`);
    if (taskEvents.length === 0) {
      console.log('Events: none');
    } else {
      console.log('Recent events:');
      for (const e of taskEvents.slice(-5)) {
        const detail = e.verdict ? `[verdict: ${e.verdict}] ` : e.note ? `[${e.note}] ` : '';
        const f = e.files ? `(files: ${e.files}) ` : '';
        console.log(`  ${e.ts} | ${e.agent} -> ${e.event} ${detail}${f}`);
      }
    }
    return;
  }

  const tasksDir = path.join(requireTeam().state, 'tasks');
  const taskFiles = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter((f) => !f.startsWith('TEMPLATE.'))
    : [];

  console.log(`Active Locks (${locks.length}):`);
  for (const l of locks) console.log(`  ${l} -> ${ownerOf(l) ?? '?'}`);

  console.log(`\nTasks Overview (${taskFiles.length}):`);
  for (const tf of taskFiles) {
    const tid = tf.replace(/\.(json|md)$/, '');
    const held = ownerOf(tid);
    const revEvents = events.filter((e) => String(e.task) === tid || String(e.task) === tf);
    const last = revEvents[revEvents.length - 1];
    const lastDesc = last ? `${last.agent}:${last.event}${last.verdict ? `(${last.verdict})` : ''}` : 'no-events';
    console.log(`  [${tid}] ${held ? `CLAIMED(${held})` : 'UNCLAIMED'} | Last: ${lastDesc}`);
  }
}

// One argv array, no shell: a message containing " or & or %VAR% reaches herdr
// literally instead of being parsed by cmd.exe.
function herdrArgv(agentName, message) {
  return ['agent', 'prompt', agentName, message];
}

function herdrPrompt(agentName, message) {
  const [bin, ...args] = ['herdr', ...herdrArgv(agentName, message)];
  return execFileSync(bin, args, { stdio: 'ignore' });
}

// A seat that restarted re-orients with one command: who am I, what do I hold,
// what is waiting for me, what happened last.
function briefFor(role) {
  const team = requireTeam();
  const teamName = path.basename(team.dir);
  const roles = rolesOf(team.dir);
  assertRosterTarget(role, roles);
  const events = loadEvents();
  const held = fs.existsSync(team.locks) ? fs.readdirSync(team.locks).filter((id) => ownerOf(id) === role) : [];
  const waiting = events.filter((e) => e.event === 'msg' && e.to === role).slice(-5);
  const last = events.filter((e) => e.agent === role).slice(-5);

  const out = [
    `TEAM: ${teamName} | YOU: ${role} | herdr/agent name: ${teamName}-${role}`,
    `CONTRACT: teams/${teamName}/AGENTS.md (read it first)`,
    `WORK: node tools/muster.mjs --team ${teamName} ...`,
    `HELD: ${held.length ? held.join(', ') : 'nothing'}`,
    'WAITING:',
    ...(waiting.length ? waiting.map((m) => `  [${m.ts}] from ${m.from}: ${m.msg}`) : ['  none']),
    'YOUR LAST EVENTS:',
    ...(last.length ? last.map((e) => `  ${e.ts} | ${e.task ?? '-'} ${e.event}`) : ['  none']),
  ];
  return out.join('\n');
}

// A delegated message that cites no task is work nobody can track.
function orphanMessages() {
  const events = loadEvents();
  const tasks = new Set(
    fs.existsSync(path.join(requireTeam().state, 'tasks'))
      ? fs.readdirSync(path.join(requireTeam().state, 'tasks')).map((f) => f.replace(/\.(json|md)$/, ''))
      : []
  );
  return events.filter((e) => e.event === 'msg' && !e.task);
}

function send(fromAgent, toAgent, msg, taskId) {
  if (!fromAgent || !toAgent || !msg) {
    die('usage: muster.mjs send <from-agent> <to-agent> "<message>" --task <id>');
  }
  const roles = rolesOf(requireTeam().dir);
  assertRosterTarget(toAgent, roles);
  // Delegated work must name the task it belongs to, so it can be tracked.
  if (!taskId) die(`send requires --task <id>: a message that hands out work must cite the task. See: node tools/muster.mjs --team ${requireTeamName()} ls`);
  if (!findTaskFile(taskId)) die(`unknown task '${taskId}'. Create it first: node tools/muster.mjs --team ${requireTeamName()} new-task ${taskId} <role> "<goal>"`);
  logEvent({ event: 'msg', from: fromAgent, to: toAgent, task: taskId, msg });

  try {
    herdrPrompt(`${requireTeamName()}-${toAgent}`, `[from ${fromAgent}] ${msg}`);
    console.log(`delivered to ${toAgent}`);
  } catch (err) {
    // Logged but not delivered is not handled: a seat that never receives the
    // work will not report back. Fail loudly and say what to check.
    const why = err.code === 'ENOENT' ? 'herdr is not on PATH' : (err.message || String(err)).split('\n')[0];
    die(`message logged but NOT delivered to ${toAgent}: ${why}\n` +
        `  the recipient will not see it. Fix herdr, then re-send:\n` +
        `  node tools/muster.mjs --team ${requireTeamName()} send ${fromAgent} ${toAgent} "<message>" --task ${taskId}`);
  }
}

function requireTeamName() {
  return path.basename(requireTeam().dir);
}

function inbox(agent) {
  if (!agent) die('usage: muster.mjs inbox <agent>');
  const events = loadEvents();
  const msgs = events.filter((e) => e.event === 'msg' && e.to === agent);
  if (msgs.length === 0) {
    console.log(`inbox for ${agent}: (empty)`);
    return;
  }
  console.log(`inbox for ${agent} (${msgs.length} messages):`);
  for (const m of msgs.slice(-10)) {
    console.log(`  [${m.ts}] from ${m.from}: ${m.msg}`);
  }
}

function addLesson(tag, rule, flags = {}) {
  if (!tag || !rule) die('usage: muster.mjs add-lesson <tag> "<rule>" [--forbid "a,b"]');
  const forbid = flags.forbid ? flags.forbid.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const date = now().slice(0, 10);
  const entry = { tag, rule, forbid, date };
  fs.appendFileSync(requireTeam().learningsJsonl, JSON.stringify(entry) + '\n');
  logEvent({ event: 'lesson_added', tag, note: rule, forbid });
  console.log(`lesson recorded under [${tag}] in learnings.jsonl`);
}

function learn(query) {
  const list = loadLessons();
  if (list.length === 0) {
    console.log('no lessons recorded yet.');
    return;
  }
  const q = (query || '').toLowerCase();
  const matched = q
    ? list.filter((l) => l.tag.toLowerCase().includes(q) || l.rule.toLowerCase().includes(q))
    : list;

  if (matched.length === 0) {
    console.log(`no lessons matching "${query}"`);
    return;
  }
  console.log(`Learnings (${matched.length}):`);
  for (const m of matched) {
    const f = m.forbid && m.forbid.length ? ` (FORBID: ${m.forbid.join(', ')})` : '';
    console.log(`  [${m.tag}] ${m.rule}${f}`);
  }
}

function ls() {
  const locks = fs.existsSync(requireTeam().locks) ? fs.readdirSync(requireTeam().locks) : [];
  console.log(`claimed (${locks.length}):`);
  for (const id of locks) console.log(`  ${id}  <- ${ownerOf(id) ?? '?'}`);
  const tasks = fs.existsSync(path.join(requireTeam().state, 'tasks'))
    ? fs.readdirSync(path.join(requireTeam().state, 'tasks')).filter((f) => !f.startsWith('TEMPLATE.'))
    : [];
  console.log(`\ntask files (${tasks.length}): ${tasks.join(' ') || '-'}`);
  if (!fs.existsSync(requireTeam().events)) return console.log('\nevents: none');
  const lines = fs.readFileSync(requireTeam().events, 'utf8').trim().split('\n').slice(-10);
  console.log('\nlast events:');
  for (const l of lines) console.log('  ' + l);
}

// Returns a temp `teams/` directory root (the same shape resolveTeam expects).
function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-selftest-'));
  const teams = path.join(dir, 'teams');
  for (const t of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(teams, t, 'state', 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(teams, t, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(teams, t, 'team.json'),
      JSON.stringify({ name: t, workspace: '.', status: 'draft' }));
  }
  return teams;
}
const rmSandbox = (teamsRoot) => fs.rmSync(path.dirname(teamsRoot), { recursive: true, force: true });

function selftest() {
  const id = '__selftest__';
  const assert = (c, m) => { if (!c) die('SELFTEST FAIL: ' + m); };

  const realExit = process.exit, realErr = console.error;
  const quiet = () => {
    process.exit = () => { throw new Error('exited'); };
    console.error = () => {};
  };
  const loud = () => { process.exit = realExit; console.error = realErr; };

  // --- team resolution -------------------------------------------------
  quiet();
  let noTeam = false;
  TEAM = null;
  try { requireTeam(); } catch { noTeam = true; }
  loud();
  assert(noTeam, 'a work command without --team did not fail');

  quiet();
  let badTeam = false;
  try { resolveTeam('nope'); } catch { badTeam = true; }
  loud();
  assert(badTeam, 'unknown team did not fail');

  // Every work command must refuse --team-less invocation at the CLI. The set is WORK itself:
  // dispatch is one call site, so a command cannot be added ungated and cannot escape this loop.
  for (const c of Object.keys(WORK)) {
    const r = spawnSync(process.execPath, [process.argv[1], c], { encoding: 'utf8' });
    assert(r.status !== 0 && /--team/.test(r.stderr), `${c} did not reject a missing --team`);
  }
  assert(!Object.hasOwn(WORK, 'team') && !Object.hasOwn(WORK, 'selftest'), 'team/selftest must stay outside WORK');

  const sb = mkSandbox();
  const alpha = resolveTeam('alpha', sb), betaTeam = resolveTeam('beta', sb);
  assert(alpha.events !== betaTeam.events, 'two teams resolved to the same event log');
  assert(alpha.events.endsWith(path.join('teams', 'alpha', 'state', 'events.jsonl')), 'alpha event path wrong');

  // The rest of the suite runs inside the sandbox's alpha team.
  const savedTEAM = TEAM;
  TEAM = alpha;
  fs.writeFileSync(TEAM.events, '');

  claim(id, 'alice');
  assert(ownerOf(id) === 'alice', 'owner not recorded');

  let denied = false;
  quiet();
  try { claim(id, 'bob'); } catch { denied = true; }
  loud();
  assert(denied, 'double claim was allowed');
  assert(ownerOf(id) === 'alice', 'loser overwrote owner');

  let wrongRelease = false;
  quiet();
  try { release(id, 'bob'); } catch { wrongRelease = true; }
  loud();
  assert(wrongRelease, 'non-owner released the lock');

  release(id, 'alice', 'selftest done');
  assert(!fs.existsSync(path.join(requireTeam().locks, id)), 'lock survived release');
  claim(id, 'bob');
  assert(ownerOf(id) === 'bob', 're-claim after release failed');
  release(id, 'bob');

  // Boundary check selftest
  let boundaryBlocked = false;
  quiet();
  try { checkBoundary('builder-frontend', 'app/api/auth/route.ts', null, null); } catch { boundaryBlocked = true; }
  loud();
  assert(boundaryBlocked, 'frontend touching api was not blocked');

  let boundaryAllowed = false;
  try { checkBoundary('builder-frontend', 'app/components/nav.tsx', null, null); boundaryAllowed = true; } catch {}
  assert(boundaryAllowed, 'frontend touching components was blocked');

  let overrideWorked = false;
  try { checkBoundary('builder-frontend', 'app/api/auth/route.ts', 'emergency fix', null); overrideWorked = true; } catch {}
  assert(overrideWorked, 'override-boundary did not work');

  let reviewerBlocked = false;
  quiet();
  try { log(id, 'reviewer', 'done', {}); } catch { reviewerBlocked = true; }
  loud();
  assert(reviewerBlocked, 'reviewer done without verdict was allowed');

  let reviewerAllowed = false;
  try { log(id, 'reviewer', 'done', { verdict: 'PASS' }); reviewerAllowed = true; } catch {}
  assert(reviewerAllowed, 'reviewer done with PASS was rejected');

  // Peer messaging selftest (send now reads the roster from agents/)
  for (const r of ['builder-frontend', 'builder-backend']) {
    fs.writeFileSync(path.join(TEAM.dir, 'agents', `${r}.md`), `---\nname: ${r}\n---\n`);
  }
  newTask('msg-task', 'builder-backend', 'Answer the question', {});
  // No herdr in the test environment: delivery fails by design and must throw.
  quiet();
  let delivered = false;
  try { send('builder-frontend', 'builder-backend', 'selftest msg', 'msg-task'); delivered = true; } catch { delivered = false; }
  loud();
  const evs = loadEvents();
  const lastMsg = evs[evs.length - 1];
  assert(lastMsg.event === 'msg' && lastMsg.to === 'builder-backend', 'peer message not logged');
  assert(lastMsg.task === 'msg-task', 'peer message did not record its task');
  assert(!delivered, 'send claimed delivery while herdr was unavailable');

  // Task JSON creation & boundary test
  const testTaskId = '__selftest_task__';
  const testTaskFile = path.join(requireTeam().state, 'tasks', `${testTaskId}.json`);
  fs.rmSync(testTaskFile, { force: true });
  newTask(testTaskId, 'builder-frontend', 'Test Task', { allow: 'app/components/**', deny: 'app/api/**' });
  assert(fs.existsSync(testTaskFile), 'newTask failed to create JSON file');

  let taskDenyBlocked = false;
  quiet();
  try { checkBoundary('builder-frontend', 'app/api/route.ts', null, testTaskId); } catch { taskDenyBlocked = true; }
  loud();
  assert(taskDenyBlocked, 'task-level deny was not enforced');

  fs.rmSync(testTaskFile, { force: true });

  // --- state isolation: one team's event never reaches another -------------
  const sb5 = mkSandbox();
  const isoAlpha = resolveTeam('alpha', sb5), isoBeta = resolveTeam('beta', sb5);
  fs.writeFileSync(isoAlpha.events, '');
  fs.writeFileSync(isoBeta.events, '');
  const beforeIso = TEAM;
  TEAM = isoAlpha;
  logEvent({ task: 'iso-1', agent: 'builder-frontend', event: 'claim' });
  TEAM = beforeIso;
  assert(fs.readFileSync(isoAlpha.events, 'utf8').includes('iso-1'),
    'alpha log missing its own event');
  assert(!fs.readFileSync(isoBeta.events, 'utf8').includes('iso-1'),
    'event leaked into beta');
  rmSandbox(sb5);

  // --- team new --------------------------------------------------------
  const sb2 = mkSandbox();
  teamNew('gamma', 'workspace/gamma', sb2);
  const gdir = path.join(sb2, 'gamma');
  const gj = JSON.parse(fs.readFileSync(path.join(gdir, 'team.json'), 'utf8'));
  assert(gj.status === 'draft', 'new team was not draft');
  assert(gj.workspace === 'workspace/gamma', 'workspace not recorded');
  assert(fs.existsSync(path.join(gdir, 'agents')), 'agents/ not created');
  assert(fs.existsSync(path.join(gdir, 'state', 'tasks')), 'state/tasks not created');
  assert(fs.existsSync(path.join(gdir, 'state', 'events.jsonl')), 'events.jsonl not created');

  quiet();
  let dup = false;
  try { teamNew('gamma', 'workspace/gamma', sb2); } catch { dup = true; }
  loud();
  assert(dup, 'duplicate team name was accepted');

  quiet();
  let badName = false;
  try { teamNew('Bad Name', 'x', sb2); } catch { badName = true; }
  loud();
  assert(badName, 'invalid team name was accepted');
  rmSandbox(sb2);

  // --- roster and doctor -----------------------------------------------
  const sb3 = mkSandbox();
  const sb3Alpha = path.join(sb3, 'alpha');
  fs.mkdirSync(path.join(sb3Alpha, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sb3Alpha, 'agents', 'builder.md'), '---\nname: builder\n---\n');
  fs.writeFileSync(path.join(sb3Alpha, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
  const roles = rolesOf(sb3Alpha);
  assert(roles.includes('builder') && roles.includes('reviewer'), 'rolesOf did not read agents/');

  quiet();
  let badTarget = false;
  try { assertRosterTarget('ghost', roles); } catch { badTarget = true; }
  loud();
  assert(badTarget, 'send to a non-roster target was not refused');

  assert(roleKey('alpha-builder-frontend') === 'builder-frontend', 'prefixed role not resolved');
  assert(roleKey('builder-frontend') === 'builder-frontend', 'plain role changed');
  assert(roleKey('custom-role') === 'custom-role', 'unknown role was rewritten');

  // team.json in the sandbox points at '.', which is not a git repo => doctor fails
  const d1 = teamDoctor('alpha', sb3);
  assert(!d1.ok, 'doctor passed a team with no workspace');

  rmSandbox(sb3);

  // --- prefixed install -------------------------------------------------
  const sb4 = mkSandbox();
  fs.mkdirSync(path.join(sb4, 'alpha', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sb4, 'alpha', 'agents', 'builder.md'),
    '---\nname: builder\n---\nnode tools/muster.mjs --team <team> status\n');
  const dest = path.join(path.dirname(sb4), 'claude-agents');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const res = installTeam('alpha', dest, false, sb4);
  assert(res.copied === 1, 'install did not copy');
  const out = fs.readFileSync(path.join(dest, 'alpha-builder.md'), 'utf8');
  assert(out.includes('name: alpha-builder'), 'frontmatter name not prefixed');
  assert(out.includes('--team alpha'), '<team> token not substituted');
  assert(!out.includes('<team>'), 'token left unsubstituted');

  // F1 regression: Claude Code's --agent loader only reads a file whose first
  // line is the `---` fence. A marker line above it hides the whole agent.
  const installedText = fs.readFileSync(path.join(dest, 'alpha-builder.md'), 'utf8');
  assert(installedText.startsWith('---'), 'installed role file does not start with the frontmatter fence');
  assert(installedText.includes(`<!-- muster: alpha -->`), 'install marker missing');

  // F2 regression: the message reaches herdr as ONE argv element, never a
  // string the shell parses. Asserted on the argv this tool builds.
  const evil = 'hi" & echo PWNED & rem " %PATH%';
  const f2 = herdrArgv('alpha-builder-backend', `[from builder-frontend] ${evil}`);
  assert(f2.length === 4, 'herdr argv shape changed');
  assert(f2[2] === 'alpha-builder-backend', `herdr address wrong: ${f2[2]}`);
  assert(f2[3] === `[from builder-frontend] ${evil}`, 'message was rewritten before dispatch');
  assert(!/^[a-z]+ (agent|prompt) /i.test(f2[3]), 'args were flattened into one shell string');
  // The dispatched binary plus args must never be a single string with a shell.
  assert(typeof herdrArgv === 'function' && herdrArgv.length === 2, 'herdr dispatch signature changed');

  // F4 regression: nested team names that install the same file are caught.
  // web + role 'team-orchestrator' and web-team + role 'orchestrator' both
  // produce 'web-team-orchestrator'.
  const sb6 = mkSandbox();
  fs.mkdirSync(path.join(sb6, 'web', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sb6, 'web', 'team.json'), JSON.stringify({ name: 'web', workspace: '.', status: 'ready' }));
  fs.writeFileSync(path.join(sb6, 'web', 'agents', 'team-orchestrator.md'), '---\nname: team-orchestrator\n---\n');
  fs.writeFileSync(path.join(sb6, 'web', 'agents', 'other.md'), '---\nname: other\n---\n');
  fs.mkdirSync(path.join(sb6, 'web-team', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sb6, 'web-team', 'team.json'), JSON.stringify({ name: 'web-team', workspace: '.', status: 'ready' }));
  fs.writeFileSync(path.join(sb6, 'web-team', 'agents', 'orchestrator.md'), '---\nname: orchestrator\n---\n');
  fs.writeFileSync(path.join(sb6, 'web-team', 'agents', 'other.md'), '---\nname: other\n---\n');
  const d6 = teamDoctor('web-team', sb6);
  assert(!d6.ok, 'doctor missed a nested-name install collision');
  assert(d6.problems.some((p) => p.includes('web-team-orchestrator')), 'doctor did not name the colliding file');
  rmSandbox(sb6);

  // --- custom roles must keep their boundary -----------------------------
  // A team can invent its own roles (muster-dev has builder-core and
  // builder-shell). They must still be enforceable, and a seat that reports
  // its installed name must resolve to the same rule.
  const sb7 = mkSandbox();
  fs.mkdirSync(path.join(sb7, 'alpha', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sb7, 'alpha', 'agents', 'builder-core.md'), '---\nname: builder-core\n---\n');
  fs.writeFileSync(path.join(sb7, 'alpha', 'agents', 'builder-shell.md'), '---\nname: builder-shell\n---\n');
  const savedT = TEAM;
  TEAM = resolveTeam('alpha', sb7);

  quiet();
  let coreBlocked = false;
  try { checkBoundary('builder-core', 'scripts/seat-up.ps1', null, null); } catch { coreBlocked = true; }
  loud();
  assert(coreBlocked, 'builder-core touching scripts/ was allowed');

  quiet();
  let shellBlocked = false;
  try { checkBoundary('builder-shell', 'tools/muster.mjs', null, null); } catch { shellBlocked = true; }
  loud();
  assert(shellBlocked, 'builder-shell touching tools/muster.mjs was allowed');

  let coreAllowed = false;
  try { checkBoundary('builder-core', 'tools/muster.mjs', null, null); coreAllowed = true; } catch {}
  assert(coreAllowed, 'builder-core was blocked from its own file');

  // the installed (prefixed) name resolves to the same rule
  assert(roleKey('alpha-builder-core') === 'builder-core', 'prefixed custom role not resolved');
  quiet();
  let prefixedBlocked = false;
  try { checkBoundary('alpha-builder-core', 'scripts/seat-up.ps1', null, null); } catch { prefixedBlocked = true; }
  loud();
  assert(prefixedBlocked, 'builder-core reported by its installed name escaped its boundary');

  TEAM = savedT;
  rmSandbox(sb7);

  const stuck = path.join(requireTeam().locks, 'stuck-1');
  fs.mkdirSync(stuck, { recursive: true });
  quiet();
  let staleOk = false;
  try { release('stuck-1', 'alice', 'stale'); staleOk = true; } catch {}
  loud();
  assert(staleOk, 'a lock with no owner file could not be released as stale');
  assert(!fs.existsSync(stuck), 'stale release left the lock behind');

  // --- a builder cannot close a task without a review ---------------------
  // The contract says every code change is reviewed by someone who did not
  // write it. Nothing enforced that, and a live seat closed its task with no
  // reviewer at all. `--reviewed-by` cites the reviewer's PASS.
  const sb8 = mkSandbox();
  fs.mkdirSync(path.join(sb8, 'alpha', 'agents'), { recursive: true });
  for (const r of ['builder-frontend', 'reviewer']) {
    fs.writeFileSync(path.join(sb8, 'alpha', 'agents', `${r}.md`), `---\nname: ${r}\n---\n`);
  }
  const savedT8 = TEAM;
  TEAM = resolveTeam('alpha', sb8);
  newTask('rev-1', 'builder-frontend', 'Change a file', { allow: 'src/**' });

  quiet();
  let closedUnreviewed = false;
  try { log('rev-1', 'builder-frontend', 'done', { files: 'src/a.ts' }); } catch { closedUnreviewed = true; }
  loud();
  assert(closedUnreviewed, 'a builder closed a task with no review');

  quiet();
  let selfReview = false;
  try { log('rev-1', 'builder-frontend', 'done', { files: 'src/a.ts', 'reviewed-by': 'builder-frontend' }); } catch { selfReview = true; }
  loud();
  assert(selfReview, 'a builder could approve its own work');

  // a review that is not a PASS does not count
  log('rev-1', 'reviewer', 'done', { verdict: 'FAIL', note: 'bad' });
  quiet();
  let failedReview = false;
  try { log('rev-1', 'builder-frontend', 'done', { files: 'src/a.ts', 'reviewed-by': 'reviewer' }); } catch { failedReview = true; }
  loud();
  assert(failedReview, 'a FAILing review was accepted as approval');

  log('rev-1', 'reviewer', 'done', { verdict: 'PASS', note: 'ok' });
  let closed = false;
  try { log('rev-1', 'builder-frontend', 'done', { files: 'src/a.ts', 'reviewed-by': 'reviewer' }); closed = true; } catch {}
  assert(closed, 'a reviewed task could not be closed');

  // reviewer and orchestrator close their own events without a review
  let reviewerOwn = false;
  try { log('rev-1', 'reviewer', 'done', { verdict: 'PASS' }); reviewerOwn = true; } catch {}
  assert(reviewerOwn, 'reviewer needed a review of its own review');

  TEAM = savedT8;
  rmSandbox(sb8);

  // --- delivery failure must be loud -------------------------------------
  // A message that is logged but never delivered looks handled. If herdr is
  // missing or fails, send() must exit nonzero so the caller knows.
  const realPath = process.env.PATH;
  process.env.PATH = path.join(path.dirname(sb), 'no-herdr-here');
  quiet();
  let undelivered = false;
  try { send('builder-frontend', 'builder-backend', 'undeliverable', 'msg-task'); } catch { undelivered = true; }
  loud();
  process.env.PATH = realPath;
  assert(undelivered, 'a message that could not be dispatched was reported as delivered');

  // --- idea 2: startup brief -------------------------------------------
  // A seat that restarted must learn who it is, what it holds, and what is
  // waiting for it, in one command.
  fs.writeFileSync(path.join(TEAM.dir, 'agents', 'runner.md'), '---\nname: runner\n---\n');
  claim('task-held', 'builder-frontend');
  newTask('brief-task', 'builder-frontend', 'Produce the build', {});
  // delivery is unavailable here; the message is still logged, which is what
  // the brief reads.
  quiet();
  try { send('runner', 'builder-frontend', 'need the build output', 'brief-task'); } catch {}
  loud();
  const brief = briefFor('builder-frontend');
  assert(brief.includes('builder-frontend'), 'brief does not name the seat');
  assert(brief.includes('task-held'), 'brief omits the lock this seat holds');
  assert(brief.includes('need the build output'), 'brief omits pending messages');
  assert(brief.includes('alpha-builder-frontend'), 'brief omits the herdr address');
  release('task-held', 'builder-frontend');

  // --- idea 3: delegated messages must cite a task -----------------------
  quiet();
  let noTask = false;
  try { send('builder-frontend', 'runner', 'do the thing'); } catch { noTask = true; }
  loud();
  assert(noTask, 'a work message without --task was accepted');

  quiet();
  let badTask = false;
  try { send('builder-frontend', 'runner', 'do the thing', 'no-such-task'); } catch { badTask = true; }
  loud();
  assert(badTask, 'a message citing a nonexistent task was accepted');

  assert(orphanMessages().length === 0, 'a message with a task was counted as orphaned');
  // A hand-written legacy line with no task is what the scan exists to find.
  fs.appendFileSync(TEAM.events, JSON.stringify({ ts: now(), event: 'msg', from: 'runner', to: 'qa', msg: 'old' }) + '\n');
  assert(orphanMessages().length === 1, 'the orphan scan missed an untracked message');

  // a CRLF role file (git on Windows) must be prefixed too
  fs.writeFileSync(path.join(sb4, 'alpha', 'agents', 'qa.md'),
    '---\r\nname: qa\r\ndescription: x\r\n---\r\nbody\r\n');
  installTeam('alpha', dest, false, sb4);
  const crlfOut = fs.readFileSync(path.join(dest, 'alpha-qa.md'), 'utf8');
  assert(crlfOut.includes('name: alpha-qa'), 'CRLF frontmatter name not prefixed');
  assert(!crlfOut.includes('name: qa\r'), 'CRLF frontmatter left unprefixed');

  // a foreign file at the same target is refused, even with force
  fs.writeFileSync(path.join(dest, 'alpha-builder.md'), 'someone else\n');
  quiet();
  let refused = false;
  try { installTeam('alpha', dest, true, sb4); } catch { refused = true; }
  loud();
  assert(refused, 'foreign file was overwritten');
  assert(fs.readFileSync(path.join(dest, 'alpha-builder.md'), 'utf8') === 'someone else\n',
    'foreign file was modified');

  // files installed before the rename are still owned by their team
  fs.writeFileSync(path.join(dest, 'alpha-builder.md'), '<!-- agent-team: alpha -->\nlegacy\n');
  installTeam('alpha', dest, true, sb4);
  assert(fs.readFileSync(path.join(dest, 'alpha-builder.md'), 'utf8').includes('name: alpha-builder'),
    'a pre-rename marker was treated as foreign');

  // force overwrites a file this team installed
  fs.rmSync(path.join(dest, 'alpha-builder.md'));
  installTeam('alpha', dest, false, sb4);
  fs.writeFileSync(path.join(dest, 'alpha-builder.md'), '<!-- agent-team: alpha -->\nstale\n');
  const res2 = installTeam('alpha', dest, true, sb4);
  assert(res2.copied === 2, '-Force did not overwrite own prefix');
  assert(fs.readFileSync(path.join(dest, 'alpha-builder.md'), 'utf8').includes('name: alpha-builder'),
    'force left the file stale');
  assert(fs.readFileSync(path.join(dest, 'alpha-qa.md'), 'utf8').includes('name: alpha-qa'),
    'force did not refresh the skipped file');
  fs.rmSync(dest, { recursive: true, force: true });
  rmSandbox(sb4);

  // --- legacy rewrite ---------------------------------------------------
  const src = [
    'Read `state/AGENTS.md` first.',
    'node tools/muster.mjs claim 001 builder',
    'node tools/muster.mjs --team <team> status',
    'herdr agent prompt orchestrator "hi"',
  ].join('\n');
  const once = rewriteLegacyText(src, 'web-team');
  assert(once.includes('teams/web-team/AGENTS.md'), 'contract path not rewritten');
  assert(once.includes('--team web-team claim'), 'command not team-scoped');
  assert(!once.includes('muster.mjs --team web-team --team'), 'command rewritten twice');
  assert(once.includes('herdr agent prompt web-team-orchestrator'), 'herdr address not prefixed');
  assert(rewriteLegacyText('herdr agent prompt <seat> "x"', 'web-team')
    .includes('herdr agent prompt web-team-<seat>'), 'seat placeholder not prefixed');
  assert(rewriteLegacyText(once, 'web-team') === once, 'rewrite is not idempotent');
  fs.rmSync(path.join(requireTeam().locks, id), { recursive: true, force: true });
  TEAM = savedTEAM;
  rmSandbox(sb);
  console.log('SELFTEST PASS');
}

const argv = process.argv.slice(2);
const ti = argv.indexOf('--team');
if (ti !== -1) {
  if (argv[ti + 1] === undefined) die('--team needs a name. run: node tools/muster.mjs team list');
  TEAM = resolveTeam(argv[ti + 1]);
  argv.splice(ti, 2);
}
const [cmd, ...rest] = argv;
// Work commands: dispatched only through the single call site below, which calls requireTeam()
// first. A per-case gate cannot be forgotten and selftest iterates these keys at runtime.
// shortcut: a dispatch branch added outside WORK bypasses requireTeam(), add commands as WORK keys.
const WORK = {
  claim: (r) => claim(r[0], r[1]),
  release: (r) => release(r[0], r[1], r[2]),
  log: (r) => log(r[0], r[1], r[2], parseFlags(r.slice(3))),
  'new-task': (r) => newTask(r[0], r[1], r[2], parseFlags(r.slice(3))),
  view: (r) => view(r[0], parseFlags(r.slice(1))),
  status: (r) => status(r[0]),
  send: (r) => send(r[0], r[1], r[2], parseFlags(r.slice(3)).task),
  brief: (r) => console.log(briefFor(r[0])),
  orphans: () => {
    const o = orphanMessages();
    if (o.length === 0) console.log('no untracked messages');
    else { console.log(`untracked messages (${o.length}):`); for (const m of o) console.log(`  [${m.ts}] ${m.from} -> ${m.to}: ${m.msg}`); }
  },
  inbox: (r) => inbox(r[0]),
  learn: (r) => learn(r[0]),
  'add-lesson': (r) => addLesson(r[0], r[1], parseFlags(r.slice(2))),
  ls: () => ls(),
};

if (cmd === 'team') teamCmd(rest);
else if (cmd === 'selftest') selftest();
else if (Object.hasOwn(WORK, cmd)) { requireTeam(); WORK[cmd](rest); }
else die('usage: node tools/muster.mjs [--team <name>] claim|release|log|new-task|view|status|send|inbox|learn|add-lesson|ls\n' +
         '       node tools/muster.mjs team list|new|info|install|doctor|import-legacy\n' +
         '       node tools/muster.mjs selftest');
