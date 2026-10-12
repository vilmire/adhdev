/** Read-only, content-free projection of authorized roster facts. No quota fetch or availability inference. */
import { canonicalDaemonId, type MeshNodeFacts } from '@adhdev/mesh-shared';
import type { LocalMeshEntry } from '../repo-mesh-types.js';

export const INVENTORY_MAX_MACHINES = 64;
export const INVENTORY_MAX_PROVIDERS = 32;
export const INVENTORY_STALE_MS = 5 * 60_000;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const label = (v: unknown): string | null => typeof v === 'string' ? v.slice(0, 120) : null;
const freshness = (at: number | null, now: number): string => at === null ? 'unknown' : at > now || now - at > INVENTORY_STALE_MS ? 'stale' : 'current';

export function environmentInventory(meshes: readonly LocalMeshEntry[], now = Date.now(), local?: { daemonId: string; facts: MeshNodeFacts }) {
    const machines = new Map<string, { daemonId: string; facts: MeshNodeFacts | undefined; nodes: Array<{ meshId: string; nodeId: string; slots: unknown[] }> }>();
    let omittedNodes = 0;
    for (const mesh of meshes) for (const node of mesh.nodes ?? []) {
        const daemonId = canonicalDaemonId(node.daemonId);
        if (!daemonId) continue;
        let row = machines.get(daemonId);
        if (!row) {
            if (machines.size >= INVENTORY_MAX_MACHINES) { omittedNodes++; continue; }
            row = { daemonId, facts: undefined, nodes: [] }; machines.set(daemonId, row);
        }
        const facts = node.nodeFacts;
        if (facts && (!row.facts || facts.reportedAt > row.facts.reportedAt)) row.facts = facts;
        if (row.nodes.length >= 64) { omittedNodes++; continue; }
        row.nodes.push({ meshId: mesh.id, nodeId: node.id, slots: (node.policy?.slots ?? []).slice(0, 32).map(s => ({
            providerType: label(s.provider), model: label(s.model), maxParallel: number(s.maxParallel),
        })) });
    }
    if (local) {
        const id = canonicalDaemonId(local.daemonId) ?? local.daemonId;
        const row = machines.get(id) ?? { daemonId: id, facts: undefined, nodes: [] };
        row.facts = local.facts;
        if (machines.has(id) || machines.size < INVENTORY_MAX_MACHINES) machines.set(id, row);
    }
    return { observedAt: now, source: 'authorized_roster_cache', omittedNodes, machines: [...machines.values()].map(row => {
        const f = row.facts;
        const at = number(f?.reportedAt);
        const providers = [...new Set([...Object.keys(f?.providerVersions ?? {}), ...Object.keys(f?.providerEnablement ?? {}),
            ...Object.keys(f?.providerInventory?.providers ?? {}), ...Object.keys(f?.quota ?? {}), ...row.nodes.flatMap(n => n.slots.map(s => (s as { providerType: string }).providerType).filter(Boolean))])].sort();
        return { daemonId: row.daemonId, reportedAt: at, freshness: freshness(at, now),
            platform: label(f?.platform), arch: label(f?.arch), label: label(f?.machineNickname), nodes: row.nodes,
            omittedProviders: Math.max(0, providers.length - INVENTORY_MAX_PROVIDERS),
            providers: providers.slice(0, INVENTORY_MAX_PROVIDERS).map(provider => {
                const q = f?.quota?.[provider]; const enabled = f?.providerEnablement?.[provider];
                const installed = f?.providerInventory?.providers[provider];
                const updatedAt = number(q?.updatedAt);
                const state = q ? q.status === 'ok' ? freshness(updatedAt, now) : q.status === 'error' ? 'error' : 'unavailable' : 'unknown';
                const window = (v: unknown) => {
                    const w = v as { usedPercent?: unknown; resetsAt?: unknown } | null;
                    return w ? { usedPercent: number(w.usedPercent), resetsAt: number(w.resetsAt) } : null;
                };
                return { provider: label(provider), installed: installed?.installed ?? null,
                    installationObservedAt: number(f?.providerInventory?.observedAt),
                    installationFreshness: freshness(number(f?.providerInventory?.observedAt), now),
                    version: label(f?.providerVersions?.[provider]), enabled: enabled?.enabled ?? null, quotaEnabled: enabled?.quotaEnabled ?? null,
                    quota: { state, status: q ? label(q.status) : 'unknown', updatedAt, fetchedAt: number(q?.metadata?.fetchedAt),
                        failureKind: label(q?.metadata?.failureKind),
                        // Stale numbers remain evidence, explicitly labelled; never a launch recommendation.
                        session: window(q?.session), weekly: window(q?.weekly), monthly: window(q?.monthly) } };
            }) };
    }) };
}

/** Project again at the consumer boundary: an older/malformed host cannot widen the content surface. */
export function observedInventoryMachine(raw: unknown) {
    const r = raw as any;
    if (!r || typeof r !== 'object' || typeof r.daemonId !== 'string') return null;
    const state = (v: unknown) => ['current', 'stale', 'unknown', 'error', 'unavailable'].includes(String(v)) ? String(v) : 'unknown';
    const bool = (v: unknown) => typeof v === 'boolean' ? v : null;
    const window = (v: any) => v && typeof v === 'object' ? { usedPercent: number(v.usedPercent), resetsAt: number(v.resetsAt) } : null;
    return { daemonId: canonicalDaemonId(r.daemonId), reportedAt: number(r.reportedAt), freshness: state(r.freshness),
        providers: (Array.isArray(r.providers) ? r.providers : []).slice(0, 32).map((p: any) => ({
            provider: label(p?.provider), installed: bool(p?.installed), enabled: bool(p?.enabled), quotaEnabled: bool(p?.quotaEnabled),
            installationObservedAt: number(p?.installationObservedAt), installationFreshness: state(p?.installationFreshness), version: label(p?.version),
            quota: { state: state(p?.quota?.state), status: ['ok','unknown','error','unavailable'].includes(p?.quota?.status) ? p.quota.status : 'unknown',
                updatedAt: number(p?.quota?.updatedAt), fetchedAt: number(p?.quota?.fetchedAt), failureKind: label(p?.quota?.failureKind),
                session: window(p?.quota?.session), weekly: window(p?.quota?.weekly), monthly: window(p?.quota?.monthly) },
        })) };
}
