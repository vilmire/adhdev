import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config/config.js';
import { writeFileAtomic600 } from '../assistant/store-guards.js';

interface GrantRecord { granted: boolean; updatedAt: string }
interface GrantDoc { version: 1; grants: Record<string, Record<string, GrantRecord>> }
const ID = /^[a-z][a-z0-9_]*$/;
const TYPE = /^[a-z][a-z0-9-]*$/;

/** Owner permission checkboxes per driver type. Machine-local, default off.
 * Every query reads disk, so unchecking applies to the very next call. A
 * corrupt or unreadable file fails closed (everything off) and refuses writes
 * rather than overwriting, so a bad file is never silently "repaired". */
export class DriverGrantStore {
    readonly path: string;
    private readonly now: () => Date;
    constructor(opts: { configDir?: string; now?: () => Date } = {}) {
        this.path = join(opts.configDir ?? getConfigDir(), 'drivers', 'grants.json');
        this.now = opts.now ?? (() => new Date());
    }
    /** Throws when the file exists but is unreadable or malformed. */
    private load(): GrantDoc {
        let raw: string;
        try { raw = readFileSync(this.path, 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, grants: {} };
            throw error;
        }
        const doc = JSON.parse(raw) as GrantDoc;
        const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
        if (doc?.version !== 1 || !isObj(doc.grants)) throw new Error('Invalid driver grant store');
        for (const [type, byId] of Object.entries(doc.grants)) {
            if (!TYPE.test(type) || !isObj(byId)) throw new Error('Invalid driver grant store');
            for (const [id, rec] of Object.entries(byId)) {
                if (!ID.test(id) || !isObj(rec) || typeof rec.granted !== 'boolean' || !Number.isFinite(Date.parse(String(rec.updatedAt)))) {
                    throw new Error('Invalid driver grant store');
                }
            }
        }
        return doc;
    }
    /** True when the store can be read (or does not exist yet). */
    isHealthy(): boolean { try { this.load(); return true; } catch { return false; } }
    isGranted(type: string, grantId: string): boolean {
        try { return this.load().grants[type]?.[grantId]?.granted === true; } catch { return false; }
    }
    /** Granted state for the given ids; unknown ids and any read failure are false. */
    snapshot(type: string, grantIds: readonly string[]): Record<string, boolean> {
        let byId: Record<string, GrantRecord> | undefined;
        try { byId = this.load().grants[type]; } catch { byId = undefined; }
        return Object.fromEntries(grantIds.map(id => [id, byId?.[id]?.granted === true]));
    }
    /** Throws on a corrupt store instead of overwriting it. */
    set(type: string, changes: Record<string, boolean>): void {
        if (!TYPE.test(type)) throw new Error('Invalid driver type');
        for (const id of Object.keys(changes)) if (!ID.test(id)) throw new Error('Invalid grant id');
        const doc = this.load();
        const updatedAt = this.now().toISOString();
        const byId = { ...(doc.grants[type] ?? {}) };
        for (const [id, granted] of Object.entries(changes)) byId[id] = { granted, updatedAt };
        writeFileAtomic600(this.path, JSON.stringify({ version: 1, grants: { ...doc.grants, [type]: byId } }, null, 2));
    }
}
