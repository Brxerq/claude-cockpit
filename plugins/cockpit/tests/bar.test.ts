// claude plugin test plugins/cockpit: a bar left open at the end of a turn stops looking live
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } } as never

function world(on: On, sounds: string[]) {
  mock.clock(on, { now: 1_000_000_000_000 })
  mock.store(on, { settings: {} })
  mock.env(on, {})
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
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
