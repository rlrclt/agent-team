#!/usr/bin/env node
// agent-team state layer: atomic claim + append-only event log + machine JSON tasks + peer messaging + learnings.
// usage: node tools/team.mjs claim <task-id> <agent>
//        node tools/team.mjs release <task-id> <agent> [reason]
//        node tools/team.mjs log <task-id> <agent> <event> [--note ..] [--files ..] [--verdict ..] [--override-boundary ..]
//        node tools/team.mjs new-task <id> <role> "<goal>" [--allow ".."] [--deny ".."] [--spec ".."] [--verify ".."]
//        node tools/team.mjs view <task-id> [--json] [--raw]
//        node tools/team.mjs status [task-id]
//        node tools/team.mjs send <from-agent> <to-agent> "<message>"
//        node tools/team.mjs inbox <agent>
//        node tools/team.mjs learn [tag/keyword]
//        node tools/team.mjs add-lesson <tag> "<lesson text>" [--forbid "a,b"]
//        node tools/team.mjs ls
//        node tools/team.mjs selftest
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const LOCKS = path.join(STATE, 'locks');
const EVENTS = path.join(STATE, 'events.jsonl');
const LEARNINGS_JSONL = path.join(STATE, 'learnings.jsonl');
const LEARNINGS_MD = path.join(STATE, 'LEARNINGS.md');

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const die = (m) => { console.error(m); process.exit(1); };

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
  const patterns = ROLE_FORBIDDEN[agent];
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
  fs.appendFileSync(EVENTS, JSON.stringify({ ts: now(), ...ev }) + '\n');
}

function ownerOf(id) {
  try { return fs.readFileSync(path.join(LOCKS, id, 'owner'), 'utf8').trim(); }
  catch { return null; }
}

function claim(id, agent) {
  try {
    fs.mkdirSync(LOCKS, { recursive: true });
    fs.mkdirSync(path.join(LOCKS, id)); // atomic: throws EEXIST if another agent got it
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const held = ownerOf(id);
    die(`claim denied: ${id} is held by ${held ?? 'unknown'}${held === agent ? ' (you)' : ''}\n` +
        `if that holder is dead, release it: node tools/team.mjs release ${id} ${agent} stale`);
  }
  fs.writeFileSync(path.join(LOCKS, id, 'owner'), agent);
  logEvent({ task: id, agent, event: 'claim' });
  console.log(`claimed ${id} by ${agent}`);
}

function release(id, agent, reason = '') {
  const held = ownerOf(id);
  if (!held) die(`release denied: ${id} is not claimed`);
  if (held !== agent) die(`release denied: ${id} is held by ${held}, not ${agent}`);
  fs.rmSync(path.join(LOCKS, id), { recursive: true });
  logEvent({ task: id, agent, event: 'release', note: reason });
  console.log(`released ${id}`);
}

function log(id, agent, event, flags) {
  if (event === 'done') {
    if (flags.files) {
      checkBoundary(agent, flags.files, flags['override-boundary'], id);
    }
    if (agent === 'reviewer') {
      const v = flags.verdict ? flags.verdict.toUpperCase() : '';
      if (v !== 'PASS' && v !== 'FAIL') {
        die('reviewer done requires --verdict PASS or --verdict FAIL');
      }
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
  if (!id) die('usage: team.mjs view <task-id>');
  const tasksDir = path.join(STATE, 'tasks');
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
  if (fs.existsSync(LEARNINGS_JSONL)) {
    return fs.readFileSync(LEARNINGS_JSONL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  }
  if (!fs.existsSync(LEARNINGS_MD)) return [];
  return fs.readFileSync(LEARNINGS_MD, 'utf8')
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
    die('usage: team.mjs new-task <id> <role> "<goal>" [--allow "a/**,b/**"] [--deny "c/**"] [--spec "s1;s2"] [--verify ".."]');
  }
  const tasksDir = path.join(STATE, 'tasks');
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
  if (!fs.existsSync(EVENTS)) return [];
  return fs.readFileSync(EVENTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function status(id) {
  const events = loadEvents();
  const locks = fs.existsSync(LOCKS) ? fs.readdirSync(LOCKS) : [];

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

  const tasksDir = path.join(STATE, 'tasks');
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

function send(fromAgent, toAgent, msg) {
  if (!fromAgent || !toAgent || !msg) {
    die('usage: team.mjs send <from-agent> <to-agent> "<message>"');
  }
  const ROSTER = ['orchestrator', 'builder-frontend', 'builder-backend', 'reviewer', 'qa', 'runner'];
  if (!ROSTER.includes(toAgent)) {
    console.warn(`warning: target '${toAgent}' not in default roster (${ROSTER.join(', ')})`);
  }
  logEvent({ event: 'msg', from: fromAgent, to: toAgent, msg });

  try {
    const safeMsg = msg.replace(/["\\`$]/g, '\\$&');
    execSync(`herdr agent prompt ${toAgent} "[from ${fromAgent}] ${safeMsg}"`, { stdio: 'ignore' });
    console.log(`delivered to ${toAgent}`);
  } catch {
    console.log(`logged message for ${toAgent} (herdr dispatch skipped)`);
  }
}

function inbox(agent) {
  if (!agent) die('usage: team.mjs inbox <agent>');
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
  if (!tag || !rule) die('usage: team.mjs add-lesson <tag> "<rule>" [--forbid "a,b"]');
  const forbid = flags.forbid ? flags.forbid.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const date = now().slice(0, 10);
  const entry = { tag, rule, forbid, date };
  fs.appendFileSync(LEARNINGS_JSONL, JSON.stringify(entry) + '\n');
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
  const locks = fs.existsSync(LOCKS) ? fs.readdirSync(LOCKS) : [];
  console.log(`claimed (${locks.length}):`);
  for (const id of locks) console.log(`  ${id}  <- ${ownerOf(id) ?? '?'}`);
  const tasks = fs.existsSync(path.join(STATE, 'tasks'))
    ? fs.readdirSync(path.join(STATE, 'tasks')).filter((f) => !f.startsWith('TEMPLATE.'))
    : [];
  console.log(`\ntask files (${tasks.length}): ${tasks.join(' ') || '-'}`);
  if (!fs.existsSync(EVENTS)) return console.log('\nevents: none');
  const lines = fs.readFileSync(EVENTS, 'utf8').trim().split('\n').slice(-10);
  console.log('\nlast events:');
  for (const l of lines) console.log('  ' + l);
}

function selftest() {
  const id = '__selftest__';
  fs.rmSync(path.join(LOCKS, id), { recursive: true, force: true });
  const before = fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8') : '';
  const assert = (c, m) => { if (!c) die('SELFTEST FAIL: ' + m); };

  claim(id, 'alice');
  assert(ownerOf(id) === 'alice', 'owner not recorded');

  let denied = false;
  const realExit = process.exit, realErr = console.error;
  process.exit = () => { throw new Error('exited'); };
  console.error = () => {};
  try { claim(id, 'bob'); } catch { denied = true; }
  process.exit = realExit; console.error = realErr;
  assert(denied, 'double claim was allowed');
  assert(ownerOf(id) === 'alice', 'loser overwrote owner');

  let wrongRelease = false;
  process.exit = () => { throw new Error('exited'); };
  console.error = () => {};
  try { release(id, 'bob'); } catch { wrongRelease = true; }
  process.exit = realExit; console.error = realErr;
  assert(wrongRelease, 'non-owner released the lock');

  release(id, 'alice', 'selftest done');
  assert(!fs.existsSync(path.join(LOCKS, id)), 'lock survived release');
  claim(id, 'bob');
  assert(ownerOf(id) === 'bob', 're-claim after release failed');
  release(id, 'bob');

  // Boundary check selftest
  let boundaryBlocked = false;
  process.exit = () => { throw new Error('exited'); };
  console.error = () => {};
  try { checkBoundary('builder-frontend', 'app/api/auth/route.ts', null, null); } catch { boundaryBlocked = true; }
  process.exit = realExit; console.error = realErr;
  assert(boundaryBlocked, 'frontend touching api was not blocked');

  let boundaryAllowed = false;
  try { checkBoundary('builder-frontend', 'app/components/nav.tsx', null, null); boundaryAllowed = true; } catch {}
  assert(boundaryAllowed, 'frontend touching components was blocked');

  let overrideWorked = false;
  try { checkBoundary('builder-frontend', 'app/api/auth/route.ts', 'emergency fix', null); overrideWorked = true; } catch {}
  assert(overrideWorked, 'override-boundary did not work');

  let reviewerBlocked = false;
  process.exit = () => { throw new Error('exited'); };
  console.error = () => {};
  try { log(id, 'reviewer', 'done', {}); } catch { reviewerBlocked = true; }
  process.exit = realExit; console.error = realErr;
  assert(reviewerBlocked, 'reviewer done without verdict was allowed');

  let reviewerAllowed = false;
  try { log(id, 'reviewer', 'done', { verdict: 'PASS' }); reviewerAllowed = true; } catch {}
  assert(reviewerAllowed, 'reviewer done with PASS was rejected');

  // Peer messaging selftest
  send('builder-frontend', 'builder-backend', 'selftest msg');
  const evs = loadEvents();
  const lastMsg = evs[evs.length - 1];
  assert(lastMsg.event === 'msg' && lastMsg.to === 'builder-backend', 'peer message not logged');

  // Task JSON creation & boundary test
  const testTaskId = '__selftest_task__';
  const testTaskFile = path.join(STATE, 'tasks', `${testTaskId}.json`);
  fs.rmSync(testTaskFile, { force: true });
  newTask(testTaskId, 'builder-frontend', 'Test Task', { allow: 'app/components/**', deny: 'app/api/**' });
  assert(fs.existsSync(testTaskFile), 'newTask failed to create JSON file');

  let taskDenyBlocked = false;
  process.exit = () => { throw new Error('exited'); };
  console.error = () => {};
  try { checkBoundary('builder-frontend', 'app/api/route.ts', null, testTaskId); } catch { taskDenyBlocked = true; }
  process.exit = realExit; console.error = realErr;
  assert(taskDenyBlocked, 'task-level deny was not enforced');

  fs.rmSync(testTaskFile, { force: true });
  fs.writeFileSync(EVENTS, before); // selftest must not pollute the real log
  fs.rmSync(path.join(LOCKS, id), { recursive: true, force: true });
  console.log('SELFTEST PASS');
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'claim': claim(rest[0], rest[1]); break;
  case 'release': release(rest[0], rest[1], rest[2]); break;
  case 'log': log(rest[0], rest[1], rest[2], parseFlags(rest.slice(3))); break;
  case 'new-task': newTask(rest[0], rest[1], rest[2], parseFlags(rest.slice(3))); break;
  case 'view': view(rest[0], parseFlags(rest.slice(1))); break;
  case 'status': status(rest[0]); break;
  case 'send': send(rest[0], rest[1], rest[2]); break;
  case 'inbox': inbox(rest[0]); break;
  case 'learn': learn(rest[0]); break;
  case 'add-lesson': addLesson(rest[0], rest[1], parseFlags(rest.slice(2))); break;
  case 'ls': ls(); break;
  case 'selftest': selftest(); break;
  default: die('usage: team.mjs claim|release|log|new-task|view|status|send|inbox|learn|add-lesson|ls|selftest ...');
}
