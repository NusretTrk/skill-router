#!/usr/bin/env node
// skill-router for cloud sessions. Copy to <repo>/.claude/hooks/skill-router.mjs and add the hooks from
// extras/cloud-settings.json to <repo>/.claude/settings.json.
//
// Cloud sessions don't install plugins, but they do run hooks committed to the repository. This loader fetches
// skill-router into the session VM at session start and runs its hooks from there. On your own machine it exits at
// once: the installed plugin does the work, so nothing runs twice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = process.env.SKILL_ROUTER_REPO || 'https://github.com/NusretTrk/skill-router.git';
const REF = process.env.SKILL_ROUTER_REF || 'main';
const DIR = path.join(os.homedir(), '.cache', 'skill-router');
const HOOKS = ['setup', 'route', 'pretool'];

const which = process.argv[2];
if (process.env.CLAUDE_CODE_REMOTE !== 'true' || !HOOKS.includes(which)) process.exit(0);

const script = path.join(DIR, 'scripts', `${which}.mjs`);
if (!fs.existsSync(script)) {
  // Fetch once, at session start; a later hook without a copy just does nothing.
  if (which !== 'setup') process.exit(0);
  fs.rmSync(DIR, { recursive: true, force: true });
  spawnSync('git', ['clone', '--quiet', '--depth', '1', '--branch', REF, REPO, DIR], { stdio: 'ignore', timeout: 25000 });
  if (!fs.existsSync(script)) process.exit(0);
}

const res = spawnSync(process.execPath, [script], { input: fs.readFileSync(0), stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
process.exit(res.status ?? 0);
