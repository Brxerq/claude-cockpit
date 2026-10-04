// node hooks/cache.test.mjs
import assert from 'node:assert/strict'
import { accountOf, decideTtl, emptyCache, isStuck, leftLabel, leftMs, missReason, observe, phase, report, touch, TTL_MS } from './cache.mjs'

const MIN = 60000
const O = 'claude-opus-5-5'
// real requests carry a clock time, never 0 (at 0 means no entry), so every time here is counted from T
const T = 1000 * MIN
const req = (at, read, write, extra = {}) => ({ at: T + at, model: O, read, write, fresh: 300, ...extra })

// the account: a plan window is a subscription, a full one means usage credits
assert.equal(accountOf([]), 'other')
assert.equal(accountOf([{ kind: 'five_hour', percentUsed: 40 }]), 'subscription')
assert.equal(accountOf([{ kind: 'five_hour', percentUsed: 100 }, { kind: 'seven_day', percentUsed: 60 }]), 'credits')
assert.equal(accountOf([{ kind: 'spend_limit', percentUsed: 10 }]), 'other')

// Claude Code's order: force 5m, the variable, the setting, enable 1h, then the account
assert.equal(decideTtl({ force5m: '1', ttlVar: '1h', enable1h: '1' }, '1h', 'subscription').ttl, '5m')
assert.equal(decideTtl({ ttlVar: '1h' }, '5m', 'other').ttl, '1h')
assert.equal(decideTtl({ ttlVar: '2h' }, '5m', 'subscription').ttl, '5m') // a value it does not know is ignored
assert.equal(decideTtl({ enable1h: 'true' }, undefined, 'other').ttl, '1h')
assert.equal(decideTtl({}, undefined, 'subscription').ttl, '1h')
assert.equal(decideTtl({}, undefined, 'credits').ttl, '5m')
assert.equal(decideTtl().ttl, '5m')

// a first request starts the countdown on the account's lifetime
let c = touch({ ...emptyCache(), ttl: '1h' }, req(0, 0, 80000))
assert.equal(c.until, T + TTL_MS['1h'])
assert.equal(c.tokens, 80300)
assert.equal(c.why, null)
assert.equal(leftMs(c, T + 10 * MIN), 50 * MIN)

// a request that read the cache renews it
c = touch(c, req(10 * MIN, 80300, 900))
assert.equal(c.until, T + 70 * MIN)
assert.equal(c.why, null)

// a hit more than 5 minutes after the last request proves the hour, whatever the account said
let five = touch(emptyCache(), req(0, 0, 80000))
assert.equal(five.life, '5m')
assert.equal(observe(five, req(4 * MIN, 80000, 500)), null) // inside 5 minutes it says nothing
five = touch(five, req(8 * MIN, 80000, 500))
assert.equal(five.seen, '1h')
assert.equal(five.life, '1h')

// a miss 5 to 60 minutes later, same model and size, says 5 minutes; and names the reason
let hour = touch({ ...emptyCache(), ttl: '1h' }, req(0, 0, 80000))
hour = touch(hour, req(20 * MIN, 0, 81000))
assert.equal(hour.seen, '5m')
assert.equal(hour.life, '5m')
assert.match(hour.why, /prefix changed/) // the meter believed the hour, so it blames the prefix, not the clock
assert.match(touch(hour, req(40 * MIN, 0, 82000)).why, /5m lifetime had passed/)
// a proven hour is not undone by a later miss
assert.equal(touch({ ...hour, seen: '1h' }, req(60 * MIN, 0, 82000)).seen, '1h')
// your own choice beats what the traffic says
assert.equal(touch({ ...hour, pin: '1h' }, req(60 * MIN, 0, 82000)).life, '1h')

// misses: a model change is named, a prompt that shrank (/compact) is not a miss
assert.match(missReason(c, { ...req(11 * MIN, 0, 81000), model: 'claude-sonnet-5-5' }), /opus 5.5 to sonnet 5.5/)
assert.equal(missReason(c, req(11 * MIN, 0, 20000)), null)

// a request that was not cached leaves nothing to count down
assert.equal(touch(c, req(12 * MIN, 0, 0)).at, 0)

// a keep-warm ping on a 5-minute account renews it for 5 minutes
let ping = touch(touch(emptyCache(), req(0, 0, 80000)), req(4 * MIN, 80300, 0, { ping: true }))
assert.equal(ping.until, T + 9 * MIN)
assert.equal(ping.viaPing, true)
// on an hour-long entry it counts as 5 minutes, and never shortens what is left
ping = touch(c, req(30 * MIN, 81000, 0, { ping: true }))
assert.equal(ping.until, T + 70 * MIN)
assert.equal(ping.life, '1h')
ping = touch(c, req(68 * MIN, 81000, 0, { ping: true }))
assert.equal(ping.until, T + 73 * MIN)
assert.equal(ping.life, '5m')
// a hit long after the ping proves the ping renewed it for the hour; the next ping counts as one
const proven = touch(ping, req(100 * MIN, 81000, 500))
assert.equal(proven.pingSeen, '1h')
assert.equal(proven.seen, ping.seen) // and says nothing more about the account
assert.equal(touch(proven, req(150 * MIN, 81000, 0, { ping: true })).until, T + 210 * MIN)
// a ping that touched no cache, or came back after a newer request, changes nothing
assert.equal(touch(c, req(30 * MIN, 0, 0, { ping: true })), c)
assert.equal(touch(c, req(5 * MIN, 81000, 0, { ping: true })), c)

// the row's states and its coarse clock
assert.equal(phase(emptyCache(), 0), 'none')
assert.equal(phase({ ...c, busy: true }, 20 * MIN), 'live')
assert.equal(phase(c, T + 20 * MIN), 'warm')
assert.equal(phase(c, T + 50 * MIN), 'low')
assert.equal(phase(c, T + 66 * MIN), 'soon')
assert.equal(phase(c, T + 70 * MIN), 'cold')
assert.equal(leftLabel(50 * MIN), '50m')
assert.equal(leftLabel(119000), '2:00')
assert.equal(leftLabel(61000), '1:10')
assert.equal(leftLabel(9000), '0:10')
assert.equal(leftLabel(0), 'cold')

assert.match(report(c, T + 20 * MIN), /Cache lifetime: 1h[\s\S]*99% read[\s\S]*Warm for 50m/)
assert.match(report(c, T + 80 * MIN), /re-reads 82k tokens/)

// a reply marked running whose entry has lapsed is stuck (an interrupted turn); a live one is not
assert.equal(isStuck({ ...c, busy: true }, T + 70 * MIN), true)
assert.equal(isStuck({ ...c, busy: true }, T + 20 * MIN), false)
assert.equal(isStuck({ ...c, busy: false }, T + 70 * MIN), false)
assert.equal(isStuck({ ...emptyCache(), busy: true }, 5), false)
assert.equal(emptyCache().hidden, false)

console.log('cache ok')
