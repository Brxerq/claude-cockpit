// claude plugin test plugins/cockpit: the router decides on a session's first request
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

function world(on: On, sent: string[], state = { isUsageBroken: false }) {
  mock.clock(on, { now: 1_000_000_000_000 })
  mock.store(on, { settings: { routes: { normal: 'sonnet high' } } })
  mock.env(on, {})
  on('session.usage', () => {
    if (state.isUsageBroken) throw new Error('no usage yet')
    return { value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.read', () => {
    throw new Error('no such file')
  })
  on('process.run', () => ({ value: { code: 0, stdout: '', stderr: '' } }) as never)
  on('audio.play', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.step', async function* ($, e) {
    sent.push(String(e.model))
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, model: e.model } } as never
  })
}

const request = async ($: any, index: number) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-fable-5-1', messageCount: 1 })
  for (;;) if ((await stream.next()).done) return
}

test('a normal prompt runs on its route', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await $.prompt.submit({ text: 'Review the router code and explain how routes are decided.', origin: { kind: 'sdk' } } as never)
  await request($, 0)
  expect(sent).toEqual(['claude-sonnet-5-5'])
})

test('a turn whose first request carried no decision still gets its route on a later request', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await $.prompt.submit({ text: 'Review the router code and explain how routes are decided.', origin: { kind: 'sdk' } } as never)
  await request($, 1)
  expect(sent).toEqual(['claude-sonnet-5-5'])
})

test('a failing usage call does not keep the turn off its route', async ($, on) => {
  const sent: string[] = []
  const state = { isUsageBroken: false }
  world(on, sent, state)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await $.prompt.submit({ text: 'Review the router code and explain how routes are decided.', origin: { kind: 'sdk' } } as never)
  state.isUsageBroken = true
  await request($, 0)
  expect(sent).toEqual(['claude-sonnet-5-5'])
})
