# skill-router

Claude Code rarely invokes installed skills on its own. This plugin makes it use them.

- **On every work request** (200+ characters, not a `/command`), Haiku reads your message against all installed skills and tells the model which ones the task needs, in the order it needs them.
- **While the model works**, each Edit/Write is checked against the file kind (UI, tests, Swift, Kotlin, SQL, …). If a matching skill is not loaded yet, the model gets a one-time reminder. This part runs locally and costs no tokens.
- **It tunes itself to your setup.** On first start, and whenever your skill set changes, a background Opus pass groups your skills into domains, maps file kinds to them, and flags duplicated or deprecated skills. Review those with `/skill-router:cleanup`; nothing is removed without your OK.

## Install

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

## Cost

- Routing: one Haiku call per work request (~8k input tokens with ~100 skills), adds a few seconds before the reply.
- Tuning: one Opus call per skill-set change (~30k input tokens with ~100 skills).
- File reminders: none.

## Files

Everything it writes lives in `~/.claude/skill-router/`:
`profile.json` (the tuned setup), `router.log` (every routing decision), `state/` (per-session record of loaded skills).
Delete `profile.json` to force a re-tune.

## Overrides (optional)

Not needed — everything above is automatic. If you want the last word on something, create `~/.claude/skill-router/overrides.json`:

```json
{
  "protect": ["my-skill"],
  "ignore": ["skill-i-never-want-suggested"],
  "fileRules": { "ui": ["impeccable"] },
  "extraSkillDirs": [{ "dir": "~/my-skills", "prefix": "mine:" }],
  "minPromptChars": 120
}
```

- `protect`: never offered for cleanup.
- `ignore`: never routed or reminded.
- `fileRules`: replaces the tuned skills for a file kind (`ui`, `motion`, `test`, `e2e`, `reactNative`, `swift`, `android`, `python`, `rust`, `go`, `sql`, `infra`, `llmApp`, `designSpec`, `skillFile`).

- `extraSkillDirs`: more folders of skills to include.
- `minPromptChars`: shortest message that gets routed (default 200).

## Which skills it sees

User skills (`~/.claude/skills`), claude.ai-synced skills, plugins enabled in `~/.claude/settings.json`, plugins installed through the Claude desktop app (Windows `%LOCALAPPDATA%\Claude-Data`, macOS `~/Library/Application Support/Claude-Data`; set `SKILL_ROUTER_DESKTOP_DATA` if yours lives elsewhere), and the project's `.claude/skills`. A plugin's skills are read from `skills/` and from the `skills` path its `plugin.json` declares. Aliases (same plugin, same description) are counted once.

Session records older than two weeks are deleted and `router.log` is kept under ~1 MB.

Requires Node.js on PATH.

## License

MIT
