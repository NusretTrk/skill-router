---
name: cleanup
description: Review the skills skill-router flagged as duplicated or deprecated and archive the ones the user approves.
disable-model-invocation: true
---

# Review flagged skills

1. Read `~/.claude/skill-router/profile.json` and take its `cleanup` list. If it is empty or missing, say there is nothing to review and stop.
2. Show one table: skill, which skill covers it (`keep`), the reason, and where it lives (`source`).
3. Explain what can be done for each source:
   - `user` or `project`: the folder in `dir` can be moved to `~/.claude/skills-archive/<timestamp>_<source>_<skill_name>/` (preserving history and preventing name collisions).
   - `plugin:<id>`: single plugin skills cannot be removed. Only suggest `claude plugin disable <id>` if every skill of that plugin is redundant, and explain what else the plugin provides.
   - `desktop:<name>`: a plugin installed through the Claude desktop app. Single skills cannot be removed; if the whole plugin is redundant, the user can turn it off in the app's plugin settings.
   - `synced`: managed by claude.ai; leave it.
   - `extra`: a folder the user listed in `extraSkillDirs`; same handling as `user`.
4. Ask the user which actions to apply. Change nothing they did not approve:
   - If the user chooses to **keep/protect** a flagged skill, add its name to the `protect` array in `~/.claude/skill-router/overrides.json` so it will never be flagged for cleanup again.
5. For approved `user`/`project`/`extra` removals:
   - Create `~/.claude/skills-archive/<ISO_TIMESTAMP>_<source>_<skill_name>/` and move the folder there.
   - A project skill tracked by git is a repository change: inform the user before moving it.
6. Tell the user the router re-tunes itself automatically at the next session start, because the skill set or overrides changed.
