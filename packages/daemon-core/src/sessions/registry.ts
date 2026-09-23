import type { SessionTermination } from '@adhdev/session-host-core';
import type { SessionTransport } from '../shared-types.js';
import type { SessionLifecycleBus } from './lifecycle-bus.js';
import type { LaunchUpdateCause, RegisterOrigin, TerminationCause } from './lifecycle-events.js';
import { appendAxisHistory, cloneLaunchRecord, type LaunchAxis, type SessionLaunchRecord } from './launch-record.js';

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
    /**
     * Launch provenance — provider, model, thinking level, and where each value
     * came from (Phase E). Written by the launching caller right after
     * `register()` via `setLaunchRecord()` (only the caller knows the source),
     * then updated in place by `updateLaunchAxis()` / `observeLaunchAxis()`.
     * Absent for sessions that have no launch axis (IDE / extension).
     */
    launch?: SessionLaunchRecord;
}

export interface TerminateDetail {
    termination?: SessionTermination;
    runtimeSettings?: Readonly<Record<string, unknown>>;
}

/**
 * Legacy origin for `register()` callers that do not pass one yet (B2..B5 make
 * every caller explicit): CDP pages come from an attach, webviews from discovery,
 * PTY/ACP sessions from a launch.
 */
function inferLegacyOrigin(target: SessionRuntimeTarget): RegisterOrigin {
    if (target.transport === 'cdp-page') return 'attach';
    if (target.transport === 'cdp-webview') return 'discover';
    return 'launch';
}

/**
 * SessionRegistry — the owner of "which sessions exist on this daemon".
 *
 * Wiring-unification Phase B1: it is the ONLY emitter of the `registered`,
 * `binding` and `terminated` lifecycle events. `terminate()` is idempotent per
 * registration, so racing causes (PTY exit vs. explicit stop vs. auto-clean)
 * produce exactly one `terminated`.
 */
export class SessionRegistry {
    private transcriptTopicRelease: ((rawSessionId: string) => void) | null = null;
    private shuttingDown = false;

    /** The bus is optional only until boot constructs it (B4); without one nothing is emitted. */
    constructor(
        private readonly bus: SessionLifecycleBus | null = null,
        private readonly now: () => number = Date.now,
    ) {}

    /** Hook installed at boot once the seqscribe transcript claim registry exists. */
    setTranscriptTopicRelease(release: ((rawSessionId: string) => void) | null): void {
        this.transcriptTopicRelease = release;
    }

    private readonly bySessionId = new Map<string, SessionRuntimeTarget>();
    private readonly byManagerKey = new Map<string, Set<string>>();
    private readonly byInstanceKey = new Map<string, Set<string>>();
    private readonly byParentSessionId = new Map<string, Set<string>>();
    private readonly byProviderSessionId = new Map<string, string>();

    /**
     * Add (or replace) a session. Emits `registered{origin}` every time — a
     * re-register of a live id is an upsert, not a termination, so it emits no
     * `terminated`.
     */
    register(target: SessionRuntimeTarget, origin: RegisterOrigin = inferLegacyOrigin(target)): void {
        // Preserve an already-resolved conversation binding across a
        // re-register (attach-restore, meta refresh): the caller rarely knows
        // the antigravity conv uuid at register time, so a plain replace would
        // drop the SSOT binding and force a fresh (crosswire-prone) re-resolve.
        const prior = this.bySessionId.get(target.sessionId);
        const priorProviderSessionId = prior?.providerSessionId;
        this.detach(target.sessionId);
        if (priorProviderSessionId && !target.providerSessionId) {
            target = { ...target, providerSessionId: priorProviderSessionId };
        }
        // Same for the launch record: a re-register (meta refresh) must not
        // erase how the session was launched.
        if (prior?.launch && !target.launch) {
            target = { ...target, launch: prior.launch };
        }
        this.bySessionId.set(target.sessionId, target);
        if (target.cdpManagerKey) this.addIndex(this.byManagerKey, target.cdpManagerKey, target.sessionId);
        if (target.instanceKey) this.addIndex(this.byInstanceKey, target.instanceKey, target.sessionId);
        if (target.parentSessionId) this.addIndex(this.byParentSessionId, target.parentSessionId, target.sessionId);
        if (target.providerSessionId) this.byProviderSessionId.set(target.providerSessionId, target.sessionId);
        this.bus?.emit({
            kind: 'registered',
            sessionId: target.sessionId,
            at: this.now(),
            origin,
            session: { ...target },
        });
    }

    get(sessionId: string | undefined | null): SessionRuntimeTarget | undefined {
        if (!sessionId) return undefined;
        return this.bySessionId.get(sessionId);
    }

    has(sessionId: string | undefined | null): boolean {
        return !!sessionId && this.bySessionId.has(sessionId);
    }

    list(): SessionRuntimeTarget[] {
        return [...this.bySessionId.values()];
    }

    /**
     * Resolve a daemon session id OR a provider-native conversation id to the
     * daemon session id. Returns null when neither is known.
     */
    resolveAlias(idOrProviderSessionId: string | undefined | null): string | null {
        const id = typeof idOrProviderSessionId === 'string' ? idOrProviderSessionId.trim() : '';
        if (!id) return null;
        if (this.bySessionId.has(id)) return id;
        return this.byProviderSessionId.get(id) ?? null;
    }

    /**
     * Record the authoritative provider-native conversation id for a session
     * (SSOT). Idempotent; a no-op when the session is unknown or the value is
     * empty or unchanged. Never overwrites a known binding with an empty one.
     * Returns whether the stored value changed; emits `binding` when it did.
     */
    setProviderSessionId(sessionId: string | undefined | null, providerSessionId: string | undefined | null): boolean {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        const value = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
        if (!sid || !value) return false;
        const target = this.bySessionId.get(sid);
        if (!target) return false;
        if (target.providerSessionId === value) return false;
        this.dropProviderSessionAlias(target);
        target.providerSessionId = value;
        this.byProviderSessionId.set(value, sid);
        this.bus?.emit({ kind: 'binding', sessionId: sid, at: this.now(), providerSessionId: value });
        return true;
    }

    /**
     * Set a session's launch record (Phase E). Called by the launching code path
     * right after `register()` — `launch` for a fresh spawn, `restore` for a
     * hosted runtime re-attached after a daemon restart. Emits `launch_updated`.
     * Returns false (and emits nothing) when the session is unknown or the
     * record names another session.
     */
    setLaunchRecord(sessionId: string | undefined | null, record: SessionLaunchRecord, cause: 'launch' | 'restore' = 'launch'): boolean {
        const target = sessionId ? this.bySessionId.get(sessionId) : undefined;
        if (!target || record.sessionId !== target.sessionId) return false;
        target.launch = cloneLaunchRecord(record);
        this.emitLaunchUpdated(target, cause);
        return true;
    }

    /**
     * An explicit runtime change of one axis (`change_model`,
     * `set_thought_level`): sets `current` and appends history. No-op when the
     * session has no launch record or the value is unchanged.
     */
    updateLaunchAxis(sessionId: string | undefined | null, axis: LaunchAxis, value: string | undefined | null): boolean {
        const target = sessionId ? this.bySessionId.get(sessionId) : undefined;
        const next = typeof value === 'string' ? value.trim() : '';
        if (!target?.launch || !next) return false;
        const selection = target.launch[axis];
        if (selection.current === next) return false;
        const at = this.now();
        selection.current = next;
        appendAxisHistory(selection, { at, value: next, via: 'change_model' });
        this.emitLaunchUpdated(target, 'change_model');
        return true;
    }

    /**
     * The provider reported which value it is running (statusline, native
     * history). The narrow observation write: monotonic on `observedAt` (a
     * transcript re-read of old lines cannot roll it back), and a repeat of the
     * same value only refreshes `observedAt` — no history entry, no event.
     */
    observeLaunchAxis(sessionId: string | undefined | null, axis: LaunchAxis, value: string | undefined | null, observedAt: number): boolean {
        const target = sessionId ? this.bySessionId.get(sessionId) : undefined;
        const next = typeof value === 'string' ? value.trim() : '';
        if (!target?.launch || !next || !Number.isFinite(observedAt)) return false;
        const selection = target.launch[axis];
        if (typeof selection.observedAt === 'number' && observedAt < selection.observedAt) return false;
        if (selection.observed === next) {
            selection.observedAt = observedAt;
            return false;
        }
        selection.observed = next;
        selection.observedAt = observedAt;
        // Confirming the value already in force (the launch value, a change the
        // daemon just made) is not a change: record it, but add no history.
        const inForce = selection.history[selection.history.length - 1]?.value;
        if (inForce !== next) appendAxisHistory(selection, { at: observedAt, value: next, via: 'observed' });
        this.emitLaunchUpdated(target, 'observed');
        return true;
    }

    private emitLaunchUpdated(target: SessionRuntimeTarget, cause: LaunchUpdateCause): void {
        if (!target.launch) return;
        this.bus?.emit({
            kind: 'launch_updated',
            sessionId: target.sessionId,
            at: this.now(),
            cause,
            launch: cloneLaunchRecord(target.launch),
        });
    }

    /** After this, every `terminate()` carries cause `daemon_shutdown`. */
    beginShutdown(): void {
        this.shuttingDown = true;
    }

    /**
     * Remove a session and emit exactly one `terminated`. Returns false (and
     * emits nothing) when the session is not registered — including the second
     * of two racing terminations of the same registration.
     */
    terminate(sessionId: string | undefined | null, cause: TerminationCause, detail: TerminateDetail = {}): boolean {
        if (!sessionId) return false;
        const target = this.detach(sessionId);
        if (!target) return false;
        this.bus?.emit({
            kind: 'terminated',
            sessionId,
            at: this.now(),
            cause: this.shuttingDown ? 'daemon_shutdown' : cause,
            providerType: target.providerType,
            ...(target.workspace ? { workspace: target.workspace } : {}),
            runtimeSettings: detail.runtimeSettings ?? {},
            ...(detail.termination ? { termination: detail.termination } : {}),
        });
        return true;
    }

    /** Terminate every session attached through a CDP manager. Returns how many were terminated. */
    terminateByManagerKey(managerKey: string, cause: TerminationCause): number {
        let count = 0;
        for (const sessionId of [...(this.byManagerKey.get(managerKey) || [])]) {
            if (this.terminate(sessionId, cause)) count += 1;
        }
        return count;
    }

    /** Terminate every session hosted by one provider instance. Returns how many were terminated. */
    terminateByInstanceKey(instanceKey: string, cause: TerminationCause): number {
        let count = 0;
        for (const sessionId of [...(this.byInstanceKey.get(instanceKey) || [])]) {
            if (this.terminate(sessionId, cause)) count += 1;
        }
        return count;
    }

    listChildren(parentSessionId: string): SessionRuntimeTarget[] {
        const ids = this.byParentSessionId.get(parentSessionId);
        if (!ids) return [];
        return [...ids].map((id) => this.bySessionId.get(id)).filter(Boolean) as SessionRuntimeTarget[];
    }

    /** Drop a session from every index without emitting. Returns the removed entry. */
    private detach(sessionId: string): SessionRuntimeTarget | undefined {
        const target = this.bySessionId.get(sessionId);
        if (!target) return undefined;
        this.bySessionId.delete(sessionId);
        try { this.transcriptTopicRelease?.(sessionId); } catch { /* claim release is best-effort */ }
        if (target.cdpManagerKey) this.removeIndex(this.byManagerKey, target.cdpManagerKey, sessionId);
        if (target.instanceKey) this.removeIndex(this.byInstanceKey, target.instanceKey, sessionId);
        if (target.parentSessionId) this.removeIndex(this.byParentSessionId, target.parentSessionId, sessionId);
        this.dropProviderSessionAlias(target);
        return target;
    }

    private dropProviderSessionAlias(target: SessionRuntimeTarget): void {
        const psid = target.providerSessionId;
        if (psid && this.byProviderSessionId.get(psid) === target.sessionId) {
            this.byProviderSessionId.delete(psid);
        }
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
