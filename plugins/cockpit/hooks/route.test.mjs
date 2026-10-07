// node hooks/route.test.mjs (named .test.mjs, not .test.ts, so `claude plugin test` leaves it alone)
import assert from 'node:assert/strict'
import { parseRule, addTurn, buildRoutes, classify, clampEffort, emptyRoutes, emptyStats, formatStats, guard, isSetUp, MODELS, parsePrompt, parseSpec, routeFor, shortModel, specText } from './route.mjs'

const task = (text, prevTask = null, words) => classify(text, { prevTask, words }).task

// --- sorting prompts
assert.equal(task('rename getUser to fetchUser'), 'quick')
assert.equal(task('Change the button color to blue'), 'quick')
assert.equal(task('what does this function return?'), 'quick')
assert.equal(task('add a pricing section to the homepage with three plans'), 'normal')
assert.equal(task('checkout page is broken after deploy'), 'hard')
assert.equal(task('redesign the whole site navigation'), 'hard')
assert.equal(task('ultrathink about the caching layer'), 'hard')
// follow-ups keep the kind; "still broken" steps up
assert.equal(task('yes', 'normal'), 'normal')
assert.equal(task('still not working', 'quick'), 'normal')
assert.equal(task('same error', 'normal'), 'hard')
assert.equal(task('yes', 'lock'), 'normal') // an unknown earlier kind is ignored
// a pasted log past 300 characters does not decide
assert.equal(task('add a footer with social links ' + 'x'.repeat(300) + ' error crash'), 'normal')
// project keywords
assert.equal(task('publish the changelog', null, { quick: ['changelog'] }), 'quick')

// --- @tags: stripped, and they win
const tagged = classify('@opus @high refactor the auth module')
assert.equal(tagged.text, 'refactor the auth module')
assert.deepEqual([tagged.override.model, tagged.override.effort, tagged.strong], [MODELS.opus, 'high', true])
assert.equal(classify('@hard why is this slow').task, 'hard')
assert.equal(parsePrompt('@opus').text, '@opus')
assert.equal(parsePrompt('@alice please look').tags.length, 0)

// --- nothing is chosen for you
assert.equal(isSetUp(emptyRoutes()), false)
assert.deepEqual(routeFor('hard', emptyRoutes()), { model: null, effort: null })
assert.deepEqual(parseSpec('opus high'), { model: MODELS.opus, effort: 'high' })
assert.deepEqual(parseSpec('keep max'), { model: null, effort: 'max' })
assert.deepEqual(parseSpec('sonnet keep'), { model: MODELS.sonnet, effort: null })
assert.equal(parseSpec('banana'), null)
const routes = buildRoutes([{ normal: 'sonnet medium', hard: 'sonnet max' }, { hard: 'banana' }])
assert.equal(isSetUp(routes), true)
assert.deepEqual(routes.hard, { model: MODELS.sonnet, effort: 'max' })
assert.deepEqual(routes.quick, { model: null, effort: null })
assert.equal(specText(routes.normal), 'sonnet medium')
assert.equal(specText(routes.quick), 'keep keep')
assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku 4.5')

// --- effort limits
assert.equal(clampEffort('claude-haiku-4-5', 'high'), null)
assert.equal(clampEffort(MODELS.haiku, 'high'), 'high')
assert.equal(clampEffort('claude-opus-4-5', 'max'), 'high')
assert.equal(clampEffort(MODELS.sonnet, 'max'), 'max')

// --- cache guard
const O = MODELS.opus
const S = MODELS.sonnet
const base = { sessionModel: O, sessionEffort: 'medium', ctxTokens: 120000, idleMs: 1000 }
// moving to the home model (the one chosen for normal prompts) goes through, once
assert.equal(guard({ ...base, home: { model: S, effort: 'medium' }, wanted: { model: S, effort: 'medium' }, ran: { model: O, effort: 'medium' } }).model, S)
// a short trip to another model in a long conversation is held back ...
const trip = guard({ ...base, sessionModel: S, home: { model: S, effort: 'medium' }, wanted: { model: O, effort: 'high' }, ran: { model: S, effort: 'medium' } })
assert.deepEqual([trip.model, trip.held], [S, ['model']])
// ... unless asked for, the conversation is small, or the cache expired
assert.equal(guard({ ...base, sessionModel: S, home: { model: S, effort: 'medium' }, strong: true, wanted: { model: O, effort: 'high' }, ran: { model: S, effort: 'medium' } }).model, O)
assert.equal(guard({ ...base, sessionModel: S, home: { model: S, effort: 'medium' }, ctxTokens: 5000, wanted: { model: O, effort: 'high' }, ran: null }).model, O)
assert.equal(guard({ ...base, sessionModel: S, home: { model: S, effort: 'medium' }, idleMs: 2 * 3600000, wanted: { model: O, effort: 'high' }, ran: { model: S, effort: 'medium' } }).model, O)
// effort on Sonnet 5.5 / Opus 5.5 never waits
assert.deepEqual(guard({ ...base, wanted: { model: null, effort: 'max' }, ran: { model: O, effort: 'medium' } }), { model: O, effort: 'max', held: [] })
// keep / keep changes nothing
assert.deepEqual(guard({ ...base, wanted: { model: null, effort: null }, ran: null }), { model: O, effort: 'medium', held: [] })

// today's bug: long chat after a restart (ran is null, the session started on Opus), a quick prompt wants Haiku.
// The trip is held back, and must land on the Normal route (Sonnet high), never stay on Opus
const homeRoute = { model: S, effort: 'high' }
const restart = guard({ sessionModel: O, sessionEffort: 'medium', ctxTokens: 120000, idleMs: 0, home: homeRoute, wanted: { model: MODELS.haiku, effort: null }, ran: null })
assert.deepEqual([restart.model, restart.effort, restart.held], [S, 'high', ['model']])
// a normal prompt in the same state goes straight to Sonnet high
assert.deepEqual(guard({ sessionModel: O, sessionEffort: 'medium', ctxTokens: 120000, home: homeRoute, wanted: homeRoute, ran: null }), { model: S, effort: 'high', held: [] })
// once on Sonnet, a quick prompt stays on Sonnet high instead of hopping to Haiku
assert.deepEqual(guard({ sessionModel: O, sessionEffort: 'medium', ctxTokens: 120000, home: homeRoute, wanted: { model: MODELS.haiku, effort: null }, ran: homeRoute }).model, S)
// with no Normal route set, a held trip stays where it is
assert.equal(guard({ sessionModel: O, sessionEffort: 'medium', ctxTokens: 120000, wanted: { model: MODELS.haiku, effort: null }, ran: null }).model, O)

// --- stats
let stats = addTurn(emptyStats(), 'sonnet 5.5 · medium', { input_tokens: 100, output_tokens: 400, cache_read_input_tokens: 9000, cache_creation_input_tokens: 900 }, false)
stats = addTurn(stats, 'sonnet 5.5 · max', { input_tokens: 50, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 }, true)
assert.match(formatStats(stats, 1.234), /Replies: 2[\s\S]*switches: 1, 10k tokens re-cached[\s\S]*\$1\.23/)

// --- a full personal setup: kinds, rules, and the still-stuck ladder up to Fable
const mine = buildRoutes([{ quick: 'haiku', normal: 'sonnet high', hard: 'opus high' }])
const rules = [
  parseRule('architecture, migration, migrate, full audit = opus xhigh'),
  parseRule('ultrathink, think hard = opus max'),
  parseRule('redesign = sonnet max'),
]
const go = (text, prev = {}) => {
  const c = classify(text, { rules, top: MODELS.fable, ...prev })
  return { c, r: routeFor(c.task, mine, c.override) }
}
assert.deepEqual(go('rename the header').r, { model: MODELS.haiku, effort: null })
assert.deepEqual(go('add a contact form').r, { model: MODELS.sonnet, effort: 'high' })
assert.deepEqual(go('the checkout is broken').r, { model: MODELS.opus, effort: 'high' })
assert.deepEqual(go('plan the database migration').r, { model: MODELS.opus, effort: 'xhigh' })
assert.deepEqual(go('ultrathink about caching').r, { model: MODELS.opus, effort: 'max' })
assert.equal(go('ultrathink about caching').c.strong, true)
assert.deepEqual(go('redesign the homepage').r, { model: MODELS.sonnet, effort: 'max' })
// "yes" repeats the last route exactly, even a rule's
assert.deepEqual(go('yes', { prevTask: 'rule', prevRoute: { model: MODELS.sonnet, effort: 'max' } }).r, { model: MODELS.sonnet, effort: 'max' })
// still broken: normal -> hard -> xhigh -> Fable
assert.equal(go('still broken', { prevTask: 'normal', prevRoute: { model: MODELS.sonnet, effort: 'high' } }).c.task, 'hard')
assert.deepEqual(go('still broken', { prevTask: 'hard', prevRoute: { model: MODELS.opus, effort: 'high' } }).r, { model: MODELS.opus, effort: 'xhigh' })
assert.deepEqual(go('same error', { prevTask: 'rule', prevRoute: { model: MODELS.opus, effort: 'xhigh' } }).r, { model: MODELS.fable, effort: 'xhigh' })
// without a top model the ladder ends at max
assert.deepEqual(routeFor('hard', mine, classify('still broken', { prevTask: 'hard', prevRoute: { model: MODELS.opus, effort: 'xhigh' } }).override), { model: MODELS.opus, effort: 'max' })
assert.equal(parseRule('no equals sign'), null)
assert.deepEqual(parseRule('design = sonnet 5.5.max'), { words: ['design'], route: { model: MODELS.sonnet, effort: 'max' } })
assert.deepEqual(parseRule('design = sonnet 5.5 max'), { words: ['design'], route: { model: MODELS.sonnet, effort: 'max' } })

console.log('route ok')
