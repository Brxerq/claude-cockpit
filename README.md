# Cockpit

**Instruments and controls for Claude Code: see where every task is, and choose which model and effort handles it.**

![Cockpit progress bars above the prompt in the Claude desktop app: running, waiting for you, and done](docs/img/bars.png)

- **Progress**: live bars above your prompt. Claude's own todo list becomes a bar automatically, so tracking progress costs zero extra tokens.
- **Router**: you pick a model and effort for quick, normal and hard prompts in a small panel, and every prompt runs on the one that fits.
- **Cache meter**: a row that counts down to the moment the prompt cache expires, warns once before it does, and can keep it warm for under a tenth of what a rewrite costs.

## Install

In Claude Code:

```
/plugin marketplace add Brxerq/claude-cockpit
/plugin install cockpit@claude-cockpit
```

Start a new session afterwards. Cockpit is built on Claude Code's function-hook mods, so it needs a Claude Code build that has them. The pixel bars draw in the desktop app; the terminal gets a text bar.

## What it costs

| Part | Tokens |
|---|---|
| Router | **0**. It runs on your machine; the model never sees it. `@tags` are stripped before sending. |
| Bars from Claude's todo list | **0** extra. Claude already writes that list; Cockpit only draws it. |
| Rules in the system prompt | About 40 tokens, read from the prompt cache |
| Named-stage bars (optional) | A short tool call, about once per stage, only on long tasks |
| Cache meter | **0**. It reads the token counts every reply already reports. |
| Keep-warm ping (only when you ask, or allow it) | One read of the conversation from the cache: a tenth of the input price or less, and a short reply. The toast shows what it cost. |

Cockpit never adds reminders to the conversation, never refuses an edit, and never sends Claude back at the end of a turn. A keep-warm ping is a side request: it adds nothing to the conversation.

## The router

You decide which model and effort handles each kind of prompt. Cockpit sorts every prompt you type into one of three kinds:

| Kind | Sorted here when you write |
|---|---|
| **Quick** | rename, typo, change the text or colour, a short question |
| **Normal** | everything else: build, add, change, explain |
| **Hard** | bug, error, broken, slow, refactor, redesign, migration, "ultrathink" |

Nothing is picked for you. Until you choose, every kind is set to **Keep**, which leaves your own model and effort alone.

### Set it up

![The router panel: a model and effort dropdown for each kind of prompt, your rules, the still-broken ladder and the cache saver](docs/img/router.png)

Type `/route` (or click **Set up router** in the footer). A panel opens with a Model and an Effort dropdown for each kind (Keep leaves your own setting). Your choice is saved for every project.

Prefer typing? The same in one line each:

```
/route set quick haiku
/route set normal sonnet medium
/route set hard opus high
```

### Your own rules

Want "redesign" on Sonnet max and "architecture" on Opus xhigh? Add rules. They are checked before the three kinds:

```
/route rule redesign = sonnet max
/route rule architecture, migration, full audit = opus xhigh
/route rule ultrathink, think hard = opus max
/route rule remove redesign
```

"yes", "ok" and "continue" repeat the last choice. "still broken" or "same error" steps up: Quick to Normal, Normal to Hard, then one effort level at a time up to xhigh. Past xhigh it goes to max, or to the model you pick with `/route stuck fable`. Only the first 300 characters count, so a pasted log full of the word "error" does not make a small request hard.

### One prompt only

Start a prompt with tags. Cockpit strips them before sending, so they cost nothing:

```
@opus @high refactor the auth module
@quick bump the version
```

Tags: `@haiku @sonnet @opus @fable`, `@low @medium @high @xhigh @max`, `@quick @normal @hard`.

### Commands

| Command | Does |
|---|---|
| `/route` | Opens the panel |
| `/route set hard opus high` | Sets one kind by command |
| `/route test <prompt>` | Shows which kind a prompt is, without sending it |
| `/route stats` | Tokens and cache hits per model, and the session cost |
| `/route rule redesign = sonnet max` | Adds one of your rules |
| `/route stuck fable` | Where "still broken" goes past xhigh |
| `/route saver off` | Always switch, even in long chats (see below) |
| `/route on`, `/route off`, `/route clear` | Turn routing on or off, or clear all your choices |

Everything is saved in one file, `~/.claude/cockpit.json`, which the panel and the commands edit and you can edit by hand. A full example:

```json
{
  "routes": { "quick": "haiku", "normal": "sonnet high", "hard": "opus high" },
  "rules": [
    { "words": ["architecture", "migration", "full audit"], "route": "opus xhigh" },
    { "words": ["ultrathink", "think hard"], "route": "opus max" },
    { "words": ["redesign"], "route": "sonnet max" }
  ],
  "top": "fable",
  "saver": true,
  "cache": { "show": true, "auto": 0 }
}
```

A project can add its own in `.claude/cockpit.json` (same shape; its routes win and its rules come first).

### Protecting the prompt cache

Claude Code caches the conversation per model, so a model switch makes the next reply re-read the whole conversation at full price. Per the [prompt caching docs](https://code.claude.com/docs/en/prompt-caching), Sonnet 5.5, Opus 5.5 and Fable 5.1 keep the cache when only effort changes. So Cockpit:

- Always lets you move to the model you chose for **Normal** prompts. That is a one-time move.
- With the **cache saver** on (the default), a long conversation (past 30k tokens) holds back a one-off trip to another model, unless you asked for it (a tag, "ultrathink", "still broken") or the cache has already expired. The panel says when this happened. Turn it off with `/route saver off` if you always want the exact model.
- Fixes the route at the start of a reply, so tool loops never switch mid-reply. Subagents are never touched.

## The cache meter

Claude Code caches your conversation on the API side, so each reply re-reads it at about a tenth of the normal input price. The cache expires 5 minutes after the last request (1 hour on a Claude subscription within its plan usage). After that, the next prompt writes the whole conversation again: 1.25 times the input price for the 5-minute cache, 2 times for the 1-hour one. On a long conversation that is the most expensive moment of the session.

Once a conversation passes 30k tokens, a row above the prompt shows where the cache stands:

- A bar drawn like the progress bars (same pixel fill, same pill, same colours) that drains as the cache runs out. The pill names the state: **Warm** (green), **Cooling** (amber, under 40% left), **Expiring** (red, the last minute, or the last 5 minutes of the 1-hour cache), **Expired**, and **In use** (violet) while a reply runs and renews it. The percent beside it is the share of the lifetime left, and the ✕ hides the row for this session (`/cache on` brings it back; `/cache off` turns it off for good).
- One toast and a sound when it is about to expire, with what the next prompt would cost. Not a countdown of toasts.
- A **Keep warm** button once the cache is past 60% of its life. It sends one tiny side request that reads the conversation from the cache, which renews it. Nothing is added to your conversation.
- When the cache has expired, the row says how many tokens the next prompt re-reads, so you can `/clear` first if the task is done.
- When a reply missed the cache, the row says why: the model changed, the lifetime had passed, or the prompt prefix changed.

Want it kept warm while you are away? `/cache auto 2` lets Cockpit send up to 2 pings by itself in one pause (0 to 5; off by default, and never when a plan window is 95% used). Each ping costs under a tenth of one rewrite, so it pays off if you come back before the cache would have expired.

| Command | Does |
|---|---|
| `/cache` | Lifetime and where it came from, the last request, time left |
| `/cache warm` | Keeps the cache warm now |
| `/cache auto 2`, `/cache auto off` | Pings Cockpit may send by itself in one pause |
| `/cache ttl 5m`, `1h`, `auto` | Sets the lifetime yourself |
| `/cache on`, `/cache off` | The row, its warning and its pings |

**Which lifetime.** Cockpit follows [Claude Code's own rules](https://code.claude.com/docs/en/prompt-caching#cache-lifetime): `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then the account (1 hour on a subscription, 5 minutes on usage credits, an API key or a cloud provider). It then checks that against the traffic: a reply that reads the cache more than 5 minutes after the last one proves the hour. `/cache` names the source in use.

**How it differs from a plain cache countdown.** It can renew the cache instead of only telling you to send a message. The bar animates by itself, so nothing is redrawn each second. And the router's cache saver now uses the real lifetime instead of assuming an hour.

**One thing it learns as it goes.** Claude Code sends side requests with the 5-minute lifetime. Whether such a read renews a 1-hour cache for the full hour is not documented, so on a subscription a ping counts as 5 more minutes until a later reply proves it bought more. From then on pings count for the hour.

## Progress bars

- Claude's todo list shows as a `Tasks` bar by itself
- For long tasks with distinct phases, Claude can show named stages instead
- A plan you approve in plan mode becomes a bar
- Four states: running (violet), needs input (amber), error (red), done (green, with the total time)
- Hover the pill for the running time, hover a checkpoint for when it was reached
- Soft sounds when Claude needs a decision, hits an error or finishes (turn them off in the settings)
- Bars are saved per session and come back when you resume it

Commands: `/progress` (hide or show), `/progress-demo`, `/progress-sounds`, `/progress-clear`.

## Good to know

- Cockpit is early (0.7.4). Please open an issue when something looks off.
- The keyword rules are English. Add your own words with `/route rule` or the project file.
- Your choices are saved for every project; `/route off` resets when the app restarts.
- `.claude/cockpit.json` is read when a session starts and whenever you change a choice.

## Develop

```
node plugins/cockpit/hooks/route.test.mjs   # router, cache guard, stats
node plugins/cockpit/hooks/plan.test.mjs    # bars and drawing (Node 22+)
node plugins/cockpit/hooks/cache.test.mjs   # cache lifetime, misses, keep-warm
claude plugin test plugins/cockpit          # the cache meter through the engine
claude plugin validate plugins/cockpit
```

## License

MIT. See [LICENSE](LICENSE).
