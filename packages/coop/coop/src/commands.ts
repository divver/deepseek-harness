/** Human slash-command surface (`/coop ...`) registered on `ctx.commands`. @module @deepseek-ai/dsh-coop/commands */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CoopService } from './service.ts'
import type { Role } from './types.ts'

/** Parsed command line: positionals plus long flags (`--flag`, `--flag value`). */
interface ParsedInput {
  positional: string[]
  flags: Map<string, string | true>
}

/** Tokenize raw input into positionals and long flags; a flag value consumes the next token unless it looks like another flag. */
function parseInput(raw: string): ParsedInput {
  const tokens = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/u)
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === undefined) break
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    const next: string | undefined = tokens.at(index + 1)
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      index++
    } else {
      flags.set(name, true)
    }
  }
  return { positional, flags }
}

const USAGE = 'usage: /coop role <master|worker> [--level <strict|standard|lenient>] [--any-cwd] · role list [--all] · role off · plan notify <planId> [--worker <sessionId>] · abort <planId> [--reason <text>]'

/**
 * Register the `/coop` command family. The deployed mode selects the v1
 * plan grammar or the v2 node grammar; plan creation stays model-facing
 * (`coop_plan_create`) because its objective payload does not fit a slash line.
 * @param ctx - context carrying the commands child.
 * @param service - owning coop service performing the transitions.
 */
export function registerCoopCommands(ctx: Context, service: CoopService): void {
  ctx.commands.register({
    name: 'coop',
    description: service.mode === 'v2'
      ? 'Cross-session cooperation (v2): master/worker/reviewer nodes, bind/release, workspace anchor'
      : 'Cross-session cooperation: /coop role master|worker|off|list, plan notify, abort',
    input: { hint: service.mode === 'v2'
      ? 'master [--any-cwd] | worker|reviewer [--master <id>] [--model <route>] | off | list [--unbound] | status | bind <sessionId> | release <sessionId> | workspace init [path]'
      : 'role <master|worker> [--level L] [--any-cwd] | role list [--all] | role off | plan notify <planId> | abort <planId> [--reason text]' },
    async handler(invocation) {
      const parsed = parseInput(invocation.rawInput)
      if (service.mode === 'v2') {
        try {
          return { kind: 'success', text: await runV2(service, invocation.agent, parsed) }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
      const [head, sub, ...rest] = parsed.positional
      try {
        if (head === 'role') {
          return { kind: 'success', text: await runRole(service, invocation.agent, sub, parsed) }
        }
        if (head === 'plan' && sub === 'notify') {
          const planId = rest[0]
          if (planId === undefined) return { kind: 'error', text: USAGE }
          const worker = parsed.flags.get('worker')
          const plan = await service.notifyPlan(invocation.agent, planId, {
            ...(typeof worker === 'string' ? { workerSessionId: worker } : {}),
          })
          return { kind: 'success', text: `Plan ${plan.planId} notified (${plan.status}${plan.assignedWorkerSessionId === undefined ? '' : `, worker ${plan.assignedWorkerSessionId}`}).` }
        }
        if (head === 'abort') {
          const planId = sub
          if (planId === undefined) return { kind: 'error', text: USAGE }
          const reason = parsed.flags.get('reason')
          await service.abortPlan(invocation.agent, planId, typeof reason === 'string' ? reason : undefined)
          return { kind: 'success', text: `Plan ${planId} set to aborting; stop notice delivered.` }
        }
        return { kind: 'error', text: USAGE }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** Handle the `role` subcommand family for one live agent. */
async function runRole(
  service: CoopService,
  agent: Agent,
  sub: string | undefined,
  parsed: ParsedInput,
): Promise<string> {
  if (sub === 'off') {
    await service.setRoles(agent, { set: [] })
    return 'Coop roles dropped for this session.'
  }
  if (sub === 'list') {
    const entries = parsed.flags.has('all')
      ? await service.listWorkspace(agent, { all: true })
      : await service.listWorkspace(agent)
    if (entries.length === 0) return 'No visible coop sessions.'
    return entries.map(entry => `${entry.sessionId}: ${entry.roles.join('+')} [${entry.cwdScope}] cwd=${entry.cwd}`).join('\n')
  }
  if (sub === 'master' || sub === 'worker') {
    const level = parsed.flags.get('level')
    if (level !== undefined && level !== true && !['strict', 'standard', 'lenient'].includes(level)) {
      return 'usage: --level accepts strict | standard | lenient'
    }
    const roles: Role[] = await service.setRoles(agent, { set: [sub] }, {
      ...(parsed.flags.has('any-cwd') ? { cwdScope: 'any' as const } : {}),
      ...(typeof level === 'string' ? { reviewLevel: level as 'strict' | 'standard' | 'lenient' } : {}),
    })
    return `This session is now registered as: ${roles.join(', ')}.`
  }
  return USAGE
}
const V2_USAGE = 'usage: /coop master [--any-cwd] · worker|reviewer [--master <masterId>] [--model <route>] [--skills a,b] [--any-cwd] · off · list [--unbound] · status · bind <sessionId> · release <sessionId> · board [planId] · plan close|abort <planId> · workspace init [path]'
/** Dispatch the v2 `/coop` grammar for one live agent. */
async function runV2(
  service: CoopService,
  agent: Agent,
  parsed: ParsedInput,
): Promise<string> {
  const [head, sub] = parsed.positional
  const cwdScope = parsed.flags.has('any-cwd') ? 'any' as const : undefined
  if (head === 'master') {
    const entry = await service.registerV2(agent, { roles: ['master'], ...(cwdScope === undefined ? {} : { cwdScope }) })
    return `Master registered: ${String(entry.masterId)}.`
  }
  if (head === 'worker' || head === 'reviewer') {
    const master = parsed.flags.get('master')
    const model = parsed.flags.get('model')
    const skillsFlag = parsed.flags.get('skills')
    const skills = typeof skillsFlag === 'string'
      ? skillsFlag.split(',').map(part => part.trim()).filter(part => part.length > 0)
      : undefined
    const entry = await service.registerV2(agent, {
      roles: [head],
      ...(typeof master === 'string' ? { masterId: master } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(skills === undefined ? {} : { skills }),
      ...(cwdScope === undefined ? {} : { cwdScope }),
    })
    return `${head} registered (${entry.bindState}${entry.masterId === undefined ? '' : ` → ${String(entry.masterId)}`}).`
  }
  if (head === 'off') {
    await service.registerV2(agent, { roles: [] })
    return 'Coop v2 node deregistered for this session.'
  }
  if (head === 'list') {
    const entries = await service.listNodesV2(agent, { ...(parsed.flags.has('unbound') ? { unboundOnly: true } : {}) })
    if (entries.length === 0) return 'No visible coop nodes.'
    return entries.map(entry => `${entry.sessionId}: ${entry.roles.join('+')} [${entry.bindState}${entry.masterId === undefined ? '' : ` → ${String(entry.masterId)}`}]`).join('\n')
  }
  if (head === 'status') {
    const status = await service.statusV2(agent)
    return [
      `self: ${status.self === undefined ? 'unregistered' : `${status.self.roles.join('+')} [${status.self.bindState}${status.self.masterId === undefined ? '' : ` → ${String(status.self.masterId)}`}]`}`,
      `masters: ${status.masters.join(', ') || '(none)'}`,
      `your nodes: ${String(status.own.length)}`,
      `unbound: ${String(status.unbound)}`,
    ].join('\n')
  }
  if (head === 'bind' && sub !== undefined) {
    const bound = await service.bindNode(agent, sub)
    return `Node ${bound.sessionId} bound to ${String(bound.masterId)}.`
  }
  if (head === 'release' && sub !== undefined) {
    await service.releaseNode(agent, sub)
    return `Node ${sub} released to the unbound pool.`
  }
  if (head === 'board') {
    const plans = await service.boardV2(agent, sub)
    if (plans.length === 0) return 'No plans yet.'
    return plans.map(plan => [
      `${plan.planId} ${plan.title} [${plan.status}]`,
      plan.tasks.map(task => `  ${task.taskId} ${task.title} [${task.status}${task.assignee === undefined ? '' : ` → ${task.assignee}`}]`).join('\n') || '  (no tasks)',
    ].join('\n')).join('\n\n')
  }
  if (head === 'plan' && (sub === 'close' || sub === 'abort')) {
    const planId = parsed.positional[2]
    if (planId === undefined) return V2_USAGE
    const plan = sub === 'close'
      ? await service.closePlanV2(agent, planId)
      : await service.abortPlanV2(agent, planId)
    return `Plan ${plan.planId} → ${plan.status}.`
  }
  if (head === 'worktree' && (sub === 'list' || sub === undefined)) {
    const planId = parsed.positional[2]
    const entries = await service.listWorktreesV2(agent, planId)
    if (entries.length === 0) return 'No worktrees.'
    return entries.map(entry => `${entry.dir} [${entry.status}] ${entry.branch} ← ${entry.baseBranch} (${entry.planId})`).join('\n')
  }
  if (head === 'spawn' && (sub === 'worker' || sub === 'reviewer')) {
    const model = parsed.flags.get('model')
    const workdir = parsed.flags.get('workdir')
    const outcome = await service.createNodeV2(agent, {
      role: sub,
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof workdir === 'string' ? { workdir } : {}),
    })
    if (outcome.spawned === 'herdr') return `Node spawned in herdr pane ${outcome.paneId} — registration line sent.`
    return `Node spawned headless: ${outcome.entry?.sessionId ?? '?'} (${outcome.entry?.bindState ?? '?'}).`
  }
  if (head === 'workspace' && sub === 'init') {
    const target = parsed.positional[2]
    const root = await service.initWorkspace(agent, target)
    return `Workspace anchored at ${root}.`
  }
  return V2_USAGE
}
