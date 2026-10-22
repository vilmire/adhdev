import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSessionLaunchRecord } from '@adhdev/mesh-shared';
import type { HostedCliRuntimeDescriptor } from '../commands/cli-manager.js';
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

/** Shared config can contain other hosts. Their role records block a duplicate launch,
 * but must never be attached via this daemon's endpoint. Read failure is uncertainty. */
export function persistedAssistantRuntimeIds(configDir: string): Set<string> {
    const ids = new Set<string>();
    const hostRoot = join(configDir, 'session-host');
    let namespaces: string[];
    try { namespaces = readdirSync(hostRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ids; throw error; }
    for (const namespace of namespaces) {
        const runtimes = join(hostRoot, namespace, 'runtimes');
        let files: string[];
        try { files = readdirSync(runtimes); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        for (const file of files.filter(f => f.endsWith('.json'))) {
            const r = JSON.parse(readFileSync(join(runtimes, file), 'utf8'));
            if (r.category !== 'cli' || ['stopped', 'failed'].includes(r.lifecycle)) continue;
            if (hasAssistantProvenance({ runtimeId: r.sessionId, cliType: r.providerType, assistant: r.meta?.assistant, launchRecord: r.meta?.launchRecord })) {
                if (typeof r.sessionId !== 'string' || !r.sessionId) throw new Error('assistant_runtime_identity_missing');
                ids.add(r.sessionId);
            }
        }
    }
    return ids;
}
