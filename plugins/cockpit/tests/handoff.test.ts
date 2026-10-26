// claude plugin test plugins/cockpit: near the compaction point the model chooses compact or handoff
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } } as never
const HANDOFF = 'HANDOFF\n# Handoff: fix the login\n\nContinue work in `/repo`. Token sk-abcdefghijklmnopqrstuvwx stays out.'

// total: the context in use; the engine compacts at 200k less its 20k reserve, so the decision comes at 153k
type World = { total: number; reply: string; prompts: string[]; compacts: string[]; files: Record<string, string>; toasts: string[]; canStart?: boolean; runs?: string[][] }

function world(on: On, w: World) {
  const clock = mock.clock(on, { now: 1_000_000_000_000 })
  mock.store(on, { settings: {} })
  mock.env(on, { HOME: '/home/u' })
  const breakdown = () => ({ totalTokens: w.total, rawMaxTokens: 200_000, categories: [{ kind: 'used', tokens: w.total }, { kind: 'buffer', tokens: 20_000 }] })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, breakdown: breakdown() }, rateLimits: [] } }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('session.compact', ($, e) => {
    w.compacts.push(String((e as { instructions?: string }).instructions))
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never
  })
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.read', () => {
    throw new Error('no such file')
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as { path: string; text: string }
    w.files[path.replace(/\\/g, '/')] = text
    return { value: undefined } as never
  })
  on('process.run', ($, e) => {
    w.runs?.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  // the desktop app's tool to start a session: there, or not
  on('tool.call', ($, e) => ((e as { tool: string }).tool === 'mcp__ccd_session__start_session' && !w.canStart ? { deny: 'No such tool' } : { result: 'ok' }) as never)
  on('audio.play', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text: unknown }).text))
    return { value: undefined } as never
  })
  on('model.fork', ($, e) => {
    w.prompts.push(String((e as { prompt: unknown }).prompt))
    return { value: { isAnswered: true, text: w.reply, usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: w.total, cache_creation_input_tokens: 0 } } } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('classic.Stop', () => ({}) as never)
  return clock
}

const fresh = (): World => ({ total: 100_000, reply: HANDOFF, prompts: [], compacts: [], files: {}, toasts: [] })

async function endTurn($: Engine, clock: { advance: (ms: number) => Promise<void> }, agentId?: string) {
  await $.turn.start({ turnId: 't1', text: 'go', ...(agentId ? { agentId } : {}) } as never)
  await ($ as any).classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.' })
  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}), usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)
  await clock.advance(10)
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)

test('below the compaction point nothing happens; a subagent turn is never counted', async ($, on) => {
  const w = fresh()
  const clock = world(on, w)
  await start($)
  await endTurn($, clock)
  expect(w.prompts).toHaveLength(0)
  w.total = 160_000
  await endTurn($, clock, 'a1')
  expect(w.prompts).toHaveLength(0)
})

test('with steps left the model is told so, and its COMPACT answer compacts with its notes', async ($, on) => {
  const w = { ...fresh(), reply: 'COMPACT\nKeep the goal: fix login. Steps left: Test.' }
  const clock = world(on, w)
  await start($)
  await $.tool.call({ tool: 'mcp__cockpit__plan_progress', id: 'job', title: 'Job', stages: [{ name: 'Build', steps: [{ title: 'Edit', status: 'done' }, { title: 'Test' }] }] } as never)
  w.total = 160_000
  // the turn's end turns the bar to needs_input; its unfinished step still counts
  await endTurn($, clock)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toMatch(/unfinished:\n- Job: Test/)
  expect(w.compacts).toEqual(['Keep the goal: fix login. Steps left: Test.'])
  expect(w.toasts.join('\n')).toMatch(/compacted/)
  // still high, already decided: no second side request
  await endTurn($, clock)
  expect(w.prompts).toHaveLength(1)
})

test('at a clean stop the HANDOFF answer is saved, secrets cut, and shown above the prompt', async ($, on) => {
  const w = { ...fresh(), total: 160_000 }
  const clock = world(on, w)
  await start($)
  await endTurn($, clock)
  expect(w.prompts[0]).toMatch(/no unfinished steps/)
  expect(w.compacts).toHaveLength(0)
  const [path, text] = Object.entries(w.files).find(([p]) => /\/\.claude\/handoffs\/.+-fix-the-login\.md$/.test(p)) ?? []
  expect(path).toBeDefined()
  expect(text).toMatch(/^# Handoff: fix the login/)
  expect(text).not.toMatch(/sk-abc/)
  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', ...(BAND as object) } as never)
  expect(await ui.find({ type: 'Text', text: /Handoff ready/ })).toBeDefined()
  // no session tool here: a start line goes to the clipboard instead
  await ui.press({ key: 'handoff-start' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /Copied a start line/ })).toBeDefined()
  w.canStart = true
  await ui.press({ key: 'handoff-start' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /New session started/ })).toBeDefined()
  await ui.unmount()
})

test('a reply running when the check comes: nothing compacts, and the next turn end asks again', async ($, on) => {
  const w = { ...fresh(), total: 160_000, reply: 'COMPACT\nKeep the plan.' }
  const clock = world(on, w)
  await start($)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  await ($ as any).classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.' })
  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  // the next prompt is sent before the check runs
  await $.turn.start({ turnId: 't2', text: 'more' } as never)
  await clock.advance(10)
  expect(w.prompts).toHaveLength(0)
  expect(w.compacts).toHaveLength(0)
  await ($ as any).classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.' })
  await $.turn.complete({ turnId: 't2', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await clock.advance(10)
  expect(w.compacts).toEqual(['Keep the plan.'])
})

test('/handoff writes one whatever the size; /handoff auto off stops the automatic check', async ($, on) => {
  const w = fresh()
  const clock = world(on, w)
  await start($)
  await $.command.run({ command: 'handoff', args: '' } as never)
  await clock.advance(10)
  expect(w.prompts[0]).toMatch(/^Do not call any tool. Write a handoff/)
  await $.command.run({ command: 'handoff', args: 'auto off' } as never)
  w.total = 160_000
  await endTurn($, clock)
  expect(w.prompts).toHaveLength(1)
})
