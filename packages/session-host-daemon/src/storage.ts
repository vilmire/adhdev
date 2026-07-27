import * as fs from 'fs';
import * as path from 'path';
import { resolveInstanceConfigDir } from '@adhdev/session-host-core';
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
    this.runtimesDir = path.join(this.rootDir, 'runtimes');
    this.tombstonesDir = path.join(this.rootDir, 'tombstones');
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
