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
      render: (_args, value) => textOut(value.status === 'ready_to_execute'
        ? `Plan ${value.planId} is ready_to_execute — call coop_execute_begin(planId) now, do the work, then coop_execute_report.`
        : `Plan ${value.planId} returned to the master (${value.status}).`),
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

/**
 * Register the v2 coop tools: the node registry (register/list/bind/release)
 * and status. These replace the v1 eleven while `mode: "v2"` is in force;
 * plan/task tooling arrives with later phases.
 * @param ctx - context carrying the tool registry child.
 * @param service - owning coop service performing the transitions.
 */
export function registerCoopV2Tools(ctx: Context, service: CoopService): void {
  const needAgent = (exec: { agent?: NonAgent }): Agent => {
    if (exec.agent === undefined) throw new Error('coop tools require an owning agent session')
    return exec.agent
  }
  const failMessage = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  ctx.tools.register(defineTool({
    name: 'coop_register',
    description: 'Register THIS session as a coop v2 node: master (orchestrate), worker (execute), or reviewer (gate). Empty roles deregister. Workers/reviewers stay unbound until a master binds them.',
    parameters: {
      roles: {
        type: 'array',
        required: true,
        description: 'Roles to hold after this call; empty deregisters.',
        items: { type: 'string', enum: ['master', 'worker', 'reviewer'] },
      },
      masterId: {
        type: 'string',
        description: 'Pre-bind to this master id at registration (workers/reviewers only).',
      },
      model: {
        type: 'string',
        description: 'Model route string recorded on your node for orchestration defaults.',
      },
      skills: {
        type: 'array',
        description: 'Skills this node declares; the scheduler assigns only tasks whose skill demands you cover.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          roles: { type: 'array', items: { type: 'string' }, required: true },
          bindState: { type: 'string' },
          masterId: { type: 'string' },
        },
      },
      render: (_args, value) => textOut(`coop v2 node: ${value.roles.join(', ') || '(none — deregistered)'}${value.masterId === undefined ? '' : ` [${String(value.bindState)} to ${value.masterId}]`}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const entry = await service.registerV2(agent, {
          roles: args.roles,
          ...(args.masterId === undefined ? {} : { masterId: args.masterId }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.skills === undefined ? {} : { skills: args.skills }),
        })
        return {
          roles: entry.roles,
          ...(entry.masterId === undefined ? {} : { bindState: entry.bindState, masterId: String(entry.masterId) }),
        }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Register coop v2 node', kind: 'other', rawInput: args.roles }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_list',
    description: 'List coop v2 nodes visible to you: your own master\'s nodes plus every unbound worker/reviewer.',
    parameters: {
      unbound: { type: 'boolean', description: 'Only show adoptable unbound nodes.' },
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
      render: (_args, value) => textOut(value.count === 0 ? 'No visible coop nodes.' : `${value.count} visible coop node(s):\n${value.detail.join('\n')}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      const entries = await service.listNodesV2(agent, { ...(args.unbound === true ? { unboundOnly: true } : {}) })
      return {
        count: entries.length,
        detail: entries.map(entry => `${entry.sessionId}: ${entry.roles.join('+')} [${entry.bindState}${entry.masterId === undefined ? '' : ` → ${String(entry.masterId)}`}]`),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_bind',
    description: 'Adopt one unbound worker/reviewer node for your master (master only). Binding is exclusive: the node becomes visible to your master alone.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id of the unbound node to adopt.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          bindState: { type: 'string', required: true },
          masterId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(`node ${value.sessionId} bound to ${value.masterId}.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const bound = await service.bindNode(agent, args.sessionId)
        return { sessionId: bound.sessionId, bindState: bound.bindState, masterId: String(bound.masterId) }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Bind coop node', kind: 'other', rawInput: args.sessionId }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_release',
    description: 'Return one bound node to the unbound pool (its owning master only).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id of the bound node to release.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sessionId: { type: 'string', required: true }, released: { type: 'boolean', required: true } },
      },
      render: (_args, value) => textOut(`node ${value.sessionId} released to the unbound pool.`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        await service.releaseNode(agent, args.sessionId)
        return { sessionId: args.sessionId, released: true }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Release coop node', kind: 'other', rawInput: args.sessionId }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_status',
    description: 'Summarize this workspace\'s coop v2 state: your node, live masters, your bound nodes, and the adoptable unbound count.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          self: { type: 'string' },
          masters: { type: 'integer', required: true },
          ownNodes: { type: 'integer', required: true },
          unbound: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textOut(`${value.self ?? 'unregistered'} · masters: ${String(value.masters)} · your nodes: ${String(value.ownNodes)} · unbound: ${String(value.unbound)}`),
    },
    async execute(_args, exec) {
      const agent = needAgent(exec)
      const status = await service.statusV2(agent)
      return {
        ...(status.self === undefined
          ? {}
          : { self: `${status.self.roles.join('+')} [${status.self.bindState}${status.self.masterId === undefined ? '' : ` → ${String(status.self.masterId)}`}]` }),
        masters: status.masters.length,
        ownNodes: status.own.length,
        unbound: status.unbound,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_plan_create',
    description: 'Create a v2 plan (master only): an empty task DAG bound to one repo root, in `designing` status with a markdown trail.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short plan title.' },
      objective: { type: 'string', required: true, description: 'What the plan must achieve and how success is judged.' },
      repoRoot: { type: 'string', description: 'Absolute git repo root this plan is bound to; defaults to the current directory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`plan ${value.planId} created (${value.status})`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.createPlanV2(agent, {
          title: args.title,
          objective: args.objective,
          ...(args.repoRoot === undefined ? {} : { repoRoot: args.repoRoot }),
        })
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Create coop plan', kind: 'other', rawInput: args.title }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_plan_submit_review',
    description: 'Submit a designing plan to review (master only): the plan moves to reviewing and every bound reviewer of your master is woken to judge the DAG against the objective.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan id from coop_plan_create.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`plan ${value.planId} → ${value.status}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.submitReviewV2(agent, args.planId)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_plan_review',
    description: 'Review a submitted plan (reviewer bound to the plan\'s master; the master itself only with allowSelfReview). pass → active (ready tasks schedule); request_changes → back to designing for the master.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan under review.' },
      decision: { type: 'string', required: true, enum: ['pass', 'request_changes'], description: 'Review verdict.' },
      summary: { type: 'string', description: 'One-line rationale.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`plan ${value.planId} → ${value.status}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.reviewPlanV2(agent, args.planId, args.decision,
          args.summary === undefined ? undefined : args.summary)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_execute_touch',
    description: 'Assigned worker heartbeat while executing; a silent heartbeat past the stale window returns the task to rework, so touch periodically during long work.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      taskId: { type: 'string', required: true, description: 'Target task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { touched: { type: 'boolean', required: true } },
      },
      render: (_args, value) => textOut(value.touched ? 'execution heartbeat recorded' : 'not touched'),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        await service.touchExecutionV2(agent, args.planId, args.taskId)
        return { touched: true }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_task_add',
    description: 'Add one task to a non-terminal plan (master only). `dependsOn` lists upstream task ids; a cycle rejects.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      title: { type: 'string', required: true, description: 'Short task title.' },
      spec: { type: 'string', required: true, description: 'Full task brief handed to the assigned worker.' },
      dependsOn: { type: 'array', description: 'Upstream task ids that must be done first.', items: { type: 'string' } },
      executor: { type: 'string', enum: ['inline', 'subagent'], description: 'Executor style; subagent delegates the task spec to a spawned sub-agent.' },
      skills: { type: 'array', description: 'Skills an assigned worker must cover.', items: { type: 'string' } },
      softDeadlineMs: { type: 'integer', description: 'Informational soft deadline in ms from first assignment.' },
      hardDeadlineMs: { type: 'integer', description: 'Hard deadline in ms from first assignment; past due the task blocks.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`task ${value.taskId} added (${value.status})`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const task = await service.addTaskV2(agent, args.planId, {
          title: args.title,
          spec: args.spec,
          ...(args.dependsOn === undefined ? {} : { dependsOn: args.dependsOn }),
          ...(args.executor === undefined ? {} : { executor: args.executor }),
          ...(args.skills === undefined ? {} : { skills: args.skills }),
          ...(args.softDeadlineMs === undefined && args.hardDeadlineMs === undefined
            ? {}
            : {
              deadlines: {
                ...(args.softDeadlineMs === undefined ? {} : { softMs: args.softDeadlineMs }),
                ...(args.hardDeadlineMs === undefined ? {} : { hardMs: args.hardDeadlineMs }),
              },
            }),
        })
        return { taskId: task.taskId, status: task.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Add coop task', kind: 'other', rawInput: args.title }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_task_update',
    description: 'Update a task brief (master only) while it is not executing/reporting/verifying.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      taskId: { type: 'string', required: true, description: 'Target task id.' },
      title: { type: 'string', description: 'New title.' },
      spec: { type: 'string', description: 'New task brief.' },
      executor: { type: 'string', enum: ['inline', 'subagent'], description: 'New executor style.' },
      skills: { type: 'array', description: 'New skill demands.', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`task ${value.taskId} updated (${value.status})`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const task = await service.updateTaskV2(agent, args.planId, args.taskId, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.spec === undefined ? {} : { spec: args.spec }),
          ...(args.executor === undefined ? {} : { executor: args.executor }),
          ...(args.skills === undefined ? {} : { skills: args.skills }),
        })
        return { taskId: task.taskId, status: task.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_task_link',
    description: 'Add one dependency edge to a non-terminal plan (master only): `from` finishing unblocks `to`. Cycles reject; idempotent.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      from: { type: 'string', required: true, description: 'Upstream task id.' },
      to: { type: 'string', required: true, description: 'Downstream task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { linked: { type: 'boolean', required: true } },
      },
      render: (_args, value) => textOut(value.linked ? `edge ${_args.from} → ${_args.to} recorded` : 'edge already present'),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        await service.linkTaskV2(agent, args.planId, { from: args.from, to: args.to })
        return { linked: true }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_task_cancel',
    description: 'Cancel one task of a non-terminal plan (master only); the assignee is signalled and downstream tasks go blocked.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      taskId: { type: 'string', required: true, description: 'Target task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { cancelled: { type: 'boolean', required: true } },
      },
      render: args => textOut(`task ${args.taskId} cancelled`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        await service.cancelTaskV2(agent, args.planId, args.taskId)
        return { cancelled: true }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_board',
    description: 'Kanban view of one plan (or every plan of your master): tasks grouped by status, readiness recomputed.',
    parameters: {
      planId: { type: 'string', description: 'Single plan id; omit for every plan.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plans: { type: 'integer', required: true },
          detail: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => textOut(value.plans === 0 ? 'No plans yet.' : value.detail.join('\n')),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      const plans = await service.boardV2(agent, args.planId)
      const detail: string[] = []
      for (const plan of plans) {
        detail.push(`# ${plan.planId} ${plan.title} [${plan.status}]`)
        const byStatus = new Map<string, string[]>()
        for (const task of plan.tasks) {
          const column = byStatus.get(task.status) ?? []
          column.push(`${task.taskId} ${task.title}${task.assignee === undefined ? '' : ` → ${task.assignee}`}`)
          byStatus.set(task.status, column)
        }
        if (byStatus.size === 0) detail.push('  (no tasks)')
        for (const [status, tasks] of byStatus) detail.push(`  ${status}: ${tasks.join(' · ')}`)
      }
      return { plans: plans.length, detail }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_execute_begin',
    description: 'Assigned worker starts (or restarts after rework) a task: assigned/rework → executing.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      taskId: { type: 'string', required: true, description: 'Target task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`task ${value.taskId} → ${value.status}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const task = await service.executeBeginV2(agent, args.planId, args.taskId)
        return { taskId: task.taskId, status: task.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    description: 'Assigned worker reports finished execution: the task moves to verifying and the master/reviewers are woken.',
    name: 'coop_execute_report',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      taskId: { type: 'string', required: true, description: 'Target task id.' },
      summary: { type: 'string', required: true, description: 'What was done and any notable outcomes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`task ${value.taskId} → ${value.status}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const task = await service.executeReportV2(agent, args.planId, args.taskId, args.summary)
        return { taskId: task.taskId, status: task.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_task_verify',
    description: 'Verify a reported task (reviewer bound to the plan\'s master; the master itself only with allowSelfReview). pass → done; request_changes → rework for the assignee.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Owning plan id.' },
      taskId: { type: 'string', required: true, description: 'Target task id.' },
      decision: { type: 'string', required: true, enum: ['pass', 'request_changes'], description: 'Verification verdict.' },
      summary: { type: 'string', description: 'Acceptance rationale or rework demand.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true }, attempts: { type: 'integer', required: true } },
      },
      render: (_args, value) => textOut(`task ${value.taskId} → ${value.status} (attempts ${String(value.attempts)})`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const task = await service.verifyTaskV2(agent, args.planId, args.taskId, args.decision,
          args.summary === undefined ? undefined : args.summary)
        return { taskId: task.taskId, status: task.status, attempts: task.attempts }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_plan_close',
    description: 'Close a finished plan (master only): every task must be done or cancelled.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan id to close.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`plan ${value.planId} → ${value.status}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.closePlanV2(agent, args.planId)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_plan_abort',
    description: 'Abort a plan (master only): every open task is cancelled, in-flight assignees are signalled to stop, and the plan lands aborted.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan id to abort.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { planId: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`plan ${value.planId} → ${value.status}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const plan = await service.abortPlanV2(agent, args.planId)
        return { planId: plan.planId, status: plan.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_worktree_create',
    description: 'Create a git worktree for a plan (master only) under <workspace>/wt/<masterId>/; the name is unique per master and the occupancy row rides the global wt-registry lock. Defaults: base = the repo HEAD, branch = coop/<masterId>/<seq>-<slug>.',
    parameters: {
      planId: { type: 'string', required: true, description: 'Plan the worktree serves.' },
      from: { type: 'string', description: 'Base ref (branch or HEAD); default HEAD of the plan repo.' },
      branch: { type: 'string', description: 'Branch to check out in the worktree; default coop/<masterId>/<seq>-<slug>.' },
      purpose: { type: 'string', description: 'Short purpose slug used in the directory and branch name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          baseBranch: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(`worktree ${value.dir} on ${value.branch} (base ${value.baseBranch}, ${value.status})`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const entry = await service.createWorktreeV2(agent, args.planId, {
          ...(args.from === undefined ? {} : { from: args.from }),
          ...(args.branch === undefined ? {} : { branch: args.branch }),
          ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
        })
        return { dir: entry.dir, branch: entry.branch, baseBranch: entry.baseBranch, status: entry.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Create coop worktree', kind: 'other', rawInput: args.planId }),
  }))

  ctx.tools.register(defineTool({
    name: 'coop_worktree_list',
    description: 'List your worktree occupancy rows (optionally narrowed to one plan) with their status: active, merged, or cleaned.',
    parameters: {
      planId: { type: 'string', description: 'Optional plan filter.' },
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
      render: (_args, value) => textOut(value.count === 0 ? 'No worktrees.' : `${value.count} worktree(s):\n${value.detail.join('\n')}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      const entries = await service.listWorktreesV2(agent, args.planId)
      return {
        count: entries.length,
        detail: entries.map(entry => `${entry.dir} [${entry.status}] ${entry.branch} ← ${entry.baseBranch} (${entry.planId})`),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_worktree_merge',
    description: 'Merge one active worktree back into its base branch (git merge --no-ff, master only). Conflicts abort and fail loud — resolve manually or send the task to rework.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Worktree directory from coop_worktree_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { dir: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => textOut(`worktree ${value.dir} → ${value.status}`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        const entry = await service.mergeWorktreeV2(agent, args.dir)
        return { dir: entry.dir, status: entry.status }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coop_worktree_clean',
    description: 'Remove one worktree (git worktree remove, master only) and mark its occupancy row cleaned; pass force to discard local modifications.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Worktree directory from coop_worktree_list.' },
      force: { type: 'boolean', description: 'Discard local modifications.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { dir: { type: 'string', required: true }, cleaned: { type: 'boolean', required: true } },
      },
      render: (_args, value) => textOut(`worktree ${value.dir} removed`),
    },
    async execute(args, exec) {
      const agent = needAgent(exec)
      try {
        await service.cleanWorktreeV2(agent, args.dir, { ...(args.force === true ? { force: true } : {}) })
        return { dir: args.dir, cleaned: true }
      } catch (error) {
        throw new Error(failMessage(error))
      }
    },
  }))
}
