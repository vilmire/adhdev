/**
 * Session-control runtime: the pieces that live across calls — the deferred
 * assistant request (end of turn), the quota-failover tick and the daily
 * counters (design 2026-11-01 §5.3, §6). Created once by the assistant runtime
 * (`createSessionControlRuntime`) and read by the verb layer through
 * `getSessionControlRuntime()`.
 */

import { LOG } from '../logging/logger.js';
import { readQuotaCache } from '../quota/refresh.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { getLaunchDefaultsCommandPorts, createLaunchValidationPorts } from '../launch-defaults/ports.js';
import { validateLaunchDefault } from '../launch-defaults/validate.js';
import type { AssistantRegistry } from './assistant-registry.js';
import type { AssistantMetricColumn, AssistantMetricsStore } from './assistant-relay-sqlite-store.js';
import { getAssistantServices } from './assistant-services.js';
import { getAssistantProjectPorts } from './assistant-project-ports.js';
import { projectSlugs } from './assistant-projects.js';
import { liveAssistantQuotaPort } from './assistant-quota.js';
import { PendingSessionControl, createSqlitePendingJobStore, type PendingJobStore } from './pending-session-control.js';
import { QuotaFailoverTicker, type FailoverHistory, type FailoverSubject, type QuotaFailoverPorts } from './quota-failover.js';
import { executeApprovedControl, type DeferredAssistantJob, type ProviderSelection } from './session-control.js';
import { getStagedControlStore, type StagedControlProposal } from './staged-control.js';
import { buildSessionControlPorts, instanceControlState, type ControlHost } from '../commands/high-family/assistant-session-control.js';

type MetricColumn = Extract<AssistantMetricColumn, 'session_controls' | 'quota_failovers_proposed' | 'quota_failovers_accepted' | 'quota_failovers_auto'>;

export interface SessionControlRuntime {
    readonly pending: PendingSessionControl;
    bumpMetric(column: MetricColumn, meshId: string): void;
    onTurnCommitted(sessionId: string): void;
    /** Quota failover pass (called on the assistant tick). */
    tick(): Promise<void>;
    recordAccepted(entry: { role: string; meshId: string; sessionId: string; from: string; to: string }): void;
    restorePending(): void;
}

let current: SessionControlRuntime | null = null;

/** The wired runtime; before wiring (tests, early boot) deferred requests are refused rather than lost. */
export function getSessionControlRuntime(): SessionControlRuntime {
    return current ?? unwired;
}
export function setSessionControlRuntimeForTest(runtime: SessionControlRuntime | null): void {
    current = runtime;
}

const unwired: SessionControlRuntime = {
    pending: new PendingSessionControl({
        store: { read: () => null, write: () => {}, clear: () => {} },
        turnOpen: () => true,
        run: async () => ({ success: false, code: 'session_control_unavailable' }),
    }),
    bumpMetric: () => {},
    onTurnCommitted: () => {},
    tick: async () => {},
    recordAccepted: () => {},
    restorePending: () => {},
};

function memoryHistory(): FailoverHistory & { rows: Array<{ at: number; role: string; meshId: string; mode: string }> } {
    const rows: Array<{ at: number; role: string; meshId: string; mode: string }> = [];
    return {
        rows,
        autoCountSince: (role, meshId, since) => rows.filter(r => r.role === role && r.meshId === meshId && r.mode === 'auto' && r.at >= since).length,
        lastAt: (role, meshId) => rows.filter(r => r.role === role && r.meshId === meshId).reduce<number | null>((m, r) => (m === null || r.at > m ? r.at : m), null),
        record: (e) => { rows.push({ at: e.at, role: e.role, meshId: e.meshId, mode: e.mode }); },
    };
}

type Db = ReturnType<typeof MeshRuntimeStore.getInstance>['db'];

function sqliteHistory(db: Db): FailoverHistory {
    return {
        autoCountSince: (role, meshId, since) => (db.prepare("SELECT COUNT(*) AS n FROM assistant_quota_failover_log WHERE role = ? AND mesh_id = ? AND mode = 'auto' AND at_ms >= ?").get(role, meshId, since) as { n: number }).n,
        lastAt: (role, meshId) => ((db.prepare('SELECT MAX(at_ms) AS at FROM assistant_quota_failover_log WHERE role = ? AND mesh_id = ?').get(role, meshId) as { at: number | null } | undefined)?.at ?? null),
        record: (e) => { db.prepare('INSERT INTO assistant_quota_failover_log (at_ms, role, mesh_id, session_id, mode, from_provider, to_provider) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.at, e.role, e.meshId, e.sessionId, e.mode, e.from, e.to); },
    };
}

/** Earliest instant at which every exhausted window of a provider has reset. */
export function exhaustedResetsAt(entry: any, now: number): number | undefined {
    const windows = [entry?.session, entry?.weekly, entry?.monthly, ...(Array.isArray(entry?.buckets) ? entry.buckets : [])];
    let latest: number | undefined;
    for (const w of windows) {
        if (!w || typeof w.usedPercent !== 'number' || w.usedPercent < 100) continue;
        if (typeof w.resetsAt === 'number' && w.resetsAt > now) latest = latest === undefined ? w.resetsAt : Math.max(latest, w.resetsAt);
    }
    return latest;
}

export interface SessionControlRuntimeDeps {
    components: any;
    registry: AssistantRegistry;
    metrics: AssistantMetricsStore | null;
    enqueueNotice(sessionId: string, text: string, messageId: string): void;
    /** Meshes the owner follows (open assistant threads); coordinator failover considers only these. */
    openThreadMeshIds(): string[];
    now?: () => number;
}

export function createSessionControlRuntime(deps: SessionControlRuntimeDeps): SessionControlRuntime {
    const { components, registry } = deps;
    const now = deps.now ?? Date.now;
    const host: ControlHost = {
        deps: components,
        components: () => components,
        exec: (cmd, a) => components.router.execute(cmd, a, 'ipc', { inProcess: true }),
    };
    const projectPorts = () => getAssistantProjectPorts({
        components: () => components, selfDaemonId: String(components.statusInstanceId ?? ''),
        execute: (cmd, a) => components.router.execute(cmd, a, 'ipc', { inProcess: true }),
        transport: { dispatch: components.dispatchMeshCommand, peerStatus: components.getMeshPeerConnectionStatus },
    });

    let db: Db | null = null;
    try { db = MeshRuntimeStore.getInstance().db; } catch { db = null; }
    const history = db ? sqliteHistory(db) : memoryHistory();
    const store: PendingJobStore = db ? createSqlitePendingJobStore(db as never) : (() => {
        let job: DeferredAssistantJob | null = null;
        return { read: () => job, write: (j) => { job = j; }, clear: () => { job = null; } };
    })();

    const stopAndWait = async (cliType: string, sessionId: string, reason: string): Promise<{ success: boolean; code?: string }> => {
        const out = await host.exec('stop_cli', { cliType, targetSessionId: sessionId, mode: 'hard', reason });
        if (out?.success === false) return { success: false, code: String(out.code ?? 'stop_failed') };
        const deadline = now() + 20_000;
        while (components.instanceManager.getInstance(sessionId) && now() < deadline) await new Promise(r => setTimeout(r, 250));
        return components.instanceManager.getInstance(sessionId) ? { success: false, code: 'stop_not_confirmed' } : { success: true };
    };

    const pending = new PendingSessionControl({
        store,
        turnOpen: (sid) => getAssistantServices().inputLog.currentTurn(sid)?.open === true,
        log: (line) => LOG.info('Assistant', line),
        run: async (job) => {
            const cliType = String(registry.read()?.cliType ?? '');
            if (job.action === 'restart') {
                const out = await host.exec('restart_session', { cliType, targetSessionId: job.sessionId });
                return out?.success === false ? { success: false, code: String(out.code ?? 'restart_failed'), error: String(out.error ?? '') } : { success: true };
            }
            const stopped = await stopAndWait(cliType, job.sessionId, 'owner_session_control');
            if (!stopped.success || job.action === 'stop') return stopped;
            const sel = job.selection!;
            const launched = await host.exec('launch_assistant', { cliType: sel.provider, ...(sel.model ? { model: sel.model } : {}), ...(sel.thinkingLevel ? { thinkingLevel: sel.thinkingLevel } : {}) });
            return launched?.success === false ? { success: false, code: String(launched.code ?? 'assistant_launch_failed'), error: String(launched.error ?? '') } : { success: true };
        },
    });

    const metric = (column: MetricColumn, meshId: string) => {
        try { deps.metrics?.bump(column, meshId, now()); } catch { /* counters never fail an operation */ }
    };

    const failoverPorts = (): QuotaFailoverPorts => {
        const validation = createLaunchValidationPorts({ deps: components });
        const launchPorts = getLaunchDefaultsCommandPorts({ deps: components } as never);
        return {
            now,
            async subjects() {
                const out: FailoverSubject[] = [];
                const entry = registry.read();
                const pp = await projectPorts();
                const slugs = projectSlugs(pp.listMeshes());
                const quota = readQuotaCache();
                const t = now();
                const subjectOf = (role: 'assistant' | 'coordinator', sessionId: string, cliType: string, meshId: string, project: string, view: { idle?: boolean; modalParked?: boolean }): FailoverSubject | null => {
                    const inst = components.instanceManager.getInstance(sessionId);
                    if (!inst || !cliType) return null;
                    let state = instanceControlState(inst);
                    if (view.modalParked) state = 'waiting';
                    else if (view.idle && state === 'unknown') state = 'idle';
                    const pct = liveAssistantQuotaPort.remainingPct(cliType, t, null);
                    const resetsAt = pct === 0 ? exhaustedResetsAt(quota?.[cliType], t) : undefined;
                    return { role, project, meshId, sessionId, cliType, state, remainingPct: pct, ...(resetsAt !== undefined ? { resetsAt } : {}) };
                };
                if (entry?.sessionId && entry.cliType) {
                    const s = subjectOf('assistant', entry.sessionId, entry.cliType, '', 'assistant', {});
                    if (s) out.push(s);
                }
                const followed = new Set(deps.openThreadMeshIds());
                for (const mesh of pp.listMeshes()) {
                    if (!pp.isHostedHere(mesh) || (followed.size && !followed.has(mesh.id))) continue;
                    const view = pp.coordinators(mesh.id).find(v => !v.draining);
                    if (!view) continue;
                    const { getCoordinatorForSession } = await import('../mesh/coordinator-registry.js');
                    const s = subjectOf('coordinator', view.sessionId, getCoordinatorForSession(view.sessionId)?.cliType ?? '', mesh.id, slugs.get(mesh.id) ?? mesh.id, view);
                    if (s) out.push(s);
                }
                return out;
            },
            mode: (role) => registry.read()?.quotaFailover?.[role] ?? 'notify',
            fallbackOrder(role) {
                const read = launchPorts.store.read();
                const list = read.status === 'ok' ? read.document[role]?.fallback ?? [] : [];
                return list.map(s => ({ ...s }));
            },
            quotaOf(provider) {
                const t = now();
                return { remainingPct: liveAssistantQuotaPort.remainingPct(provider, t, null) };
            },
            isEligible: (role, sel) => validateLaunchDefault(role, sel, validation).ok,
            hasOpenCard: (meshId, role, sessionId) => !!getStagedControlStore().findOpen(r => r.kind === 'session_control' && r.meshId === meshId && r.role === role && r.sessionId === sessionId && r.trigger === 'quota_exhausted'),
            stage: (proposal: StagedControlProposal) => getStagedControlStore().write(proposal),
            notify(text, messageId) {
                const sid = registry.read()?.sessionId;
                if (sid) deps.enqueueNotice(sid, text, messageId);
            },
            async autoSwitch(subject, to: ProviderSelection) {
                const pp = await projectPorts();
                const ports = buildSessionControlPorts(host, pp);
                const res = await executeApprovedControl({
                    kind: 'session_control', project: subject.project, meshId: subject.meshId, trigger: 'quota_exhausted',
                    role: subject.role, action: 'switch_provider', sessionId: subject.sessionId, provider: to.provider,
                    ...(to.model ? { model: to.model } : {}), ...(to.thinkingLevel ? { thinkingLevel: to.thinkingLevel } : {}), reason: 'quota_exhausted',
                }, { meshId: subject.meshId, remote: false, now }, ports);
                return res.result === 'refused' ? { success: false, code: res.code } : { success: true };
            },
            history,
            metric: (column, meshId) => metric(column, meshId),
            log: (line) => LOG.info('Assistant', line),
        };
    };

    const ticker = new QuotaFailoverTicker(failoverPorts());
    let ticking = false;
    const runtime: SessionControlRuntime = {
        pending,
        bumpMetric: metric,
        onTurnCommitted(sessionId) { void pending.onTurnCommitted(sessionId).catch(e => LOG.warn('Assistant', `deferred session control failed: ${(e as Error)?.message ?? e}`)); },
        async tick() {
            if (ticking) return;
            ticking = true;
            try {
                const outcomes = await ticker.tick();
                for (const o of outcomes) if (o.outcome !== 'skipped') LOG.info('Assistant', `[session-control] quota failover ${o.subject} ${o.outcome}`);
            } catch (e) { LOG.warn('Assistant', `quota failover tick failed: ${(e as Error)?.message ?? e}`); }
            finally { ticking = false; }
        },
        recordAccepted(e) { history.record({ at: now(), role: e.role, meshId: e.meshId, sessionId: e.sessionId, mode: 'accepted', from: e.from, to: e.to }); },
        restorePending() { void pending.restore().catch(() => {}); },
    };
    current = runtime;
    return runtime;
}

export function disposeSessionControlRuntime(): void {
    current = null;
}

