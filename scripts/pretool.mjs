// PreToolUse hook: records Skill calls and, mid-task, reminds the model once per session about the
// skills setup mapped to the kind of file it is about to edit. Local only — no model call.
import path from 'node:path';
import { FILE_KINDS, buildCatalog, loadProfile, loadOverrides, loadState, saveState, log, readStdin } from './lib.mjs';

async function main() {
  if (process.env.SKILL_ROUTER_CHILD) return;
  const input = await readStdin();
  const sid = input.session_id;
  const args = input.tool_input || {};
  const state = loadState(sid);

  if (input.tool_name === 'Skill') {
    if (args.skill) {
      const full = args.skill;
      const short = full.split(':').pop();
      if (!state.invoked.includes(full)) state.invoked.push(full);
      if (!state.invoked.includes(short)) state.invoked.push(short);
      saveState(sid, state);
    }
    return;
  }

  const profile = loadProfile();
  const file = args.file_path || args.notebook_path || '';
  if (!file) return;
  const overrides = loadOverrides();
  // Without a tuned profile (inline mode never tunes) the user's own fileRules still apply.
  const rules = { ...(profile?.fileRules || {}), ...overrides.fileRules };
  const content = [args.content, args.new_string, ...(args.edits || []).map(e => e.new_string)].filter(Boolean).join('\n');

  const matched = Object.entries(rules).filter(([kind]) => FILE_KINDS[kind]?.test(file, content)).flatMap(([, skills]) => skills);
  if (!matched.length) return;
  const known = new Set(buildCatalog(input.cwd).map(s => s.name));

  // Avoid repetitive/spurious reminders: check both namespaced and short name against invoked, reminded, and already routed
  const isDue = (s) => {
    const short = s.split(':').pop();
    if (overrides.ignore.includes(s) || overrides.ignore.includes(short)) return false;
    if (state.invoked.includes(s) || state.invoked.includes(short)) return false;
    if (state.reminded.includes(s) || state.reminded.includes(short)) return false;
    if ((state.routed || []).includes(s) || (state.routed || []).includes(short)) return false;
    return true;
  };

  const due = [...new Set(matched)].filter(s => known.has(s) && isDue(s));
  if (!due.length) return;

  for (const s of due) {
    state.reminded.push(s);
    const short = s.split(':').pop();
    if (!state.reminded.includes(short)) state.reminded.push(short);
  }
  saveState(sid, state);
  log(`remind session=${sid} file=${path.basename(file)} skills=${JSON.stringify(due)}`);

  const context = `Skill router: you are editing ${path.basename(file)}, and these skills cover this kind of file but are not loaded in this session: ${due.join(', ')}. Unless this is a trivial fix, invoke them with the Skill tool and apply them to this and the following edits.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
}

main().catch(err => log(`pretool crash ${err?.stack || err}`));
