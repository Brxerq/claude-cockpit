// Cockpit: progress bars, sounds and a model and effort router.
// The bar drawing and tool handling derive from plan-progress by Kirill Serditov (MIT, github.com/zycck/claude-mods);
// agent strips and the demo reel were dropped. The router (./route.mjs) and the token savings are new.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, PlanStage, PlanState, Route, Router, Rule, Spec, StepStatus } from '../types'
import { elapsed, lastHead, plural, STATE_COLOR, STATE_GLYPH, textWidth, trackSvg, TRACK_H } from './draw.ts'
import { carryDone, DEMO, isFinished, normalize, parsePlan, PLAN_ID, pointAt, slug, str, where } from './plan.ts'
import type { Raw } from './plan.ts'
// @ts-ignore plain JS, so its self-check runs under node without a build
import { addTurn, buildRoutes, classify, emptyRoutes, emptyStats, formatStats, guard, isSetUp, MODELS, parseRule, parseSpec, routeFor, routeLabel, shortModel, specText, takesEffort, TASK_INFO, TASKS } from './route.mjs'

const TOOL = 'mcp__cockpit__plan_progress'
const MAX_BARS = 3
// a space as wide as a digit, so '  0%' and '100%' take the same room
const FIGURE_SPACE = String.fromCharCode(0x2007)
const plans = atom({ plugin: 'cockpit', key: 'plans' } as const, [])
// the model and effort the "add a rule" dropdowns hold until the rule is added
const ruleDraft = atom({ plugin: 'cockpit', key: 'ruleDraft' } as const, { model: 'sonnet', effort: 'high' })
const isOpen = atom({ plugin: 'cockpit', key: 'isOpen' } as const, true)
const router = atom({ plugin: 'cockpit', key: 'router' } as const, { mode: 'auto', routes: emptyRoutes(), rules: [], top: null, saver: true, pending: null, current: null, ran: null, seen: null, lastEnd: 0, switched: false, stats: emptyStats() } as Router)

// this text sits in the cached system prompt (about 40 tokens), so it stays short and never changes within a session
const RULES = `# Cockpit
If you have a todo tool (TodoWrite, TaskCreate), its list shows as a progress bar. If you have none, for any task of 3+ steps create a bar with ${TOOL} and move it once per stage. Never mention the bars.`

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

async function putPlan($: EngineInterface, next: Plan) {
  await editPlan($, next.id, () => next)
}

// builds a bar from the latest stored one inside update(), so back-to-back calls never work from a stale copy;
// make returns a string to refuse, and the list stays as it was
async function editPlan($: EngineInterface, id: string, make: (prev: Plan | null) => Plan | string): Promise<Plan | string> {
  let prev: Plan | undefined
  let made = '' as Plan | string
  await update($, plans, list => {
    prev = list.find(p => p.id === id)
    made = make(prev ?? null)
    return typeof made === 'string' ? [...list] : placeBar(list, made)
  })
  if (typeof made === 'string') return made
  chime($, prev?.state, made.state)
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
//   "words": { "quick": ["changelog"] } }

const PROJECT_FILE = '.claude/cockpit.json'
const PANE = 'cockpit-router'
const FREE_BELOW = 30000 // context tokens under which a switch is cheap enough to always allow
const CACHE_TTL_MS = 60 * 60000 // past this idle time the prompt cache is gone anyway
const MODEL_CHOICES: [string, string | null][] = [['Keep', null], ['Haiku', MODELS.haiku], ['Sonnet', MODELS.sonnet], ['Opus', MODELS.opus], ['Fable', MODELS.fable]]
// one colour per model, readable on light and dark panels
const MODEL_COLOR: Record<string, string | undefined> = { haiku: '#1D9E75', sonnet: '#378ADD', opus: '#7F77DD', fable: '#BA7517' }
const EFFORT_CHOICES: [string, string | null][] = [['Keep', null], ['Low', 'low'], ['Medium', 'medium'], ['High', 'high'], ['XHigh', 'xhigh'], ['Max', 'max']]

type RuleText = { words: string[]; route: string }
type Settings = { routes?: Record<string, string>; rules?: RuleText[]; top?: string | null; saver?: boolean; words?: Record<string, string[]> }
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

async function readSettings($: EngineInterface): Promise<Settings> {
  const path = settingsPath($)
  return path ? readJson($, path) : (((await $.store.get('settings')) ?? {}) as Settings)
}

async function writeSettings($: EngineInterface, s: Settings) {
  const path = settingsPath($)
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
  await writeSettings($, {})
}

async function openPanel($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Model router', focus: true, closeOnEscape: true })
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

    return next(e)
  })

  // sorts the prompt into a task and strips @tags (so they cost no tokens); the route applies from the turn's first request
  on('prompt.submit', async ($, e, next) => {
    // the desktop app sends typed prompts as sdk, not composer; machine origins (notifications, peers) are left alone
    if (!['composer', 'bridge', 'sdk', 'unclassified'].includes(e.origin.kind)) return next(e)
    const r = await read($, router)
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
    if (e.agentId) return yield* next(e)
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
        const g = guard({
          wanted,
          ran: r.ran,
          sessionModel: e.model,
          sessionEffort: seen.effort,
          home: r.routes.normal ?? null,
          ctxTokens: (await $.session.usage()).context.tokens ?? 0,
          idleMs: r.lastEnd ? now - r.lastEnd : 0,
          strong: strong || !r.saver,
          freeBelow: FREE_BELOW,
          ttlMs: CACHE_TTL_MS,
        })
        const current: Route = { task, model: g.model, effort: g.effort, reason, held: g.held, wanted }
        const switched = r.ran !== null && (r.ran.model !== g.model || r.ran.effort !== g.effort)
        await update($, router, x => ({ ...x, seen, current, ran: { model: g.model, effort: g.effort }, pending: null, switched }))
      }
    }
    const route = (await read($, router)).current
    if (!route || (route.model === e.model && route.effort === (e.effort === undefined ? null : String(e.effort)))) return yield* next(e)
    const { effort: _drop, ...rest } = e

    return yield* next(route.effort ? { ...rest, model: route.model, effort: route.effort as typeof e.effort } : { ...rest, model: route.model })
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
    if (e.stop_hook_active || result.block || isWaitingOnBackground || (e.background_tasks?.length ?? 0) > 0) return result
    const asks = /\?\s*$/.test(e.last_assistant_message ?? '')
    // a turn that did no work on the plan (a side question) leaves the bar alone, so it does not chime every turn
    if (!asks && workCalls === 0 && !isPlanTouched) return result
    const note = asks ? 'Waiting for your answer' : 'Stopped with steps left'
    for (const p of (await read($, plans)).filter(isOpenPlan)) await putPlan($, { ...p, state: 'needs_input', note })

    return result
  })

  on('session.start', async ($, e, next) => {
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
    })
    await loadRoutes($)
    // a session reopened later (an app restart, a resume) finds its bars where it left them
    if ((await read($, plans)).length === 0) await restorePlans($)
    $.clock.every(1000, async () => {
      const list = await read($, plans)
      for (const id of lastHead.keys()) if (!list.some(p => p.id === id)) lastHead.delete(id)
      if (list !== lastSaved) await savePlans($, list)
    })
    await $.command.register({ name: 'progress', description: 'Show or hide the progress bars' })
    await $.command.register({ name: 'progress-demo', description: 'Show a sample plan in the progress bars' })
    await $.command.register({ name: 'progress-sounds', description: 'Play the decision, error and done sounds' })
    await $.command.register({ name: 'progress-clear', description: 'Remove all progress bars' })
    await $.command.register({ name: 'route', description: 'Choose a model and effort for quick, normal and hard prompts' })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return { sections: [...result.sections, { id: 'cockpit:rules', text: RULES, scope: 'session' as const }] }
  })

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
    const list = await read($, plans)
    if (list.length === 0 || e.props.hasSurvey || !(await read($, isOpen))) return next(e)
    const t = $.ui.resolve(e)
    const { Box, Button, Text } = t
    const Svg = 'Svg' in t ? t.Svg : null
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    // every bar has the same width and is pinned to the right edge (fixed-width percent, close button),
    // so rows line up whatever their titles; the slack goes into the gap after the title.
    // Desktop reports ~8 CSS px per column; glyph, gaps, percent and the close button take ~126 px.
    const titleWidth = Math.min(Math.round(total * 0.3), Math.max(...list.map(p => Math.round(textWidth(p.title, 6.4)))))
    const trackW = Math.max(120, Math.min(1400, total - titleWidth - 140))
    const now = await $.clock.now()

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
      </Box>
    )
  })

  // routed-turn stats and the bar that closes itself when its steps are all finished
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      const r = await read($, router)
      const c = r.mode === 'off' ? null : r.current
      await update($, router, x => ({
        ...x,
        lastEnd: now,
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
