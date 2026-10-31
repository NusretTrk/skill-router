// UserPromptSubmit hook: asks Haiku which skills fit the request and hands the list to the main model.
import { buildCatalog, loadProfile, loadOverrides, loadState, saveState, askClaude, extractJson, log, readStdin } from './lib.mjs';

const MAX_PROMPT_CHARS = 16000;

const SYSTEM = `You route tasks to skills for a coding agent.
You get a catalog of skills (name: description), optional user preferences, and a task message.
The task is often a long multi-step plan: consider every step, not just the first.
Return every skill that would materially help with some part of the task, including skills that make the work cheaper, faster or more reliable (planning, verification, token-saving).
Leave out skills whose domain does not occur in the task, and when two skills cover the same thing pick the better fit.
If the message is a question, a confirmation or conversation about the setup rather than a request to do work, reply [].
Order by when they are needed: skills that govern how the work starts come first.
Reply with only a JSON array of exact skill names from the catalog, e.g. ["a","b"]. Reply [] if nothing fits.`;

async function main() {
  if (process.env.SKILL_ROUTER_CHILD) return;
  const input = await readStdin();
  const prompt = (input.prompt || '').trim();
  const { ignore, minPromptChars } = loadOverrides();
  if (prompt.length < minPromptChars || prompt.startsWith('/')) return;

  const catalog = buildCatalog(input.cwd).filter(s => !ignore.includes(s.name));
  const names = new Set(catalog.map(s => s.name));
  const hints = (loadProfile()?.hints || []).map(h => `${h.domain}: ${h.skills.join(', ')}`).join('\n');

  const message = [
    'SKILL CATALOG:',
    ...catalog.map(s => `- ${s.name}: ${s.description}`),
    hints && `\nPREFERRED SKILLS PER DOMAIN:\n${hints}`,
    `\nTASK:\n${prompt.slice(0, MAX_PROMPT_CHARS)}`,
  ].filter(Boolean).join('\n');

  const started = Date.now();
  const res = askClaude({ model: 'haiku', system: SYSTEM, message, timeout: 75000 });
  const picked = [...new Set((extractJson(res.text, '[') || []).filter(n => names.has(n)))];
  log(`route session=${input.session_id} ms=${Date.now() - started} status=${res.status} picked=${JSON.stringify(picked)}${res.error ? ' error=' + res.error : ''}`);
  if (!picked.length) return;

  const state = loadState(input.session_id);
  state.routed = [...new Set([...state.routed, ...picked])];
  saveState(input.session_id, state);

  // Skills already loaded in this session need no second nudge.
  const fresh = picked.filter(n => !state.invoked.includes(n));
  if (!fresh.length) return;
  const loaded = picked.filter(n => state.invoked.includes(n));

  const context = `Skill router (Haiku read this request against the installed skills) — relevant skills, in the order they are needed: ${fresh.join(', ')}.${loaded.length ? ` Already loaded and still relevant: ${loaded.join(', ')}.` : ''}
Before your first action, invoke with the Skill tool the ones that govern how this work starts. Invoke each of the others when you reach the step it covers. Skip any that turn out not to apply.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
}

main().catch(err => log(`route crash ${err?.stack || err}`));
