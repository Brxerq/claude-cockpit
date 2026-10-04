// claude plugin test plugins/cockpit: the cache meter through the engine's own hooks
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const T0 = 1_000_000_000_000
const MIN = 60_000
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } } as never

type World = { toasts: string[]; forks: number; windows?: { kind: string; percentUsed: number }[] }

// what sits beneath the plugin: a clock the test moves, a store in memory, and an API whose every request reads
// 80k tokens from the cache
function world(on: On, w: World, settings: object = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { settings })
  mock.env(on, {})
  const usage = { input_tokens: 300, output_tokens: 2, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 0 }
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: w.windows ?? [] } }) as never)
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
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text: unknown }).text))
    return { value: undefined } as never
  })
  on('model.fork', () => {
    w.forks += 1
    return { value: { isAnswered: true, text: '.', usage } } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: 'claude-opus-5-5' } } as never
  })
  return clock
}

async function request($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as never)
  for (;;) if ((await stream.next()).done) return
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

test('a request starts the countdown; one warning comes before the end; the button keeps it warm', async ($, on) => {
  const w: World = { toasts: [], forks: 0 }
  const clock = world(on, w)
  await start($)
  await request($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cockpit', surface, ...(BAND as object) } as never)
    expect(await ui.find({ type: 'Text', text: /Prompt cache · 80k/ })).toBeDefined()
    // the desktop draws the track as a picture whose alt text names the time left
    if (surface === 'desktop') expect(JSON.stringify(await ui.find({ type: 'Svg' }))).toMatch(/5m left, 100%/)
    // with most of the lifetime left there is nothing to press
    expect(await ui.find({ key: 'cache-warm' })).toBeUndefined()
    await ui.unmount()
  }

  // inside the last minute: one toast, however many seconds pass
  await clock.advance(4 * MIN + 5000)
  expect(w.toasts.filter(t => /Cache expires in/.test(t))).toHaveLength(1)
  expect(w.forks).toBe(0)

  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', ...(BAND as object) } as never)
  await ui.press({ key: 'cache-warm' })
  expect(w.forks).toBe(1)
  expect(w.toasts.at(-1)).toMatch(/Cache kept warm: 80k tokens/)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /Prompt cache · 80k/ })).toBeDefined()
  await ui.unmount()

  // left alone, it lapses and the row says what the next prompt costs
  await clock.advance(6 * MIN)
  const cold = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', ...(BAND as object) } as never)
  expect(await cold.find({ type: 'Text', text: /Cache expired · next prompt re-reads 80k/ })).toBeDefined()
  await cold.unmount()
  expect(w.forks).toBe(1)
})

test('with automatic pings allowed, Cockpit keeps the cache warm by itself, up to the limit', async ($, on) => {
  const w: World = { toasts: [], forks: 0 }
  const clock = world(on, w, { cache: { auto: 2 } })
  await start($)
  await request($)

  await clock.advance(20 * MIN)
  expect(w.forks).toBe(2)
  expect(w.toasts.filter(t => /Cache kept warm/.test(t))).toHaveLength(2)
  // the third time it only warns
  expect(w.toasts.filter(t => /Cache expires in/.test(t))).toHaveLength(1)
})

test('a subagent request is not the conversation and leaves the row out', async ($, on) => {
  const w: World = { toasts: [], forks: 0 }
  world(on, w)
  await start($)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'a1' } as never)
  for (;;) if ((await stream.next()).done) break

  // the plugin draws nothing, so the band is left to the engine, which this test does not stand in for
  await expect($.ui.mount({ plugin: 'cockpit', surface: 'terminal', ...(BAND as object) } as never)).rejects.toThrow(/nothing beneath the plugins answers ui.render|no implementation for ui.render/)
})

test('a Claude subscription counts on the hour', async ($, on) => {
  const w: World = { toasts: [], forks: 0, windows: [{ kind: 'five_hour', percentUsed: 12 }] }
  world(on, w)
  await start($)
  await request($)

  const ui = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', ...(BAND as object) } as never)
  expect(JSON.stringify(await ui.find({ type: 'Svg' }))).toMatch(/60m left/)
  await ui.unmount()
  const said = await $.command.run({ command: 'cache', args: '' } as never)
  expect((said as { text: string }).text).toMatch(/Cache lifetime: 1h \(Claude subscription\)/)
})
