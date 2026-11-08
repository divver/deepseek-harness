import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import CoopService, { bundledSkillsPlugin } from '../src/index.ts'
import { registerCoopBundledSkills } from '../src/bundled-skills.ts'

interface CapturedProvider {
  name: string
  list: () => Promise<Array<{ name: string; description: string; invocation: { modelInvocable: boolean; userInvocable: boolean } }>>
  get: (candidate: { name: string }, options?: { signal?: AbortSignal }) => Promise<{ name: string; content: string }>
}

/**
 * Bundled-skill provider suite: every vendored directory parses into a
 * candidate with a description, invocation policy follows frontmatter, and
 * bodies load through `get`.
 */

describe('bundled skills', () => {
  it('registers the curated set with correct invocation policies', async () => {
    let registered: CapturedProvider | undefined
    const warns: string[] = []
    const ctx = {
      logger: { info: () => undefined, warn: (text: string) => warns.push(text) },
      skills: { registerProvider: (register: () => CapturedProvider) => { registered = register() } },
    }
    await registerCoopBundledSkills(ctx as never)
    expect(warns).toEqual([])
    expect(registered).toBeDefined()
    const candidates = await registered!.list()
    const names = candidates.map(candidate => candidate.name).sort()
    // pstack body + superpowers/matt picks + the two self-written skills.
    for (const expected of [
      'architect', 'benchmark-checklist', 'blast-radius', 'brainstorming', 'coop-flow', 'coop-help',
      'diagnosing-bugs', 'figure-it-out', 'grilling', 'handoff', 'how', 'interrogate', 'ketchup',
      'no-comments', 'recall', 'reflect', 'sharpen', 'systematic-debugging', 'tdd',
      'typescript-best-practices', 'unslop', 'why',
    ]) {
      expect(names, `bundled skills: ${names.join(', ')}`).toContain(expected)
    }
    expect(candidates.length).toBeGreaterThanOrEqual(20)
    for (const candidate of candidates) {
      expect(candidate.description.length, `${candidate.name} description`).toBeGreaterThan(0)
    }
    const byName = new Map(candidates.map(candidate => [candidate.name, candidate]))
    expect(byName.get('coop-help')?.invocation.modelInvocable).toBe(false)
    expect(byName.get('tdd')?.invocation.modelInvocable).toBe(true)
    expect(byName.get('interrogate')?.invocation.modelInvocable).toBe(true)
    expect(byName.get('architect')?.invocation.modelInvocable).toBe(false)
  })

  it('loads a body through get', async () => {
    let registered: CapturedProvider | undefined
    const ctx = {
      logger: { info: () => undefined, warn: () => undefined },
      skills: { registerProvider: (register: () => CapturedProvider) => { registered = register() } },
    }
    await registerCoopBundledSkills(ctx as never)
    const candidates = await registered!.list()
    const flow = candidates.find(candidate => candidate.name === 'coop-flow')
    expect(flow).toBeDefined()
    const loaded = await registered!.get(flow!, {})
    expect(loaded.name).toBe('coop-flow')
    expect(loaded.content).toContain('six-step')
  })

  it('is fail-soft without the registry package', async () => {
    const warns: string[] = []
    const ctx = {
      logger: { info: () => undefined, warn: (text: string) => warns.push(text) },
    }
    // No ctx.skills: the dynamic registry import fails and the helper warns instead of throwing.
    await expect(registerCoopBundledSkills(ctx as never)).resolves.toBeUndefined()
    expect(warns.length).toBe(1)
  })

  it('surfaces the bundled set through the standalone plugin row (TUI path)', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(bundledSkillsPlugin as unknown as { apply: (ctx: Context) => void })
      for (let attempt = 0; attempt < 20; attempt++) {
        const catalog = await ctx.skills.list()
        if (catalog.length >= 20) {
          expect(catalog.map(skill => skill.name)).toContain('coop-help')
          return
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect((await ctx.skills.list()).map(skill => skill.name).join(',')).toContain('coop-help')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces the bundled set through a real skill registry when coop mounts', async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(CoopService, { mode: 'v2' })
      for (let attempt = 0; attempt < 20; attempt++) {
        const catalog = await ctx.skills.list()
        if (catalog.length >= 20) {
          expect(catalog.map(skill => skill.name)).toContain('coop-flow')
          expect(catalog.every(skill => skill.provider === 'coop' || skill.provider === 'runtime')).toBe(true)
          return
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name).join(','), 'bundled skills through the real registry').toContain('coop-flow')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
