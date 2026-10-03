export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'
export type PlanSubstep = { title: string; status: StepStatus }
// doneAt: when the step was finished, so a checkpoint can tell how long it took
export type PlanStep = { title: string; status: StepStatus; substeps: PlanSubstep[]; doneAt?: number }
export type PlanStage = { name: string; steps: PlanStep[] }
export type PlanState = 'running' | 'needs_input' | 'error' | 'done'
export type Plan = {
  id: string
  title: string
  kind: 'plan' | 'todo'
  stages: PlanStage[]
  state: PlanState
  note: string | null
  startedAt: number
  // when the plan was finished; the pill then shows the time it took
  endedAt?: number | null
}

// a model and an effort; model null keeps the session's model, effort null leaves effort alone
export type Spec = { model: string | null; effort: string | null }
// what a prompt was sorted into, waiting for the turn's first request to apply it
export type Pending = { task: string; reason: string; strong: boolean; override: { task?: string; model?: string; effort?: string } }
// what a turn runs on, after the cache guard; held lists what was kept back to protect the prompt cache
export type Route = { task: string; model: string; effort: string | null; reason: string; held: string[]; wanted: Spec }
// one of your rules: these words in a prompt -> this model and effort
export type Rule = { words: string[]; route: Spec }
export type RouteStats = { turns: number; input: number; output: number; read: number; write: number }
export type Stats = { turns: number; switches: number; switchWrite: number; byRoute: Record<string, RouteStats> }
export type Router = {
  // auto: each prompt runs on the route chosen for its kind; off: the session's own model and effort
  mode: 'auto' | 'off'
  // your choice per kind of prompt (quick, normal, hard); model and effort null mean keep yours
  routes: Record<string, Spec>
  rules: Rule[]
  // where "still broken" goes past xhigh: a model id, or null for max on the same model
  top: string | null
  // hold back one-off model trips in long chats, to keep the prompt cache
  saver: boolean
  pending: Pending | null
  current: Route | null
  // what the last turn actually sent, to tell a switch from a repeat
  ran: Spec | null
  // the model and effort the engine had before the router touched them
  seen: Spec | null
  // when the last main turn ended, to tell whether the prompt cache has expired
  lastEnd: number
  // the route changed at this turn's start
  switched: boolean
  stats: Stats
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      plans: Plan[]
      isOpen: boolean
      router: Router
    }
  }
}
