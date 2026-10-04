// claude plugin test plugins/cockpit: the bar tool stays in the prompt's list, so a model can call it without a lookup
import { expect, test } from 'claude-code/testing'

test('plan_progress is listed in the prompt, not behind ToolSearch', async ($, on) => {
  // the engine's own placement for a plugin's tool: deferred
  on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }) as never)
  const tool = 'mcp__cockpit__plan_progress'
  const r = await $.tool.describe({ tool, description: 'Progress bar', isDeferred: true, provider: { plugin: 'cockpit', tier: 'user' } } as never)
  expect(r.isDeferred).toBe(false)
  const other = await $.tool.describe({ tool: 'mcp__other__x', description: 'x', isDeferred: true, provider: { plugin: 'other', tier: 'user' } } as never)
  expect(other.isDeferred).toBe(true)
})
