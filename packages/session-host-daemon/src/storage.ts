import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionBufferSnapshot, SessionHostRecord } from '@adhdev/session-host-core';

export interface PersistedRuntimeState {
  record: SessionHostRecord;
  snapshot: SessionBufferSnapshot;
  updatedAt: number;
}

interface SessionHostStorageOptions {
  appName?: string;
}

export class SessionHostStorage {
  private readonly rootDir: string;
  private readonly runtimesDir: string;

  constructor(options: SessionHostStorageOptions = {}) {
    const appName = options.appName || 'adhdev';
    this.rootDir = path.join(os.homedir(), '.adhdev', 'session-host', appName);
    this.runtimesDir = path.join(this.rootDir, 'runtimes');
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
}
