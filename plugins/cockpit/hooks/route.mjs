// Cockpit router: the pure part. No engine calls, so `node hooks/route.test.mjs` can check every rule.
//
// Every prompt is sorted into one of three kinds: quick, normal or hard. You choose the model and effort for each kind
// (in the /route panel). Nothing is chosen for you: a kind you leave on "keep" runs on your own model and effort.
// A cache guard then decides whether switching right now is worth it, since a model switch makes the next reply
// re-read the whole conversation at full price.

export const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const TASKS = ['quick', 'normal', 'hard']
export const TASK_INFO = {
  quick: 'typos, renames, small edits, short questions',
  normal: 'everyday work: build, change, explain',
  hard: 'bugs, redesigns, migrations, "ultrathink"',
}

// nothing set: every kind keeps the session's model and effort
export const emptyRoutes = () => Object.fromEntries(TASKS.map(t => [t, { model: null, effort: null }]))
export const isSetUp = routes => TASKS.some(t => routes?.[t]?.model || routes?.[t]?.effort)

// ---------- models and effort ----------

const rank = e => EFFORTS.indexOf(e) // -1 for none
// models that take no effort setting (it errors or is ignored)
const NO_EFFORT = /haiku|claude-3|sonnet-4-5|sonnet-4-0|opus-4-1|opus-4-0/
// Claude Code keeps the prompt cache when effort changes on these (docs: prompt caching, "Changing effort level")
const EFFORT_KEEPS_CACHE = /^claude-(sonnet-5-5|opus-5-5|fable-5-1)/

export const takesEffort = model => !NO_EFFORT.test(model || '')
export function clampEffort(model, effort) {
  if (!effort || !takesEffort(model)) return null
  if (/opus-4-5/.test(model)) return rank(effort) > rank('high') ? 'high' : effort
  if (/(opus|sonnet)-4-6/.test(model) && effort === 'xhigh') return 'high'
  return effort
}

// claude-haiku-4-5-20251001 -> "haiku 4.5"; null -> "your model"
export function shortModel(m) {
  if (!m) return 'your model'
  const r = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(m)
  return r ? `${r[1]} ${r[2]}${r[3] ? `.${r[3]}` : ''}` : m
}
export const routeLabel = r => `${shortModel(r.model)}${r.effort ? ` · ${r.effort}` : ''}`

const modelId = w => MODELS[w] ?? (/^claude-[a-z0-9-]+$/.test(w) ? w : undefined)

// "opus high", "sonnet", "high", "keep max", "keep keep" -> { model, effort }; null when a word is not understood.
// "keep" (or "session") means leave it as the session has it.
export function parseSpec(text) {
  const out = {}
  for (const w of String(text).toLowerCase().split(/[\s·,/.]+/).filter(Boolean)) {
    if (/^\d+$/.test(w)) continue // a version number ("sonnet 5.5 max") adds nothing
    if (['keep', 'session', 'default', 'none'].includes(w)) {
      if (!('model' in out)) out.model = null
      else out.effort = null
    } else if (EFFORTS.includes(w)) out.effort = w
    else if (modelId(w)) out.model = modelId(w)
    else return null
  }
  return 'model' in out || 'effort' in out ? out : null
}

// routes for every kind: nothing set, then each layer's `kind: "spec"` entries on top, in order
export function buildRoutes(layers = []) {
  const routes = emptyRoutes()
  for (const layer of layers) {
    for (const [task, spec] of Object.entries(layer ?? {})) {
      const p = TASKS.includes(task) ? parseSpec(spec) : null
      if (p) routes[task] = { ...routes[task], ...p }
    }
  }
  return routes
}

// the spec text /route set and the panel store for a route: "sonnet max", "keep low", "keep keep"
export const specText = r => `${Object.keys(MODELS).find(k => MODELS[k] === r.model) ?? r.model ?? 'keep'} ${r.effort ?? 'keep'}`

// ---------- reading a prompt ----------

const TAGS = new Set([...Object.keys(MODELS), ...EFFORTS, ...TASKS])

// leading "@opus @high ..." tags: returned without them, so the model never pays tokens for them
export function parsePrompt(text) {
  let rest = String(text)
  const tags = []
  for (;;) {
    const m = /^\s*@([a-z]+)\b[:,]?\s*/i.exec(rest)
    if (!m || !TAGS.has(m[1].toLowerCase())) break
    tags.push(m[1].toLowerCase())
    rest = rest.slice(m[0].length)
  }
  // a prompt that was only tags is sent as typed
  return rest.trim() ? { text: rest, tags } : { text: String(text), tags: [] }
}

const THINK = /\b(ultrathink|think (really |very )?hard|max effort|hardest)\b/
const HARD = ['architect(ure)?', 'system design', 'redesign', 'from scratch', 'rewrite (the|this|whole)', 'migrat(e|ion)', 'design system', 'full (site|seo|security) audit', 'security (audit|review)', 'plan (out|the whole)', 'bugs?', 'debug', 'errors?', 'exceptions?', 'crash(es|ing)?', 'broken', 'not working', "doesn'?t work", "isn'?t working", 'fail(s|ing|ed)?', 'stack ?trace', 'regression', 'refactor', 'performance', 'slow', 'race condition', 'memory leak']
const QUICK = ['rename', 'typos?', 'spelling', 'format', 'lint', 'prettier', 'reword', 'bump', 'commit', 'push', 'translate', '(change|update|replace|make) ([\\w-]+ ){0,3}(colou?rs?|text|font|title|copy|link|label|wording|image|icon)']
const QUICK_QUESTION = /^(what|who|when|where|which|is|are|does|do|can|how many)\b[^\n]{0,80}\?$/
const FOLLOW_UP = /^(y|yes|yeah|yep|ok(ay)?|sure|go( ahead)?|do it|continue|proceed|next|sounds good|lgtm|thanks?|thank you|perfect|great|nice)\b[\s.!]*$/
const STUCK = /\b(still (not|broken|failing|wrong|the same|doesn'?t|isn'?t)|same (error|issue|problem|bug)|didn'?t (work|fix|help)|not fixed|wrong again|try again)\b/
const STEP_UP = { quick: 'normal', normal: 'hard' }

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const rule = (defaults, extra = []) => new RegExp(`\\b(${[...defaults, ...extra.map(escapeRe)].join('|')})\\b`)

// one of your rules: { words: ['redesign'], route: { model, effort } }. "redesign, landing page = sonnet max" -> a rule
export function parseRule(text) {
  const at = String(text).indexOf('=')
  if (at < 0) return null
  const words = text.slice(0, at).split(',').map(w => w.trim().toLowerCase()).filter(Boolean)
  const route = parseSpec(text.slice(at + 1))
  return words.length && route ? { words, route: { model: route.model ?? null, effort: route.effort ?? null } } : null
}

// "still broken" after a hard prompt or a rule: one effort step up; past xhigh, the top model if you set one, else max
function stepUp(prev, top) {
  const at = rank(prev?.effort ?? 'high')
  if (at < rank('xhigh')) return { model: prev?.model ?? null, effort: EFFORTS[at + 1] }
  if (top) return { model: top, effort: 'xhigh' }
  return { model: prev?.model ?? null, effort: 'max' }
}

// -> { task, reason, strong, override: { task?, model?, effort? }, text }
// task is quick, normal, hard, or 'rule' (one of yours; its route is in override).
// strong: the person asked for it (a tag, "ultrathink", "still broken"), so the cache guard lets it through.
// prevRoute: what the last prompt wanted; rules: yours, checked first; top: the model "still broken" climbs to past xhigh
export function classify(raw, { prevTask = null, prevRoute = null, words = {}, rules = [], top = null } = {}) {
  const { text, tags } = parsePrompt(raw)
  const tagged = {}
  for (const tag of tags) {
    if (TASKS.includes(tag)) tagged.task = tag
    else if (MODELS[tag]) tagged.model = MODELS[tag]
    else tagged.effort = tag
  }
  const t = text.slice(0, 300).toLowerCase().trim()
  const done = (task, reason, strong = false, route = null) => ({ task, reason, strong: strong || tags.length > 0, override: { ...(route ?? {}), ...tagged }, text })
  if (prevTask && prevTask !== 'rule' && !TASKS.includes(prevTask)) prevTask = null
  const again = () => (prevRoute ? { model: prevRoute.model ?? null, effort: prevRoute.effort ?? null } : null)

  if (tagged.task) return done(tagged.task, `you tagged @${tagged.task}`, true)
  if (prevTask && STUCK.test(t)) {
    if (STEP_UP[prevTask]) return done(STEP_UP[prevTask], 'still stuck, stepped up', true)
    return done(prevTask, 'still stuck, stepped up', true, stepUp(prevRoute, top))
  }
  if (prevTask && FOLLOW_UP.test(t)) return done(prevTask, 'follow-up', false, again())
  const isThink = THINK.test(t)
  for (const r of rules) if (r.words?.length && rule([], r.words).test(t)) return done('rule', `your rule "${r.words[0]}"`, isThink, r.route)
  if (isThink) return done('hard', 'you asked for max', true)
  if (rule(HARD, words.hard).test(t)) return done('hard', 'hard task')
  if (rule(QUICK, words.quick).test(t)) return done('quick', 'quick edit')
  if (QUICK_QUESTION.test(t)) return done('quick', 'quick question')
  if (words.normal?.length && rule([], words.normal).test(t)) return done('normal', 'your keyword')
  // a short line with no rule hit is usually a reply mid-task
  if (prevTask && t.length < 40) return done(prevTask, 'follow-up', false, again())
  return done('normal', 'everyday work')
}

// the route a prompt runs on: its kind's choice, then a rule's or a tag's on top
export function routeFor(task, routes, override = {}) {
  const r = task === 'rule' ? { model: null, effort: null } : (routes[task] ?? routes.normal)
  return { model: 'model' in override ? override.model : r.model, effort: 'effort' in override ? override.effort : r.effort }
}

// ---------- the cache guard ----------
//
// A model switch makes the next reply read the whole conversation uncached. An effort change does the same on most
// models (not on Sonnet 5.5, Opus 5.5 and Fable 5.1). So in a long conversation, short trips to another model are
// held back. A switch always goes through when:
//   the person asked for it, the conversation is still small, the cache has already expired, or it moves to the
//   "home" model (the one chosen for normal prompts), which is a one-time move, not a back-and-forth.
// home: the route chosen for normal prompts ({ model, effort }). A held-back trip lands there, never on the session's
// own model: after a restart that would be whatever the session started on (often Opus), the opposite of saving
export function guard({ wanted, ran, sessionModel, sessionEffort, home = null, ctxTokens = 0, idleMs = 0, strong = false, freeBelow = 30000, ttlMs = 3600000 }) {
  const held = []
  const free = strong || ctxTokens <= freeBelow || idleMs > ttlMs
  const lastModel = ran?.model ?? sessionModel
  const homeModel = home?.model ?? null
  let model = wanted.model ?? sessionModel
  let wantedEffort = wanted.effort
  if (model !== lastModel && !free && model !== (homeModel ?? sessionModel)) {
    held.push('model')
    model = homeModel ?? lastModel
    if (homeModel) wantedEffort = home.effort
  }
  const lastEffort = ran?.model === model ? (ran?.effort ?? null) : (sessionEffort ?? null)
  let effort = clampEffort(model, wantedEffort ?? sessionEffort)
  if (effort && effort !== lastEffort && !free && !EFFORT_KEEPS_CACHE.test(model) && rank(effort) <= rank(lastEffort)) {
    held.push('effort')
    effort = clampEffort(model, lastEffort)
  }
  return { model, effort, held }
}

// ---------- stats ----------

export const emptyStats = () => ({ turns: 0, switches: 0, switchWrite: 0, byRoute: {} })

// usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }; switched: the route changed this turn
export function addTurn(stats, key, usage, switched) {
  const u = usage ?? {}
  const prev = stats.byRoute[key] ?? { turns: 0, input: 0, output: 0, read: 0, write: 0 }
  return {
    turns: stats.turns + 1,
    switches: stats.switches + (switched ? 1 : 0),
    switchWrite: stats.switchWrite + (switched ? (u.cache_creation_input_tokens ?? 0) : 0),
    byRoute: {
      ...stats.byRoute,
      [key]: {
        turns: prev.turns + 1,
        input: prev.input + (u.input_tokens ?? 0),
        output: prev.output + (u.output_tokens ?? 0),
        read: prev.read + (u.cache_read_input_tokens ?? 0),
        write: prev.write + (u.cache_creation_input_tokens ?? 0),
      },
    },
  }
}

export const k = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function formatStats(stats, costUsd) {
  if (!stats.turns) return 'No routed replies yet.'
  const rows = Object.entries(stats.byRoute)
  const sum = f => rows.reduce((a, [, r]) => a + r[f], 0)
  const all = sum('input') + sum('read') + sum('write')
  const lines = [`Replies: ${stats.turns}. Cache hit: ${all ? Math.round((sum('read') / all) * 100) : 0}% of input tokens.`]
  for (const [key, r] of rows) {
    const total = r.input + r.read + r.write
    lines.push(`  ${key}: ${r.turns} replies, ${k(total)} in (${total ? Math.round((r.read / total) * 100) : 0}% cached), ${k(r.output)} out`)
  }
  lines.push(`Model or effort switches: ${stats.switches}${stats.switches ? `, ${k(stats.switchWrite)} tokens re-cached on those replies` : ''}.`)
  if (costUsd !== undefined) lines.push(`Session cost so far: $${costUsd.toFixed(2)}.`)
  return lines.join('\n')
}
