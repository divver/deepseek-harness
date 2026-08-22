/**
 * File-store layer for the workspace-shared coop authority. Every mutation of
 * `registry.json` / `plans/<planId>.json` runs inside a `withFileLock` cycle so
 * the read-validate-commit sequence cannot resurrect a state another process
 * just replaced; inbox signal lines are seq-assigned and atomically rewritten
 * under their own lock, while the consumer-side watermark file is written only
 * by the consuming session, so append and consume never contend on one file.
 * @module @deepseek-ai/dsh-coop/store
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { CoopInboxEntry, CoopPlanFile, CoopRegistryEntry, CoopRegistryFile } from './types.ts'

/** Whether one caught read failure is the plain absence of the file. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Coop shared files hold cross-session workflow state; keep them user-private. */
const FILE_MODE = 0o600
/** Parent directories this store creates stay owner-only. */
const DIR_MODE = 0o700

/**
 * The per-workspace registry path.
 * @param root - absolute coop root (`<cwd>/.dsh/coop`).
 * @returns the registry file path.
 */
export function registryPath(root: string): string {
  return join(root, 'registry.json')
}

/**
 * The global any-scope registry path.
 * @param home - resolved harness home.
 * @returns the global registry file path.
 */
export function globalRegistryPath(home: string): string {
  return join(home, 'coop', 'registry.json')
}

/**
 * Read one registry table.
 * @param path - registry file path.
 * @returns the parsed table, or `undefined` when absent.
 * @throws when the file exists but is not a version-1 registry table.
 */
export async function readRegistryFile(path: string): Promise<CoopRegistryFile | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  // Corrupt on-disk state must fail loud here, so parse through a partial view
  // that keeps the version/entries comparisons meaningful.
  const parsed = JSON.parse(raw) as Partial<CoopRegistryFile> & Record<string, unknown>
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`coop registry at ${path} is not a version-1 registry table`)
  }
  return parsed as CoopRegistryFile
}

/**
 * Atomically replace one registry table's content.
 * @param path - registry file path.
 * @param file - complete next table.
 */
export async function writeRegistryFile(path: string, file: CoopRegistryFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/**
 * Run one read-modify-write cycle over a registry table under the writer lock.
 * The mutator sees the current table (or `undefined` when absent) and returns
 * the complete replacement; returning `undefined` leaves the file untouched.
 * @param path - registry file path.
 * @param mutate - pure transition over the current table.
 */
export async function mutateRegistry(
  path: string,
  mutate: (current: CoopRegistryFile | undefined) => CoopRegistryFile | undefined,
): Promise<void> {
  await withFileLock(path, async () => {
    const next = mutate(await readRegistryFile(path))
    if (next !== undefined) await writeRegistryFile(path, next)
  })
}

/**
 * Register or update one entry in both its local and any-scope tables. The
 * conflict predicate runs under the local writer lock against every visible
 * candidate entry, so the master singleton check shares one lock with the
 * write and no cross-process registration window exists. Any-scope writes to
 * the global table happen before the local commit; a crash between them
 * leaves only an unregistered global row that heartbeat staleness reclaims.
 * @param args.localPath - the workspace-local registry file.
 * @param args.globalPath - the global any-scope registry file, when the entry is any-scope.
 * @param args.entry - the complete entry to persist.
 * @param args.conflictsWith - whether another live entry blocks this registration.
 * @throws when `conflictsWith` matches a visible entry (the caller maps this to `COOP_MASTER_ALREADY_EXISTS`).
 */
export async function registerEntry(args: {
  localPath: string
  globalPath?: string
  entry: CoopRegistryEntry
  conflictsWith: (candidate: CoopRegistryEntry) => boolean
}): Promise<void> {
  if (args.globalPath !== undefined) {
    await mutateRegistry(args.globalPath, current => upsertEntry(current, args.entry))
  }
  await mutateRegistry(args.localPath, (current) => {
    for (const candidate of visibleEntries(current, args.entry.cwd)) {
      if (candidate.sessionId !== args.entry.sessionId && args.conflictsWith(candidate)) {
        throw new Error(`master role already held by session "${candidate.sessionId}"`)
      }
    }
    return upsertEntry(current, args.entry)
  })
}

/**
 * Entries from one table visible to a workspace: same cwd, or any-scope.
 * @param current - table to scan, or `undefined`.
 * @param cwd - normalized workspace of the caller.
 * @returns the matching entries.
 */
function visibleEntries(current: CoopRegistryFile | undefined, cwd: string): CoopRegistryEntry[] {
  return (current?.entries ?? []).filter(entry => entry.cwd === cwd || entry.cwdScope === 'any')
}

/** Insert or replace by sessionId, preserving array shape. */
function upsertEntry(current: CoopRegistryFile | undefined, entry: CoopRegistryEntry): CoopRegistryFile {
  const entries = (current?.entries ?? []).filter(candidate => candidate.sessionId !== entry.sessionId)
  entries.push(entry)
  return { version: 1, entries }
}

/**
 * Remove one session's entries from a table.
 * @param path - registry file path.
 * @param sessionId - leaving session.
 */
export async function removeEntry(path: string, sessionId: string): Promise<void> {
  await mutateRegistry(path, current => current === undefined
    ? undefined
    : { version: 1, entries: current.entries.filter(entry => entry.sessionId !== sessionId) })
}

/**
 * Touch one session's heartbeat without disturbing other fields.
 * @param path - registry file path.
 * @param sessionId - owning session.
 * @param now - epoch ms to stamp.
 */
export async function touchHeartbeat(path: string, sessionId: string, now: number): Promise<void> {
  await mutateRegistry(path, (current) => {
    if (current === undefined) return undefined
    for (const entry of current.entries) {
      if (entry.sessionId === sessionId) entry.heartbeatAt = now
    }
    return current
  })
}

/**
 * The authoritative plan file path for one plan id.
 * @param root - absolute coop root.
 * @param planId - branded plan id.
 * @returns the plan JSON path.
 */
export function planPath(root: string, planId: string): string {
  return join(root, 'plans', `${planId}.json`)
}

/**
 * Read one plan file.
 * @param path - plan JSON path.
 * @returns the parsed plan, or `undefined` when absent.
 * @throws when the file exists but is not a version-1 plan.
 */
export async function readPlanFile(path: string): Promise<CoopPlanFile | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<CoopPlanFile> & Record<string, unknown>
  if (parsed.version !== 1 || typeof parsed.planId !== 'string' || typeof parsed.status !== 'string') {
    throw new Error(`coop plan at ${path} is not a version-1 plan file`)
  }
  return parsed as CoopPlanFile
}

/**
 * Atomically replace one plan file.
 * @param path - plan JSON path.
 * @param plan - complete next plan state.
 */
export async function writePlanFile(path: string, plan: CoopPlanFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/**
 * Run one read-modify-write cycle over a plan under the plan writer lock. The
 * whole status transition — validation against the current status included —
 * happens inside the callback, so model-visible callers never observe or race
 * an intermediate state and never need a retry instruction. When the callback
 * returns its input unchanged (lazy watchdog found nothing to do) the file is
 * not rewritten.
 * @param path - plan JSON path.
 * @param mutate - transition receiving the current plan (or `undefined`); returns the replacement.
 * @returns the plan the callback committed.
 */
export async function mutatePlan(
  path: string,
  mutate: (current: CoopPlanFile | undefined) => CoopPlanFile,
): Promise<CoopPlanFile> {
  return withFileLock(path, async () => {
    const current = await readPlanFile(path)
    const next = mutate(current)
    if (next !== current) await writePlanFile(path, next)
    return next
  })
}

/**
 * The inbox signal file for one target session.
 * @param root - absolute coop root.
 * @param sessionId - receiving session.
 * @returns the jsonl signal file path.
 */
export function inboxPath(root: string, sessionId: string): string {
  return join(root, 'inbox', `${sessionId}.jsonl`)
}

/**
 * The consumer watermark file for one target session. Written only by the
 * consuming session after delivery, so producers appending signals never
 * contend with watermark advances.
 * @param root - absolute coop root.
 * @param sessionId - receiving session.
 * @returns the watermark path.
 */
export function consumedPath(root: string, sessionId: string): string {
  return join(root, 'inbox', '.consumed', sessionId)
}

/** Parse one jsonl signal file body into entries; blank trailing lines are ignored. */
function parseSignals(raw: string): CoopInboxEntry[] {
  return raw.split('\n').flatMap(line => line.trim().length === 0 ? [] : [JSON.parse(line) as CoopInboxEntry])
}

/**
 * Append one signal line, assigning the monotonic `seq` under the inbox
 * writer lock. The whole file is rewritten atomically so a concurrent reader
 * never observes a torn line.
 * @param path - inbox signal file path.
 * @param entry - signal content without its `seq`.
 * @returns the stored entry including the assigned `seq`.
 */
export async function appendSignal(path: string, entry: Omit<CoopInboxEntry, 'seq'>): Promise<CoopInboxEntry> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  return withFileLock(path, async () => {
    let lines: CoopInboxEntry[] = []
    try {
      lines = parseSignals(await readFile(path, 'utf8'))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const last = lines.at(-1)
    const stored: CoopInboxEntry = { ...entry, seq: (last?.seq ?? 0) + 1 }
    lines.push(stored)
    await writeFileAtomic(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n', { mode: FILE_MODE })
    return stored
  })
}

/**
 * Read undelivered signals: every line above the consumer watermark.
 * @param path - inbox signal file path.
 * @param watermarkPath - consumer watermark path.
 * @returns the undelivered entries plus the file's maximum seq.
 */
export async function readSignals(path: string, watermarkPath: string): Promise<{ entries: CoopInboxEntry[]; maxSeq: number }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { entries: [], maxSeq: 0 }
    throw error
  }
  const consumed = await readConsumed(watermarkPath)
  const lines = parseSignals(raw)
  return {
    entries: lines.filter(line => line.seq > consumed),
    maxSeq: lines.at(-1)?.seq ?? 0,
  }
}

/**
 * Read the consumer watermark.
 * @param watermarkPath - consumer watermark path.
 * @returns the highest delivered seq, or `0`.
 */
export async function readConsumed(watermarkPath: string): Promise<number> {
  try {
    const value = Number.parseInt(await readFile(watermarkPath, 'utf8'), 10)
    return Number.isSafeInteger(value) && value > 0 ? value : 0
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
}

/**
 * Advance the consumer watermark to `seq`. Lower or equal values are ignored:
 * deliveries may complete out of order, and the watermark must never move back.
 * @param watermarkPath - consumer watermark path.
 * @param seq - highest seq fully delivered.
 */
export async function advanceConsumed(watermarkPath: string, seq: number): Promise<void> {
  const current = await readConsumed(watermarkPath)
  if (seq <= current) return
  await writeFileAtomic(watermarkPath, `${seq}\n`, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/**
 * Drop delivered signal lines once the file grows past `threshold` and the
 * watermark has moved onto the last line. Undelivered lines are preserved.
 * @param path - inbox signal file path.
 * @param watermarkPath - consumer watermark path.
 * @param threshold - minimum line count before compaction applies.
 */
export async function compactSignals(path: string, watermarkPath: string, threshold: number): Promise<void> {
  await withFileLock(path, async () => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    const lines = parseSignals(raw)
    const consumed = await readConsumed(watermarkPath)
    const kept = lines.filter(line => line.seq > consumed)
    if (lines.length < threshold || kept.length === lines.length) return
    await writeFileAtomic(path, kept.map(line => JSON.stringify(line)).join('\n') + '\n', { mode: FILE_MODE })
  })
}

/**
 * Append one markdown section under the document writer lock, creating parent
 * directories and the file itself on first append.
 * @param docPath - absolute markdown document path.
 * @param text - complete section text ending in a newline.
 */
export async function appendDocSection(docPath: string, text: string): Promise<void> {
  await mkdir(dirname(docPath), { recursive: true, mode: DIR_MODE })
  await withFileLock(docPath, async () => {
    let existing = ''
    try {
      existing = await readFile(docPath, 'utf8')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const glue = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    await writeFileAtomic(docPath, existing + glue + text, { mode: FILE_MODE })
  })
}
