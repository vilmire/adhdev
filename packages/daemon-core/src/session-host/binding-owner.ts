import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config/config.js';

/** A complete host inventory is authoritative only for bindings owned here. */
export interface HostedBindingOwner {
    endpoint: string;
    managedBy: string;
    clientId: string;
    namespace?: string;
}

export function readHostedBindingOwner(raw: unknown): HostedBindingOwner | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    if (![r.endpoint, r.managedBy, r.clientId].every(v => typeof v === 'string' && v.trim())) return undefined;
    return { endpoint: r.endpoint as string, managedBy: r.managedBy as string, clientId: r.clientId as string,
        ...(typeof r.namespace === 'string' && /^[\w.-]+$/.test(r.namespace) ? { namespace: r.namespace } : {}) };
}

export function sameHostedBindingOwner(a: unknown, b: unknown): boolean {
    const left = readHostedBindingOwner(a), right = readHostedBindingOwner(b);
    return !!left && !!right && left.endpoint === right.endpoint
        && left.managedBy === right.managedBy && left.clientId === right.clientId
        && (!left.namespace || !right.namespace || left.namespace === right.namespace);
}

export interface PersistedBindingEvidence { namespace: string; record: Record<string, any>; terminal: boolean }

/** Resolve the exact UUID, including storage's {record,snapshot} envelope and tombstones. */
export function persistedBindingEvidence(sessionId: string, configDir = getConfigDir()): PersistedBindingEvidence[] {
    if (!/^[\w-]+$/.test(sessionId)) return [];
    const root = join(configDir, 'session-host');
    let namespaces: string[];
    try { namespaces = readdirSync(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const evidence: PersistedBindingEvidence[] = [];
    for (const namespace of namespaces) for (const kind of ['runtimes', 'tombstones']) {
        let value;
        try { value = JSON.parse(readFileSync(join(root, namespace, kind, `${sessionId}.json`), 'utf8')); }
        // ENOTDIR: a stray file (macOS Finder's .DS_Store) sits beside the namespace dirs.
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
        const record = value?.record ?? value;
        if (record?.sessionId !== sessionId) continue;
        evidence.push({ namespace, record, terminal: kind === 'tombstones' || !!record.termination || ['stopped', 'failed'].includes(record.lifecycle) });
    }
    return evidence;
}

export function resolveHostedBindingOwner(sessionId: string, recorded: unknown, owner: HostedBindingOwner | undefined,
    liveIds: ReadonlySet<string>, configDir = getConfigDir()): HostedBindingOwner | undefined {
    const explicit = readHostedBindingOwner(recorded);
    if (explicit) return explicit;
    if (!owner) return undefined;
    const evidence = persistedBindingEvidence(sessionId, configDir);
    // A UUID present in several namespaces is ambiguous, even if one is ours.
    if (evidence.some(e => e.namespace !== owner.namespace ||
        (e.record.meta?.managedBy && e.record.meta.managedBy !== owner.managedBy))) return undefined;
    if (liveIds.has(sessionId) || (owner.namespace && evidence.some(e => e.namespace === owner.namespace))) return owner;
    return undefined;
}

export function hasTerminalBindingEvidence(sessionId: string): boolean {
    const evidence = persistedBindingEvidence(sessionId);
    return evidence.length > 0 && evidence.every(e => e.terminal);
}
