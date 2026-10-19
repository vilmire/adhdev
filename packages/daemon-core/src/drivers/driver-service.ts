/** Local-only driver orchestration. Mesh policy and mailbox delivery are injected ports. */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ProviderRegistry } from '../providers/provider-registry.js';
import type { SessionLifecycleBus } from '../sessions/lifecycle-bus.js';
import type { AssistantDriverStaging } from '../assistant/driver-staging.js';
import type { DriverActivationStore, InstalledDriverManifest } from './activation-store.js';
import { ManagedMcpProcess } from './managed-mcp-process.js';
import type { DriverMcpClient } from './mcp-client.js';
import { DriverActionStaging, type DriverWorkerIdentity, type DriverOwnerSource } from './staged-action.js';
import { deriveDriverRiskClass } from './risk-class.js';
import { readDriverInputSchema, validateDriverArgs } from './input-schema.js';

export type DriverInstanceState = 'discovered' | 'validated' | 'installed' | 'approved' | 'ready' | 'running' | 'stopped' | 'failed' | 'removed';
type ManagedClient = DriverMcpClient & { start(): Promise<void>; state: string };
type Installed = { module: InstalledDriverManifest; treeDigest: string; cwd: string };
export interface DriverReply { success: boolean; code?: string; [key: string]: unknown }
export interface DriverInvocationRecord {
    invocationId: string; driverType: string; action: string; activationDigest: string;
    caller: ({ kind: 'worker' } & DriverWorkerIdentity) | { kind: 'owner'; source: DriverOwnerSource; stagedRequestId: string; resolvedAt: number };
    resourceKeys: string[]; startedAt: number; completedAt?: number;
    status: 'running' | 'completed' | 'failed'; output?: unknown; error?: string;
}
export interface DriverServicePorts {
    registry: Pick<ProviderRegistry, 'getByCategory'>;
    readCurrent(type: string): Installed | null;
    activations: DriverActivationStore;
    activationStaging: AssistantDriverStaging;
    actions: DriverActionStaging;
    policy(meshId: string): Promise<Record<string, { actions: string[] }> | undefined>;
    relay(identity: DriverWorkerIdentity, result: DriverReply): unknown;
    bus?: SessionLifecycleBus | null;
    now?: () => number;
    createProcess?: (installed: Installed) => ManagedClient;
}
const refused = (code: string): DriverReply => ({ success: false, code });
const LEASE_MS = 30 * 60_000;
export class DriverService {
    private closed = false;
    private readonly instances = new Map<string, { digest: string; state: DriverInstanceState; process?: ManagedClient }>();
    private readonly leases = new Map<string, { sessionId: string; expiresAt: number }>();
    private readonly records: DriverInvocationRecord[] = [];
    private readonly now: () => number;
    private readonly unsubscribe?: () => void;
    constructor(private readonly ports: DriverServicePorts) {
        this.now = ports.now ?? Date.now;
        this.unsubscribe = ports.bus?.on('terminated', event => {
            for (const [key, lease] of this.leases) if (lease.sessionId === event.sessionId) this.leases.delete(key);
        }, { name: 'driver-leases' });
    }
    private read(type: string): Installed | null {
        try { return this.ports.readCurrent(type); } catch { return null; }
    }
    private runtimeDirFor(installed: Installed): string {
        const baseDir = dirname(this.ports.activations.path);
        const candidate = join(baseDir, 'runtime', installed.module.type);
        const rel = relative(resolve(installed.cwd), resolve(candidate));
        if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
            return join(tmpdir(), 'adhdev-driver-runtime', installed.module.type);
        }
        return candidate;
    }
    async describe(type: string): Promise<DriverReply> {
        const installed = this.read(type);
        if (!installed) {
            const previous = this.instances.get(type);
            if (previous) { previous.state = 'removed'; await previous.process?.close(); }
            return refused('driver_not_installed');
        }
        const { module, treeDigest } = installed;
        let instance = this.instances.get(type);
        if (instance && instance.digest !== treeDigest) {
            await instance.process?.close();
            instance = undefined;
        }
        if (!instance) {
            instance = { digest: treeDigest, state: 'validated' };
            this.instances.set(type, instance);
        }
        let prepared;
        try { prepared = this.ports.activationStaging.prepare(module, treeDigest, this.ports.activations); }
        catch { return refused('activation_unavailable'); }
        if (prepared.state !== 'ready') {
            await instance.process?.close();
            instance.process = undefined;
            instance.state = 'installed';
        } else if (instance.process) {
            instance.state = instance.process?.state === 'failed' ? 'failed'
                : instance.process.state === 'stopped' ? 'stopped' : 'running';
        } else instance.state = 'ready';
        return { success: true, type, name: module.name, providerVersion: module.providerVersion,
            ...(module.publisher ? { publisher: module.publisher } : {}), state: instance.state,
            treeDigest, actions: await Promise.all(module.actions.map(async action => ({ ...action,
                ...(action.inputSchema ? { inputSchema: await readDriverInputSchema(installed.cwd, action.inputSchema) } : {}) }))), resources: module.resources ?? [],
            declaredAccess: module.declaredAccess ?? {}, ...deriveDriverRiskClass(module),
            leases: (module.resources ?? []).map(r => ({ key: r.key, ...this.leases.get(JSON.stringify([type, r.key])) })), ...('stagedId' in prepared ? { stagedId: prepared.stagedId } : {}) };
    }
    async list(): Promise<DriverReply> {
        const modules = this.ports.registry.getByCategory('driver');
        const types = new Set(modules.map(m => m.type));
        for (const [type, instance] of this.instances) if (!types.has(type)) {
            await instance.process?.close(); instance.state = 'removed';
        }
        return { success: true, drivers: await Promise.all(modules.map(m => this.describe(m.type))) };
    }
    async setEnabled(type: string, enabled: boolean): Promise<DriverReply> {
        const installed = this.read(type);
        if (!installed) return refused('driver_not_installed');
        // Untrusted code always requires the Inbox, even when an owner toggles it.
        if (enabled && installed.module._sourceTrust !== 'trusted') {
            if (this.ports.activations.isDisabled(type)) this.ports.activations.clearDisabled(type);
            const stagedId = this.ports.activationStaging.write(installed.module, installed.treeDigest);
            return { success: true, state: 'installed', stagedId };
        }
        this.ports.activations.setDisabled(installed.module, installed.treeDigest, !enabled);
        return this.describe(type);
    }
    async invoke(identity: DriverWorkerIdentity | null, input: { type: string; action: string; args?: unknown; resourceKey?: string; target?: unknown }): Promise<DriverReply> {
        // 1. Only the command boundary can supply a cryptographically resolved identity.
        if (!identity?.sessionId || !identity.meshId || !identity.taskId) return refused('worker_credential_required');
        if (input.target !== undefined && input.target !== 'local') return refused('unsupported');
        // resolveWorkerIdentity also returns a secret token. Persist only public identity fields.
        const caller: DriverWorkerIdentity = { meshId: identity.meshId, taskId: identity.taskId, sessionId: identity.sessionId,
            ...(identity.attemptId ? { attemptId: identity.attemptId } : {}), ...(identity.nodeId ? { nodeId: identity.nodeId } : {}) };
        return this.execute(caller, input);
    }
    private async execute(identity: DriverWorkerIdentity, input: { type: string; action: string; args?: unknown; resourceKey?: string },
        approval?: { source: DriverOwnerSource; id: string; digest: string; expiresAt: number }): Promise<DriverReply> {
        // 2. Refresh bytes and machine-local activation before every invocation.
        const installed = this.read(input.type);
        if (!installed) return refused('driver_not_approved');
        if (approval && this.now() >= approval.expiresAt) return refused('expired');
        if (approval && installed.treeDigest !== approval.digest) return refused('stale');
        try { this.ports.activationStaging.prepare(installed.module, installed.treeDigest, this.ports.activations); }
        catch { return refused('driver_not_approved'); }
        if (!this.ports.activations.isReady(input.type, installed.treeDigest)) return refused('driver_not_approved');
        // 3. Policy comes from the daemon's mesh record, never caller-supplied inlineMesh.
        const policy = await this.ports.policy(identity.meshId).catch(() => undefined);
        const allowed = policy && Object.hasOwn(policy, input.type) ? policy[input.type] : undefined;
        const action = installed.module.actions.find(a => a.id === input.action);
        if (!action || !Array.isArray(allowed?.actions) || !allowed.actions.includes(input.action)) return refused('driver_not_allowed_for_mesh');
        // 4. A worker can propose destructive execution, but cannot execute it.
        if (action.risk === 'destructive' && !approval) {
            const staged = this.ports.actions.write({ type: input.type, action: input.action,
                args: (input.args ?? {}) as Record<string, unknown>, activationDigest: installed.treeDigest, requester: identity,
                ...(input.resourceKey !== undefined ? { resourceKey: input.resourceKey } : {}) });
            return { ...refused('owner_approval_required'), stagedId: staged.id, expiresAt: staged.expiresAt };
        }
        // 5. Reserve the selected declared resource, or all resources when no key was selected.
        const resources = installed.module.resources ?? [];
        if (input.resourceKey !== undefined && !resources.some(r => r.key === input.resourceKey)) return refused('invalid_arguments');
        const resourceKeys = resources.filter(r => input.resourceKey === undefined || r.key === input.resourceKey).map(r => r.key);
        const keys = resourceKeys.map(key => JSON.stringify([input.type, key]));
        for (const key of keys) {
            const lease = this.leases.get(key);
            if (lease && lease.expiresAt > this.now() && lease.sessionId !== identity.sessionId) return refused('lease_held');
        }
        const added: string[] = [];
        for (const key of keys) {
            if (this.leases.get(key)?.sessionId !== identity.sessionId) added.push(key);
            this.leases.set(key, { sessionId: identity.sessionId, expiresAt: this.now() + LEASE_MS });
        }
        const releaseNew = () => { for (const key of added) if (this.leases.get(key)?.sessionId === identity.sessionId) this.leases.delete(key); };
        // 6. Local JSON Schema validation, before any process is constructed or started.
        if (!await validateDriverArgs(installed.cwd, action.inputSchema, input.args ?? {})) {
            releaseNew(); return refused('invalid_arguments');
        }
        // Schema I/O yields: fail closed if bytes, approval, or policy changed meanwhile.
        const current = this.read(input.type);
        if (current?.treeDigest !== installed.treeDigest || !this.ports.activations.isReady(input.type, installed.treeDigest)) {
            releaseNew(); return refused('driver_not_approved');
        }
        const latest = await this.ports.policy(identity.meshId).catch(() => undefined);
        if (!latest || !Object.hasOwn(latest, input.type) || !Array.isArray(latest[input.type]?.actions) || !latest[input.type].actions.includes(input.action)) {
            releaseNew(); return refused('driver_not_allowed_for_mesh');
        }
        if (this.read(input.type)?.treeDigest !== installed.treeDigest || !this.ports.activations.isReady(input.type, installed.treeDigest)) {
            releaseNew(); return refused('driver_not_approved');
        }
        if (keys.some(key => this.leases.get(key)?.sessionId !== identity.sessionId)) { releaseNew(); return refused('lease_held'); }
        if (approval && this.now() >= approval.expiresAt) { releaseNew(); return refused('expired'); }
        if (this.closed) { releaseNew(); return refused('driver_stopped'); }
        let instance = this.instances.get(input.type);
        if (instance && instance.digest !== installed.treeDigest) {
            await instance.process?.close();
            if (this.instances.get(input.type) === instance) this.instances.delete(input.type);
            return this.execute(identity, input, approval);
        }
        if (!instance) { instance = { digest: installed.treeDigest, state: 'approved' }; this.instances.set(input.type, instance); }
        const record: DriverInvocationRecord = { invocationId: randomUUID(), driverType: input.type,
            action: input.action, activationDigest: installed.treeDigest, resourceKeys, startedAt: this.now(), status: 'running',
            caller: approval ? { kind: 'owner', source: approval.source, stagedRequestId: approval.id, resolvedAt: this.now() }
                : { kind: 'worker', ...identity } };
        this.records.push(record); if (this.records.length > 100) this.records.shift();
        try {
            instance.process ??= this.ports.createProcess?.(installed) ?? new ManagedMcpProcess(installed.module.runtime, { cwd: this.runtimeDirFor(installed), packageDir: installed.cwd });
            await instance.process.start(); instance.state = 'running';
            const output = await instance.process.callTool(action.tool, (input.args ?? {}) as Record<string, unknown>);
            record.status = output.isError ? 'failed' : 'completed';
            const json = JSON.stringify(output);
            record.output = json.length <= 64_000 ? output : { truncated: true, text: json.slice(0, 64_000) };
            return { success: !output.isError, invocationId: record.invocationId, status: record.status, output: record.output };
        } catch (error) {
            instance.state = instance.process?.state === 'failed' ? 'failed' : 'stopped';
            record.status = 'failed'; record.error = error instanceof Error ? error.message : String(error);
            return { ...refused('driver_execution_failed'), invocationId: record.invocationId, error: record.error };
        } finally { record.completedAt = this.now(); }
    }
    async resolveAction(id: string, decision: 'apply' | 'discard', source: DriverOwnerSource): Promise<DriverReply> {
        if (!['p2p', 'ws', 'standalone'].includes(source)) return refused('COMMAND_SOURCE_REJECTED');
        const pending = this.ports.actions.read(id);
        const claim = this.ports.actions.claim(id, pending ? this.read(pending.type)?.treeDigest : undefined, decision);
        if ('code' in claim) {
            const result = { success: claim.code === 'discarded', code: claim.code, result: claim.code, stagedId: id };
            if (pending?.status === 'pending' && ['expired', 'stale', 'discarded'].includes(claim.code)) {
                return { ...result, delivery: this.relay(pending.requester, result) };
            }
            return result;
        }
        const r = claim.record;
        let result: DriverReply;
        try { result = await this.execute(r.requester, r, { source, id, digest: r.activationDigest, expiresAt: r.expiresAt }); }
        catch { result = refused('driver_execution_failed'); }
        const delivery = this.relay(r.requester, { ...result, stagedId: id });
        return { ...result, stagedId: id, delivery };
    }
    private relay(identity: DriverWorkerIdentity, result: DriverReply): unknown {
        try { return this.ports.relay(identity, result); } catch { return { ok: false, error: 'mailbox_unavailable' }; }
    }
    stagedActions() { return this.ports.actions.list(); }
    invocations(): DriverInvocationRecord[] { return structuredClone(this.records); }
    async close(): Promise<void> {
        this.closed = true;
        this.unsubscribe?.(); this.leases.clear();
        await Promise.all([...this.instances.values()].map(i => i.process?.close()));
    }
}
