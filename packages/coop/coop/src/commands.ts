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
 * Register the `/coop` command family. Plan creation stays model-facing
 * (`coop_plan_create`) because its objective payload does not fit a slash line.
 * @param ctx - context carrying the commands child.
 * @param service - owning coop service performing the transitions.
 */
export function registerCoopCommands(ctx: Context, service: CoopService): void {
  ctx.commands.register({
    name: 'coop',
    description: 'Cross-session cooperation: /coop role master|worker|off|list, plan notify, abort',
    input: { hint: 'role <master|worker> [--level L] [--any-cwd] | role list [--all] | role off | plan notify <planId> | abort <planId> [--reason text]' },
    async handler(invocation) {
      const parsed = parseInput(invocation.rawInput)
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
