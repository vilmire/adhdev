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

// Recovery evidence is deliberately stricter than tolerant boot/restore loading.
// The unversioned writer has one known schema. Optional fields below cover the
// documented older environment/input-provenance forms; unknown fields/versions
// cannot silently be certified by an older recovery reader. Metadata is open.
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' &&
  Object.getPrototypeOf(v) === Object.prototype;
const shape = (v: unknown, keys: string[]): v is ObjectValue => object(v) && Object.keys(v).every(k => keys.includes(k));
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const string = (v: unknown) => typeof v === 'string';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => count(v) && v > 0;
const optional = (v: ObjectValue, key: string, check: (value: unknown) => boolean) =>
  !Object.hasOwn(v, key) || check(v[key]);
const lifecycle = (v: unknown) => ['starting','running','stopping','stopped','failed','interrupted'].includes(v as string);
function validTermination(v: unknown): v is SessionTermination {
  if (!shape(v, ['exitCode','signal','reason','lifecycle','terminatedAt','osPid','previousLifecycle','lastOutputAt','requestedStop']) ||
      !(v.exitCode === null || Number.isInteger(v.exitCode)) ||
      !(v.signal === null || count(v.signal)) || !finite(v.terminatedAt) ||
      !optional(v, 'osPid', positive) || !optional(v, 'previousLifecycle', lifecycle) ||
      !optional(v, 'lastOutputAt', finite) ||
      !optional(v, 'requestedStop', x => ['stop','delete','restart','prune'].includes(x as string))) return false;
  const classified = classifyTermination(v as unknown as SessionTermination);
  return classified.reason === v.reason && classified.lifecycle === v.lifecycle;
}
function validRuntimeState(v: unknown): v is PersistedRuntimeState {
  if (!shape(v, ['record','snapshot','updatedAt']) || !finite(v.updatedAt)) return false;
  const r = v.record, s = v.snapshot;
  if (!shape(r, ['sessionId','runtimeKey','displayName','workspaceLabel','transport','providerType','category','workspace',
      'launchCommand','osPid','createdAt','startedAt','lastActivityAt','lifecycle','surfaceKind','writeOwner',
      'attachedClients','buffer','meta','termination','inputSeq','inputEpoch']) ||
      !['sessionId','runtimeKey','providerType','workspace'].every(k => nonempty(r[k])) ||
      !string(r.displayName) || !string(r.workspaceLabel) || r.transport !== 'pty' ||
      !['cli','acp','shell'].includes(r.category as string) || !lifecycle(r.lifecycle) ||
      !finite(r.createdAt) || !finite(r.lastActivityAt) || !object(r.meta) ||
      !optional(r, 'startedAt', finite) || !optional(r, 'osPid', positive) ||
      !optional(r, 'surfaceKind', x => ['live_runtime','recovery_snapshot','inactive_record'].includes(x as string)) ||
      !optional(r, 'inputSeq', count) || !optional(r, 'inputEpoch', nonempty) ||
      !optional(r, 'termination', validTermination)) return false;
  const c = r.launchCommand, b = r.buffer, w = r.writeOwner;
  if (!shape(c, ['command','args','env','envMode']) || !nonempty(c.command) ||
      !Array.isArray(c.args) || !c.args.every(string) ||
      !optional(c, 'env', x => object(x) && Object.values(x).every(string)) ||
      !optional(c, 'envMode', x => x === 'launch_overrides') ||
      !shape(b, ['scrollbackBytes','snapshotSeq']) || !count(b.scrollbackBytes) || !count(b.snapshotSeq)) return false;
  if (w !== null && (!shape(w, ['clientId','ownerType','acquiredAt']) || !nonempty(w.clientId) ||
      !['agent','user'].includes(w.ownerType as string) || !finite(w.acquiredAt))) return false;
  if (!Array.isArray(r.attachedClients) || !r.attachedClients.every(a =>
      shape(a, ['clientId','type','readOnly','attachedAt','lastSeenAt']) && nonempty(a.clientId) &&
      ['daemon','web','local-terminal'].includes(a.type as string) && typeof a.readOnly === 'boolean' &&
      finite(a.attachedAt) && finite(a.lastSeenAt))) return false;
  return shape(s, ['seq','text','truncated','cols','rows']) && count(s.seq) && string(s.text) &&
    typeof s.truncated === 'boolean' && optional(s, 'cols', positive) && optional(s, 'rows', positive);
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
      if (!states.every(validRuntimeState) || !tombstones.every(parsed =>
        shape(parsed, ['sessionId','termination','updatedAt']) && nonempty(parsed.sessionId) &&
        finite(parsed.updatedAt) && validTermination(parsed.termination))) return incomplete();
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
