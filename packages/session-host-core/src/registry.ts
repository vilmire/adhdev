import { randomUUID } from 'crypto';
import type {
  AcquireWritePayload,
  AttachSessionPayload,
  CreateSessionPayload,
  DetachSessionPayload,
  ReleaseWritePayload,
  SessionAttachedClient,
  SessionHostRecord,
} from './types.js';
import { SessionRingBuffer } from './buffer.js';
import { buildRuntimeDisplayName, buildRuntimeKey, getWorkspaceLabel } from './runtime-labels.js';

interface SessionRuntimeState {
  record: SessionHostRecord;
  buffer: SessionRingBuffer;
}

export class SessionHostRegistry {
  private sessions = new Map<string, SessionRuntimeState>();

  createSession(payload: CreateSessionPayload): SessionHostRecord {
    const sessionId = payload.sessionId || randomUUID();
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }
    const now = Date.now();
    const initialClient = payload.clientId
      ? [{
          clientId: payload.clientId,
          type: payload.clientType || 'daemon',
          readOnly: false,
          attachedAt: now,
          lastSeenAt: now,
        } satisfies SessionAttachedClient]
      : [];

    const record: SessionHostRecord = {
      sessionId,
      runtimeKey: buildRuntimeKey(
        payload,
        Array.from(this.sessions.values(), (state) => state.record.runtimeKey),
      ),
      displayName: buildRuntimeDisplayName(payload),
      workspaceLabel: getWorkspaceLabel(payload.workspace),
      transport: 'pty',
      providerType: payload.providerType,
      category: payload.category,
      workspace: payload.workspace,
      launchCommand: payload.launchCommand,
      createdAt: now,
      lastActivityAt: now,
      lifecycle: 'starting',
      writeOwner: null,
      attachedClients: initialClient,
      buffer: {
        scrollbackBytes: 0,
        snapshotSeq: 0,
      },
      meta: payload.meta || {},
    };

    record.meta = {
      sessionHostCols: payload.cols || 80,
      sessionHostRows: payload.rows || 24,
      ...record.meta,
    };

    this.sessions.set(sessionId, {
      record,
      buffer: new SessionRingBuffer(),
    });

    return this.cloneRecord(record);
  }

  restoreSession(record: SessionHostRecord, snapshot?: { seq: number; text: string } | null): SessionHostRecord {
    const cloned = this.cloneRecord(record);
    this.sessions.set(cloned.sessionId, {
      record: cloned,
      buffer: (() => {
        const buffer = new SessionRingBuffer();
        if (snapshot) buffer.restore(snapshot);
        return buffer;
      })(),
    });
    return this.cloneRecord(cloned);
  }

  listSessions(): SessionHostRecord[] {
    return Array.from(this.sessions.values())
      .map(state => this.cloneRecord(state.record))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  getSession(sessionId: string): SessionHostRecord | null {
    const state = this.sessions.get(sessionId);
    return state ? this.cloneRecord(state.record) : null;
  }

  attachClient(payload: AttachSessionPayload): SessionHostRecord {
    const state = this.requireSession(payload.sessionId);
    const now = Date.now();
    let removedDaemonOwner = false;

    if (payload.clientType === 'daemon') {
      const staleDaemonClientIds = state.record.attachedClients
        .filter(client => client.type === 'daemon' && client.clientId !== payload.clientId)
        .map(client => client.clientId);
      if (staleDaemonClientIds.length > 0) {
        state.record.attachedClients = state.record.attachedClients.filter(
          client => !(client.type === 'daemon' && client.clientId !== payload.clientId),
        );
        if (state.record.writeOwner && staleDaemonClientIds.includes(state.record.writeOwner.clientId)) {
          removedDaemonOwner = true;
        }
      }
    }

    const existing = state.record.attachedClients.find(client => client.clientId === payload.clientId);

    if (existing) {
      existing.type = payload.clientType;
      existing.readOnly = !!payload.readOnly;
      existing.lastSeenAt = now;
    } else {
      state.record.attachedClients.push({
        clientId: payload.clientId,
        type: payload.clientType,
        readOnly: !!payload.readOnly,
        attachedAt: now,
        lastSeenAt: now,
      });
    }

    if (removedDaemonOwner) {
      state.record.writeOwner = null;
    }

    state.record.lastActivityAt = now;
    return this.cloneRecord(state.record);
  }

  detachClient(payload: DetachSessionPayload): SessionHostRecord {
    const state = this.requireSession(payload.sessionId);
    state.record.attachedClients = state.record.attachedClients.filter(client => client.clientId !== payload.clientId);
    if (state.record.writeOwner?.clientId === payload.clientId) {
      state.record.writeOwner = null;
    }
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  acquireWrite(payload: AcquireWritePayload): SessionHostRecord {
    const state = this.requireSession(payload.sessionId);
    if (state.record.writeOwner && state.record.writeOwner.clientId !== payload.clientId && !payload.force) {
      throw new Error(`Write owned by ${state.record.writeOwner.clientId}`);
    }
    const attachedClient = state.record.attachedClients.find(client => client.clientId === payload.clientId);
    if (attachedClient) {
      attachedClient.readOnly = false;
      attachedClient.lastSeenAt = Date.now();
    }
    state.record.writeOwner = {
      clientId: payload.clientId,
      ownerType: payload.ownerType,
      acquiredAt: Date.now(),
    };
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  releaseWrite(payload: ReleaseWritePayload): SessionHostRecord {
    const state = this.requireSession(payload.sessionId);
    const attachedClient = state.record.attachedClients.find(client => client.clientId === payload.clientId);
    if (attachedClient) {
      attachedClient.readOnly = false;
      attachedClient.lastSeenAt = Date.now();
    }
    if (state.record.writeOwner?.clientId === payload.clientId) {
      state.record.writeOwner = null;
    }
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  appendOutput(sessionId: string, data: string): { record: SessionHostRecord; seq: number } {
    const state = this.requireSession(sessionId);
    const seq = state.buffer.append(data);
    state.record.buffer = state.buffer.getState();
    state.record.lastActivityAt = Date.now();
    return { record: this.cloneRecord(state.record), seq };
  }

  getSnapshot(sessionId: string, sinceSeq?: number) {
    const state = this.requireSession(sessionId);
    state.record.buffer = state.buffer.getState();
    return state.buffer.snapshot(sinceSeq);
  }

  clearBuffer(sessionId: string): SessionHostRecord {
    const state = this.requireSession(sessionId);
    state.buffer.clear();
    state.record.buffer = state.buffer.getState();
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  updateSessionMeta(sessionId: string, meta: Record<string, unknown>, replace = false): SessionHostRecord {
    const state = this.requireSession(sessionId);
    state.record.meta = replace
      ? { ...meta }
      : {
          ...(state.record.meta || {}),
          ...meta,
        };
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  markStarted(sessionId: string, pid?: number): SessionHostRecord {
    const state = this.requireSession(sessionId);
    state.record.lifecycle = 'running';
    state.record.startedAt = state.record.startedAt || Date.now();
    if (typeof pid === 'number') state.record.osPid = pid;
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  markStopped(sessionId: string, lifecycle: 'stopped' | 'failed' = 'stopped'): SessionHostRecord {
    const state = this.requireSession(sessionId);
    state.record.lifecycle = lifecycle;
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  setLifecycle(sessionId: string, lifecycle: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'interrupted'): SessionHostRecord {
    const state = this.requireSession(sessionId);
    state.record.lifecycle = lifecycle;
    state.record.lastActivityAt = Date.now();
    return this.cloneRecord(state.record);
  }

  private requireSession(sessionId: string): SessionRuntimeState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown session: ${sessionId}`);
    return state;
  }

  private cloneRecord(record: SessionHostRecord): SessionHostRecord {
    return {
      ...record,
      launchCommand: {
        ...record.launchCommand,
        args: [...record.launchCommand.args],
        env: record.launchCommand.env ? { ...record.launchCommand.env } : undefined,
      },
      writeOwner: record.writeOwner ? { ...record.writeOwner } : null,
      attachedClients: record.attachedClients.map(client => ({ ...client })),
      buffer: { ...record.buffer },
      meta: { ...record.meta },
    };
  }
}
