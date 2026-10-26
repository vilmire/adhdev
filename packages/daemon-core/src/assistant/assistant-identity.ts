import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSessionLaunchRecord } from '@adhdev/mesh-shared';
import type { HostedCliRuntimeDescriptor } from '../commands/cli-manager.js';
import { isPidAlive } from '../launch-defaults/owned-lock.js';
import { getDefaultSessionHostEndpoint, SessionHostClient, type SessionHostDiagnostics } from '@adhdev/session-host-core';
import { isManagedSessionHostCommandLine } from '../commands/process-lifecycle.js';
import { readPersistedRuntimeRecord } from '../session-host/persisted-runtime-record.js';
import type { AssistantRegistryEntry } from './assistant-registry.js';

/** Workspace/title alone is never assistant evidence. Launch evidence must name this runtime. */
export function hasAssistantProvenance(record: Pick<HostedCliRuntimeDescriptor, 'runtimeId' | 'cliType' | 'assistant' | 'launchRecord'>): boolean {
    if (record.assistant === true) return true;
    const launch = parseSessionLaunchRecord(record.launchRecord);
    return !!launch && launch.sessionId === record.runtimeId && launch.providerType === record.cliType
        && (launch.launchedBy === 'assistant' || launch.roleLaunch?.role === 'assistant');
}

export function assistantRestoreCandidate(entry: AssistantRegistryEntry | null, records: HostedCliRuntimeDescriptor[]): HostedCliRuntimeDescriptor | undefined {
    const marked = records.filter(hasAssistantProvenance);
    const exact = records.find(r => r.runtimeId === entry?.sessionId);
    if (marked.some(r => r.runtimeId !== exact?.runtimeId) && (exact || entry?.sessionId || marked.length > 1)) {
        throw new Error(`assistant_identity_conflict: ${[entry?.sessionId, ...marked.map(r => r.runtimeId)].filter(Boolean).join(', ')}`);
    }
    return exact ?? (!entry?.sessionId && marked.length === 1 ? marked[0] : undefined);
}

/** Verify the namespace endpoint and host's recorded identity, then use its
 * current census. PID existence alone cannot distinguish a reused PID. */
async function verifiedHostAssistants(configDir: string, namespace: string, ipcKey: string, boundSessionId?: string): Promise<Set<string> | undefined> {
    const endpoint = getDefaultSessionHostEndpoint(namespace, { ipcKey });
    const client = new SessionHostClient({ endpoint, requestTimeoutMs: 500 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const response = await Promise.race([
            client.request<SessionHostDiagnostics>({ type: 'get_host_diagnostics', payload: { includeSessions: true } }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('assistant_host_probe_timeout')), 500); }),
        ]);
        const host = response.result;
        if (!response.success || !host || host.endpoint !== endpoint.path || !(host.hostStartedAt > 0)
            || typeof host.hostEntryPath !== 'string' || !isManagedSessionHostCommandLine(`node "${host.hostEntryPath.replace(/\\/g, '/')}"`)
            || !Array.isArray(host.sessions)) return undefined;
        return new Set(host.sessions.filter(r => r.category === 'cli' && !r.termination
            && ['starting', 'running', 'stopping', 'interrupted'].includes(r.lifecycle)
            && (r.sessionId === boundSessionId || hasAssistantProvenance({ runtimeId: r.sessionId, cliType: r.providerType, assistant: r.meta?.assistant === true, launchRecord: r.meta?.launchRecord })))
            .map(r => r.sessionId));
    } catch (error) {
        // A dead pid plus an absent endpoint can dismiss a stale snapshot. A
        // live/reused/missing pid cannot establish host identity or liveness.
        if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            try {
                const pid = Number((await readFile(join(configDir, `${namespace}-session-host.pid`), 'utf8')).trim());
                if (Number.isSafeInteger(pid) && pid > 0 && !isPidAlive(pid)) return new Set();
            } catch { /* Unverified evidence remains an owner decision. */ }
        }
        return undefined;
    } finally {
        if (timer) clearTimeout(timer);
        await client.close().catch(() => {});
    }
}

/** Shared config can contain other hosts. Their role records block a duplicate launch,
 * but must never be attached via this daemon's endpoint. Read failure is uncertainty. */
export async function persistedAssistantRuntimeIds(configDir: string, options: {
    /** Already derived at boot; resolving it here would perform sync realpath. */
    ipcKey: string;
    /** Compatibility flag: uncertainty never authorizes a second assistant. */
    allowUnverified?: boolean;
    currentNamespace?: string;
    onConflictEvidence?: (evidence: { namespace: string; sessionId: string; reason: string }) => void;
    onUnverified?: (namespace: string) => void;
    boundSessionId?: string;
    boundNamespace?: string;
}): Promise<Set<string>> {
    const ids = new Set<string>();
    const hostRoot = join(configDir, 'session-host');
    let namespaces: string[];
    try { namespaces = await readdir(hostRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') namespaces = []; else throw error; }
    if (options.boundNamespace && !namespaces.includes(options.boundNamespace)) namespaces.push(options.boundNamespace);
    for (const namespace of namespaces) {
        if (!/^[\w.-]+$/.test(namespace) || namespace === '.' || namespace === '..') continue;
        if (namespace !== options.boundNamespace && namespace !== options.currentNamespace) {
            if (/^adhdev-(?:test(?:-|$)|input-ann-)/.test(namespace)) continue;
            // Reserved global names belong to different install tracks. Custom
            // namespaces within this config still need positive death proof.
            if (['adhdev', 'adhdev-preview'].includes(options.currentNamespace ?? '')
                && ['adhdev', 'adhdev-preview'].includes(namespace)) continue;
        }
        const runtimes = join(hostRoot, namespace, 'runtimes');
        let files: string[];
        try { files = await readdir(runtimes); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = []; else throw error; }
        // The durable binding is also positive role provenance, including legacy
        // runtimes whose metadata predates assistant:true or whose file rotated.
        const candidates = new Set<string>(options.boundSessionId && namespace === options.boundNamespace ? [options.boundSessionId] : []);
        for (const file of files.filter(f => /^[\w-]+\.json$/.test(f))) {
            let r: Record<string, any>;
            try { r = await readPersistedRuntimeRecord(join(runtimes, file)); }
            catch { candidates.add(file.slice(0, -5)); continue; }
            if (r.category !== 'cli' || r.termination || ['stopped', 'failed'].includes(r.lifecycle)
                || (r.sessionId !== options.boundSessionId && !hasAssistantProvenance({ runtimeId: r.sessionId, cliType: r.providerType, assistant: r.meta?.assistant, launchRecord: r.meta?.launchRecord }))) continue;
            if (typeof r.sessionId !== 'string' || !/^[\w-]+$/.test(r.sessionId)) throw new Error('assistant_runtime_identity_missing');
            try { await access(join(hostRoot, namespace, 'tombstones', `${r.sessionId}.json`)); continue; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            candidates.add(r.sessionId);
        }
        // Ordinary sessions never cause PID/socket probes. One census per host,
        // irrespective of the number of assistant records or snapshots.
        if (!candidates.size) continue;
        const verified = await verifiedHostAssistants(configDir, namespace, options.ipcKey, options.boundSessionId);
        if (verified) for (const id of verified) {
            ids.add(id);
            options.onConflictEvidence?.({ namespace, sessionId: id, reason: 'host census reports a live assistant' });
        }
        else {
            for (const id of candidates) {
                ids.add(id);
                options.onConflictEvidence?.({ namespace, sessionId: id, reason: 'host endpoint or identity unverifiable; cannot prove the writer dead' });
            }
            options.onUnverified?.(namespace);
        }
    }
    return ids;
}
