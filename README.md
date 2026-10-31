# skill-router

Claude Code rarely invokes installed skills on its own. This plugin makes it use them.

- **On every actionable request** (25+ characters, not a `/command` or casual acknowledgement), Haiku reads your message against installed skills and tells the model which ones the task needs, in the order it needs them.
- **While the model works**, each Edit/Write is checked against the file kind (UI, tests, Swift, Kotlin, SQL, …). If a matching skill is not loaded yet, the model gets a one-time reminder. This part runs locally and costs no tokens.
- **It tunes itself to your setup.** On first start, and whenever your skill set changes, a background Opus pass groups your skills into domains, maps file kinds to them, and flags duplicated or deprecated skills. Review those with `/skill-router:cleanup`; nothing is removed without your OK.
- **Model and effort check.** It judges whether the task fits the model and effort the session runs on (Haiku for lookups and one-line fixes, Sonnet for routine coding, Opus for architecture, hard bugs and long plans). Only a clear mismatch is mentioned, in one line; nothing is switched without your yes.

## Two modes

- **inline** (default in the Claude desktop app): no extra model call, no delay, no login needed. The desktop app does not pass its login to child processes, so a separate `claude -p` cannot run there. Instead the session's own model, which already sees every skill, gets a short instruction to pick them, and on the first request (and later long, new tasks) a model/effort check. In the desktop app it can offer to switch model or effort with the session tools. Setup tuning is skipped; your `fileRules` still drive the file reminders.
- **haiku** (default elsewhere): one Haiku call per request picks the skills and judges model/effort; a mismatch is shown to you as a one-line suggestion. Needs a logged-in `claude` CLI; without one, routing pauses for 15 minutes and tells you once.

Cloud sessions also use inline. Force one with `"mode": "inline"` or `"mode": "haiku"` in `overrides.json`.

## Cloud sessions

Cloud sessions (claude.ai/code, the mobile app, the desktop app's Cloud environments) don't install plugins and don't read `~/.claude`. They do run hooks committed to the repository. To use skill-router there:

1. Copy `extras/cloud-loader.mjs` to `<repo>/.claude/hooks/skill-router.mjs`.
2. Merge the hooks from `extras/cloud-settings.json` into `<repo>/.claude/settings.json`.
3. Put the project's rules in `<repo>/.claude/skill-router.json` (same keys as `overrides.json`) and commit all three.

At session start the loader shallow-clones this repository into `~/.cache/skill-router` inside the cloud VM and runs the hooks from there. On your own machine it exits immediately, because the installed plugin already runs, so nothing runs twice. Set `SKILL_ROUTER_REPO` / `SKILL_ROUTER_REF` on the cloud environment to pin another fork or a tag.

## Install

Inside Claude Code:

```
/plugin marketplace add Ilkegnn/skill-router
/plugin install skill-router@skill-router
```

Or in a terminal:

```
claude plugin marketplace add Ilkegnn/skill-router
claude plugin install skill-router@skill-router
```

Start a new session. You will see one message while it tunes itself (about a minute, in the background).

## Update

To update to the latest version:

Inside Claude Code:

```
/plugin marketplace update Ilkegnn/skill-router
/plugin update skill-router
```

Or in a terminal:

```
claude plugin marketplace update Ilkegnn/skill-router
claude plugin update skill-router@skill-router
```

The router automatically detects new setup versions and re-tunes itself in the background when your next session starts.

## Cost & Performance

- **Routing (inline):** no model call; ~100 tokens of instructions added to the request, ~0.3 s.
- **Routing (haiku):** one Haiku call per actionable request (~8k input tokens with ~100 skills, 20 s timeout). The catalog is sent as a stable system prompt file so repeat calls hit the prompt cache; `router.log` records input, cache-read tokens and cost per call. Already-invoked skills are skipped.
- **Tuning:** one background Opus call per skill-set change (~30k input tokens with ~100 skills).
- **File reminders:** 100% local regex checking — zero tokens, zero delay.

## Files & Safety

Everything it writes lives in `~/.claude/skill-router/`:
- `profile.json` (the tuned setup, saved atomically)
- `router.log` (routing decisions, auto-rotated when > 1 MB)
- `state/` and `prompts/` (per-session state and cached Haiku system prompts, auto-cleaned after 7 days)
- `auth-missing` (present while the CLI has no login; haiku mode only)

Delete `profile.json` to force a re-tune.

## Overrides (optional)

Not needed — everything above is automatic. If you want the last word on something, create `~/.claude/skill-router/overrides.json` (yours, every project) or `<repo>/.claude/skill-router.json` (committed, reaches teammates and cloud sessions; wins over yours, lists are merged):

```json
{
  "protect": ["my-skill"],
  "ignore": ["skill-i-never-want-suggested"],
  "fileRules": { "ui": ["impeccable"] },
  "extraSkillDirs": [{ "dir": "~/my-skills", "prefix": "mine:" }],
  "minPromptChars": 25,
  "mode": "auto",
  "advisor": "notify"
}
```

- `protect`: never offered for cleanup (also auto-populated when you choose to keep a flagged skill in `/skill-router:cleanup`).
- `ignore`: never routed or reminded.
- `fileRules`: replaces the tuned skills for a file kind (`ui`, `motion`, `test`, `e2e`, `reactNative`, `swift`, `android`, `python`, `rust`, `go`, `sql`, `infra`, `llmApp`, `designSpec`, `skillFile`). In inline mode these are the only file rules.
- `extraSkillDirs`: more folders of skills to include.
- `minPromptChars`: shortest message that gets routed (default 25).
- `mode`: `auto` (default), `inline` or `haiku`; see Two modes.
- `advisor`: `notify` (default) or `off` for the model/effort check.

## Which skills it sees

User skills (`~/.claude/skills`), claude.ai-synced skills, plugins enabled in `~/.claude/settings.json`, plugins installed through the Claude desktop app (Windows `%LOCALAPPDATA%\Claude-Data`, macOS `~/Library/Application Support/Claude-Data`; set `SKILL_ROUTER_DESKTOP_DATA` if yours lives elsewhere), and the project's `.claude/skills`. A plugin's skills are read from `skills/` and from the `skills` path its `plugin.json` declares. Aliases (same plugin, same description) are counted once. A project skill never shadows a user or plugin skill of the same name.

Requires Node.js on PATH. Tests: `node --test tests/router.test.mjs`.

## License

MIT
