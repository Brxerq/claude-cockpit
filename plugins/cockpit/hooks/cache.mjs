// Cockpit cache meter: the pure part. No engine calls, so `node hooks/cache.test.mjs` can check every rule.
//
// Claude Code caches the conversation on the API side, per model. An entry lives 5 minutes or 1 hour, counted from the
// start of the last request that read or wrote it. A read costs about a tenth of the input price; once the entry has
// lapsed, the next request writes the whole conversation again at 1.25x (5 minutes) or 2x (1 hour). This module tracks
// the entry the main conversation last touched: which lifetime it has, when it lapses, and why a request missed it.
// (docs: code.claude.com/docs/en/prompt-caching, platform.claude.com/docs/en/build-with-claude/prompt-caching)
import { k, shortModel } from './route.mjs'

export const TTL_MS = { '5m': 5 * 60000, '1h': 60 * 60000 }
// how long before the end the warning comes, or an automatic keep-warm ping goes out
export const WARN_MS = { '5m': 60000, '1h': 5 * 60000 }
// requests are timed on this machine, so a hit that landed just inside the lifetime must not read as proof of the longer one
const SLACK_MS = 10000

export const asTtl = v => (v === '5m' || v === '1h' ? v : null)

// at 0: no entry. until: when the entry lapses. life: the lifetime the meter is scaled to
export const emptyCache = () => ({ show: true, auto: 0, pin: null, ttl: '5m', source: 'no plan window seen yet', seen: null, pingSeen: null, at: 0, until: 0, life: '5m', tokens: 0, read: 0, write: 0, model: '', viaPing: false, pings: 0, busy: false, why: null })

// ---------- which lifetime the account gets ----------

// from the rate-limit windows the last response reported: a five-hour or seven-day window is a Claude subscription,
// and a full one means requests now draw on usage credits. No window: an API key, a cloud provider, or no response yet
export function accountOf(windows = []) {
  const plan = windows.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
  if (plan.length === 0) return 'other'
  return plan.some(w => w.percentUsed >= 100) ? 'credits' : 'subscription'
}

const isSet = v => v === '1' || String(v).toLowerCase() === 'true'

// Claude Code's own order for the main conversation (docs: "Choose the TTL yourself"), first match wins.
// env: { force5m, ttlVar, enable1h }; setting: the promptCacheTtl setting
export function decideTtl(env = {}, setting, account) {
  if (isSet(env.force5m)) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' }
  if (asTtl(env.ttlVar)) return { ttl: env.ttlVar, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  if (asTtl(setting)) return { ttl: setting, source: 'the promptCacheTtl setting' }
  if (isSet(env.enable1h)) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' }
  if (account === 'subscription') return { ttl: '1h', source: 'Claude subscription' }
  return { ttl: '5m', source: account === 'credits' ? 'usage credits' : 'no plan window seen yet' }
}

// ---------- what a request says ----------
// s: { at, model, read, write, fresh, ping }. at: when the request started; read, write, fresh: the prompt tokens the
// cache served, wrote, and neither; ping: a keep-warm ping, not a request of the conversation

// what a request proves about the lifetime of the entry before it: a hit more than 5 minutes later proves 1 hour;
// a miss 5 to 60 minutes later, on the same model with a prompt that did not shrink, says it lapsed at 5 minutes
// (weaker: a changed prefix looks the same). null: it says nothing
export function observe(c, s) {
  const gap = s.at - c.at
  if (!c.at || s.model !== c.model || gap <= TTL_MS['5m'] + SLACK_MS) return null
  if (s.read >= c.tokens * 0.5) return '1h'
  return s.write > 0 && s.read + s.write + s.fresh >= c.tokens * 0.7 && gap < TTL_MS['1h'] + SLACK_MS ? '5m' : null
}

// why a request that should have read the cache wrote it instead; null when it did not miss. A prompt that shrank is
// a /compact or /clear, and a first request has nothing to read
export function missReason(c, s) {
  if (!c.at || s.write === 0 || s.read >= c.tokens * 0.5 || s.read + s.write + s.fresh < c.tokens * 0.7) return null
  if (s.model !== c.model) return `model changed (${shortModel(c.model)} to ${shortModel(s.model)})`
  if (s.at > c.until) return `the ${c.life} lifetime had passed`
  return 'the prompt prefix changed (effort, tools or system prompt)'
}

// the cache state after a request
export function touch(c, s) {
  // a ping that came back after a newer request, or one that touched no cache, changes nothing
  if (s.at < c.at || (s.ping && s.read + s.write === 0)) return c
  const said = observe(c, s)
  // a proven hour stands: a later miss is more likely a changed prefix than a lapse
  const learn = known => (said && known !== '1h' ? said : known)
  const seen = c.viaPing ? c.seen : learn(c.seen)
  const pingSeen = c.viaPing ? learn(c.pingSeen) : c.pingSeen
  // not cached (a prompt under the model's minimum, or caching switched off): nothing to count down
  if (s.read + s.write === 0) return { ...c, seen, pingSeen, at: 0, until: 0, viaPing: false, why: null }
  let life = c.pin ?? seen ?? c.ttl
  // Claude Code sends a fork with the 5-minute lifetime, and whether its read renews an hour-long entry for the hour
  // is not documented: a ping counts as 5 minutes until a later hit proves more
  if (s.ping && life === '1h') life = pingSeen ?? '5m'
  const until = s.at + TTL_MS[life]
  const state = { ...c, seen, pingSeen, at: s.at, tokens: s.read + s.write + s.fresh, read: s.read, write: s.write, model: s.model, viaPing: !!s.ping }
  // a ping never shortens the entry it read
  if (s.ping) return until > c.until ? { ...state, until, life } : state
  return { ...state, until, life, why: missReason(c, s) }
}

// ---------- reading the state ----------

export const leftMs = (c, now) => (c.at ? Math.max(0, c.until - now) : 0)

// none: no entry; live: a reply is running and every request renews it; warm, low (under 40% left), soon (inside the
// warning), cold (lapsed)
export function phase(c, now) {
  if (!c.at) return 'none'
  if (c.busy) return 'live'
  const left = c.until - now
  if (left <= 0) return 'cold'
  return left <= WARN_MS[c.life] ? 'soon' : left <= TTL_MS[c.life] * 0.4 ? 'low' : 'warm'
}

// the time left in the steps the row shows: whole minutes, then 10 seconds for the last two. The row is redrawn only
// when the step changes, never each second; rounded up, so the row is exact at the moment it is redrawn
export const leftStep = ms => (ms <= 0 ? 0 : ms >= 120000 ? Math.ceil(ms / 60000) * 60000 : Math.ceil(ms / 10000) * 10000)

export function leftLabel(ms) {
  const step = leftStep(ms)
  if (step === 0) return 'cold'
  if (ms >= 120000) return `${step / 60000}m`
  return `${Math.floor(step / 60000)}:${String((step % 60000) / 1000).padStart(2, '0')}`
}

// /cache: the lifetime and where it came from, the last request, the time left, the keep-warm setting
export function report(c, now) {
  const from = c.pin ? 'your /cache ttl choice' : c.seen ? 'seen in this session' : c.source
  const lines = [`Cache lifetime: ${c.pin ?? c.seen ?? c.ttl} (${from}).`]
  const state = phase(c, now)
  if (state === 'none') lines.push('No cached request yet.')
  else {
    lines.push(`Last request: ${Math.round((c.read / Math.max(1, c.tokens)) * 100)}% read from the cache (${k(c.read)} read, ${k(c.write)} written, ${k(c.tokens - c.read - c.write)} new) on ${shortModel(c.model)}.`)
    if (c.why) lines.push(`It missed the cache: ${c.why}.`)
    if (state === 'live') lines.push('A reply is running: every request renews the cache.')
    else if (state === 'cold') lines.push(`Expired: the next prompt re-reads ${k(c.tokens)} tokens at full price. /clear first if the task is done.`)
    else lines.push(`Warm for ${leftLabel(c.until - now)}${c.viaPing ? ' (kept warm by a ping)' : ''}.`)
  }
  lines.push(c.show ? `Keep warm: /cache warm or the button on the row. Automatic pings per pause: ${c.auto || 'off'} (/cache auto 2).` : 'The cache row is off: /cache on.')
  return lines.join('\n')
}
