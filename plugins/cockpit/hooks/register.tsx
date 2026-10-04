// Cockpit: progress bars, sounds, a model and effort router and a prompt-cache meter.
// The bar drawing and tool handling derive from plan-progress by Kirill Serditov (MIT, github.com/zycck/claude-mods);
// agent strips and the demo reel were dropped. The router (./route.mjs) and the token savings are new.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Plan, PlanStage, PlanState, Route, Router, Rule, Spec, StepStatus, Ttl } from '../types'
// @ts-ignore plain JS, as the router is
import { accountOf, asTtl, decideTtl, emptyCache, isStuck, leftLabel, leftMs, phase, report, touch, TTL_MS, WARN_MS } from './cache.mjs'
import { elapsed, lastHead, METER_COLOR, METER_STATE, meterSvg, plural, STATE_COLOR, STATE_GLYPH, textWidth, trackSvg, TRACK_H } from './draw.ts'
import type { MeterLook } from './draw.ts'
import { carryDone, DEMO, isFinished, normalize, parsePlan, PLAN_ID, pointAt, slug, str, where } from './plan.ts'
import type { Raw } from './plan.ts'
// @ts-ignore plain JS, so its self-check runs under node without a build
import { addTurn, buildRoutes, classify, emptyRoutes, emptyStats, formatStats, guard, isSetUp, k, MODELS, parseRule, parseSpec, routeFor, routeLabel, shortModel, specText, takesEffort, TASK_INFO, TASKS } from './route.mjs'

const TOOL = 'mcp__cockpit__plan_progress'
const MAX_BARS = 3
// a space as wide as a digit, so '  0%' and '100%' take the same room
const FIGURE_SPACE = String.fromCharCode(0x2007)
const plans = atom({ plugin: 'cockpit', key: 'plans' } as const, [])
// the model and effort the "add a rule" dropdowns hold until the rule is added
const ruleDraft = atom({ plugin: 'cockpit', key: 'ruleDraft' } as const, { model: 'sonnet', effort: 'high' })
const isOpen = atom({ plugin: 'cockpit', key: 'isOpen' } as const, true)
const router = atom({ plugin: 'cockpit', key: 'router' } as const, { mode: 'auto', routes: emptyRoutes(), rules: [], top: null, saver: true, pending: null, current: null, ran: null, seen: null, switched: false, stats: emptyStats() } as Router)
const cache = atom({ plugin: 'cockpit', key: 'cache' } as const, emptyCache() as Cache)

// this text sits in the cached system prompt (about 40 tokens), so it stays short and never changes within a session
const RULES = `# Cockpit
If you have a todo tool (TodoWrite, TaskCreate), its list shows as a progress bar. If you have none, before the first tool call of any task of 3+ steps create a bar with ${TOOL}, then move it as each stage finishes, and finish it before your last reply. Never mention the bars.`

// ---------- sound, bars, saving ----------

let isSoundOn = true

// on Windows the engine's player can report success and stay silent, so the system player plays it directly
function play($: EngineInterface, name: 'decision' | 'error' | 'done') {
  if (!isSoundOn) return
  const file = `${$.plugin.root}/sounds/${name}.wav`.replace(/\//g, '\\')
  const viaPowerShell = () =>
    $.process
      .run(['powershell', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { timeoutMs: 5000 })
      .catch(() => undefined)
  if (/^[A-Za-z]:/.test($.plugin.root)) {
    void viaPowerShell()
    return
  }
  void $.audio.play({ asset: `sounds/${name}.wav` }).catch(viaPowerShell)
}

const isOpenPlan = (p: Plan) => p.state === 'running' && !p.stages.flatMap(s => s.steps).every(s => isFinished(s.status))

// adds or replaces one bar by id; keeps at most MAX_BARS, dropping finished ones first
// computed inside update() from the latest list, so back-to-back writers do not drop each other
function placeBar(list: readonly Plan[], next: Plan): Plan[] {
  const rest = list.some(p => p.id === next.id) ? list.map(p => (p.id === next.id ? next : p)) : [...list, next]
  while (rest.length > MAX_BARS) {
    const doneAt = rest.findIndex(p => p.state === 'done')
    rest.splice(doneAt >= 0 ? doneAt : 0, 1)
  }
  return rest
}

function chime($: EngineInterface, prev: PlanState | undefined, next: PlanState) {
  if (next === prev) return
  if (next === 'needs_input') play($, 'decision')
  if (next === 'error') play($, 'error')
  if (next === 'done') play($, 'done')
}

async function putPlan($: EngineInterface, next: Plan, isQuiet = false) {
  await editPlan($, next.id, () => next, isQuiet)
}

// builds a bar from the latest stored one inside update(), so back-to-back calls never work from a stale copy;
// make returns a string to refuse, and the list stays as it was
async function editPlan($: EngineInterface, id: string, make: (prev: Plan | null) => Plan | string, isQuiet = false): Promise<Plan | string> {
  let prev: Plan | undefined
  let made = '' as Plan | string
  await update($, plans, list => {
    prev = list.find(p => p.id === id)
    made = make(prev ?? null)
    return typeof made === 'string' ? [...list] : placeBar(list, made)
  })
  if (typeof made === 'string') return made
  if (!isQuiet) chime($, prev?.state, made.state)
  if (!prev) await update($, isOpen, () => true)
  return made
}

async function dropPlan($: EngineInterface, id: string) {
  lastHead.delete(id)
  await update($, plans, list => list.filter(p => p.id !== id))
}

const STEP_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' }, status: { enum: ['pending', 'active', 'done', 'error', 'skipped'] } },
}

// edits are the work the nudge below counts. Shell calls are never counted: the host marks only plain reads (ls)
// read-only, so a compound read (cd x && git log) would look like work
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

// ---------- bars from Claude's own task list: no extra tool calls, so no extra tokens ----------

const TODO_BAR = 'tasks'
const TODO_STATUS: Record<string, StepStatus> = { pending: 'pending', in_progress: 'active', completed: 'done', deleted: 'skipped' }

// TodoWrite sends the whole list each time: [{ content, status, activeForm }]
function todosToStages(todos: unknown): PlanStage[] {
  const steps = (Array.isArray(todos) ? todos : [])
    .filter(t => t && typeof t === 'object')
    .map(t => t as Raw)
    .map(t => ({ title: str(t.content ?? t.subject ?? t.title, 80) || 'Task', status: TODO_STATUS[String(t.status)] ?? 'pending', substeps: [] }))
  return steps.length ? [{ name: 'Tasks', steps }] : []
}

// TaskCreate / TaskUpdate send one task at a time; their ids live here, their titles on the bar
const taskTitles = new Map<string, string>()

async function taskCreated($: EngineInterface, raw: Raw, result: unknown) {
  const now = await $.clock.now()
  const title = str(raw.subject ?? raw.title ?? raw.content, 80) || 'Task'
  const id = /#?(\d+)/.exec(typeof result === 'string' ? result : JSON.stringify(result ?? ''))?.[1]
  if (id) taskTitles.set(id, title)
  await editPlan($, TODO_BAR, prev => {
    const steps = [...(prev?.stages[0]?.steps ?? []), { title, status: 'pending' as const, substeps: [] }]
    return { id: TODO_BAR, title: 'Tasks', kind: 'todo', stages: [{ name: 'Tasks', steps }], state: 'running', note: null, startedAt: prev?.startedAt ?? now, endedAt: null }
  })
}

// false when the update names a task this bar does not know
async function taskUpdated($: EngineInterface, raw: Raw): Promise<boolean> {
  const title = taskTitles.get(String(raw.taskId ?? raw.id ?? ''))
  const status = TODO_STATUS[String(raw.status)]
  if (!title || !status) return false
  const now = await $.clock.now()
  const made = await editPlan($, TODO_BAR, prev => {
    if (!prev) return 'no bar'
    const steps = (prev.stages[0]?.steps ?? []).map(st => (st.title === title ? { ...st, status, ...(status === 'done' ? { doneAt: now } : {}) } : st))
    const isDone = steps.every(st => isFinished(st.status))
    return { ...prev, stages: [{ name: 'Tasks', steps }], state: isDone ? 'done' : 'running', endedAt: isDone ? now : null }
  })
  return typeof made !== 'string'
}

// $.state lives as long as the process, so the bars are kept per session in the plugin's store as well
const SAVED = 'plans:'
const KEEP_SESSIONS = 20
let lastSaved: Plan[] | null = null

async function savePlans($: EngineInterface, list: Plan[]) {
  lastSaved = list
  const key = SAVED + (await $.session.id())
  if (list.length === 0) {
    await $.store.delete(key)
    return
  }
  await $.store.set(key, list)
  const keys = (await $.store.keys()).filter(k => k.startsWith(SAVED))
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_SESSIONS))) await $.store.delete(old)
}

async function restorePlans($: EngineInterface) {
  const saved = await $.store.get(SAVED + (await $.session.id()))
  if (!Array.isArray(saved) || saved.length === 0) return
  await update($, plans, () => saved as Plan[])
  lastSaved = saved as Plan[]
}

// ---------- router settings ----------
// Your choices live in one file, ~/.claude/cockpit.json, for every project; the panel and /route edit it, and you can
// too. A project can add to it in .claude/cockpit.json (its rules come first, its routes win). Shape:
// { "routes": { "quick": "haiku", "normal": "sonnet high", "hard": "opus high" },
//   "rules": [{ "words": ["redesign"], "route": "sonnet max" }], "top": "fable", "saver": true,
//   "words": { "quick": ["changelog"] }, "cache": { "show": true, "auto": 0, "ttl": "1h" } }

const PROJECT_FILE = '.claude/cockpit.json'
const PANE = 'cockpit-router'
const FREE_BELOW = 30000 // context tokens under which a switch, or a lapsed cache, is cheap enough to let pass
const MODEL_CHOICES: [string, string | null][] = [['Keep', null], ['Haiku', MODELS.haiku], ['Sonnet', MODELS.sonnet], ['Opus', MODELS.opus], ['Fable', MODELS.fable]]
// one colour per model, readable on light and dark panels
const MODEL_COLOR: Record<string, string | undefined> = { haiku: '#1D9E75', sonnet: '#378ADD', opus: '#7F77DD', fable: '#BA7517' }
const EFFORT_CHOICES: [string, string | null][] = [['Keep', null], ['Low', 'low'], ['Medium', 'medium'], ['High', 'high'], ['XHigh', 'xhigh'], ['Max', 'max']]

type RuleText = { words: string[]; route: string }
type Settings = { routes?: Record<string, string>; rules?: RuleText[]; top?: string | null; saver?: boolean; words?: Record<string, string[]>; cache?: { show?: boolean; auto?: number; ttl?: string } }
let projectWords: Record<string, string[]> = {}

// plugins always live under the Claude config folder (~/.claude), so its path comes from the plugin's own
function settingsPath($: EngineInterface): string | null {
  const root = $.plugin.root.replace(/\\/g, '/')
  const at = root.lastIndexOf('/.claude/')
  return at >= 0 ? `${root.slice(0, at)}/.claude/cockpit.json` : null
}

async function readJson($: EngineInterface, path: string): Promise<Settings> {
  try {
    return JSON.parse(await $.fs.read(path)) as Settings
  } catch {
    return {}
  }
}

async function isBroken($: EngineInterface, path: string): Promise<boolean> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return false
  }
  try {
    JSON.parse(text)
    return false
  } catch {
    return text.trim() !== ''
  }
}

async function readSettings($: EngineInterface): Promise<Settings> {
  const path = settingsPath($)
  return path ? readJson($, path) : (((await $.store.get('settings')) ?? {}) as Settings)
}

async function writeSettings($: EngineInterface, s: Settings) {
  const path = settingsPath($)
  // a file that exists but does not parse reads as empty, and saving over it would erase what you wrote by hand
  if (path && (await isBroken($, path))) {
    $.ui.toast(`${path} is not valid JSON, so nothing was saved. Fix or delete it.`, { timeoutMs: 15000 })
    return
  }
  if (path) await $.fs.write(path, `${JSON.stringify(s, null, 2)}\n`)
  else await $.store.set('settings', s)
  await loadRoutes($)
}

const toRules = (list: RuleText[] = []) => list.map(r => parseRule(`${(r.words ?? []).join(',')} = ${r.route}`)).filter(Boolean) as Rule[]

// your settings, then the project's on top
async function loadRoutes($: EngineInterface) {
  const mine = await readSettings($)
  const project = await readJson($, PROJECT_FILE)
  projectWords = { ...mine.words, ...project.words }
  const routes = buildRoutes([mine.routes, project.routes]) as Record<string, Spec>
  const rules = toRules([...(project.rules ?? []), ...(mine.rules ?? [])])
  const top = parseSpec(String(project.top ?? mine.top ?? ''))?.model ?? null
  const saver = (project.saver ?? mine.saver) !== false
  await update($, router, x => ({ ...x, routes, rules, top, saver }))
  const pin = asTtl(mine.cache?.ttl) as Ttl | null
  const auto = Math.max(0, Math.min(MAX_AUTO, Math.floor(Number(mine.cache?.auto) || 0)))
  await update($, cache, x => onLife({ ...x, show: mine.cache?.show !== false, auto, pin }, pin ?? x.seen ?? x.ttl))
}

async function setCache($: EngineInterface, patch: NonNullable<Settings['cache']>) {
  const s = await readSettings($)
  await writeSettings($, { ...s, cache: { ...s.cache, ...patch } })
}

async function setRoute($: EngineInterface, task: string, patch: Partial<Spec>) {
  const s = await readSettings($)
  const r = await read($, router)
  const next = { ...r.routes[task], ...patch } as Spec
  if (next.model && !takesEffort(next.model)) next.effort = null
  await writeSettings($, { ...s, routes: { ...s.routes, [task]: specText(next) } })
}

async function addRule($: EngineInterface, rule: Rule) {
  const s = await readSettings($)
  const others = (s.rules ?? []).filter(r => !r.words.some(w => rule.words.includes(w)))
  await writeSettings($, { ...s, rules: [...others, { words: rule.words, route: specText(rule.route) }] })
}

async function removeRule($: EngineInterface, word: string) {
  const s = await readSettings($)
  await writeSettings($, { ...s, rules: (s.rules ?? []).filter(r => !r.words.includes(word)) })
}

async function setOption($: EngineInterface, patch: Settings) {
  await writeSettings($, { ...(await readSettings($)), ...patch })
}

async function clearRoutes($: EngineInterface) {
  // the cache row's choices are not router choices
  const { cache: kept } = await readSettings($)
  await writeSettings($, kept ? { cache: kept } : {})
}

async function openPanel($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Model router', focus: true, closeOnEscape: true })
}

// ---------- cache meter ----------
// The rules are in ./cache.mjs. This half feeds them each request of the main conversation, warns once before the
// entry lapses, and can keep it warm.

const MAX_AUTO = 5
// a question answered with almost nothing; what counts is the request around it, the conversation read from the cache
const PING = 'Reply with a single period.'
// output tokens past which a ping was no cheap read (the session's effort made the model think over it)
const PING_MAX_OUT = 500
// what Claude Code's own lifetime rules read, kept from session start
let ttlEnv: { force5m?: string; ttlVar?: string; enable1h?: string } = {}
let ttlSetting: unknown
let isPinging = false
let meterText = ''
let warnedAt = 0

// the entry the last request left, counted on another lifetime
const onLife = (x: Cache, life: Ttl): Cache => (x.at && !x.viaPing ? { ...x, life, until: x.at + TTL_MS[life] } : x)

// the lifetime the account's rules give. When it changes (the first reply names the plan, or a subscription runs
// into usage credits) what the traffic showed before no longer holds
async function setAccount($: EngineInterface, windows: readonly { kind: string; percentUsed: number }[]) {
  const d = decideTtl(ttlEnv, ttlSetting, accountOf(windows)) as { ttl: Ttl; source: string }
  const c = await read($, cache)
  if (c.ttl !== d.ttl) await update($, cache, x => onLife({ ...x, ...d, seen: null }, x.pin ?? d.ttl))
  else if (c.source !== d.source) await update($, cache, x => ({ ...x, ...d }))
}

type Sample = { at: number; model: string; read: number; write: number; fresh: number; ping: boolean }

async function sawRequest($: EngineInterface, s: Sample) {
  const before = (await read($, cache)).pingSeen
  await update($, cache, x => touch(x, s) as Cache)
  // what a ping is worth on this account is learnt once, so it is kept for later sessions
  const after = (await read($, cache)).pingSeen
  if (after !== before) await $.store.set('pingTtl', after)
}

// one tool-less question over the conversation as it was last sent: the API serves it from the cache, which renews
// the entry at the read price instead of the rewrite a lapsed one costs. Answers with what happened, in words
async function keepWarm($: EngineInterface): Promise<string> {
  const c = await read($, cache)
  const startedAt = await $.clock.now()
  if (isPinging || c.busy) return 'Claude is working: every request keeps the cache warm.'
  if (leftMs(c, startedAt) <= 0) return 'Nothing to keep warm: the cache has expired, or nothing is cached yet.'
  isPinging = true
  try {
    const r = await $.model.fork({ prompt: PING })
    if (!('usage' in r)) return 'Nothing to keep warm yet.'
    const u = r.usage
    const isHit = u.cache_read_input_tokens >= c.tokens * 0.5
    // a ping that missed paid for the whole conversation, and one the model thought long over paid in output:
    // no more by themselves in this pause
    const isCheap = isHit && u.output_tokens <= PING_MAX_OUT
    await update($, cache, x => ({ ...(touch(x, { at: startedAt, model: x.model, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, fresh: u.input_tokens, ping: true }) as Cache), pings: isCheap ? x.pings + 1 : Math.max(x.pings + 1, x.auto) }))
    await update($, router, x => ({ ...x, stats: addTurn(x.stats, 'keep-warm', u, false) }))
    if (isHit) return `Cache kept warm: ${k(u.cache_read_input_tokens)} tokens read at the cache price, ${u.output_tokens} out.`
    return `Keep-warm missed: the cache served ${k(u.cache_read_input_tokens)} of ${k(c.tokens)} tokens${!r.isAnswered && r.reason === 'api-error' ? ` (API error ${r.status ?? 'without a reply'})` : ''}.`
  } catch (err) {
    return `Keep-warm failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    isPinging = false
  }
}

// runs each second and redraws only when the row's clock text changes. Once per entry, inside the warning: a
// keep-warm ping if you allowed them, else one toast and a sound
async function watchCache($: EngineInterface) {
  const c = await read($, cache)
  if (!c.show || c.hidden || !c.at) return
  const now = await $.clock.now()
  if (isStuck(c, now)) {
    await update($, cache, x => ({ ...x, busy: false }))
    return
  }
  const left = leftMs(c, now)
  const text = c.busy ? 'live' : leftLabel(left)
  if (text !== meterText) {
    meterText = text
    $.ui.invalidate('ui.render')
  }
  if (c.busy || c.tokens < FREE_BELOW || left <= 0 || left > WARN_MS[c.life] || warnedAt === c.at) return
  warnedAt = c.at
  // a plan window almost used up is not spent on pings
  const isNearLimit = (await $.session.usage()).rateLimits.some(w => w.percentUsed >= 95)
  // On a 1-hour entry a ping counts as 5 minutes until a later reply proves it bought the hour, so until then the
  // entry's end does not move and a second ping would only repeat the first. A wasted ping is one that was shown to
  // buy nothing, or that would repeat a first ping nothing has vouched for yet
  const isWasted = c.life === '1h' && (c.pingSeen === '5m' || (c.viaPing && c.pingSeen !== '1h'))
  if (c.viaPing && isWasted) return
  if (c.pings < c.auto && !isNearLimit && !isWasted) {
    $.ui.toast(await keepWarm($))
    return
  }
  $.ui.toast(`Cache expires in ${leftLabel(left)}. After that the next prompt re-reads ${k(c.tokens)} tokens at full price. /cache warm keeps it.`, { timeoutMs: 15000 })
  play($, 'decision')
}

const title = (t: string) => (t === 'rule' ? 'Your rule' : t.charAt(0).toUpperCase() + t.slice(1))
const routeShort = (x: { model: string | null; effort: string | null }) => (x.model || x.effort ? routeLabel(x) : 'keep')
const modelWord = (id: string | null) => Object.keys(MODELS).find(k => (MODELS as Record<string, string>)[k] === id)

export const register: Register = (on, options) => {
  isSoundOn = options.sounds !== false

  // two copies would both rewrite every request and share one state; the first one loaded keeps the job
  on('plugin.register', async ($, e, next) => (e.name === $.plugin.name && e.root !== $.plugin.root ? { refuse: `another ${e.name} is already loaded from ${$.plugin.root}` } : next(e)))
  let workCalls = 0
  let isPlanTouched = false
  let isWaitingOnBackground = false

  on('turn.start', async ($, e, next) => {
    workCalls = 0
    isPlanTouched = false
    isWaitingOnBackground = false
    await update($, cache, x => ({ ...x, busy: true }))

    return next(e)
  })

  // sorts the prompt into a task and strips @tags (so they cost no tokens); the route applies from the turn's first request
  on('prompt.submit', async ($, e, next) => {
    // the desktop app sends typed prompts as sdk, not composer; machine origins (notifications, peers) are left alone
    if (!['composer', 'bridge', 'sdk', 'unclassified'].includes(e.origin.kind)) return next(e)
    const r = await read($, router)
    // your prompt ends the pause: automatic pings get their budget back
    if ((await read($, cache)).pings > 0) await update($, cache, x => ({ ...x, pings: 0 }))
    let text = e.text
    if (r.mode === 'auto' && !e.text.trimStart().startsWith('/')) {
      const c = classify(e.text, { prevTask: r.pending?.task ?? r.current?.task ?? null, prevRoute: r.current?.wanted ?? null, words: projectWords, rules: r.rules, top: r.top })
      text = c.text
      await update($, router, x => ({ ...x, pending: { task: c.task, reason: c.reason, strong: c.strong, override: c.override } }))
    }
    if ((await read($, plans)).some(p => p.state === 'needs_input')) {
      await update($, plans, all => all.map(p => (p.state === 'needs_input' ? { ...p, state: 'running' as const, note: null } : p)))
    }

    return next(text === e.text ? e : { ...e, text })
  })

  // decides the route once per turn (first request), then every request of the main loop runs on it; subagents are untouched
  on('turn.step', async function* ($, e, next) {
    // a keep-warm ping sent while nothing runs is no request of the conversation, should the engine raise one for it
    if (e.agentId || (isPinging && !(await read($, cache)).busy)) return yield* next(e)
    if (e.index === 0) {
      const r = await read($, router)
      const seen = { model: e.model, effort: e.effort === undefined ? null : String(e.effort) }
      if (r.mode === 'off') {
        await update($, router, x => ({ ...x, seen, current: null, ran: null, pending: null }))
      } else {
        const p = r.pending
        let wanted: Spec
        let task = 'normal'
        let reason = 'everyday work'
        let strong = false
        if (p) {
          ;[wanted, task, reason, strong] = [routeFor(p.task, r.routes, p.override), p.task, p.reason, p.strong]
        } else if (r.current) {
          ;[wanted, task, reason] = [r.current.wanted, r.current.task, r.current.reason]
        } else {
          wanted = routeFor('normal', r.routes)
        }
        const now = await $.clock.now()
        const c = await read($, cache)
        const g = guard({
          wanted,
          ran: r.ran,
          sessionModel: e.model,
          sessionEffort: seen.effort,
          home: r.routes.normal ?? null,
          ctxTokens: (await $.session.usage()).context.tokens ?? 0,
          // the cache meter knows when the entry was last touched and how long it lives
          idleMs: c.at ? now - c.at : 0,
          strong: strong || !r.saver,
          freeBelow: FREE_BELOW,
          ttlMs: c.until - c.at,
        })
        const current: Route = { task, model: g.model, effort: g.effort, reason, held: g.held, wanted }
        const switched = r.ran !== null && (r.ran.model !== g.model || r.ran.effort !== g.effort)
        await update($, router, x => ({ ...x, seen, current, ran: { model: g.model, effort: g.effort }, pending: null, switched }))
      }
    }
    const route = (await read($, router)).current
    let sent = e
    if (route && !(route.model === e.model && route.effort === (e.effort === undefined ? null : String(e.effort)))) {
      const { effort: _drop, ...rest } = e
      sent = route.effort ? { ...rest, model: route.model, effort: route.effort as typeof e.effort } : { ...rest, model: route.model }
    }
    // the cache's lifetime counts from the start of the request that read or wrote it
    const startedAt = await $.clock.now()
    const result = yield* next(sent)
    const u = result.usage
    if (u) await sawRequest($, { at: startedAt, model: u.model || sent.model, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, fresh: u.input_tokens, ping: false }).catch(() => undefined)

    return result
  })

  // counts the main loop's edits (so a side question does not touch the bars); never adds anything to the context
  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (SHELL_TOOLS.has(e.tool)) {
      isWaitingOnBackground = (e as unknown as Raw).run_in_background === true
      return next(e)
    }
    if (!EDIT_TOOLS.has(e.tool)) return next(e)
    isWaitingOnBackground = false
    const ran = await next(e)
    if (ran.deny === undefined) workCalls += 1

    return ran
  })

  // the todo list becomes the "tasks" bar; the call itself passes through untouched
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined || ran.isError === true) return ran
    const stages = todosToStages((e as unknown as Raw).todos)
    if (stages.length === 0) {
      await dropPlan($, TODO_BAR)
      return ran
    }
    const now = await $.clock.now()
    await editPlan($, TODO_BAR, prev => {
      const steps = stages[0]?.steps ?? []
      const isDone = steps.every(st => isFinished(st.status))
      return { id: TODO_BAR, title: prev?.title ?? 'Tasks', kind: 'todo', stages, state: isDone ? 'done' : 'running', note: null, startedAt: prev?.startedAt ?? now, endedAt: isDone ? (prev?.endedAt ?? now) : null }
    })
    isPlanTouched = true

    return ran
  })

  // the task tools (one task per call) feed the same bar
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined || ran.isError === true) return ran
    await taskCreated($, e as unknown as Raw, ran.result)
    isPlanTouched = true

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId || ran.deny !== undefined || ran.isError === true) return ran
    if (await taskUpdated($, e as unknown as Raw)) isPlanTouched = true

    return ran
  })

  // a turn that ends with a bar still open costs nothing: the bar turns amber by itself, no model call to ask why
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    // the reply is over, whatever turn.complete did or did not say; a blocked stop means it carries on
    if (!result.block) await update($, cache, x => (x.busy ? { ...x, busy: false } : x))
    if (e.stop_hook_active || result.block || isWaitingOnBackground || (e.background_tasks?.length ?? 0) > 0) return result
    const asks = /\?\s*$/.test(e.last_assistant_message ?? '')
    // a turn that did no edits and did not touch the bar (a side question, a push) still stops the bar, so it never
    // looks live while nothing runs; it does so without a sound, so it does not chime every turn
    const isQuiet = !asks && workCalls === 0 && !isPlanTouched
    const note = asks ? 'Waiting for your answer' : isQuiet ? 'Not updated this turn' : 'Stopped with steps left'
    for (const p of (await read($, plans)).filter(isOpenPlan)) await putPlan($, { ...p, state: 'needs_input', note }, isQuiet)

    return result
  })

  on('session.start', async ($, e, next) => {
    const unset = () => undefined
    // one failing step must not stop the ones after it: the clock below is what runs the cache row
    await $.tool.register({
      name: 'plan_progress',
      description: 'Progress bar above the prompt. Create with id, title, stages; update with next, done, active, failed or state.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          stages: { type: 'array', items: { type: 'object', required: ['name', 'steps'], properties: { name: { type: 'string' }, steps: { type: 'array', items: STEP_SCHEMA } } } },
          next: { type: 'boolean' },
          done: { type: 'array', items: { type: 'string' } },
          active: { type: 'string' },
          failed: { type: 'string' },
          state: { enum: ['running', 'needs_input', 'error', 'done'] },
          note: { type: 'string' },
        },
      },
    }).catch(unset)
    ttlEnv = {
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(unset),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(unset),
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(unset),
    }
    // the promptCacheTtl setting: the project's local file, the project's, then yours
    ttlSetting = undefined
    for (const file of ['.claude/settings.local.json', '.claude/settings.json', settingsPath($)?.replace(/cockpit\.json$/, 'settings.json')]) {
      if (file && !asTtl(ttlSetting)) ttlSetting = ((await readJson($, file)) as { promptCacheTtl?: unknown }).promptCacheTtl
    }
    const pingSeen = asTtl(await $.store.get('pingTtl').catch(unset)) as Ttl | null
    await update($, cache, x => ({ ...x, pingSeen: x.pingSeen ?? pingSeen }))
    await loadRoutes($).catch(unset)
    await setAccount($, (await $.session.usage()).rateLimits).catch(unset)
    // a session reopened later (an app restart, a resume) finds its bars where it left them
    if ((await read($, plans)).length === 0) await restorePlans($).catch(unset)
    $.clock.every(1000, async () => {
      const list = await read($, plans)
      for (const id of lastHead.keys()) if (!list.some(p => p.id === id)) lastHead.delete(id)
      if (list !== lastSaved) await savePlans($, list)
      await watchCache($)
    })
    await $.command.register({ name: 'progress', description: 'Show or hide the progress bars' })
    await $.command.register({ name: 'progress-demo', description: 'Show a sample plan in the progress bars' })
    await $.command.register({ name: 'progress-sounds', description: 'Play the decision, error and done sounds' })
    await $.command.register({ name: 'progress-clear', description: 'Remove all progress bars' })
    await $.command.register({ name: 'route', description: 'Choose a model and effort for quick, normal and hard prompts' })
    await $.command.register({ name: 'cache', description: 'Prompt cache: time left before it expires, keep it warm' })

    return next(e)
  })

  // the plan windows arrive with the first reply and move with every one after
  on('session.measure', async ($, e, next) => {
    await setAccount($, e.rateLimits)

    return next(e)
  })

  // /clear and /compact start a new prefix, so the old entry is no longer the conversation's. A resumed session says
  // whether Claude Code itself counts the cache as gone: with the last reply 5 to 60 minutes back, that names the lifetime
  on('classic.SessionStart', async ($, e, next) => {
    const gap = (e.seconds_since_last_response ?? 0) * 1000
    if (e.source === 'clear' || e.source === 'compact') await update($, cache, x => ({ ...x, at: 0, until: 0, pings: 0, why: null }))
    else if (e.prompt_cache_likely_expired !== undefined && gap > TTL_MS['5m'] && gap < TTL_MS['1h']) {
      const seen: Ttl = e.prompt_cache_likely_expired ? '5m' : '1h'
      await update($, cache, x => ({ ...x, seen }))
    }

    return next(e)
  })

  // a /model switch reports the lifetime the engine itself uses
  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, cache, x => onLife({ ...x, seen: e.cache_ttl }, x.pin ?? e.cache_ttl))

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return { sections: [...result.sections, { id: 'cockpit:rules', text: RULES, scope: 'session' as const }] }
  })

  // a plugin's tool is listed behind ToolSearch by default, and a model with nothing to look up never loads it, so the
  // rule in the prompt could not be followed; the schema is small and sits in the cached prefix
  on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const raw = e as unknown as Raw
    const now = await $.clock.now()
    const id = slug(str(raw.id, 60) || str(raw.title, 80))
    const next = await editPlan($, id, prev => {
      const made = normalize(raw, prev, now, id)
      return typeof made !== 'string' && made.stages.length === 0 ? `No bar "${id}" yet: create it with title and stages.` : made
    })
    if (typeof next === 'string') return { deny: next }
    isPlanTouched = true
    const w = where(next)

    return { result: `${Math.min(w.pos, w.total)}/${w.total}${next.state === 'running' ? '' : ` ${next.state}`}` }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const live = (await read($, plans)).filter(p => p.state === 'running').pop()
    if (live) await update($, plans, list => list.map(p => (p.id === live.id ? { ...p, state: 'needs_input' as const } : p)))
    play($, 'decision')
    const ran = await next(e)
    if (live) await update($, plans, list => list.map(p => (p.id === live.id && p.state === 'needs_input' ? { ...p, state: 'running' as const } : p)))

    return ran
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    play($, 'decision')
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const text = (ran.result as { plan?: unknown } | undefined)?.plan
    const parsed = typeof text === 'string' ? parsePlan(text, await $.clock.now()) : null
    if (!parsed) return ran
    await editPlan($, PLAN_ID, prev =>
      prev ? { ...parsed, stages: pointAt(carryDone(parsed.stages, prev.stages)), startedAt: prev.startedAt } : { ...parsed, stages: pointAt(parsed.stages) },
    )

    // the model learns which bar holds its plan, so it moves that one rather than opening its own
    return { ...ran, context: [...(ran.context ?? []), `cockpit: bar "${PLAN_ID}" tracks this plan; move it with {id:"${PLAN_ID}", next:true}.`] }
  })

  on('command.run', { command: 'progress' }, async $ => {
    if ((await read($, plans)).length === 0) return { text: 'No plan yet. /progress-demo shows a sample.' }
    const open = await read($, isOpen)
    await update($, isOpen, () => !open)

    return { text: open ? 'Progress bars hidden.' : 'Progress bars shown.' }
  })

  on('command.run', { command: 'progress-demo' }, async $ => {
    await putPlan($, DEMO(await $.clock.now()))
    await update($, isOpen, () => true)

    return { text: 'Sample plan shown above the prompt.' }
  })

  on('command.run', { command: 'progress-clear' }, async $ => {
    await update($, plans, () => [])

    return { text: 'Progress bars removed.' }
  })

  on('command.run', { command: 'progress-sounds' }, async $ => {
    play($, 'decision')
    $.clock.after(900, () => play($, 'error'))
    $.clock.after(1800, () => play($, 'done'))

    return { text: 'Sounds: decision, error, done.' }
  })

  // /route opens the setup panel; a few words cover everything else
  on('command.run', { command: 'route' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const r = await read($, router)

    switch (sub.toLowerCase()) {
      case '':
      case 'setup': {
        const opened = await openPanel($)
        const lines = TASKS.map((t: string) => `  ${title(t).padEnd(8)}${routeShort(r.routes[t] ?? { model: null, effort: null }).padEnd(20)}${(TASK_INFO as Record<string, string>)[t]}`)
        return { text: [opened.isPlaced ? 'Router panel opened.' : 'Router:', ...lines, 'Change one: /route set hard opus high   ·   all commands: /route help'].join('\n') }
      }
      case 'on':
      case 'off':
        await update($, router, x => ({ ...x, mode: sub.toLowerCase() === 'off' ? 'off' : 'auto' }))
        return { text: sub.toLowerCase() === 'off' ? 'Router off: your own model and effort apply.' : 'Router on.' }
      case 'set': {
        const [task = '', ...spec] = rest
        const p = parseSpec(spec.join(' '))
        if (!(TASKS as string[]).includes(task) || !p) return { text: 'Example: /route set hard opus high. Kinds: quick, normal, hard. Models: haiku, sonnet, opus, fable, keep. Effort: low, medium, high, xhigh, max, keep.' }
        await setRoute($, task, p)
        return { text: `${title(task)} → ${routeShort((await read($, router)).routes[task] ?? { model: null, effort: null })}` }
      }
      case 'rule': {
        if (rest[0]?.toLowerCase() === 'remove') {
          await removeRule($, rest.slice(1).join(' ').trim().toLowerCase())
          return { text: 'Rule removed.' }
        }
        const rule = parseRule(arg)
        if (!rule) return { text: 'Example: /route rule redesign, landing page = sonnet max   ·   remove: /route rule remove redesign' }
        await addRule($, rule)
        return { text: `Rule saved: ${rule.words.join(', ')} → ${routeShort(rule.route)}` }
      }
      case 'stuck': {
        const top = parseSpec(arg)?.model ?? null
        await setOption($, { top: top ? modelWord(top) ?? top : null })
        return { text: top ? `Still stuck past xhigh: switch to ${shortModel(top)}.` : 'Still stuck past xhigh: go to max on the same model.' }
      }
      case 'saver':
        await setOption($, { saver: arg.toLowerCase() !== 'off' })
        return { text: arg.toLowerCase() === 'off' ? 'Cache saver off: every prompt switches to its model, even in long chats.' : 'Cache saver on.' }
      case 'clear':
        await clearRoutes($)
        return { text: 'All choices cleared: every prompt keeps your own model and effort.' }
      case 'test': {
        if (!arg) return { text: 'Example: /route test fix the login bug' }
        const c = classify(arg, { prevTask: r.current?.task ?? null, prevRoute: r.current?.wanted ?? null, words: projectWords, rules: r.rules, top: r.top })
        return { text: `${title(c.task)} (${c.reason}) → ${routeShort(routeFor(c.task, r.routes, c.override))}` }
      }
      case 'stats':
        return { text: formatStats(r.stats, (await $.session.usage()).cost?.usd) }
      default:
        return {
          text: [
            '/route                       open the panel: pick a model and effort for quick, normal and hard prompts',
            '/route set hard opus high    the same by command (models: haiku sonnet opus fable keep)',
            '/route rule redesign = sonnet max    your own words → model and effort (remove: /route rule remove redesign)',
            '/route stuck fable           where "still broken" goes after xhigh (or: /route stuck max)',
            '/route saver on | off        hold back short model trips in long chats to keep the cache',
            '/route test <prompt>         which kind a prompt is, without sending it',
            '/route stats                 tokens and cache hits per model',
            '/route on | off | clear',
            'One prompt only: start it with @hard, @opus, @max and so on (stripped before sending).',
          ].join('\n'),
        }
    }
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)

    switch (sub) {
      case '':
        return { text: report(await read($, cache), await $.clock.now()) }
      case 'warm':
        return { text: await keepWarm($) }
      case 'on':
      case 'off':
        await update($, cache, x => ({ ...x, hidden: false }))
        await setCache($, { show: sub === 'on' })
        return { text: sub === 'on' ? 'Cache row on.' : 'Cache row off: no row, no warning, no keep-warm pings.' }
      case 'auto': {
        const n = arg === 'off' ? 0 : Number.parseInt(arg, 10)
        if (!(n >= 0 && n <= MAX_AUTO)) return { text: `Example: /cache auto 2 (0 to ${MAX_AUTO} pings Cockpit may send by itself in one pause), /cache auto off` }
        await setCache($, { auto: n })
        return { text: n ? `Up to ${plural(n, 'keep-warm ping')} per pause. Each one reads the conversation from the cache, at a tenth of the input price or less.` : 'Automatic keep-warm off. The button and /cache warm still work.' }
      }
      case 'ttl':
        if (arg !== 'auto' && !asTtl(arg)) return { text: 'Example: /cache ttl 1h, /cache ttl 5m, or /cache ttl auto to let Cockpit work it out' }
        await setCache($, { ttl: asTtl(arg) ?? undefined })
        return { text: arg === 'auto' ? 'Cache lifetime worked out from your account and the traffic.' : `Cache lifetime set to ${arg}.` }
      default:
        return {
          text: [
            '/cache                 lifetime, last request, time left',
            '/cache warm            keep the cache warm now: one cheap read of the conversation',
            '/cache auto 2 | off    pings Cockpit may send by itself in one pause',
            '/cache ttl 5m | 1h | auto    set the lifetime yourself',
            '/cache on | off        the row above the prompt, its warning and its pings',
          ].join('\n'),
        }
    }
  })

  // the setup panel: a status bar, one row of dropdowns per kind, your rules with an add field, and two options.
  // Every line wraps instead of clipping, so it reads at any panel width.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const Select = 'Select' in t ? t.Select : null
    const Input = 'Input' in t ? t.Input : null
    const r = await read($, router)
    const isOn = r.mode !== 'off'
    const last = r.current
    const draft = await read($, ruleDraft)
    const modelValue = (id: string | null) => modelWord(id) ?? 'keep'
    const modelOptions = MODEL_CHOICES.map(([label, id]) => ({ value: modelWord(id) ?? 'keep', label: id ? `${label} ${shortModel(id).split(' ')[1] ?? ''}`.trim() : 'Keep yours' }))
    const effortOptions = EFFORT_CHOICES.map(([label, id]) => ({ value: id ?? 'keep', label: id ? label : 'Keep yours' }))
    const section = (label: string, hint?: string) => (
      <Text>
        <Text bold>{label}</Text>
        {hint ? <Text dimColor>{`  ${hint}`}</Text> : null}
      </Text>
    )
    // one picker: a dropdown where the surface has one, else a row of buttons
    const picker = (key: string, options: { value: string; label: string }[], value: string, onPick: (v: string) => unknown) =>
      Select ? (
        <Select key={key} options={options} value={value} onSelect={v => void onPick(v)} />
      ) : (
        <Box key={key} flexDirection="row" flexWrap="wrap" gap={1}>
          {options.map(o => (
            <Button key={`${key}-${o.value}`} label={o.label} variant={o.value === value ? 'primary' : undefined} dimColor={o.value !== value} onPress={() => onPick(o.value)} />
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" alignItems="flex-start" gap={1}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text wrap="wrap">{last ? `Last reply: ${title(last.task)} → ${routeShort(last)}` : 'No reply routed yet.'}</Text>
            {last?.held.includes('model') ? <Text dimColor wrap="wrap">{`Kept off ${shortModel(last.wanted.model)} to save the cache. Start a prompt with @${modelWord(last.wanted.model) ?? 'opus'} to force it.`}</Text> : null}
          </Box>
          <Button key="router-on" label="On" variant={isOn ? 'primary' : undefined} dimColor={!isOn} onPress={() => update($, router, x => ({ ...x, mode: 'auto' }))} />
          <Button key="router-off" label="Off" variant={isOn ? undefined : 'primary'} dimColor={isOn} onPress={() => update($, router, x => ({ ...x, mode: 'off' }))} />
        </Box>

        <Box flexDirection="column" gap={1}>
          {section('Routes', 'model and effort for each kind of prompt')}
          {TASKS.map((k: string) => {
            const x = r.routes[k] ?? { model: null, effort: null }
            return (
              <Box key={`route-${k}`} flexDirection="column">
                <Text wrap="wrap">
                  <Text bold>{title(k)}</Text>
                  <Text dimColor>{`  ${(TASK_INFO as Record<string, string>)[k]}`}</Text>
                </Text>
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                  {picker(`${k}-model`, modelOptions, modelValue(x.model), v => setRoute($, k, { model: v === 'keep' ? null : ((MODELS as Record<string, string>)[v] ?? null) }))}
                  {x.model && !takesEffort(x.model) ? <Text dimColor>No effort setting</Text> : picker(`${k}-effort`, effortOptions, x.effort ?? 'keep', v => setRoute($, k, { effort: v === 'keep' ? null : v }))}
                </Box>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column" gap={1}>
          {section('Your rules', 'checked first')}
          {r.rules.length === 0 ? <Text dimColor wrap="wrap">No rules yet. Pick a model and effort, type the words, press Add rule.</Text> : null}
          {r.rules.map(rule => (
            <Box key={`rule-${rule.words[0]}`} flexDirection="row" alignItems="flex-start" gap={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="wrap">{rule.words.join(', ')}</Text>
              </Box>
              <Text bold color={MODEL_COLOR[modelWord(rule.route.model) ?? 'keep']}>{routeShort(rule.route)}</Text>
              <Button key={`rule-x-${rule.words[0]}`} plain dimColor label="✕" onPress={() => removeRule($, rule.words[0] ?? '')} />
            </Box>
          ))}
          {Input ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {picker('rule-model', modelOptions, draft.model, v => update($, ruleDraft, x => ({ ...x, model: v })))}
                {draft.model !== 'keep' && !takesEffort((MODELS as Record<string, string>)[draft.model] ?? '') ? <Text dimColor>No effort setting</Text> : picker('rule-effort', effortOptions, draft.effort, v => update($, ruleDraft, x => ({ ...x, effort: v })))}
              </Box>
              <Input
                key="rule-add"
                placeholder="words, for example landing page, redesign"
                submitLabel="Add rule"
                onSubmit={v => {
                  // "words = model effort" typed in full still works; otherwise the dropdowns give the route
                  const rule = v.includes('=') ? parseRule(v) : parseRule(`${v} = ${draft.model} ${draft.effort}`)
                  if (rule) void addRule($, rule)
                  else $.ui.toast('Type the words that should trigger the rule, for example landing page, then pick a model and effort above.')
                }}
              />
            </Box>
          ) : (
            <Text dimColor wrap="wrap">Add one with /route rule landing page = sonnet max</Text>
          )}
        </Box>

        <Box flexDirection="column" gap={1}>
          {section('Options')}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">When still broken after xhigh, move to</Text>
            </Box>
            {picker('stuck', [{ value: 'max', label: 'Max, same model' }, { value: 'sonnet', label: 'Sonnet 5.5' }, { value: 'opus', label: 'Opus 5.5' }, { value: 'fable', label: 'Fable 5.1' }], modelWord(r.top) ?? 'max', v => setOption($, { top: v === 'max' ? null : v }))}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">Cache saver: skip one-off model switches in long chats</Text>
            </Box>
            {picker('saver', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], r.saver ? 'on' : 'off', v => setOption($, { saver: v === 'on' }))}
          </Box>
        </Box>

        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="wrap">One prompt only: start it with @opus, @max or @hard</Text>
          </Box>
          <Button key="router-reset" label="Reset" dimColor onPress={() => clearRoutes($)} />
        </Box>
      </Box>
    )
  })

  // the footer: the route chip opens the panel; the Progress toggle shows the mod is loaded
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const count = (await read($, plans)).length
    const open = await read($, isOpen)
    const r = await read($, router)
    const { Box, Button } = $.ui.resolve(e)
    // other mods add their labels to modes beneath us; keep them
    const below = await next(e)
    const press = () =>
      count === 0
        ? $.ui.toast('Cockpit is on. A bar appears when Claude makes a todo list or starts a long task.')
        : update($, isOpen, () => !open)
    // what the last reply really ran on (after the cache saver), so the chip never shows a model that was not used
    let routeText = 'Router on'
    if (r.mode === 'off') routeText = 'Router off'
    else if (!isSetUp(r.routes)) routeText = 'Set up router'
    else if (r.current) routeText = routeShort(r.current)

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button key="route-open" dimColor={r.mode === 'off'} label={routeText} onPress={() => openPanel($)} />
        <Button key="progress-toggle" dimColor={count === 0 || !open} label={count > 1 ? `Progress ${count}` : 'Progress'} onPress={press} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = (await read($, isOpen)) ? await read($, plans) : []
    const c = await read($, cache)
    const now = await $.clock.now()
    const state = phase(c, now) as 'none' | MeterLook
    // under FREE_BELOW tokens a lapsed cache costs too little to take a row
    const hasMeter = c.show && !c.hidden && state !== 'none' && c.tokens >= FREE_BELOW
    if ((list.length === 0 && !hasMeter) || e.props.hasSurvey) return next(e)
    const meterTitle = state === 'cold' ? `Cache expired · next prompt re-reads ${k(c.tokens)}` : `Prompt cache · ${k(c.tokens)}${c.why && state !== 'live' ? ` · missed: ${c.why}` : ''}`
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    // every bar has the same width and is pinned to the right edge (fixed-width percent, close button),
    // so rows line up whatever their titles; the slack goes into the gap after the title.
    // Desktop reports ~8 CSS px per column; glyph, gaps, percent and the close button take ~126 px.
    const titleWidth = Math.min(Math.round(total * 0.3), Math.max(...[...list.map(p => p.title), ...(hasMeter ? [meterTitle] : [])].map(s => Math.round(textWidth(s, 6.4)))))
    // the cache row shares every width with the bars, so the tracks line up; the Keep warm button takes ~96 px of the title's side
    const trackW = Math.max(120, Math.min(1400, total - titleWidth - 140 - (hasMeter ? 96 : 0)))

    // the cache row is a bar like the others: glyph, title, a pill track whose fill drains by itself, the time left,
    // a close button. Its drawing starts from the time left now, so nothing is redrawn each second
    const meter = () => {
      const left = leftMs(c, now)
      const life = TTL_MS[c.life]
      const color = METER_COLOR[state as MeterLook]
      const canWarm = state === 'low' || state === 'soon'
      const filled = state === 'live' ? 25 : Math.round(Math.min(1, left / life) * 25)
      const pct = state === 'live' ? 100 : Math.round(Math.min(1, left / life) * 100)
      const timeLeft = state === 'live' ? 'live' : leftLabel(left)

      return (
        <Box key="cache-row" flexDirection="row" alignItems="center" gap={1}>
          <Text color={color}>{STATE_GLYPH[METER_STATE[state as MeterLook]]}</Text>
          <Text wrap="truncate">{meterTitle}</Text>
          {canWarm ? <Button key="cache-warm" label="Keep warm" onPress={async () => $.ui.toast(await keepWarm($))} /> : null}
          <Box flexGrow={1} />
          {Svg ? (
            <Box key="cache-track" flexShrink={0}>
              <Svg source={meterSvg(trackW, state as MeterLook, left, life)} alt={`Prompt cache: ${state === 'live' ? 'in use' : state === 'cold' ? 'expired' : `${timeLeft} left, ${pct}%`}`} width={trackW} height={TRACK_H} />
            </Box>
          ) : (
            <Text>
              <Text color={color}>{'━'.repeat(filled)}</Text>
              <Text dimColor>{'─'.repeat(25 - filled)}</Text>
              <Text color={color}>{` ${timeLeft}`}</Text>
            </Text>
          )}
          <Text dimColor>{`${String(pct).padStart(3, FIGURE_SPACE)}%`}</Text>
          <Button
            key="cache-close"
            plain
            dimColor
            label="✕"
            onPress={async () => {
              await update($, cache, x => ({ ...x, hidden: true }))
              $.ui.toast('Cache row hidden for this session. /cache on brings it back.')
            }}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {list.map(p => {
          const track = trackSvg(p, trackW)
          // the hover layer is rebuilt on every redraw anyway, so its clock is set from now each time
          const hover = track.overlay.replace(/\{\{T:(\d+)\}\}/g, (_, t: string) => Math.max(0, (now - Number(t)) / 1000).toFixed(1))
          const w = where(p)
          const pct = p.state === 'done' ? 100 : Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100)
          const color = STATE_COLOR[p.state]
          const stageName = p.stages[w.stage]?.name ?? ''
          const alt =
            p.state === 'done'
              ? `${p.title}: done, ${plural(w.total, 'step')}${p.endedAt ? ` in ${elapsed(p.endedAt - p.startedAt)}` : ''}`
              : `${p.title}: ${stageName}, step ${w.step} of ${w.stageSize}, ${pct}%${p.note ? ` — ${p.note}` : ''}`
          const bar = `${'━'.repeat(Math.round(pct / 4))}${'─'.repeat(25 - Math.round(pct / 4))}`

          return (
            <Box key={`bar-${p.id}`} flexDirection="row" alignItems="center" gap={1}>
              <Text color={color}>{STATE_GLYPH[p.state]}</Text>
              <Text wrap="truncate">{p.title}</Text>
              <Box flexGrow={1} />
              {Svg ? (
                <Box key={`track-${p.id}`} flexShrink={0}>
                  <Svg source={track.base} alt={alt} width={trackW} height={TRACK_H} />
                  <Box position="absolute" top={0} left={0}>
                    <Svg source={hover} alt={`${p.title}: hover for times`} width={trackW} height={TRACK_H} isInteractive />
                  </Box>
                </Box>
              ) : (
                <Text>
                  <Text color={color}>{bar.replace(/─/g, '')}</Text>
                  <Text dimColor>{bar.replace(/━/g, '')}</Text>
                  <Text color={color}>{` ${stageName} ${w.step}/${w.stageSize}`}</Text>
                </Text>
              )}
              <Text dimColor>{`${String(pct).padStart(3, FIGURE_SPACE)}%`}</Text>
              <Button key={`close-${p.id}`} plain dimColor label="✕" onPress={() => dropPlan($, p.id)} />
            </Box>
          )
        })}
        {hasMeter ? meter() : null}
      </Box>
    )
  })

  // routed-turn stats and the bar that closes itself when its steps are all finished
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      const r = await read($, router)
      const c = r.mode === 'off' ? null : r.current
      await update($, cache, x => ({ ...x, busy: false }))
      await update($, router, x => ({
        ...x,
        switched: false,
        stats: c ? addTurn(x.stats, `${shortModel(c.model)}${c.effort ? ` · ${c.effort}` : ''}`, e.usage, x.switched) : x.stats,
      }))
      for (const p of await read($, plans)) {
        if (p.state === 'done') continue
        const steps = p.stages.flatMap(s => s.steps)
        if (steps.length > 0 && steps.every(s => isFinished(s.status))) await putPlan($, { ...p, state: 'done', endedAt: now })
      }
    }

    return next(e)
  })
}
