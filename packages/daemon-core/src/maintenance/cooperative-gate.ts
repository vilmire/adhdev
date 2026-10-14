/** Cooperative maintenance only. Independent of every strict worker-bridge
 * journal/policy. Enrollment is never deleted or interpreted as native authority. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfigDir } from '../config/config.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';

export const MAINTENANCE_BOOT_NONCE = randomUUID();
export const MAINTENANCE_FILE = 'cooperative-maintenance.json';
const marker = 'cooperative-maintenance.enrolled';
const seen = new Set<string>();
interface AdmissionContext { root: string; snapshot: string; lease?: { release(): void; references: number } }
const context = new AsyncLocalStorage<AdmissionContext>();
let activeAdmissions = 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const id = (s: unknown): s is string => typeof s === 'string' && !!s && s.trim() === s;
export interface RetainedMaintenanceHost {
    pid: number; birth: string; endpoint: string; entryPath: string; nodePath: string; prefix: string; hostStartedAt: number;
    files: Array<{ path: string; sha256: string }>;
    sessionSetDigest: string;
}
export interface MaintenanceReady {
    daemonId: string; bootNonce: string; artifactSha256: string; receipt: string;
}
export interface CooperativeMaintenance {
    schema: 1; rolloutId: string; daemonId: string; planDigest: string; epoch: number;
    roster: string[]; meshIds: string[]; phase: 'held' | 'ready' | 'open';
    nodeRoster: Array<{ meshId: string; nodeId: string; daemonId: string }>;
    targetSha256: string; retainedHost: RetainedMaintenanceHost;
    release?: { ready: MaintenanceReady[]; committed: MaintenanceReady[]; decisionDigest: string };
}
export function maintenanceDecisionDigest(state: Pick<CooperativeMaintenance, 'rolloutId' | 'planDigest' | 'epoch' | 'roster' | 'targetSha256'>, ready: MaintenanceReady[]): string {
    return sha(JSON.stringify([state.rolloutId, state.planDigest, state.epoch, [...state.roster].sort(), state.targetSha256,
        [...ready].sort((a,b) => a.daemonId.localeCompare(b.daemonId))]));
}
export function validateCooperativeMaintenance(value: unknown): CooperativeMaintenance {
    const s = value as CooperativeMaintenance;
    if (s?.schema !== 1 || !id(s.rolloutId) || !id(s.daemonId) || !hash(s.planDigest) || !hash(s.targetSha256)
        || !Number.isSafeInteger(s.epoch) || s.epoch < 0 || !['held','ready','open'].includes(s.phase)
        || !Array.isArray(s.roster) || !s.roster.length || s.roster.some(v => !id(v)) || new Set(s.roster).size !== s.roster.length || !s.roster.includes(s.daemonId)
        || !Array.isArray(s.meshIds) || !s.meshIds.length || s.meshIds.some(v => !id(v)) || new Set(s.meshIds).size !== s.meshIds.length) throw new Error('maintenance_state_invalid');
    if (!Array.isArray(s.nodeRoster) || !s.nodeRoster.length || s.nodeRoster.some(n => !id(n.nodeId) || !s.meshIds.includes(n.meshId) || !s.roster.includes(n.daemonId))
        || new Set(s.nodeRoster.map(n => `${n.meshId}:${n.nodeId}`)).size !== s.nodeRoster.length) throw new Error('maintenance_roster_invalid');
    const h = s.retainedHost;
    if (!h || !Number.isSafeInteger(h.pid) || h.pid <= 0 || !id(h.birth) || !id(h.endpoint) || !hash(h.sessionSetDigest)
        || !path.isAbsolute(h.entryPath) || !path.isAbsolute(h.nodePath) || !path.isAbsolute(h.prefix) || !h.entryPath.startsWith(h.prefix + path.sep)
        || !Number.isFinite(h.hostStartedAt) || h.hostStartedAt <= 0 || !Array.isArray(h.files) || !h.files.some(f => f.path.endsWith('.node'))
        || h.files.some(f => !path.isAbsolute(f.path) || !hash(f.sha256)) || new Set(h.files.map(f => f.path)).size !== h.files.length
        || !h.files.some(f => f.path === h.entryPath) || !h.files.some(f => f.path === h.nodePath)) throw new Error('maintenance_retained_host_invalid');
    if (s.phase === 'open') {
        const r = s.release;
        if (!r || !Array.isArray(r.ready) || !Array.isArray(r.committed)) throw new Error('maintenance_release_invalid');
        const valid = (rows: MaintenanceReady[]) => rows.length === s.roster.length && new Set(rows.map(v => v.daemonId)).size === rows.length
            && rows.every(v => s.roster.includes(v.daemonId) && id(v.bootNonce) && v.artifactSha256 === s.targetSha256 && hash(v.receipt));
        if (!valid(r.ready) || !valid(r.committed) || r.ready.some(v => !r.committed.some(c => JSON.stringify(c) === JSON.stringify(v)))
            || r.decisionDigest !== maintenanceDecisionDigest(s, r.ready)) throw new Error('maintenance_release_invalid');
    }
    return s;
}
function privateJson(file: string): unknown {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('maintenance_state_untrusted');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
/** Missing after enrollment, corrupt and partially written states are CLOSED.
 * An open certificate is bound to this process boot, so restart re-enters held. */
export function readCooperativeMaintenance(configDir = getConfigDir()): CooperativeMaintenance | null {
    const requiredPlan = process.env.ADHDEV_COOPERATIVE_MAINTENANCE_PLAN;
    if (requiredPlan !== undefined && !hash(requiredPlan)) throw new Error('maintenance_expected_plan_invalid');
    const root = path.resolve(configDir), file = path.join(root, MAINTENANCE_FILE);
    let enrolled = seen.has(root);
    let enrollment: CooperativeMaintenance | undefined;
    try { fs.lstatSync(path.join(root, marker)); enrolled = true; seen.add(root); enrollment = validateCooperativeMaintenance(privateJson(path.join(root, marker))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let raw: unknown;
    try { raw = privateJson(file); seen.add(root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !enrolled && !requiredPlan) return null; throw new Error('maintenance_state_unavailable', { cause: e }); }
    const state = validateCooperativeMaintenance(raw);
    if (requiredPlan && state.planDigest !== requiredPlan) throw new Error('maintenance_expected_plan_mismatch');
    if (!enrollment || enrollment.rolloutId !== state.rolloutId || enrollment.planDigest !== state.planDigest || enrollment.daemonId !== state.daemonId
        || JSON.stringify(enrollment.roster) !== JSON.stringify(state.roster) || JSON.stringify(enrollment.meshIds) !== JSON.stringify(state.meshIds)
        || JSON.stringify(enrollment.nodeRoster) !== JSON.stringify(state.nodeRoster)) throw new Error('maintenance_enrollment_conflict');
    return state;
}
export function maintenanceHeld(configDir = getConfigDir()): boolean {
    const s = readCooperativeMaintenance(configDir);
    return !!s && (s.phase !== 'open' || !s.release?.ready.some(r => r.daemonId === s.daemonId && r.bootNonce === MAINTENANCE_BOOT_NONCE));
}
export function assertMaintenanceAdmission(meshIds: readonly string[] = [], configDir = getConfigDir()): void {
    const s = readCooperativeMaintenance(configDir);
    if (s && (maintenanceHeld(configDir) || meshIds.some(m => !s.meshIds.includes(m)))) throw new Error('cooperative_maintenance_held');
    const prior = context.getStore();
    if (prior?.root === path.resolve(configDir) && prior.snapshot !== JSON.stringify(s)) throw new Error('maintenance_epoch_changed');
}
export function assertMaintenanceDaemon(daemonId: string): void {
    const s = readCooperativeMaintenance();
    if (s && !s.roster.includes(daemonId)) throw new Error('maintenance_unknown_daemon');
}
export function assertMaintenanceCommandNode(meshIds: readonly string[], nodeId: string | undefined, daemonId?: string): void {
    const s = readCooperativeMaintenance();
    if (s && nodeId && !s.nodeRoster.some(n => meshIds.includes(n.meshId) && n.nodeId === nodeId && n.daemonId === (daemonId || s.daemonId))) throw new Error('maintenance_unknown_node_or_owner');
}
/** Validate only identity fields consumed by launch/join, never authored payloads. */
export function assertMaintenanceCommandIdentity(args: any): void {
    const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
    const settings = args?.settings || {}, member = args?.memberNode || {}, context = args?.meshContext || {};
    const meshes = [args?.meshId, args?.meshNodeFor, args?.meshCoordinatorFor, context.meshId, settings.meshNodeFor, settings.meshCoordinatorFor].map(text).filter((v): v is string => !!v);
    assertMaintenanceAdmission(meshes);
    const rootMesh = text(args?.meshId) || text(args?.meshNodeFor);
    for (const [node, owner, mesh] of [[args?.nodeId, args?.daemonId, rootMesh], [args?.meshNodeId, args?.daemonId, rootMesh], [context.nodeId, context.daemonId, text(context.meshId) || rootMesh],
        [settings.meshNodeId, settings.daemonId, text(settings.meshNodeFor) || text(settings.meshCoordinatorFor) || rootMesh],
        [text(settings.meshCoordinatorFor) ? settings.meshNodeId : undefined, settings.daemonId, text(settings.meshCoordinatorFor)],
        [args?.memberNodeId, member.daemonId, rootMesh], [member.id, member.daemonId, rootMesh]]) {
        assertMaintenanceCommandNode(text(mesh) ? [text(mesh)!] : [], text(node), text(owner));
    }
}
/** Pairing rewrites membership and consumes a token. Enrollment has no roster
 * transition protocol yet, including aliases resolved by workspace/token. */
export function assertMaintenanceJoin(meshId: string, nodeId?: string, daemonId?: string): void {
    assertMaintenanceAdmission([meshId]);
    assertMaintenanceCommandNode([meshId], nodeId, daemonId);
    if (readCooperativeMaintenance()) throw new Error('maintenance_roster_transition_required');
}
export function assertMaintenanceNode(meshId: string, nodeId: string, daemonId?: string): void {
    const s = readCooperativeMaintenance();
    if (s && !s.nodeRoster.some(n => n.meshId === meshId && n.nodeId === nodeId && n.daemonId === (daemonId || s.daemonId))) throw new Error('maintenance_unknown_node_or_owner');
}
/** Metadata observation is allowed while held, under the same epoch writer
 * exclusion. This grants no producer, lifecycle or runtime-write admission. */
export async function withMaintenanceObservation<T>(run: (state: CooperativeMaintenance) => Promise<T>): Promise<T> {
    const state = readCooperativeMaintenance();
    if (!state || !maintenanceHeld() || process.platform === 'win32') throw new Error('maintenance_held_observation_required');
    const release = maintenanceLock(path.resolve(getConfigDir()));
    const snapshot = JSON.stringify(state);
    try {
        if (JSON.stringify(readCooperativeMaintenance()) !== snapshot) throw new Error('maintenance_epoch_changed');
        const result = await run(state);
        if (JSON.stringify(readCooperativeMaintenance()) !== snapshot) throw new Error('maintenance_epoch_changed');
        return result;
    } finally { release(); }
}
export async function withMaintenanceAdmission<T>(run: () => Promise<T>): Promise<T> {
    assertMaintenanceAdmission();
    const root = path.resolve(getConfigDir()), nested = context.getStore();
    const current: AdmissionContext = { root, snapshot: nested?.snapshot ?? JSON.stringify(readCooperativeMaintenance()),
        lease: nested?.lease?.references ? nested.lease : readCooperativeMaintenance() ? { release: maintenanceLock(root), references: 0 } : undefined };
    if (current.lease) current.lease.references++;
    activeAdmissions++;
    try { assertMaintenanceAdmission(); return await context.run(current, run); }
    finally { activeAdmissions--; if (current.lease && --current.lease.references === 0) current.lease.release(); }
}
/** Cooperative SQLite writer ownership spans the actual effect, including async
 * native ACKs. Gate writers cannot cross an in-flight operation. This is not a
 * hostile same-UID/replaceable-path authority claim. Initial enrollment is COLD. */
function maintenanceLock(root: string): () => void {
    const Database = loadBetterSqlite3(), db = new Database(path.join(root, 'cooperative-maintenance.lock.sqlite'));
    try { db.pragma('busy_timeout = 0'); db.exec('BEGIN IMMEDIATE'); }
    catch (e) { db.close(); throw new Error('maintenance_operation_in_flight', { cause: e }); }
    return () => { try { if (db.inTransaction) db.exec('ROLLBACK'); } finally { db.close(); } };
}
export function withMaintenanceEffect<T>(run: () => T): T {
    assertMaintenanceAdmission();
    if (context.getStore()?.lease?.references || !readCooperativeMaintenance()) return run();
    const root = path.resolve(getConfigDir()), lease = { release: maintenanceLock(root), references: 1 };
    try { assertMaintenanceAdmission(); return context.run({ root, snapshot: JSON.stringify(readCooperativeMaintenance()), lease }, run); }
    finally { if (--lease.references === 0) lease.release(); }
}
export function assertMaintenanceLifecycle(operation: string, configDir = getConfigDir()): void {
    const state = readCooperativeMaintenance(configDir);
    if (!state) return;
    if (process.platform === 'win32') throw new Error('maintenance_windows_retained_host_unsupported');
    if (['daemon_start','cli_start','daemon_stop','cli_stop'].includes(operation)) return;
    // Retained dependencies stay protected after reopen, until a separately
    // supported host migration exists. A gate release is never host-kill authority.
    if (operation.startsWith('session_host')) throw new Error('maintenance_retained_host_mutation_refused');
    throw new Error('maintenance_external_driver_owns_lifecycle');
}
/** Capture before an await and recheck immediately before its effect. Even a
 * close/reopen during the await cannot authorize an older continuation. */
export function captureMaintenanceAdmission(meshIds: readonly string[] = [], configDir = getConfigDir()): () => void {
    assertMaintenanceAdmission(meshIds, configDir);
    const before = JSON.stringify(readCooperativeMaintenance(configDir));
    return () => {
        assertMaintenanceAdmission(meshIds, configDir);
        if (JSON.stringify(readCooperativeMaintenance(configDir)) !== before) throw new Error('maintenance_epoch_changed');
    };
}
/** External local adapter writes this BEFORE target startup. Marker first,
 * then atomic durable state; interrupted enrollment stays closed. No deletion. */
export function writeCooperativeMaintenance(configDir: string, state: CooperativeMaintenance): void {
    validateCooperativeMaintenance(state);
    if (process.env.ADHDEV_COOPERATIVE_MAINTENANCE_PLAN && process.env.ADHDEV_COOPERATIVE_MAINTENANCE_PLAN !== state.planDigest) throw new Error('maintenance_expected_plan_mismatch');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const release = maintenanceLock(path.resolve(configDir));
    try {
    let prior: CooperativeMaintenance | null;
    try {
        prior = !seen.has(path.resolve(configDir)) && !fs.existsSync(path.join(configDir, marker)) && !fs.existsSync(path.join(configDir, MAINTENANCE_FILE))
            ? null : readCooperativeMaintenance(configDir);
    }
    catch (e) {
        // Resume an interrupted marker-first enrollment only by restoring a
        // CLOSED record for the same pinned plan. Never repair directly open.
        const missing = (e as Error & { cause?: NodeJS.ErrnoException }).cause?.code === 'ENOENT';
        const initial = privateJson(path.join(configDir, marker)) as CooperativeMaintenance;
        if (!missing || state.phase !== 'held' || initial.rolloutId !== state.rolloutId || initial.planDigest !== state.planDigest
            || initial.daemonId !== state.daemonId || initial.targetSha256 !== state.targetSha256) throw e;
        prior = initial;
    }
    if (prior && (prior.rolloutId !== state.rolloutId || prior.planDigest !== state.planDigest || prior.daemonId !== state.daemonId || state.epoch < prior.epoch)) throw new Error('maintenance_plan_conflict');
    if (prior?.phase === 'open' && state.phase !== 'open' && state.epoch <= prior.epoch) throw new Error('maintenance_new_epoch_required');
    const syncDir = () => { const d = fs.openSync(configDir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } };
    try {
        const m = fs.openSync(path.join(configDir, marker), 'wx', 0o600);
        try { fs.writeFileSync(m, JSON.stringify({ ...state, phase: 'held', release: undefined })); fs.fsyncSync(m); } finally { fs.closeSync(m); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    syncDir();
    const tmp = path.join(configDir, `${MAINTENANCE_FILE}.${randomUUID()}.tmp`), fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path.join(configDir, MAINTENANCE_FILE)); syncDir();
    } finally { release(); }
}
export function cooperativeMaintenanceStatus() {
    const state = readCooperativeMaintenance();
    return { success: true, state, held: maintenanceHeld(), bootNonce: MAINTENANCE_BOOT_NONCE, activeAdmissions };
}

/** Called with fresh native and RPC facts, never a PID-file-only observation.
 * No repair, spawn, reap, upgrade lease or session stop exists in this path. */
export function verifyRetainedMaintenanceHost(s: CooperativeMaintenance, facts: {
    pid: number | null; birth: string; entryPath: string | null; endpoint: string; socketOwnerPid: number;
    hostEntryPath?: string; hostStartedAt: number; nodePath: string;
}): void {
    if (process.platform === 'win32') throw new Error('maintenance_windows_retained_host_unsupported');
    const h = s.retainedHost;
    if (facts.pid !== h.pid || facts.socketOwnerPid !== h.pid || facts.birth !== h.birth || facts.entryPath !== h.entryPath || facts.nodePath !== h.nodePath
        || facts.hostEntryPath !== h.entryPath || facts.hostStartedAt !== h.hostStartedAt || facts.endpoint !== h.endpoint) throw new Error('maintenance_retained_host_identity_changed');
    for (const f of h.files) {
        if (fs.realpathSync(f.path) !== f.path || !fs.statSync(f.path).isFile() || createHash('sha256').update(fs.readFileSync(f.path)).digest('hex') !== f.sha256) throw new Error('maintenance_retained_dependency_changed');
    }
}
