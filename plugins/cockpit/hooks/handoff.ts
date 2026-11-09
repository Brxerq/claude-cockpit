// Compact or hand off: as the conversation nears the point where Claude Code compacts it by itself, one side request
// asks the model, over the cached conversation, whether the work is mid-task (compact, keeping the plan) or at a clean
// stop (a handoff file a fresh session starts from). The handoff shape derives from the handoff mod in benai-mods.
import type { Plan } from '../types'
import { isFinished } from './plan.ts'

// the decision comes at this share of Claude Code's own compaction point, so it runs before the engine's does
export const DECIDE_AT = 0.85

type Breakdown = { totalTokens: number; rawMaxTokens: number; categories: readonly { kind: string; tokens: number }[] }

// the engine compacts at its window less the compaction reserve
export const compactPoint = (b: Breakdown) => b.rawMaxTokens - b.categories.filter(c => c.kind === 'buffer').reduce((n, c) => n + c.tokens, 0)
export const isDue = (b: Breakdown) => b.totalTokens >= compactPoint(b) * DECIDE_AT

// steps not finished, whatever the bar's state: the end of a turn turns a running bar to needs_input
export const openSteps = (list: readonly Plan[]) =>
  list.filter(p => p.state !== 'done').flatMap(p => p.stages.flatMap(s => s.steps).filter(s => !isFinished(s.status)).map(s => `${p.title}: ${s.title}`))

const HANDOFF_SHAPE = (cwd: string) => `Write it for a session that starts with an empty context. It can open files on this machine but cannot see this chat; it loads CLAUDE.md and its memory by itself, so do not repeat those. Plain, short English; leave out a section with nothing in it; under 1,500 words.

# Handoff: <the goal, in a few words>

Continue work in \`${cwd}\`. Goal: <what the user is working toward now>.

## What the user asked for
Every request in this chat, in order, in the user's key words, each marked done, in progress or not started.

## Where things stand
What is done and checked, the key decisions and why, what was tested and what was not.

## Rules the user set
Standing constraints and preferences from this chat.

## Files to open first
- \`<path>\`: why, in one line. At most 15; paths only, never file content.

## Errors already solved
- <the error>: <the fix>.

## Carried-over data
Ids, URLs, numbers and decisions that exist only in this chat, verbatim.

## Next steps
1. The very next action, specific enough to start without a question.

Never write an API key, token or password; say where it lives instead.`

export function decidePrompt(cwd: string, open: readonly string[], isForced: boolean) {
  const bars = open.length ? `The progress bars show these steps unfinished:\n${open.map(s => `- ${s}`).join('\n')}` : 'The progress bars show no unfinished steps.'
  const handoff = `put HANDOFF on the first line, then the handoff prompt for a fresh session, no preamble and no code fence. ${HANDOFF_SHAPE(cwd)}`
  if (isForced) return `Do not call any tool. Write a handoff of this conversation: ${handoff}`
  return `This conversation is close to the point where Claude Code compacts it. Decide how the work carries on. Do not call any tool.

${bars}

If the work is in the middle of a task (steps left, a fix half done, tests failing, a question waiting), put COMPACT on the first line, then in under 150 words what the summary must keep: the goal, the steps left, the decisions, the file paths.

If the work is at a clean stopping point (finished or committed, or the next request is a different task), ${handoff}`
}

// the first line names the choice; anything else is no answer
export function parseDecision(text: string): { kind: 'compact' | 'handoff'; body: string } | null {
  const t = text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, '$1')
  const m = /^\**(COMPACT|HANDOFF)\**[ \t]*:?[ \t]*\n?/i.exec(t)
  if (!m) return null
  return { kind: m[1]?.toLowerCase() === 'compact' ? 'compact' : 'handoff', body: t.slice(m[0].length).trim() }
}

// anything shaped like a secret is cut before the handoff is saved or copied
export const redact = (text: string) =>
  text.replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, '<secret removed>').replace(/(Bearer\s+)[A-Za-z0-9._-]{20,}/g, '$1<secret removed>')

// 2026-10-26-143005-fix-the-login.md, from the handoff's own title; seconds, so two in one minute do not overwrite
export function fileName(text: string, now: number) {
  const title = /^#\s*Handoff:\s*(.+)$/m.exec(text)?.[1] ?? ''
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'session'
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${slug}.md`
}
