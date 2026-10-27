import * as fs from 'fs';
import * as path from 'path';
import { resolveInstanceConfigDir, assertTestStorageIsolated, classifyTermination } from '@adhdev/session-host-core';
import type { SessionBufferSnapshot, SessionHostRecord, SessionTermination } from '@adhdev/session-host-core';

export interface PersistedRuntimeState {
  record: SessionHostRecord;
  snapshot: SessionBufferSnapshot;
  updatedAt: number;
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
          states.push(parsed);
        }
      } catch {
        // Ignore malformed snapshots; host should still boot.
      }
    }
    return states.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** Exhaustive recovery inventory: ordinary boot's tolerant reader is not
   * evidence. Unknown names, symlinks and malformed records veto completeness. */
  recoveryInventory(): { complete: boolean; states: PersistedRuntimeState[]; tombstones: PersistedTombstone[] } {
    const incomplete = () => ({ complete: false, states: [], tombstones: [] });
    try {
      const states = this.readRecoveryDirectory(this.runtimesDir) as PersistedRuntimeState[];
      const tombstones = this.readRecoveryDirectory(this.tombstonesDir) as PersistedTombstone[];
      for (const parsed of states) {
        if (!parsed?.record?.launchCommand || !Array.isArray(parsed.record.launchCommand.args) ||
            !parsed.record.meta || !Number.isFinite(parsed.updatedAt) || !parsed.snapshot) return incomplete();
      }
      for (const parsed of tombstones) {
        const t = parsed?.termination;
        const nullableInteger = (n: unknown) => n === null || Number.isInteger(n);
        if (!Number.isFinite(parsed.updatedAt) || !t || !Number.isFinite(t.terminatedAt) ||
            !nullableInteger(t.exitCode) || !nullableInteger(t.signal) || (t.signal !== null && t.signal < 0) ||
            !['exit','signal','failed','unknown'].includes(t.reason) || !['stopped','failed'].includes(t.lifecycle) ||
            (t.osPid !== undefined && (!Number.isInteger(t.osPid) || t.osPid <= 0))) return incomplete();
        // Unknown observations remain unknown; a terminal label is not native
        // descendant/handle proof. Refuse contradictory persisted diagnostics.
        const classified = classifyTermination(t);
        if (classified.reason !== t.reason || classified.lifecycle !== t.lifecycle ||
            (t.lastOutputAt !== undefined && !Number.isFinite(t.lastOutputAt)) ||
            (t.previousLifecycle !== undefined && !['starting','running','stopping','stopped','failed','interrupted'].includes(t.previousLifecycle)) ||
            (t.requestedStop !== undefined && !['stop','delete','restart','prune'].includes(t.requestedStop))) return incomplete();
      }
      return { complete: true, states, tombstones };
    } catch { return incomplete(); }
  }

  private readRecoveryDirectory(dirPath: string): unknown[] {
    let dir: fs.Stats;
    try { dir = fs.lstatSync(dirPath); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('recovery_directory_untrusted');
    const result: unknown[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-z0-9_-]+\.json$/.test(entry.name)) throw new Error('recovery_entry_untrusted');
      const full = path.join(dirPath, entry.name);
      const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw new Error('recovery_inode_untrusted');
        const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
        const after = fs.fstatSync(fd, { bigint: true });
        const current = fs.lstatSync(full, { bigint: true });
        const identity = (s: typeof before) => [s.dev,s.ino,s.ctimeNs,s.mtimeNs,s.size].join(':');
        if (identity(before) !== identity(after) || identity(after) !== identity(current) || current.isSymbolicLink()) throw new Error('recovery_entry_changed');
        const id = dirPath === this.runtimesDir ? parsed?.record?.sessionId : parsed?.sessionId;
        if (typeof id !== 'string' || !id || `${id}.json` !== entry.name) throw new Error('recovery_entry_name_mismatch');
        result.push(parsed);
      } finally { fs.closeSync(fd); }
    }
    const afterDir = fs.lstatSync(dirPath);
    if (!afterDir.isDirectory() || afterDir.isSymbolicLink() ||
        [dir.dev,dir.ino,dir.ctimeMs,dir.mtimeMs].join(':') !== [afterDir.dev,afterDir.ino,afterDir.ctimeMs,afterDir.mtimeMs].join(':')) throw new Error('recovery_directory_changed');
    return result;
  }

  save(record: SessionHostRecord, snapshot: SessionBufferSnapshot): void {
    fs.mkdirSync(this.runtimesDir, { recursive: true });
    const filePath = path.join(this.runtimesDir, `${record.sessionId}.json`);
    const payload: PersistedRuntimeState = {
      record,
      snapshot,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
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
