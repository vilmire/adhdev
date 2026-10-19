/** Driver activation proposals use the existing owner-only assistant Inbox.
 * No tool-origin classification can replace explicit consent for external code. */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getConfigDir } from '../config/config.js';
import { writeFileAtomic600 } from './store-guards.js';
import { DriverActivationStore, validDriverDigest, type InstalledDriverManifest } from '../drivers/activation-store.js';
import type { DriverManifest } from '../drivers/contracts.js';
import { deriveDriverRiskClass, type DriverRiskClass } from '../drivers/risk-class.js';

export interface StagedDriverActivation {
    kind: 'driver_activation';
    id: string;
    createdAt: string;
    origin: 'driver';
    type: string;
    name: string;
    providerVersion: string;
    publisher?: string;
    treeDigest: string;
    trust: string;
    declaredAccess: NonNullable<DriverManifest['declaredAccess']>;
    runtime: DriverManifest['runtime'];
    riskClass: DriverRiskClass;
    reasons: string[];
}
const ID = /^driver-activation-[A-Za-z0-9-]+$/;
const MAX_AGE = 14 * 24 * 60 * 60 * 1000;

export class AssistantDriverStaging {
    readonly dir: string;
    private readonly now: () => Date;
    private readonly discarded = new Set<string>();
    constructor(opts: { configDir?: string; now?: () => Date } = {}) {
        this.dir = join(opts.configDir ?? getConfigDir(), 'assistant', 'staged');
        this.now = opts.now ?? (() => new Date());
    }
    private path(id: string): string { return join(this.dir, `${id}.json`); }
    write(module: InstalledDriverManifest, digest: string): string {
        if (!validDriverDigest(digest) || module.category !== 'driver') throw new Error('Invalid driver proposal');
        this.discarded.delete(`${module.type}\0${digest}`);
        this.expire();
        const existing = this.list().find(r => r.type === module.type && r.treeDigest === digest);
        if (existing) return existing.id;
        const id = `driver-activation-${this.now().getTime()}-${randomBytes(8).toString('hex')}`;
        const rec: StagedDriverActivation = { kind: 'driver_activation', id, createdAt: this.now().toISOString(), origin: 'driver',
            type: module.type, name: module.name, providerVersion: module.providerVersion,
            ...(module.publisher ? { publisher: module.publisher } : {}),
            treeDigest: digest, trust: module._sourceTrust ?? 'unknown',
            declaredAccess: structuredClone(module.declaredAccess ?? {}), runtime: structuredClone(module.runtime),
            ...deriveDriverRiskClass(module) };
        writeFileAtomic600(this.path(id), JSON.stringify(rec, null, 2));
        return id;
    }
    read(id: string): StagedDriverActivation | null {
        if (!ID.test(id)) return null;
        try {
            const r = JSON.parse(readFileSync(this.path(id), 'utf8')) as StagedDriverActivation;
            if (r?.kind === 'driver_activation' && r.id === id && r.origin === 'driver'
                && typeof r.type === 'string' && !!r.type
                && typeof r.name === 'string' && !!r.name
                && typeof r.providerVersion === 'string' && !!r.providerVersion
                && (r.publisher === undefined || typeof r.publisher === 'string')
                && validDriverDigest(r.treeDigest)
                && typeof r.trust === 'string' && r.runtime?.kind === 'mcp-stdio' && typeof r.runtime.command === 'string'
                && r.declaredAccess && typeof r.declaredAccess === 'object' && !Array.isArray(r.declaredAccess)
                && ['low', 'elevated'].includes(r.riskClass) && Array.isArray(r.reasons) && r.reasons.every(s => typeof s === 'string')
                && Number.isFinite(Date.parse(r.createdAt))) return r;
        } catch { /* missing/corrupt proposals never grant approval */ }
        return null;
    }
    list(): StagedDriverActivation[] {
        if (!existsSync(this.dir)) return [];
        return readdirSync(this.dir).filter(n => n.startsWith('driver-activation-') && n.endsWith('.json'))
            .map(n => this.read(n.slice(0, -5))).filter((r): r is StagedDriverActivation => r !== null)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    remove(id: string): void {
        if (!ID.test(id)) return;
        try { unlinkSync(this.path(id)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    /** Same retention window as the existing assistant staged-write stores. */
    expire(maxAgeMs = MAX_AGE): string[] {
        const dropped: string[] = [];
        for (const rec of this.list()) {
            if (this.now().getTime() - Date.parse(rec.createdAt) >= maxAgeMs) {
                this.remove(rec.id);
                dropped.push(rec.id);
            }
        }
        return dropped;
    }
    /** Entry point for G1a-5 discovery/service wiring. Trusted elevated drivers
     * remain installed until an owner toggle; all external trust levels stage. */
    prepare(module: InstalledDriverManifest, digest: string, store: DriverActivationStore):
        { state: 'ready' | 'installed' | 'staged'; stagedId?: string } {
        if (store.isDisabled(module.type)) return { state: 'installed' };
        if (store.isReady(module.type, digest) || store.autoActivateIfTrustedLow(module, digest)) return { state: 'ready' };
        if (module._sourceTrust === 'trusted') return { state: 'installed' };
        const existing = this.list().find(r => r.type === module.type && r.treeDigest === digest);
        if (existing) return { state: 'staged', stagedId: existing.id };
        if (this.discarded.has(`${module.type}\0${digest}`)) return { state: 'installed' };
        return { state: 'staged', stagedId: this.write(module, digest) };
    }
    /** Called only behind assistant_staged_resolve's owner-source gate. Read the
     * currently installed tree, never caller-supplied type/digest/permissions. */
    resolve(id: string, decision: 'apply' | 'discard', store: DriverActivationStore,
        readCurrent: (type: string) => { module: InstalledDriverManifest; treeDigest: string } | null) {
        const fail = (code: string) => ({ success: false as const, code });
        if (decision !== 'apply' && decision !== 'discard') return fail('invalid_args');
        const rec = this.read(id);
        if (!rec) return fail('staged_not_found');
        if (decision === 'discard') {
            this.discarded.add(`${rec.type}\0${rec.treeDigest}`);
            this.remove(id);
            return { success: true as const, result: 'discarded' };
        }
        if (this.now().getTime() - Date.parse(rec.createdAt) >= MAX_AGE) return fail('expired');
        const current = readCurrent(rec.type);
        if (!current) return fail('driver_not_installed');
        const risk = deriveDriverRiskClass(current.module);
        if (current.module.type !== rec.type || current.module.name !== rec.name
            || current.module.providerVersion !== rec.providerVersion
            || (current.module.publisher ?? undefined) !== (rec.publisher ?? undefined)
            || current.treeDigest !== rec.treeDigest || risk.riskClass !== rec.riskClass
            || JSON.stringify(risk.reasons) !== JSON.stringify(rec.reasons)
            || JSON.stringify(current.module.declaredAccess ?? {}) !== JSON.stringify(rec.declaredAccess)
            || JSON.stringify(current.module.runtime) !== JSON.stringify(rec.runtime)) return fail('stale');
        if (!store.approve(current.module, rec.treeDigest)) return fail('driver_disabled');
        this.remove(id);
        return { success: true as const, result: 'applied', type: rec.type, treeDigest: rec.treeDigest };
    }
}

