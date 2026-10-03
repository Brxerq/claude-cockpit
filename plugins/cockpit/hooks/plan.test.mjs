// node hooks/plan.test.mjs (Node 22+ strips the TypeScript types itself)
import assert from 'node:assert/strict'
import { carryDone, normalize, parsePlan, where } from './plan.ts'
import { STATE_COLOR, trackSvg } from './draw.ts'

const stages = [
  { name: 'Build', steps: [{ title: 'Routes' }, { title: 'Store' }, { title: 'UI' }] },
  { name: 'Verify', steps: [{ title: 'Tests' }] },
]

// a new bar starts with its first step active
let plan = normalize({ id: 'a', title: 'Checkout', stages }, null, 1000, 'a')
assert.equal(plan.state, 'running')
assert.equal(plan.stages[0].steps[0].status, 'active')
assert.equal(where(plan).total, 4)

// short updates move it on
plan = normalize({ id: 'a', next: true }, plan, 2000, 'a')
assert.equal(plan.stages[0].steps[0].status, 'done')
assert.equal(plan.stages[0].steps[1].status, 'active')
plan = normalize({ id: 'a', done: ['Store', 'UI'] }, plan, 3000, 'a')
assert.equal(where(plan).pos, 3)
assert.equal(plan.stages[1].steps[0].status, 'active') // finishing the step in progress moves on

// a step the bar does not have is refused, with the step list
const refused = normalize({ id: 'a', done: ['Nope'] }, plan, 4000, 'a')
assert.equal(typeof refused, 'string')
assert.match(refused, /Routes/)

// resending the plan keeps what was finished, by title
const again = normalize({ id: 'a', stages: [...stages, { name: 'Ship', steps: [{ title: 'Deploy' }] }] }, plan, 5000, 'a')
assert.equal(where(again).total, 5)
assert.equal(where(again).pos, 3)
assert.equal(carryDone(stages.map(s => ({ ...s, steps: s.steps.map(t => ({ ...t, status: 'pending', substeps: [] })) })), plan.stages)[0].steps[0].status, 'done')

// finishing the last step closes the bar
plan = normalize({ id: 'a', next: true }, plan, 6000, 'a')
assert.equal(plan.state, 'done')

// an approved plan in markdown becomes a bar
const md = parsePlan('# Fix login\n## Investigate\n- Read the auth code\n- Reproduce\n## Fix\n- Patch the check\n', 0)
assert.equal(md.title, 'Fix login')
assert.deepEqual(md.stages.map(s => s.steps.length), [2, 1])

// the drawing is real SVG in the state's colour
const drawn = trackSvg({ ...plan, state: 'needs_input', stages: again.stages }, 420)
assert.match(drawn.base, /^<svg/)
assert.ok(drawn.base.includes(STATE_COLOR.needs_input))
assert.match(drawn.overlay, /width="420"/)

console.log('plan ok')
