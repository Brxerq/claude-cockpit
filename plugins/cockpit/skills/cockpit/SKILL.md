---
name: cockpit
description: Reference for Cockpit's plan_progress bars and its /route model router. The bar rules are already in the system prompt; load only when the user asks about the bars or the router, or a bar call was refused.
---

# Bars

The todo list (TodoWrite, or TaskCreate and TaskUpdate) shows as the `tasks` bar by itself, at no extra cost. No todo tool in this session (the desktop app has none)? Use plan_progress for any task of 3+ steps.

## plan_progress

Create once: `{id, title, stages:[{name, steps:[{title}]}]}`. 2-5 stages, titles of at most 4 words, in the user's language. The first step becomes active.

Update once per stage (each call costs tokens):
- `{id, next:true}`: active step done, next one active
- `{id, done:["A","B"]}`: mark several done at once
- `{id, failed:"B", note}`: error
- `{id, state:"needs_input", note}`: before asking the user
- `{id, state:"done"}`: finish

Plan changed: resend `stages` under the same `id`; finished steps keep their done by title. A step title the bar does not have is refused with the step list. A plan approved in plan mode lands on the bar `plan`. The reply is `done/total`.

User commands: `/progress`, `/progress-demo`, `/progress-sounds`, `/progress-clear`.

# Router (/route)

Each typed prompt is sorted into quick, normal or hard, and runs on the model and effort the user chose for that kind. Nothing is chosen by default: "keep" leaves the user's own setting. Subagents are never routed. In a long conversation, short trips to another model wait unless the user asked (to keep the cache warm).

- `/route`: open the panel and pick a model and effort per kind
- `/route set hard opus high` (models: haiku, sonnet, opus, fable, keep; effort: low .. max, keep)
- `/route test <prompt>`, `/route stats`, `/route on|off|clear`, `/route help`
- Rules (checked first): `/route rule redesign = sonnet max`; still stuck past xhigh: `/route stuck fable`; `/route saver on|off`
- All settings live in `~/.claude/cockpit.json`.
- One prompt only: lead with `@hard`, `@opus`, `@max` and so on; stripped before sending.
- Per project: `.claude/cockpit.json` with `routes` and `words`.
