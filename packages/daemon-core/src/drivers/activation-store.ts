import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config/config.js';
import { writeFileAtomic600 } from '../assistant/store-guards.js';
import type { DriverManifest } from './contracts.js';
import { deriveDriverRiskClass, type DriverRiskClass } from './risk-class.js';

export type InstalledDriverManifest = DriverManifest & { _sourceTrust?: string };
export interface DriverActivation {
    type: string;
    treeDigest: string;
    approvedBy: 'bundled' | 'owner';
    approvedAt: string;
    declaredAccessSnapshot: NonNullable<DriverManifest['declaredAccess']>;
    riskClass: DriverRiskClass;
    disabled?: boolean;
}
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export function validDriverDigest(value: unknown): value is string {
    return typeof value === 'string' && DIGEST.test(value);
}

/** Machine-local owner decisions. Every operation reads disk so multiple store
 * instances see disables immediately; synchronous writes cannot interleave in
 * the daemon event loop. Corrupt/unreadable stores fail closed, never reset. */
export class DriverActivationStore {
    readonly path: string;
    private readonly now: () => Date;
    constructor(opts: { configDir?: string; now?: () => Date } = {}) {
        this.path = join(opts.configDir ?? getConfigDir(), 'drivers', 'activations.json');
        this.now = opts.now ?? (() => new Date());
    }
    list(): DriverActivation[] {
        let raw: string;
        try { raw = readFileSync(this.path, 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const doc = JSON.parse(raw);
        if (doc?.version !== 1 || !Array.isArray(doc.activations) || doc.activations.some((r: DriverActivation) =>
            !r || typeof r.type !== 'string' || !r.type || !validDriverDigest(r.treeDigest)
            || !['bundled', 'owner'].includes(r.approvedBy) || !Number.isFinite(Date.parse(r.approvedAt))
            || !['low', 'elevated'].includes(r.riskClass) || !r.declaredAccessSnapshot
            || typeof r.declaredAccessSnapshot !== 'object' || Array.isArray(r.declaredAccessSnapshot)
            || r.disabled !== undefined && typeof r.disabled !== 'boolean')) {
            throw new Error('Invalid driver activation store');
        }
        return doc.activations;
    }
    isDisabled(type: string): boolean { return this.list().some(r => r.type === type && r.disabled === true); }
    isReady(type: string, digest: string): boolean {
        try {
            const rows = this.list();
            return validDriverDigest(digest) && !rows.some(r => r.type === type && r.disabled === true)
                && rows.some(r => r.type === type && r.treeDigest === digest);
        } catch { return false; }
    }
    autoActivateIfTrustedLow(module: InstalledDriverManifest, digest: string): DriverActivation | null {
        if (module._sourceTrust !== 'trusted' || deriveDriverRiskClass(module).riskClass !== 'low') return null;
        return this.record(module, digest, 'bundled');
    }
    /** Call only after owner-source approval. A pending proposal cannot undo a disable. */
    approve(module: DriverManifest, digest: string): DriverActivation | null {
        return this.record(module, digest, 'owner');
    }
    /** Owner toggle API for G1a-5: disabling persists across digests; explicit
     * re-enable clears that decision and approves this exact current digest. */
    setDisabled(module: DriverManifest, digest: string, disabled: boolean): DriverActivation {
        // A disable-only record is not approval for that old digest. Drop
        // tombstones on explicit re-enable instead of turning them into grants.
        const rows = this.list().filter(row => disabled || row.type !== module.type || !row.disabled);
        return this.saveRecord(rows, module, digest, 'owner', disabled);
    }
    /** Owner re-enable of external code clears disables without granting activation. */
    clearDisabled(type: string): void {
        const rows = this.list().filter(row => row.type !== type || !row.disabled);
        writeFileAtomic600(this.path, JSON.stringify({ version: 1, activations: rows }, null, 2));
    }
    private record(module: DriverManifest, digest: string, approvedBy: DriverActivation['approvedBy']): DriverActivation | null {
        const rows = this.list();
        if (rows.some(r => r.type === module.type && r.disabled === true)) return null;
        const existing = rows.find(r => r.type === module.type && r.treeDigest === digest);
        if (existing) return existing;
        return this.saveRecord(rows, module, digest, approvedBy);
    }
    private saveRecord(rows: DriverActivation[], module: DriverManifest, digest: string,
        approvedBy: DriverActivation['approvedBy'], disabled = false): DriverActivation {
        if (!validDriverDigest(digest) || module.category !== 'driver') throw new Error('Invalid driver activation identity');
        const rec: DriverActivation = { type: module.type, treeDigest: digest, approvedBy,
            approvedAt: this.now().toISOString(), declaredAccessSnapshot: structuredClone(module.declaredAccess ?? {}),
            riskClass: deriveDriverRiskClass(module).riskClass, ...(disabled ? { disabled: true } : {}) };
        const kept = rows.filter(r => r.type !== module.type || r.treeDigest !== digest);
        writeFileAtomic600(this.path, JSON.stringify({ version: 1, activations: [...kept, rec] }, null, 2));
        return rec;
    }
}
