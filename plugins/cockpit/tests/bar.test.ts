// claude plugin test plugins/cockpit: a bar left open at the end of a turn stops looking live
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { moveSteps } from '../hooks/plan.ts'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } } as never

function world(on: On, sounds: string[], saved: object = {}) {
  mock.clock(on, { now: 1_000_000_000_000 })
  mock.store(on, { settings: {}, ...saved })
  mock.env(on, {})
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.read', () => {
    throw new Error('no such file')
  })
  on('process.run', () => {
    sounds.push('process')
    return { value: { code: 0, stdout: '', stderr: '' } } as never
  })
  on('audio.play', () => {
    sounds.push('audio')
    return { value: undefined } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('classic.Stop', () => ({}) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
}

const create = ($: any) => $.tool.call({ tool: 'mcp__cockpit__plan_progress', id: 'job', title: 'Job', stages: [{ name: 'Build', steps: [{ title: 'One' }, { title: 'Two' }] }] })

test('a turn that ends with the bar untouched turns it amber, without a sound', async ($, on) => {
  const sounds: string[] = []
  world(on, sounds)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await create($)
  // a new turn: the bar made above belongs to the one before
  await $.turn.start({ turnId: 't2', text: 'deploy' } as never)
  const before = sounds.length
  await ($ as any).classic.Stop({ stop_hook_active: false, last_assistant_message: 'Pushed.' })

  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', ...(BAND as object) } as never)
  expect(JSON.stringify(await ui.find({ type: 'Svg' }))).toMatch(/Not updated this turn/)
  expect(sounds.length).toBe(before)
  await ui.unmount()
})

test("the desktop app's update_plan feeds the tasks bar", async ($, on) => {
  world(on, [])
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'build it' } as never)
  const plan = (input: object) => $.tool.call({ tool: 'mcp__ccd_turn__update_plan', ...input } as never)
  await plan({ items: [{ content: 'Read', status: 'in_progress' }, { content: 'Edit', status: 'pending' }], scope: 'first_task' })
  await plan({ advance: true })
  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', ...(BAND as object) } as never)
  expect(JSON.stringify(await ui.find({ type: 'Svg' }))).toMatch(/step 2 of 2, 50%/)
  await ui.unmount()

  const steps = ['Read', 'Edit', 'Test'].map((title, i) => ({ title, status: i === 0 ? 'active' : 'pending', substeps: [] }) as never)
  const statuses = (s: { status: string }[]) => s.map(st => st.status)
  const advanced = moveSteps(steps, { advance: true }, 1)
  expect(statuses(advanced)).toEqual(['done', 'active', 'pending'])
  const jumped = moveSteps(advanced, { done: [2], start: 3 }, 2)
  expect(statuses(jumped)).toEqual(['done', 'done', 'active'])
  expect(statuses(moveSteps(jumped, { advance: true }, 3))).toEqual(['done', 'done', 'done'])
})

const NOTHING = /no implementation for ui.render/
const mount = ($: any) => $.ui.mount({ plugin: 'cockpit', surface: 'desktop', ...(BAND as object) } as never)

test('a bar you closed stays closed until your next prompt', async ($, on) => {
  world(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await create($)
  const ui = await mount($)
  await ui.press({ key: 'close-job' })
  await ui.unmount()
  // the app restarts the session's process: what was closed is read back from the store
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)

  // the model moves the bar, then makes it again: neither brings it back, and neither is refused
  const moved = await $.tool.call({ tool: 'mcp__cockpit__plan_progress', id: 'job', next: true } as never)
  expect((moved as { deny?: string }).deny).toBeUndefined()
  await create($)
  await expect(mount($)).rejects.toThrow(NOTHING)

  await $.prompt.submit({ text: 'next job', origin: { kind: 'sdk' } } as never)
  await create($)
  const back = await mount($)
  expect(await back.find({ key: 'bar-job' })).toBeDefined()
  await back.unmount()
})

test('bars you hid stay hidden when the session starts again, and a new bar does not show them', async ($, on) => {
  // what an earlier run of this session left in the store: bars hidden, the "job" bar closed
  world(on, [], { 'view:s1': { isOpen: false, hidden: false, closed: ['job'] } })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await create($)
  await $.tool.call({ tool: 'mcp__cockpit__plan_progress', id: 'other', title: 'Other', stages: [{ name: 'Build', steps: [{ title: 'One' }] }] } as never)
  await expect(mount($)).rejects.toThrow(NOTHING)

  // shown again: the new bar is there, the closed one is not
  await $.command.run({ command: 'progress', args: '' } as never)
  const back = await mount($)
  expect(await back.find({ key: 'bar-other' })).toBeDefined()
  expect(await back.find({ key: 'bar-job' })).toBeUndefined()
  await back.unmount()
})

test("a subagent's turn does not wipe the main turn's work", async ($, on) => {
  const sounds: string[] = []
  world(on, sounds)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'build it' } as never)
  await create($)
  // since 2.1.299 a subagent's turn starts through the same hook, told apart by agentId
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'look around' } as never)
  await ($ as any).classic.Stop({ stop_hook_active: false, last_assistant_message: 'Half done.' })

  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', ...(BAND as object) } as never)
  expect(JSON.stringify(await ui.find({ type: 'Svg' }))).toMatch(/Stopped with steps left/)
  await ui.unmount()
})
