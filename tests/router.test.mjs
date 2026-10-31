// Run: node --test tests/
// Hooks run in a throwaway home folder, so the real ~/.claude is never touched. Haiku mode uses a fake `claude`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (name) => path.join(ROOT, 'scripts', name);

function sandbox({ overrides = {}, fake } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-router-test-'));
  const appdata = path.join(home, 'AppData', 'Roaming');
  const skills = path.join(home, '.claude', 'skills');
  for (const [name, desc] of [['ui-polish', 'Polish UI components'], ['db-migrations', 'Write SQL migrations']]) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nBody.`);
  }
  fs.mkdirSync(path.join(home, '.claude', 'skill-router'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skill-router', 'overrides.json'), JSON.stringify(overrides));
  if (fake) {
    // A fake CLI reached through %APPDATA%\npm\claude.cmd (the shell path) or a POSIX script on other platforms.
    const npm = path.join(appdata, 'npm');
    fs.mkdirSync(npm, { recursive: true });
    fs.writeFileSync(path.join(npm, 'fake.mjs'), fake);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(npm, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
    } else {
      const bin = path.join(home, '.local', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec node "${path.join(npm, 'fake.mjs')}" "$@"\n`, { mode: 0o755 });
    }
  }
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, '{"type":"assistant","message":{"model":"claude-opus-5-5"}}\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: path.join(home, 'nolocal'), CLAUDE_EFFORT: 'medium' };
  delete env.SKILL_ROUTER_CHILD;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const run = (name, input, extraEnv = {}) => {
    const res = spawnSync(process.execPath, [script(name)], { input: JSON.stringify({ session_id: 's1', cwd: home, transcript_path: transcript, ...input }), env: { ...env, ...extraEnv }, encoding: 'utf8' });
    return res.stdout ? JSON.parse(res.stdout) : null;
  };
  const read = (rel) => { try { return fs.readFileSync(path.join(home, '.claude', 'skill-router', rel), 'utf8'); } catch { return null; } };
  return { home, run, read };
}

const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
const TASK = 'Restoran detay ekranındaki yorum kartlarını yeniden tasarla, uzun isimlerde taşma var.';

test('inline mode: nudge every task, model check only on the first', () => {
  const sb = sandbox();
  const first = sb.run('route.mjs', { prompt: TASK }, DESKTOP);
  assert.match(first.hookSpecificOutput.additionalContext, /invoke them with the Skill tool/);
  assert.match(first.hookSpecificOutput.additionalContext, /Model check: this session runs on claude-opus-5-5 · effort medium/);
  const second = sb.run('route.mjs', { prompt: TASK }, DESKTOP);
  assert.doesNotMatch(second.hookSpecificOutput.additionalContext, /Model check/);
});

test('inline mode: long new task gets another model check after 5 requests', async () => {
  const { inlineContext } = await import(pathToFileURL(script('route.mjs')).href);
  const state = { invoked: [] };
  const args = { state, nowModel: 'claude-opus-5-5', nowEffort: 'medium', advisor: 'notify' };
  assert.match(inlineContext({ ...args, prompt: 'x' }), /Model check/);
  for (let i = 0; i < 4; i++) assert.doesNotMatch(inlineContext({ ...args, prompt: 'x'.repeat(700) }), /Model check/);
  assert.match(inlineContext({ ...args, prompt: 'x'.repeat(700) }), /Model check/);
  assert.doesNotMatch(inlineContext({ ...args, advisor: 'off', state: { invoked: [] }, prompt: 'x' }), /Model check/);
});

test('trivial and short prompts are skipped', () => {
  const sb = sandbox();
  for (const p of ['tamam', 'hayır', 'Evet!', 'devam et', 'ok', '/help me with something long enough']) {
    assert.equal(sb.run('route.mjs', { prompt: p }, DESKTOP), null, p);
  }
});

test('file reminder works without a tuned profile, once per session', () => {
  const sb = sandbox({ overrides: { fileRules: { ui: ['ui-polish'] } } });
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(sb.home, 'Card.tsx'), new_string: 'x' } };
  assert.match(sb.run('pretool.mjs', edit).hookSpecificOutput.additionalContext, /ui-polish/);
  assert.equal(sb.run('pretool.mjs', edit), null);
});

test('file reminder skips a skill already loaded', () => {
  const sb = sandbox({ overrides: { fileRules: { ui: ['ui-polish'] } } });
  sb.run('pretool.mjs', { tool_name: 'Skill', tool_input: { skill: 'ui-polish' } });
  assert.equal(sb.run('pretool.mjs', { tool_name: 'Edit', tool_input: { file_path: 'a.tsx', new_string: 'x' } }), null);
});

test('setup does nothing in the desktop app (inline mode never tunes)', () => {
  const sb = sandbox();
  assert.equal(sb.run('setup.mjs', {}, DESKTOP), null);
  assert.equal(sb.read('profile.json'), null);
});

test('advice: only confident, meaningful, non-repeating suggestions', async () => {
  const { advice } = await import(pathToFileURL(script('route.mjs')).href);
  const state = {};
  const down = advice({ confident: true, model: 'sonnet', effort: 'low', reason: 'routine' }, 'claude-opus-5-5', 'medium', state);
  assert.equal(down.direction, 'cheaper');
  assert.match(down.text, /Sonnet · low fits this task \(now Opus · medium\)/);
  assert.equal(advice({ confident: true, model: 'sonnet', effort: 'low' }, 'claude-opus-5-5', 'medium', state), null, 'repeat');
  assert.equal(advice({ confident: false, model: 'haiku', effort: 'low' }, 'claude-opus-5-5', 'medium', {}), null, 'unsure');
  assert.equal(advice({ confident: true, model: 'opus', effort: 'high' }, 'claude-opus-5-5', 'medium', {}), null, 'one effort step');
  assert.equal(advice({ confident: true, model: 'opus', effort: 'xhigh' }, 'claude-opus-5-5', 'medium', {}).direction, 'stronger');
});

test('haiku mode: picks skills and shows a model suggestion', () => {
  const fake = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const result = JSON.stringify({skills:['ui-polish','nope'],model:'sonnet',effort:'low',confident:true,reason:'Rutin UI işi.'});
    process.stdout.write(JSON.stringify({type:'result',is_error:false,result,total_cost_usd:0.001,usage:{input_tokens:10,cache_read_input_tokens:900,output_tokens:30}}));
  });`;
  const sb = sandbox({ overrides: { mode: 'haiku' }, fake });
  const out = sb.run('route.mjs', { prompt: TASK });
  assert.match(out.hookSpecificOutput.additionalContext, /relevant skills, in the order they are needed: ui-polish\./);
  assert.match(out.systemMessage, /Sonnet · low fits this task \(now Opus · medium\)\. Rutin UI işi\./);
  assert.match(sb.read('router.log'), /cacheRead=900 cost=0.001/);
});

test('haiku mode: missing login pauses routing and tells the user once', () => {
  const fake = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('Not logged in · Please run /login');process.exit(1)});`;
  const sb = sandbox({ overrides: { mode: 'haiku' }, fake });
  assert.match(sb.run('route.mjs', { prompt: TASK }).systemMessage, /not logged in/);
  assert.ok(sb.read('auth-missing'));
  assert.equal(sb.run('route.mjs', { prompt: TASK }), null, 'no second notice, no second call');
});

test('extractJson reads the CLI envelope and ignores brackets in strings', async () => {
  const { extractJson } = await import(pathToFileURL(script('lib.mjs')).href);
  assert.deepEqual(extractJson('noise {"a":"}{","b":[1]} tail', '{'), { a: '}{', b: [1] });
  assert.deepEqual(extractJson('pick ["x","y"]', '['), ['x', 'y']);
});
