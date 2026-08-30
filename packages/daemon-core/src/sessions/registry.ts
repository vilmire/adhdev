import { startTranscriptStatPolling, stopTranscriptStatPolling } from '../seqscribe/transcript-publisher.js';
import type { SessionTransport } from '../shared-types.js';

export interface SessionRuntimeTarget {
    sessionId: string;
    parentSessionId: string | null;
    providerType: string;
    transport: SessionTransport;
    cdpManagerKey?: string;
    adapterKey?: string;
    instanceKey?: string;
    /** Working directory for CLI/ACP sessions. Used by read_chat to resolve
     *  native history when there is no live adapter (e.g. subscription path). */
    workspace?: string;
    /** Wall clock at register time. native-history readers use it as a
     *  cutoff so a fresh session can't show records from a prior one. */
    spawnedAtMs?: number;
    /**
     * Authoritative provider-native conversation id for this session (SSOT).
     * For providers that expose a session id on the CLI (codex/claude/hermes)
     * this equals that id. For antigravity — which takes no --session-id — this
     * is the on-disk conversations/<uuid>.db basename, discovered by the
     * native-history dispatcher and written back here via setProviderSessionId
     * the first time it resolves. Every downstream reader (read_chat, the
     * completion probe, the dashboard) should prefer this over re-deriving the
     * conversation by spawn-floor/mtime heuristics — that re-derivation is the
     * source of the antigravity conversation crosswire/theft class. Empty until
     * the first successful native read binds it.
     */
    providerSessionId?: string;
}

export class SessionRegistry {
    private readonly bySessionId = new Map<string, SessionRuntimeTarget>();
    private readonly byManagerKey = new Map<string, Set<string>>();
    private readonly byInstanceKey = new Map<string, Set<string>>();
    private readonly byParentSessionId = new Map<string, Set<string>>();

    register(target: SessionRuntimeTarget): void {
        // Preserve an already-resolved conversation binding across a
        // re-register (attach-restore, meta refresh): the caller rarely knows
        // the antigravity conv uuid at register time, so a plain replace would
        // drop the SSOT binding and force a fresh (crosswire-prone) re-resolve.
        const priorProviderSessionId = this.bySessionId.get(target.sessionId)?.providerSessionId;
        this.unregister(target.sessionId);
        if (priorProviderSessionId && !target.providerSessionId) {
            target = { ...target, providerSessionId: priorProviderSessionId };
        }
        this.bySessionId.set(target.sessionId, target);
        startTranscriptStatPolling(target.sessionId);
        if (target.cdpManagerKey) this.addIndex(this.byManagerKey, target.cdpManagerKey, target.sessionId);
        if (target.instanceKey) this.addIndex(this.byInstanceKey, target.instanceKey, target.sessionId);
        if (target.parentSessionId) this.addIndex(this.byParentSessionId, target.parentSessionId, target.sessionId);
    }

    get(sessionId: string | undefined | null): SessionRuntimeTarget | undefined {
        if (!sessionId) return undefined;
        return this.bySessionId.get(sessionId);
    }

    /**
     * Record the authoritative provider-native conversation id for a session
     * (SSOT). Idempotent; a no-op when the session is unknown or the value is
     * empty or unchanged. Never overwrites a known binding with an empty one.
     * Returns whether the stored value changed.
     */
    setProviderSessionId(sessionId: string | undefined | null, providerSessionId: string | undefined | null): boolean {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        const value = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
        if (!sid || !value) return false;
        const target = this.bySessionId.get(sid);
        if (!target) return false;
        if (target.providerSessionId === value) return false;
        target.providerSessionId = value;
        return true;
    }

    unregister(sessionId: string | undefined | null): void {
        if (!sessionId) return;
        const target = this.bySessionId.get(sessionId);
        if (!target) return;
        this.bySessionId.delete(sessionId);
        stopTranscriptStatPolling(sessionId);
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
