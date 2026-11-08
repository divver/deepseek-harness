/**
 * Bundled coop skills: the curated skill set riding this package's `skills/`
 * directory (pstack / superpowers / matt-skills copies plus the self-written
 * `coop-flow` and `coop-help`). Registered as a bundled provider on `ctx.skills`
 * whenever a skill registry is composed in; a deployment without one simply
 * runs coop unskilled.
 * @module @deepseek-ai/dsh-coop/bundled-skills
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'

/** One bundled skill as the registry sees it (structural stand-in for `SkillCandidate`; a
 * type import would drag the optional peer's sources into this program). */
interface BundledSkillCandidate {
  name: string
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: string
  rank: number
  resourceBase: { kind: 'directory'; path: string }
  locator: string
}

/** A loaded bundled skill (structural stand-in for the registry's definition). */
interface BundledSkillDefinition extends Omit<BundledSkillCandidate, 'rank' | 'locator'> {
  path: string
  content: string
}

/** Provider contract (structural stand-in for `SkillProvider`). */
interface BundledSkillProvider {
  name: string
  list: () => Promise<BundledSkillCandidate[]>
  get: (candidate: BundledSkillCandidate, options: { signal?: AbortSignal }) => Promise<BundledSkillDefinition>
}

/** Directory-bundle skill name rule the shared registry validates (`isSkillName`). */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Absolute bundled skills root: `<package>/skills/`, one level above `src/` (dev) and `lib/` (built) alike. */
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

interface ParsedFrontmatter {
  name: string
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  content: string
}

/** Parse one `SKILL.md`: frontmatter name/description/invocation flags plus the body. */
function parseSkill(raw: string, path: string, fallbackName: string): ParsedFrontmatter {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`coop: bundled skill ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const record = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {}
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : fallbackName
  const description = typeof record.description === 'string' && record.description.length > 0 ? record.description : undefined
  if (description === undefined) throw new Error(`coop: bundled skill ${path} has no description`)
  return {
    name,
    description,
    invocation: {
      modelInvocable: record['disable-model-invocation'] !== true,
      userInvocable: record['user-invocable'] !== false,
    },
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

/**
 * Register the bundled coop skills on the skill registry reachable from `ctx`.
 * Failures log a warning and leave coop fully functional without skills.
 * @param ctx - context whose `skills` registry service is live.
 */
export async function registerCoopBundledSkills(ctx: Context): Promise<void> {
  try {
    // The rank standard only exists when the registry package is present; the
    // registry service itself comes from that same package, so this import
    // resolves exactly when registering is possible. The non-literal specifier
    // keeps this optional peer out of this program's static module graph.
    const skillModuleName = '@deepseek-ai/dsh-skill'
    const { BUNDLED_SKILL_RANK } = await import(skillModuleName) as { BUNDLED_SKILL_RANK: number }
    const dirents = await readdir(SKILLS_DIR, { withFileTypes: true })
    const candidates: BundledSkillCandidate[] = []
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue
      const name = dirent.name
      if (!SKILL_NAME_RE.test(name)) continue
      const path = join(SKILLS_DIR, name, 'SKILL.md')
      const parsed = parseSkill(await readFile(path, 'utf8'), path, name)
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        invocation: parsed.invocation,
        provider: 'coop',
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        resourceBase: { kind: 'directory', path: join(SKILLS_DIR, name) },
        locator: path,
      })
    }
    const provider: BundledSkillProvider = {
      name: 'coop',
      list: () => Promise.resolve(candidates),
      async get(candidate, options) {
        const { rank: _rank, locator, ...summary } = candidate
        const raw = await readFile(locator, { encoding: 'utf8', signal: options.signal })
        return { ...summary, path: locator, content: parseSkill(raw, locator, candidate.name).content }
      },
    }
    const registry = (ctx as unknown as { skills: { registerProvider(register: () => BundledSkillProvider): unknown } }).skills
    registry.registerProvider(() => provider)
    ctx.logger.info(`coop: registered ${String(candidates.length)} bundled skills (provider "coop")`)
  } catch (error) {
    ctx.logger.warn(`coop: bundled skills not registered: ${error instanceof Error ? error.message : String(error)}`)
  }
}
