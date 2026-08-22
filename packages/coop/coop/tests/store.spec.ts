import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendDocSection,
  appendSignal,
  advanceConsumed,
  compactSignals,
  consumedPath,
  inboxPath,
  mutatePlan,
  mutateRegistry,
  readConsumed,
  readPlanFile,
  readRegistryFile,
  readSignals,
  registryPath,
  removeEntry,
  touchHeartbeat,
  writePlanFile,
} from '../src/index.ts'
import type { CoopPlanFile, CoopRegistryEntry } from '../src/index.ts'

/** File-store behavior suite: locks give way to plain sequencing here because
 * every claim under test is about content, not concurrency windows. */

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-coop-store-'))
}

const entry = (sessionId: string, roles: string[] = ['worker']): CoopRegistryEntry => ({
  sessionId,
  roles: roles as CoopRegistryEntry['roles'],
  updatedAt: 1,
  heartbeatAt: Date.now(),
  cwd: '/tmp/w',
  cwdScope: 'cwd',
})

describe('registry table', () => {
  it('reads absent tables as undefined and persists registrations', async () => {
    const root = await workspace()
    const path = registryPath(root)
    expect(await readRegistryFile(path)).toBeUndefined()
    await mutateRegistry(path, () => ({ version: 1, entries: [] }))
    await mutateRegistry(path, current => ({
      version: 1,
      entries: [...current?.entries ?? [], entry('s1')],
    }))
    const table = await readRegistryFile(path)
    expect(table?.version).toBe(1)
    expect(table?.entries.map(candidate => candidate.sessionId)).toEqual(['s1'])
  })

  it('removes entries and touches heartbeats in place', async () => {
    const root = await workspace()
    const path = registryPath(root)
    await mutateRegistry(path, () => ({ version: 1, entries: [entry('a'), entry('b')] }))
    await touchHeartbeat(path, 'b', 1234567890)
    let table = await readRegistryFile(path)
    expect(table?.entries.find(candidate => candidate.sessionId === 'b')?.heartbeatAt).toBe(1234567890)
    await removeEntry(path, 'a')
    table = await readRegistryFile(path)
    expect(table?.entries.map(candidate => candidate.sessionId)).toEqual(['b'])
  })
})

describe('plans', () => {
  it('commits transitions under mutation and skips rewriting unchanged state', async () => {
    const root = await workspace()
    const path = join(root, 'p1.json')
    const base: CoopPlanFile = {
      version: 1,
      planId: 'plan-x' as CoopPlanFile['planId'],
      docPath: join(root, 'docs', 'plan-x.md'),
      title: 't',
      objective: 'o',
      status: 'draft',
      createdBy: 'm',
      cwd: '/tmp/w',
      reviewLevel: 'standard',
      history: [],
    }
    const created = await mutatePlan(path, current => current ?? base)
    expect(created.status).toBe('draft')
    const first = await readFile(path, 'utf8')
    await mutatePlan(path, current => current ?? base)
    expect(await readFile(path, 'utf8')).toBe(first)
    await writePlanFile(path, { ...base, status: 'pending_pre_review' })
    expect((await readPlanFile(path))?.status).toBe('pending_pre_review')
  })
})

describe('inbox signals', () => {
  it('assigns monotonic seq numbers across appends', async () => {
    const root = await workspace()
    const path = inboxPath(root, 'w1')
    const first = await appendSignal(path, { time: 1, from: 'm', planId: 'p', kind: 'notify', summary: 'a', docPath: 'd' })
    const second = await appendSignal(path, { time: 2, from: 'm', planId: 'p', kind: 'abort', summary: 'b', docPath: 'd' })
    expect([first.seq, second.seq]).toEqual([1, 2])
  })

  it('delivers only above the watermark and advances monotonically', async () => {
    const root = await workspace()
    const path = inboxPath(root, 'w1')
    const watermark = consumedPath(root, 'w1')
    expect(await readConsumed(watermark)).toBe(0)
    await appendSignal(path, { time: 1, from: 'm', planId: 'p', kind: 'notify', summary: 'a', docPath: 'd' })
    await appendSignal(path, { time: 2, from: 'm', planId: 'p', kind: 'verify', summary: 'b', docPath: 'd' })
    expect((await readSignals(path, watermark)).entries.map(line => line.seq)).toEqual([1, 2])
    await advanceConsumed(watermark, 1)
    expect((await readSignals(path, watermark)).entries.map(line => line.seq)).toEqual([2])
    await advanceConsumed(watermark, 0)
    expect(await readConsumed(watermark)).toBe(1)
    expect((await readSignals(path, watermark)).maxSeq).toBe(2)
  })

  it('compacts delivered lines and preserves undelivered ones', async () => {
    const root = await workspace()
    const path = inboxPath(root, 'w1')
    const watermark = consumedPath(root, 'w1')
    for (const summary of ['a', 'b', 'c']) {
      await appendSignal(path, { time: 1, from: 'm', planId: 'p', kind: 'notify', summary, docPath: 'd' })
    }
    await advanceConsumed(watermark, 2)
    await compactSignals(path, watermark, 3)
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('"seq":1')
    expect(raw).toContain('"seq":3')
    expect((await readSignals(path, watermark)).entries.map(line => line.seq)).toEqual([3])
  })

  it('leaves files below the compaction threshold untouched', async () => {
    const root = await workspace()
    const path = inboxPath(root, 'w2')
    const watermark = consumedPath(root, 'w2')
    await appendSignal(path, { time: 1, from: 'm', planId: 'p', kind: 'notify', summary: 'a', docPath: 'd' })
    await advanceConsumed(watermark, 1)
    await compactSignals(path, watermark, 10)
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
  })
})

describe('markdown documents', () => {
  it('creates on first append and glues later sections', async () => {
    const root = await workspace()
    const docPath = join(root, 'docs', 'plan.md')
    await appendDocSection(docPath, '# Title\n')
    await appendDocSection(docPath, '## Section\n')
    const raw = await readFile(docPath, 'utf8')
    expect(raw.startsWith('# Title\n')).toBe(true)
    expect(raw.endsWith('\n## Section\n')).toBe(true)
  })
})
