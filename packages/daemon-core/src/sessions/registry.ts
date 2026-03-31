import type { SessionTransport } from '../shared-types.js';

export interface SessionRuntimeTarget {
    sessionId: string;
    parentSessionId: string | null;
    providerType: string;
    providerCategory: 'ide' | 'extension' | 'cli' | 'acp';
    transport: SessionTransport;
    cdpManagerKey?: string;
    adapterKey?: string;
    instanceKey?: string;
}

export class SessionRegistry {
    private readonly bySessionId = new Map<string, SessionRuntimeTarget>();
    private readonly byManagerKey = new Map<string, Set<string>>();
    private readonly byInstanceKey = new Map<string, Set<string>>();
    private readonly byParentSessionId = new Map<string, Set<string>>();

    register(target: SessionRuntimeTarget): void {
        this.unregister(target.sessionId);
        this.bySessionId.set(target.sessionId, target);
        if (target.cdpManagerKey) this.addIndex(this.byManagerKey, target.cdpManagerKey, target.sessionId);
        if (target.instanceKey) this.addIndex(this.byInstanceKey, target.instanceKey, target.sessionId);
        if (target.parentSessionId) this.addIndex(this.byParentSessionId, target.parentSessionId, target.sessionId);
    }

    get(sessionId: string | undefined | null): SessionRuntimeTarget | undefined {
        if (!sessionId) return undefined;
        return this.bySessionId.get(sessionId);
    }

    unregister(sessionId: string | undefined | null): void {
        if (!sessionId) return;
        const target = this.bySessionId.get(sessionId);
        if (!target) return;
        this.bySessionId.delete(sessionId);
        if (target.cdpManagerKey) this.removeIndex(this.byManagerKey, target.cdpManagerKey, sessionId);
        if (target.instanceKey) this.removeIndex(this.byInstanceKey, target.instanceKey, sessionId);
        if (target.parentSessionId) this.removeIndex(this.byParentSessionId, target.parentSessionId, sessionId);
    }

    unregisterByManagerKey(managerKey: string): void {
        for (const sessionId of [...(this.byManagerKey.get(managerKey) || [])]) {
            this.unregister(sessionId);
        }
    }

    unregisterByInstanceKey(instanceKey: string): void {
        for (const sessionId of [...(this.byInstanceKey.get(instanceKey) || [])]) {
            this.unregister(sessionId);
        }
    }

    listChildren(parentSessionId: string): SessionRuntimeTarget[] {
        const ids = this.byParentSessionId.get(parentSessionId);
        if (!ids) return [];
        return [...ids].map((id) => this.bySessionId.get(id)).filter(Boolean) as SessionRuntimeTarget[];
    }

    private addIndex(index: Map<string, Set<string>>, key: string, sessionId: string): void {
        let set = index.get(key);
        if (!set) {
            set = new Set<string>();
            index.set(key, set);
        }
        set.add(sessionId);
    }

    private removeIndex(index: Map<string, Set<string>>, key: string, sessionId: string): void {
        const set = index.get(key);
        if (!set) return;
        set.delete(sessionId);
        if (set.size === 0) index.delete(key);
    }
}
