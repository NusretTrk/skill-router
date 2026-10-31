// SessionStart hook. Whenever the user's skill set changes (or on first install), it re-tunes the router
// in a detached background process so the session never waits: domain hints, per-file-kind skill rules,
// and a list of duplicate/obsolete skills the user can review with /skill-router:cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, PROFILE, FILE_KINDS, buildCatalog, catalogSignature, loadProfile, loadOverrides, writeJson,
  askClaude, extractJson, log, prune, readStdin, routerMode,
} from './lib.mjs';

// Bump when the setup prompt or profile format changes, so existing installs re-tune once.
const SETUP_VERSION = 4;
const LOCK = path.join(DATA_DIR, 'setup.lock');
const LOCK_TTL_MS = 10 * 60 * 1000;

const SYSTEM = `You configure a skill router for a coding agent. You get the user's installed skills (name, description, and the opening of each skill's body) and a list of file kinds.
Judge each skill by what its body says it covers, not by its name or a broad description: a skill written for marketing sites is not a general UI skill, a mobile-web skill is not a React Native skill, a terse-chat mode is not a writing skill.
Return one JSON object, nothing else:
{
  "hints": [{"domain": "<kind of task, e.g. 'UI layout and visual polish'>", "skills": ["<skill>", ...]}],
  "fileRules": {"<file kind id>": ["<skill>", ...]},
  "cleanup": [{"skill": "<skill to retire>", "keep": "<skill that covers it, or null>", "reason": "<one short sentence>"}]
}
Rules:
- Use only exact skill names from the list.
- hints: group the skills into focused task domains of at most 8 skills; split a broad area (e.g. UI) into narrower ones (visual polish, stress-testing, component sourcing) instead of one long list. Within a domain, list the most generally useful skill first. Every skill in the list belongs to some domain, including security, review and tooling skills.
- fileRules: for each file kind, the one or two skills that should be loaded before editing that kind of file. Leave a kind out if no skill fits well.
- cleanup: only skills that duplicate another installed skill (same purpose; keep the maintained or more complete one) or that describe themselves as deprecated. Being niche is NOT a reason. When unsure, leave it out.`;

function launchBackground() {
  try {
    const stat = fs.statSync(LOCK);
    if (Date.now() - stat.mtimeMs < LOCK_TTL_MS) return;
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK, String(Date.now()));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SKILL_ROUTER_CHILD: '1' },
  });
  child.unref();
}

async function hook() {
  if (process.env.SKILL_ROUTER_CHILD) return;
  await readStdin().catch(() => ({}));
  prune();
  // Inline mode makes no model calls, so there is nothing to tune in the background.
  if (routerMode() === 'inline') return;
  const catalog = buildCatalog();
  const profile = loadProfile();

  if (!profile || profile.signature !== catalogSignature(catalog) || profile.setupVersion !== SETUP_VERSION) {
    launchBackground();
    if (!profile) {
      process.stdout.write(JSON.stringify({
        systemMessage: `skill-router: tuning itself to your ${catalog.length} skills in the background (one time, about a minute).`,
      }));
    }
    return;
  }

  const { protect } = loadOverrides();
  const flagged = (profile.cleanup || []).filter(c => !protect.includes(c.skill)).length;
  if (flagged && !profile.cleanupNoticeShown) {
    profile.cleanupNoticeShown = true;
    writeJson(PROFILE, profile);
    process.stdout.write(JSON.stringify({
      systemMessage: `skill-router: ${flagged === 1 ? '1 installed skill looks' : `${flagged} installed skills look`} duplicated or deprecated. Run /skill-router:cleanup to review them — nothing changes without your OK.`,
    }));
  }
}

function run() {
  const started = Date.now();
  const catalog = buildCatalog();
  const names = new Set(catalog.map(s => s.name));
  const message = [
    'SKILLS:',
    ...catalog.map(s => `- ${s.name}: ${s.description}\n  body: ${s.excerpt}`),
    '\nFILE KINDS:',
    ...Object.entries(FILE_KINDS).map(([id, k]) => `- ${id}: ${k.desc}`),
  ].join('\n');

  const res = askClaude({ model: 'opus', system: SYSTEM, message, timeout: 300000 });
  const out = extractJson(res.text, '{');
  if (!out) {
    log(`setup failed status=${res.status} error=${res.error || ''} output=${res.text.slice(0, 200)}`);
    fs.rmSync(LOCK, { force: true });
    return;
  }

  const valid = (list) => [...new Set((list || []).filter(n => names.has(n)))];
  const { protect } = loadOverrides();
  const profile = {
    setupVersion: SETUP_VERSION,
    signature: catalogSignature(catalog),
    builtAt: new Date().toISOString(),
    skillCount: catalog.length,
    hints: (out.hints || []).map(h => ({ domain: String(h.domain), skills: valid(h.skills) })).filter(h => h.skills.length),
    fileRules: Object.fromEntries(Object.entries(out.fileRules || {})
      .filter(([kind]) => FILE_KINDS[kind])
      .map(([kind, list]) => [kind, valid(list)])
      .filter(([, list]) => list.length)),
    cleanup: (out.cleanup || [])
      .filter(c => names.has(c.skill) && !protect.includes(c.skill))
      .map(c => ({ ...c, source: catalog.find(s => s.name === c.skill).source, dir: catalog.find(s => s.name === c.skill).dir })),
    cleanupNoticeShown: false,
  };
  const grouped = new Set(profile.hints.flatMap(h => h.skills));
  const ungrouped = catalog.map(s => s.name).filter(n => !grouped.has(n));
  if (ungrouped.length) profile.hints.push({ domain: 'Other', skills: ungrouped });
  writeJson(PROFILE, profile);
  fs.rmSync(LOCK, { force: true });
  log(`setup ok ms=${Date.now() - started} skills=${catalog.length} domains=${profile.hints.length} fileRules=${Object.keys(profile.fileRules).length} cleanup=${profile.cleanup.length}`);
}

if (process.argv.includes('--run')) run();
else hook().catch(err => log(`setup hook crash ${err?.stack || err}`));
