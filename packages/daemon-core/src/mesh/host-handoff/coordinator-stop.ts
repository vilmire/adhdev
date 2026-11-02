/** A stop command ACK means "stopping", not process exit. Only a fresh census
 * from the trusted session host may prove exit. Never restart the shared host. */
export interface StopCensusRow {
    sessionId: string;
    lifecycle?: string;
    surfaceKind?: string;
    providerType?: string;
    meta?: { meshCoordinatorFor?: string };
}

export async function stopProjectCoordinators(meshId: string, ports: {
    list(): Promise<StopCensusRow[]>;
    registered(): Array<{ sessionId: string; cliType?: string }>;
    stop(sessionId: string, cliType: string): Promise<{ success?: boolean }>;
    now?: () => number;
    wait?: () => Promise<void>;
    timeoutMs?: number;
}): Promise<{ sessionIds: string[]; checkedAt: number; censusComplete: true }> {
    const now = ports.now ?? Date.now;
    const deadline = now() + (ports.timeoutMs ?? 30_000);
    const wait = ports.wait ?? (() => new Promise(r => setTimeout(r, 100)));
    const bounded = async <T>(effect: () => Promise<T>, label: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([effect(), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`source ${label} timed out`)), Math.max(1, deadline - now()));
            })]);
        } finally { if (timer) clearTimeout(timer); }
    };
    const census = async () => {
            const rows = await bounded(() => ports.list(), 'runtime census');
            if (!Array.isArray(rows) || rows.some(r => !r || typeof r.sessionId !== 'string')) throw new Error('source runtime census invalid');
            return rows;
    };
    const terminal = (row: StopCensusRow) => ['stopped', 'exited'].includes(row.lifecycle ?? '') && row.surfaceKind !== 'live_runtime';
    const initial = await census();
    const sessions = new Map(ports.registered().map(c => [c.sessionId, c.cliType ?? '']));
    for (const row of initial) {
        if (!sessions.has(row.sessionId)) continue;
        if (row.meta?.meshCoordinatorFor && row.meta.meshCoordinatorFor !== meshId) throw new Error('source coordinator project identity conflict');
        const registeredType = sessions.get(row.sessionId);
        if (registeredType && row.providerType && registeredType !== row.providerType) throw new Error('source coordinator provider identity conflict');
    }
    for (const row of initial) if (row.meta?.meshCoordinatorFor === meshId) sessions.set(row.sessionId, row.providerType ?? sessions.get(row.sessionId) ?? '');
    for (const [id, type] of sessions) {
        const row = initial.find(r => r.sessionId === id);
        if (!row || terminal(row)) continue;
        if (!type) throw new Error('source coordinator provider identity unavailable');
        if ((await bounded(() => ports.stop(id, type), 'coordinator stop')).success !== true) throw new Error('source coordinator stop refused');
    }
    for (;;) {
        const rows = await census();
        const pending = rows.filter(r => (sessions.has(r.sessionId) || r.meta?.meshCoordinatorFor === meshId) && !terminal(r));
        if (!pending.length) return { sessionIds: [...sessions.keys()].sort(), checkedAt: now(), censusComplete: true };
        if (now() >= deadline) throw new Error('source coordinator exit unconfirmed');
        await wait();
    }
}
