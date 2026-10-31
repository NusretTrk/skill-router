// Shared helpers: skill catalog, per-user profile and per-session state, and a headless `claude -p` runner.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const DATA_DIR = path.join(CLAUDE_DIR, 'skill-router');
export const PROFILE = path.join(DATA_DIR, 'profile.json');

function parseFrontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>]-?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    fm[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  // Opening of the body, where skills usually say what they cover and what they don't. Only setup reads it.
  fm.excerpt = text.slice(m[0].length).replace(/\s+/g, ' ').trim().slice(0, 600);
  return fm;
}

function scan(dir, prefix, source, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const fm = parseFrontmatter(path.join(dir, e.name, 'SKILL.md'));
    if (!fm || fm['disable-model-invocation'] === 'true') continue;
    // Claude Code invokes by slug; a display-style `name:` ("Agent Cost Report") falls back to the folder name.
    const name = prefix + (/^[a-z0-9][a-z0-9-]*$/.test(fm.name || '') ? fm.name : e.name);
    out.set(name, { name, source, dir: path.join(dir, e.name), description: (fm.description || '').slice(0, 320), excerpt: fm.excerpt });
  }
}

const listDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)); } catch { return []; } };

// A plugin may keep its skills somewhere other than `skills/` and say so in plugin.json (`"skills": "./.claude/skills/"`).
function pluginSkillDirs(root) {
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'), {});
  const declared = manifest.skills ? [].concat(manifest.skills) : [];
  return { name: manifest.name, dirs: [...new Set(['skills', ...declared].map(d => path.resolve(root, d)))] };
}

function scanPlugin(root, prefix, source, out) {
  for (const dir of pluginSkillDirs(root).dirs) scan(dir, prefix, source, out);
}

// Data folders of the Claude desktop app. It installs plugins and the claude.ai skill bundle there, not under ~/.claude.
function desktopRoots() {
  const home = os.homedir();
  const bases = [
    process.env.SKILL_ROUTER_DESKTOP_DATA,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Claude-Data'),
    path.join(home, 'Library', 'Application Support', 'Claude-Data'),
    path.join(home, 'Library', 'Application Support', 'Claude'),
    path.join(home, '.config', 'Claude-Data'),
  ].filter(Boolean);
  // Each base holds one folder per signed-in profile (e.g. `claude_xxxx`); accept the base itself too.
  return bases.flatMap(b => [b, ...listDirs(b)]).filter(d => fs.existsSync(path.join(d, 'rpm')) || fs.existsSync(path.join(d, 'local-agent-mode-sessions')));
}

function scanDesktop(out) {
  for (const root of desktopRoots()) {
    // rpm/<org>/<account>/manifest.json lists the installed plugins; each lives in a sibling folder named by id.
    for (const org of listDirs(path.join(root, 'rpm'))) {
      for (const account of listDirs(org)) {
        const manifest = readJson(path.join(account, 'manifest.json'), null);
        if (!manifest) continue;
        for (const p of manifest.plugins || []) {
          if (p.enabled === false || p.installationPreference === 'disabled') continue;
          const dir = path.join(account, p.id);
          const name = pluginSkillDirs(dir).name || p.name;
          if (name) scanPlugin(dir, `${name}:`, `desktop:${name}`, out);
        }
      }
    }
    // The claude.ai skill bundle; keep only the most recently updated copy.
    const bundles = listDirs(path.join(root, 'local-agent-mode-sessions', 'skills-plugin')).flatMap(listDirs)
      .filter(d => fs.existsSync(path.join(d, 'skills')))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (bundles[0]) scanPlugin(bundles[0], `${pluginSkillDirs(bundles[0]).name || 'anthropic-skills'}:`, 'synced', out);
  }
}

// Every skill the model can invoke: user, claude.ai-synced, enabled plugins (CLI and desktop app), extra dirs from
// overrides, then the project (wins on name clash).
export function buildCatalog(cwd) {
  const out = new Map();
  scan(path.join(CLAUDE_DIR, 'skills'), '', 'user', out);

  const synced = path.join(CLAUDE_DIR, 'skills', 'synced');
  try {
    for (const bundle of fs.readdirSync(synced)) scan(path.join(synced, bundle), 'anthropic-skills:', 'synced', out);
  } catch {}

  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
    const installed = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8'));
    const plugins = installed.plugins || installed;
    for (const [id, on] of Object.entries(settings.enabledPlugins || {})) {
      if (!on || !plugins[id]?.[0]?.installPath) continue;
      scanPlugin(plugins[id][0].installPath, id.split('@')[0] + ':', `plugin:${id}`, out);
    }
  } catch {}

  scanDesktop(out);

  for (const extra of loadOverrides().extraSkillDirs) {
    const dir = typeof extra === 'string' ? extra : extra?.dir;
    if (dir) scan(dir.replace(/^~(?=$|[\\/])/, os.homedir()), extra?.prefix || '', 'extra', out);
  }

  if (cwd) scan(path.join(cwd, '.claude', 'skills'), '', 'project', out);

  // A local copy of a plugin skill (same name, e.g. `systematic-debugging` next to `superpowers:systematic-debugging`)
  // would be offered twice; keep the one the user installed directly.
  const list = [...out.values()].filter(s => !(s.name.includes(':') && out.has(s.name.split(':').pop())));

  // Aliases inside one plugin (same description, different name): keep the shortest name.
  const seen = new Map();
  for (const s of [...list].sort((a, b) => a.name.length - b.name.length)) {
    const key = `${s.source}\n${s.description.toLowerCase().replace(/\W+/g, ' ').trim()}`;
    if (s.description && seen.has(key)) s.alias = true; else seen.set(key, s.name);
  }
  return list.filter(s => !s.alias);
}

export function catalogSignature(catalog) {
  return crypto.createHash('sha1').update(catalog.map(s => s.name).sort().join('\n')).digest('hex').slice(0, 16);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export const loadProfile = () => readJson(PROFILE, null);

// Optional, user-written; absent by default. { "protect": [...], "ignore": [...], "fileRules": { kind: [...] }, ... }
// protect: never offered for cleanup. ignore: never routed or reminded. fileRules: replaces setup's choice for a kind.
// extraSkillDirs: more folders of skills ("dir" or {dir, prefix}). minPromptChars: shortest prompt that gets routed.
export function loadOverrides() {
  const o = readJson(path.join(DATA_DIR, 'overrides.json'), {});
  return {
    protect: o.protect || [],
    ignore: o.ignore || [],
    fileRules: o.fileRules || {},
    extraSkillDirs: o.extraSkillDirs || [],
    minPromptChars: Number.isFinite(o.minPromptChars) ? o.minPromptChars : 200,
    // "notify" (default): suggest a model/effort when the task looks clearly over- or under-powered. "off": never.
    advisor: o.advisor === 'off' ? 'off' : 'notify',
    // "auto" (default): inline inside the Claude desktop app, haiku elsewhere. "haiku": always ask a separate Haiku
    // (needs a logged-in claude CLI). "inline": never call a model; the session's own model does the routing.
    mode: ['haiku', 'inline'].includes(o.mode) ? o.mode : 'auto',
  };
}

// The desktop app does not hand its login to child processes, so a separate `claude -p` fails there. Route inline.
export function routerMode() {
  const { mode } = loadOverrides();
  if (mode !== 'auto') return mode;
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' || authMissingRecently()) return 'inline';
  return 'haiku';
}

// Housekeeping, run at session start: drop session records older than two weeks and keep the log under ~1 MB.
export function prune() {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const dir of [path.join(DATA_DIR, 'state'), path.join(DATA_DIR, 'prompts')]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      }
    } catch {}
  }
  const logFile = path.join(DATA_DIR, 'router.log');
  try {
    if (fs.statSync(logFile).size > 1024 * 1024) {
      fs.writeFileSync(logFile, fs.readFileSync(logFile, 'utf8').split('\n').slice(-2000).join('\n'));
    }
  } catch {}
}

const stateFile = (sid) => path.join(DATA_DIR, 'state', `${String(sid).replace(/[^\w-]/g, '')}.json`);
export const loadState = (sid) => readJson(stateFile(sid), { routed: [], invoked: [], reminded: [] });
export const saveState = (sid, state) => writeJson(stateFile(sid), state);

export function log(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'router.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

export async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return JSON.parse(data || '{}');
}

function claudeExe() {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'claude.exe'),
       path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// Runs a one-shot, tool-less, plugin-less `claude -p` so it neither recurses into these hooks nor loads the user's setup.
// While the CLI has no login, every call fails after a few seconds. Remember that for a while instead of paying the
// wait on every prompt. Cleared by any successful call.
const AUTH_FLAG = path.join(DATA_DIR, 'auth-missing');
const AUTH_RETRY_MS = 15 * 60 * 1000;
export function authMissingRecently() {
  try { return Date.now() - fs.statSync(AUTH_FLAG).mtimeMs < AUTH_RETRY_MS; } catch { return false; }
}

export function askClaude({ model, system, message, timeout }) {
  const exe = claudeExe();
  // The system prompt goes through a file: no Windows command-line length limit, and an identical prefix on every
  // call so the API can serve it from the prompt cache.
  const sysFile = path.join(DATA_DIR, 'prompts', crypto.createHash('sha1').update(system).digest('hex').slice(0, 12) + '.txt');
  if (!fs.existsSync(sysFile)) writeText(sysFile, system);
  const base = ['-p', '--model', model, '--setting-sources', '', '--strict-mcp-config', '--tools', '',
    '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json'];
  const opts = {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: { ...process.env, SKILL_ROUTER_CHILD: '1' },
  };
  const res = exe
    ? spawnSync(exe, [...base, '--system-prompt-file', sysFile], { ...opts, input: message })
    // Unknown install location: go through the shell and carry the instructions in the message instead.
    : spawnSync('claude', base.map(a => (a === '' ? '""' : a)), { ...opts, shell: true, input: `${system}\n\n${message}` });

  const raw = `${res.stdout || ''}\n${res.stderr || ''}`;
  const out = extractJson(res.stdout || '', '{');
  const text = out?.result ?? res.stdout ?? '';
  if (/not logged in|please run \/login|invalid api key/i.test(out?.is_error ? text : raw)) {
    writeText(AUTH_FLAG, String(Date.now()));
    return { text: '', status: res.status, error: 'not-logged-in' };
  }
  if (out && !out.is_error) fs.rmSync(AUTH_FLAG, { force: true });
  const u = out?.usage || {};
  return {
    text,
    status: res.status,
    error: res.error?.message || (out?.is_error ? String(text).slice(0, 200) : undefined),
    cost: out?.total_cost_usd,
    tokens: { in: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, out: u.output_tokens },
  };
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Model the session last answered with, read from the transcript's newest assistant entry.
export function currentModel(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const all = [...buf.toString('utf8').matchAll(/"model":"(claude-[^"]+)"/g)];
    return all.length ? all[all.length - 1][1] : null;
  } catch { return null; }
}

export const MODEL_TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const tierOf = (model) => MODEL_TIERS.findIndex(t => String(model || '').toLowerCase().includes(t));

export function extractJson(text, open) {
  const close = open === '[' ? ']' : '}';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// File kinds the edit hook recognises; setup maps each kind to the user's own skills.
export const FILE_KINDS = {
  ui: { desc: 'UI components, pages, styles (.tsx .jsx .vue .svelte .css .html)', test: (f) => /\.(tsx|jsx|vue|svelte|astro|css|scss|less|html)$/i.test(f) && !/\.(test|spec)\./i.test(f) },
  motion: { desc: 'animation code (framer-motion, CSS transitions/keyframes)', test: (f, c) => /framer-motion|from ['"]motion|@keyframes|animation:|transition:|useSpring|useAnimate/.test(c) },
  test: { desc: 'unit/integration test files', test: (f) => /\.(test|spec)\.[cm]?[jt]sx?$|[\\/]__tests__[\\/]|(^|[\\/])test_\w+\.py$|_test\.go$/i.test(f) },
  e2e: { desc: 'end-to-end browser tests (Playwright, Cypress)', test: (f, c) => /[\\/](e2e|cypress)[\\/]|\.e2e\./i.test(f) || /@playwright\/test|cypress/.test(c) },
  reactNative: { desc: 'React Native / Expo code', test: (f, c) => /from ['"](react-native|expo)/.test(c) },
  swift: { desc: 'Swift / iOS code', test: (f) => /\.swift$/i.test(f) },
  android: { desc: 'Kotlin / Android code', test: (f) => /\.(kt|kts)$/i.test(f) },
  python: { desc: 'Python code', test: (f) => /\.py$/i.test(f) },
  rust: { desc: 'Rust code', test: (f) => /\.rs$/i.test(f) },
  go: { desc: 'Go code', test: (f) => /\.go$/i.test(f) },
  sql: { desc: 'SQL, migrations, database schema', test: (f) => /\.sql$|[\\/]migrations?[\\/]|schema\.prisma$/i.test(f) },
  infra: { desc: 'Dockerfiles, CI workflows, deploy config', test: (f) => /Dockerfile|docker-compose|\.github[\\/]workflows|\.gitlab-ci|vercel\.json|netlify\.toml/i.test(f) },
  llmApp: { desc: 'code calling an LLM API (Anthropic/OpenAI SDK)', test: (f, c) => /@anthropic-ai\/sdk|from anthropic|import anthropic|openai/.test(c) },
  designSpec: { desc: 'DESIGN.md design-system spec', test: (f) => path.basename(f) === 'DESIGN.md' },
  skillFile: { desc: 'SKILL.md files (writing a skill)', test: (f) => path.basename(f) === 'SKILL.md' },
};
