/** Model-facing coop tools registered on `ctx.tools`. @module @deepseek-ai/dsh-coop/tools */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CoopService } from './service.ts'
import type { Role } from './types.ts'

/** Minimal exec slice carrying the owning agent. */
type NonAgent = Agent

/** Render helper: every coop tool answers with one model-facing text block. */
function textOut(text: string): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text }]
}

/**
 * Register the eleven coop tools. All state checks run against the shared
 * files inside the service's locked transitions; session events are mirrors.
 * @param ctx - context carrying the tool registry child.
 * @param service - owning coop service performing the transitions.
 */
export function registerCoopTools(ctx: Context, service: CoopService): void {
  const needAgent = (exec: { agent?: NonAgent }): Agent => {
    if (exec.agent === undefined) throw new Error('coop tools require an owning agent session')
    return exec.agent
  }
  const failMessage = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  ctx.tools.register(defineTool({
    name: 'coop_register',
    description: 'Register THIS session with workspace-wide coop roles (master plans+verifies; worker pre-reviews+executes). Re-registering replaces your previous roles.',
    parameters: {
      roles: {
        type: 'array',
        required: true,
        description: 'Roles to hold after this call.',
        items: { type: 'string', enum: ['master', 'worker'] },
      },
      cwdScope: {
        type: 'string',
        enum: ['cwd', 'any'],
        description: '"cwd" (default) restricts cooperation to this project directory; "any" makes you visible across directories.',
      },
      reviewLevel: {
        type: 'string',
        enum: ['strict', 'standard', 'lenient'],
        description: 'Pre-review strictness you apply as worker.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { roles: { type: 'array', items: { type: 'string' }, required: true } },
      },
      render: (_args, value) => textOut(`coop roles active: ${value.roles.join(', ') || '(none — deregistered)'}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const roles: Role[] = await service.setRoles(agent, { set: args.roles }, {
          ...(args.cwdScope === undefined ? {} : { cwdScope: args.cwdScope }),
        })
        return { roles }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Register coop roles', kind: 'other', rawInput: args.roles }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_list',
    description: 'List live coop sessions visible to this workspace (same directory plus any-scope), with their roles.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          detail: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => textOut(value.count === 0 ? 'No visible coop sessions.' : `${value.count} visible coop session(s):\n${value.detail.join('\n')}`),
    },
    async execute(_args, exec) {
      const agent = needAgent(exec)
      const entries = await service.listWorkspace(agent)
      return {
        count: entries.length,
        detail: entries.map(entry => `${entry.sessionId}: ${entry.roles.join('+')} (${entry.cwdScope})`),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_plan_create',
    description: 'Create a shared plan (master only). Writes the authoritative plan file plus its markdown document.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short plan title.' },
      objective: { type: 'string', required: true, description: 'What the worker should achieve and how success is judged.' },
      reviewLevel: {
        type: 'string',
        enum: ['strict', 'standard', 'lenient'],
        description: 'Override the deployment default gating level.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} created (${value.status}). Call coop_plan_notify to assign a worker.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.createPlan(agent, {
          title: args.title,
          objective: args.objective,
          ...(args.reviewLevel === undefined ? {} : { reviewLevel: args.reviewLevel }),
        })
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: `Create plan: ${args.title}`, kind: 'other', rawInput: args.objective }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_plan_notify',
    description: 'Notify the assigned worker that a plan awaits pre-review (master only). First notify binds the affine worker.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan id from coop_plan_create.' },
      workerSessionId: { type: 'string', description: 'Bind this specific worker on first notify.' },
      reassign: { type: 'boolean', description: 'Pick a new worker (only after the old one went stale).' },
      summary: { type: 'string', description: 'One-line instruction shown to the worker.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string', required: true },
          assignedWorker: { type: 'string' },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} notified (status ${value.status}${value.assignedWorker === undefined ? '' : `, worker ${value.assignedWorker}`}).`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.notifyPlan(agent, args.planId, {
          ...(args.workerSessionId === undefined ? {} : { workerSessionId: args.workerSessionId }),
          ...(args.reassign === undefined ? {} : { reassign: args.reassign }),
          ...(args.summary === undefined ? {} : { summary: args.summary }),
        })
        const worker = plan.assignedWorkerSessionId
        return { planId: plan.planId, status: plan.status, ...(worker === undefined ? {} : { assignedWorker: worker }) }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_pre_review',
    description: 'Worker gate on an assigned plan: pass moves it to ready_to_execute; request_changes returns it to the master.',
    parameters: {
      planId: { type: 'string', required: true },
      decision: { type: 'string', required: true, enum: ['pass', 'request_changes'] },
      summary: { type: 'string', description: 'One-line rationale recorded in the plan document.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          planId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} is now ${value.status}.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.submitPreReview(agent, args.planId, args.decision, args.summary)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_execute_begin',
    description: 'Mark an approved plan as executing before you start the work (assigned worker only).',
    parameters: {
      planId: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} executing. Call coop_execute_report when done.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.beginExecution(agent, args.planId)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_execute_report',
    description: 'Report finished execution of an assigned plan (assigned worker only); wakes the master to verify.',
    parameters: {
      planId: { type: 'string', required: true },
      summary: { type: 'string', required: true, description: 'What was done and any notable outcomes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} reported (${value.status}); master notified.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.reportExecution(agent, args.planId, args.summary)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_verify',
    description: 'Verify a reported plan (creating master only): pass closes it; request_changes sends it back as needs_rework.',
    parameters: {
      planId: { type: 'string', required: true },
      decision: { type: 'string', required: true, enum: ['pass', 'request_changes'] },
      summary: { type: 'string', description: 'Acceptance rationale or rework demand.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} verified: ${value.status}.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.verifyPlan(agent, args.planId, args.decision, args.summary)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_abort',
    description: 'Stop a plan you created (master only) in any non-terminal state; the assigned worker must acknowledge.',
    parameters: {
      planId: { type: 'string', required: true },
      reason: { type: 'string', description: 'Why the plan is being stopped.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} ${value.status}; stop notice delivered.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.abortPlan(agent, args.planId, args.reason)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_abort_ack',
    description: 'As the assigned worker, confirm you stopped an aborted-in-progress plan (aborting → aborted).',
    parameters: {
      planId: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`Plan ${value.planId} acknowledged: ${value.status}.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.abortAck(agent, args.planId)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_status',
    description: 'Read one plan\'s current shared status and history, or every plan in this workspace when planId is omitted.',
    parameters: {
      planId: { type: 'string', description: 'Specific plan; omit to list all plans here.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          detail: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => textOut(value.count === 0 ? 'No plans in this workspace.' : value.detail.join('\n')),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        if (args.planId !== undefined) {
          const plan = await service.getPlan(agent, args.planId)
          return { count: 1, detail: [describePlan(plan)] }
        }
        const plans = await service.listPlans(agent)
        return { count: plans.length, detail: plans.map(describePlan) }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))
}

/** One-line human/model-readable plan digest. */
function describePlan(plan: {
  planId: string
  status: string
  title: string
  assignedWorkerSessionId?: string
  history?: { op: string }[]
}): string {
  const last = plan.history?.at(-1)
  return `${plan.planId} "${plan.title}" — ${plan.status}${plan.assignedWorkerSessionId === undefined ? '' : ` (worker ${plan.assignedWorkerSessionId})`}${last === undefined ? '' : `; last: ${last.op}`}`
}
