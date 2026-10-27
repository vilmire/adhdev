import * as fs from 'fs';
import * as path from 'path';
import { resolveInstanceConfigDir, assertTestStorageIsolated } from '@adhdev/session-host-core';
import type { SessionBufferSnapshot, SessionHostRecord, SessionTermination } from '@adhdev/session-host-core';

export interface PersistedRuntimeState {
  record: SessionHostRecord;
  snapshot: SessionBufferSnapshot;
  updatedAt: number;
}

/** Persisted-form marker: `meta.cliArgs` stored as a window into `launchCommand.args`. */
export interface PersistedCliArgsRef {
  offset: number;
  length: number;
}

/**
 * Tail kept of a non-live (stopped/failed/terminated) session's scrollback on
 * disk. Live sessions keep the whole ring buffer (their snapshot is the
 * recovery payload); a dead session's output is display-only history.
 */
export const DEAD_SESSION_SNAPSHOT_MAX_CHARS = 64 * 1024;

function findSubsequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Launch arguments live in the record twice: `launchCommand.args` (full spawn
 * argv) and `meta.cliArgs` (the caller's requested args, which the spawn argv
 * contains). On disk, keep the argv only and store `meta.cliArgs` as a window
 * (`meta.cliArgsRef`). When the window cannot be derived, cliArgs stays inline.
 */
export function compactRecordForPersist(record: SessionHostRecord): SessionHostRecord {
  const cliArgs = record.meta?.cliArgs;
  const argv = record.launchCommand?.args;
  if (!Array.isArray(cliArgs) || cliArgs.length === 0 || !Array.isArray(argv)) return record;
  if (!cliArgs.every((a) => typeof a === 'string')) return record;
  const offset = findSubsequence(argv, cliArgs as string[]);
  if (offset < 0) return record;
  const { cliArgs: _drop, ...meta } = record.meta;
  return { ...record, meta: { ...meta, cliArgsRef: { offset, length: cliArgs.length } satisfies PersistedCliArgsRef } };
}

/** Inverse of compactRecordForPersist; records in the old inline format pass through unchanged. */
export function expandPersistedRecord(record: SessionHostRecord): SessionHostRecord {
  const ref = record.meta?.cliArgsRef as PersistedCliArgsRef | undefined;
  if (!ref || typeof ref !== 'object') return record;
  const { cliArgsRef: _ref, ...meta } = record.meta;
  const argv = record.launchCommand?.args;
  const valid = Array.isArray(argv) && Number.isInteger(ref.offset) && Number.isInteger(ref.length)
    && ref.offset >= 0 && ref.length >= 0 && ref.offset + ref.length <= argv.length;
  if (Array.isArray(meta.cliArgs) || !valid) return { ...record, meta };
  return { ...record, meta: { ...meta, cliArgs: argv.slice(ref.offset, ref.offset + ref.length) } };
}

/** Bound what a dead session keeps on disk; live and freshly orphan-recovered records keep everything. */
export function pruneSnapshotForPersist(record: SessionHostRecord, snapshot: SessionBufferSnapshot): SessionBufferSnapshot {
  const dead = !!record.termination || record.lifecycle === 'stopped' || record.lifecycle === 'failed';
  if (!dead || record.meta?.runtimeRecoveryState === 'orphan_snapshot') return snapshot;
  const text = typeof snapshot?.text === 'string' ? snapshot.text : '';
  if (text.length <= DEAD_SESSION_SNAPSHOT_MAX_CHARS) return snapshot;
  let tail = text.slice(text.length - DEAD_SESSION_SNAPSHOT_MAX_CHARS);
  // Do not start on a lone low surrogate.
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return { ...snapshot, text: tail, truncated: true };
}

export interface PersistedTombstone {
  sessionId: string;
  termination: SessionTermination;
  updatedAt: number;
}

interface SessionHostStorageOptions {
  appName?: string;
  /**
   * Explicit storage root (the instance's session-host state dir). Defaults to
   * `<instanceConfigDir>/session-host/<appName>` — derived from
   * ADHDEV_CONFIG_DIR so each daemon instance persists its own runtime records
   * and tombstones. The default instance resolves to `<home>/.adhdev`,
   * byte-identical to the pre-instance layout.
   */
  rootDir?: string;
}

export class SessionHostStorage {
  private readonly rootDir: string;
  private readonly runtimesDir: string;
  private readonly tombstonesDir: string;

  constructor(options: SessionHostStorageOptions = {}) {
    const appName = options.appName || 'adhdev';
    this.rootDir = options.rootDir
      || path.join(resolveInstanceConfigDir(process.env), 'session-host', appName);
    assertTestStorageIsolated(this.rootDir);
    this.runtimesDir = path.join(this.rootDir, 'runtimes');
    this.tombstonesDir = path.join(this.rootDir, 'tombstones');
  }

  /** Unknown/corrupt recovery files also veto idle admission; reads names only. */
  hasRuntimeEntries(): boolean {
    if (!fs.existsSync(this.runtimesDir)) return false;
    const stat = fs.lstatSync(this.runtimesDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('native_host_runtime_storage_untrusted');
    return fs.readdirSync(this.runtimesDir).length > 0;
  }

  loadAll(): PersistedRuntimeState[] {
    if (!fs.existsSync(this.runtimesDir)) return [];
    const entries = fs.readdirSync(this.runtimesDir, { withFileTypes: true });
    const states: PersistedRuntimeState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(this.runtimesDir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as PersistedRuntimeState;
        if (parsed?.record?.sessionId) {
          states.push({ ...parsed, record: expandPersistedRecord(parsed.record) });
        }
      } catch {
        // Ignore malformed snapshots; host should still boot.
      }
    }
    return states.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  save(record: SessionHostRecord, snapshot: SessionBufferSnapshot): void {
    fs.mkdirSync(this.runtimesDir, { recursive: true });
    const filePath = path.join(this.runtimesDir, `${record.sessionId}.json`);
    const payload: PersistedRuntimeState = {
      record: compactRecordForPersist(record),
      snapshot: pruneSnapshotForPersist(record, snapshot),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  }

  remove(sessionId: string): void {
    const filePath = path.join(this.runtimesDir, `${sessionId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File may not exist — ignore.
    }
  }

  /**
   * Persist a compact termination tombstone. Kept in a separate directory from
   * live runtimes so it survives the post-exit cleanup of the runtime file and
   * remains inspectable for post-mortem diagnostics.
   */
  saveTombstone(sessionId: string, termination: SessionTermination): void {
    fs.mkdirSync(this.tombstonesDir, { recursive: true });
    const filePath = path.join(this.tombstonesDir, `${sessionId}.json`);
    const payload: PersistedTombstone = {
      sessionId,
      termination,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  loadTombstone(sessionId: string): PersistedTombstone | null {
    const filePath = path.join(this.tombstonesDir, `${sessionId}.json`);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedTombstone;
      return parsed?.sessionId ? parsed : null;
    } catch {
      return null;
    }
  }

  loadAllTombstones(): PersistedTombstone[] {
    if (!fs.existsSync(this.tombstonesDir)) return [];
    const entries = fs.readdirSync(this.tombstonesDir, { withFileTypes: true });
    const states: PersistedTombstone[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fullPath = path.join(this.tombstonesDir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as PersistedTombstone;
        if (parsed?.sessionId) states.push(parsed);
      } catch {
        // Ignore malformed tombstones.
      }
    }
    return states.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  removeTombstone(sessionId: string): void {
    const filePath = path.join(this.tombstonesDir, `${sessionId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File may not exist — ignore.
    }
  }
}
