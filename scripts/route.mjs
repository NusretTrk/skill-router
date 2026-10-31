// UserPromptSubmit hook: one Haiku call reads the request against the installed skills, picks the skills it needs and
// judges which model and effort the task deserves. Skills go to the main model; a model/effort suggestion goes to the
// user, only when the current choice looks clearly too strong or too weak.
import {
  buildCatalog, loadProfile, loadOverrides, loadState, saveState, askClaude, extractJson, log, readStdin,
  authMissingRecently, currentModel, routerMode, MODEL_TIERS, EFFORTS, tierOf,
} from './lib.mjs';

const MAX_PROMPT_CHARS = 16000;
const AUTH_NOTICE = 'skill-router: the claude CLI is not logged in, so routing is paused. Run `claude auth login` in a terminal once.';

const RULES = `You route tasks for a coding agent. You get a catalog of skills (name: description), optional preferred skills per domain, and then a task message with the model and effort the session runs on.
The task is often a long multi-step plan: consider every step, not just the first.

1) skills: every skill that would materially help with some part of the task, including skills that make the work cheaper, faster or more reliable (planning, verification, token-saving). Leave out skills whose domain does not occur in the task; when two cover the same thing pick the better fit. Order by when they are needed: skills that govern how the work starts come first. If the message is a question, a confirmation or conversation rather than a request to do work, skills is [].

2) model and effort the task deserves:
- haiku: lookups, renames, formatting, one-line fixes, short factual answers.
- sonnet: routine coding — a feature or fix in code that is already understood, tests, docs, UI tweaks, data wrangling.
- opus: architecture, multi-file refactors, hard or unclear bugs, security, design decisions with trade-offs, long multi-step plans.
- effort: low for mechanical work, medium by default, high for tricky reasoning, xhigh or max only for very hard problems.
Judge the task, not the length of the message. confident is true only when the right choice is clear.

Reply with only JSON, no prose:
{"skills": ["exact-name", ...], "model": "haiku|sonnet|opus", "effort": "low|medium|high|xhigh|max", "confident": true|false, "reason": "<one short sentence in the language of the task>"}`;

function systemPrompt(catalog) {
  const hints = (loadProfile()?.hints || []).map(h => `${h.domain}: ${h.skills.join(', ')}`).join('\n');
  return [
    RULES,
    '\nSKILL CATALOG:',
    ...catalog.map(s => `- ${s.name}: ${s.description.slice(0, 220)}`),
    hints && `\nPREFERRED SKILLS PER DOMAIN:\n${hints}`,
  ].filter(Boolean).join('\n');
}

// Inline mode (default in the desktop app): no extra model call. The session's own model already sees every skill;
// it gets a short nudge to pick them, plus — now and then — a prompt to judge whether its model/effort fits the task.
const MODEL_GUIDE = 'haiku: lookups, renames, one-line fixes; sonnet: routine coding in understood code, tests, docs, UI tweaks; opus: architecture, hard or unclear bugs, multi-file refactors, long plans; effort low for mechanical work, high or above only for hard reasoning';

export function inlineContext({ prompt, state, nowModel, nowEffort, advisor }) {
  state.prompts = (state.prompts || 0) + 1;
  const loaded = state.invoked.length ? ` Already loaded: ${state.invoked.join(', ')}.` : '';
  const parts = [`Skill router: before your first action, pick from the available skills the ones this task needs (how the work starts, its domains, verification) and invoke them with the Skill tool in that order; skip any that are already loaded or do not fit.${loaded}`];
  // Model check on the first routed request, then only for long (likely new) tasks, at most every 5 requests.
  const due = advisor !== 'off' && (state.adviceAt == null || (prompt.length >= 600 && state.prompts - state.adviceAt >= 5));
  if (due) {
    state.adviceAt = state.prompts;
    const now = [nowModel, nowEffort && `effort ${nowEffort}`].filter(Boolean).join(' · ') || 'an unknown model';
    parts.push(`Model check: this session runs on ${now}. Judge whether that fits this task (${MODEL_GUIDE}). Only if it is clearly over- or under-powered, say so in one short line at the start of your reply and offer to switch with the session model/effort tools if you have them; never switch without the user's yes. Otherwise say nothing about it.`);
  }
  return parts.join('\n\n');
}

const label = (model, effort) => [model && model[0].toUpperCase() + model.slice(1), effort].filter(Boolean).join(' · ');

// A suggestion is worth an interruption only when it is confident and the model tier differs, or effort is two
// steps off. Never repeat the same suggestion twice in a row in one session.
export function advice(out, nowModel, nowEffort, state) {
  if (!out?.confident || !MODEL_TIERS.includes(out.model)) return null;
  const nowTier = tierOf(nowModel);
  const recTier = tierOf(out.model);
  const effortGap = EFFORTS.includes(out.effort) && EFFORTS.includes(nowEffort)
    ? Math.abs(EFFORTS.indexOf(out.effort) - EFFORTS.indexOf(nowEffort)) : 0;
  const modelDiffers = nowTier >= 0 && nowTier !== recTier;
  if (!modelDiffers && effortGap < 2) return null;
  const key = `${out.model}/${out.effort}`;
  if (state.lastAdvice === key) return null;
  state.lastAdvice = key;
  const cheaper = modelDiffers ? recTier < nowTier : EFFORTS.indexOf(out.effort) < EFFORTS.indexOf(nowEffort);
  return {
    direction: cheaper ? 'cheaper' : 'stronger',
    text: `skill-router: ${label(out.model, out.effort)} fits this task (now ${label(MODEL_TIERS[nowTier], nowEffort)}). ${out.reason || ''}`.trim(),
  };
}

async function main() {
  if (process.env.SKILL_ROUTER_CHILD) return;
  const input = await readStdin();
  const prompt = (input.prompt || '').trim();
  const { ignore, minPromptChars, advisor } = loadOverrides();
  if (prompt.length < minPromptChars || prompt.startsWith('/')) return;

  const state = loadState(input.session_id);
  const authNotice = () => {
    if (state.authNoticeShown) return;
    state.authNoticeShown = true;
    saveState(input.session_id, state);
    process.stdout.write(JSON.stringify({ systemMessage: AUTH_NOTICE }));
  };

  const nowModel = currentModel(input.transcript_path);
  const nowEffort = process.env.CLAUDE_EFFORT || null;

  if (routerMode() === 'inline') {
    const context = inlineContext({ prompt, state, nowModel, nowEffort, advisor });
    saveState(input.session_id, state);
    log(`route-inline session=${input.session_id} prompt#=${state.prompts} modelCheck=${state.adviceAt === state.prompts} now=${nowModel || '-'}/${nowEffort || '-'}`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
    return;
  }

  // Haiku mode without a CLI login: skip the call (it would only add a few seconds) and tell the user once per session.
  if (authMissingRecently()) return authNotice();

  const catalog = buildCatalog(input.cwd).filter(s => !ignore.includes(s.name));
  const names = new Set(catalog.map(s => s.name));

  const message = `SESSION: model=${nowModel || 'unknown'} effort=${nowEffort || 'unknown'}\n\nTASK:\n${prompt.slice(0, MAX_PROMPT_CHARS)}`;

  const started = Date.now();
  const res = askClaude({ model: 'haiku', system: systemPrompt(catalog), message, timeout: 75000 });
  const out = extractJson(res.text, '{') || { skills: extractJson(res.text, '[') || [] };
  const picked = [...new Set((out.skills || []).filter(n => names.has(n)))];
  const tip = advisor === 'off' || res.error ? null : advice(out, nowModel, nowEffort, state);
  const t = res.tokens || {};
  log(`route session=${input.session_id} ms=${Date.now() - started} status=${res.status} picked=${JSON.stringify(picked)} rec=${out.model || '-'}/${out.effort || '-'}${out.confident ? '!' : ''} now=${nowModel || '-'}/${nowEffort || '-'} tip=${tip ? tip.direction : '-'} in=${t.in ?? '-'} cacheRead=${t.cacheRead ?? '-'} cost=${res.cost ?? '-'}${res.error ? ' error=' + res.error : ''}`);

  if (res.error === 'not-logged-in') return authNotice();

  state.routed = [...new Set([...state.routed, ...picked])];
  const fresh = picked.filter(n => !state.invoked.includes(n));
  const loaded = picked.filter(n => state.invoked.includes(n));
  saveState(input.session_id, state);

  const parts = [];
  if (fresh.length) {
    parts.push(`Skill router (Haiku read this request against the installed skills) — relevant skills, in the order they are needed: ${fresh.join(', ')}.${loaded.length ? ` Already loaded and still relevant: ${loaded.join(', ')}.` : ''}
Before your first action, invoke with the Skill tool the ones that govern how this work starts. Invoke each of the others when you reach the step it covers. Skip any that turn out not to apply.`);
  }
  if (tip) parts.push(`The user was shown this suggestion: "${tip.text}" Do not switch models yourself; carry on with the task.`);
  if (!parts.length) return;

  const output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } };
  if (tip) output.systemMessage = tip.text;
  process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(err => log(`route crash ${err?.stack || err}`));
}
