#!/usr/bin/env node
// agent-team state layer: atomic claim + append-only event log.
// usage: node tools/team.mjs claim <task-id> <agent>
//        node tools/team.mjs release <task-id> <agent> [reason]
//        node tools/team.mjs log <task-id> <agent> <event> [--note ..] [--files ..] [--verdict ..]
//        node tools/team.mjs ls
//        node tools/team.mjs selftest
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'state');
const LOCKS = path.join(STATE, 'locks');
const EVENTS = path.join(STATE, 'events.jsonl');

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const die = (m) => { console.error(m); process.exit(1); };

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
  logEvent({ task: id, agent, event, ...flags });
  console.log('logged');
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w[\w-]*)$/.exec(argv[i]);
    if (m && argv[i + 1] !== undefined) { out[m[1]] = argv[++i]; }
  }
  return out;
}

function ls() {
  const locks = fs.existsSync(LOCKS) ? fs.readdirSync(LOCKS) : [];
  console.log(`claimed (${locks.length}):`);
  for (const id of locks) console.log(`  ${id}  <- ${ownerOf(id) ?? '?'}`);
  const tasks = fs.existsSync(path.join(STATE, 'tasks'))
    ? fs.readdirSync(path.join(STATE, 'tasks')).filter((f) => f.endsWith('.md') && f !== 'TEMPLATE.md')
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

  fs.writeFileSync(EVENTS, before); // selftest must not pollute the real log
  fs.rmSync(path.join(LOCKS, id), { recursive: true, force: true });
  console.log('SELFTEST PASS');
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'claim': claim(rest[0], rest[1]); break;
  case 'release': release(rest[0], rest[1], rest[2]); break;
  case 'log': log(rest[0], rest[1], rest[2], parseFlags(rest.slice(3))); break;
  case 'ls': ls(); break;
  case 'selftest': selftest(); break;
  default: die('usage: team.mjs claim|release|log|ls|selftest ...');
}
