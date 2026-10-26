import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context.js';
import { collectTargetDrain } from '../../src/maintenance/drain-collection.js';
import {
    DEFAULT_NEW_WORK_HOLD_TTL_MS,
    NEW_WORK_HOLD_CAS_CONFLICT_CODE,
    NEW_WORK_HOLD_INVALID_TTL_CODE,
    NEW_WORK_HOLD_UNAUTHORIZED_CODE,
    clearNewWorkHoldMemoryCacheForTests,
    evaluateNewWorkHold,
    extendNewWorkHold,
    getNewWorkHoldStatus,
    isNewWorkHeld,
    releaseNewWorkHold,
    resetNewWorkHoldForTests,
    setNewWorkHold,
    setNewWorkHoldClockForTests,
} from '../../src/maintenance/new-work-hold.js';
import * as holdLifecycle from '../../src/maintenance/new-work-hold.js';
import { LOG } from '../../src/logging/logger.js';
import { getQueueEntryById } from '../../src/mesh/mesh-work-queue.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { createTurnLedger } from '../../src/mesh/turn-ledger/ledger.js';

describe('new-work hold lifecycle, CAS, auth, persistence, and clock safety', () => {
    let rootDir: string;
    let store: MeshRuntimeStore;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-new-work-hold-life-'));
        process.env.ADHDEV_CONFIG_DIR = rootDir;
        delete process.env.ADHDEV_NEW_WORK_HOLD_TOKEN;
        resetProcessInstanceContextForTests();
        MeshRuntimeStore.resetForTests();
        resetNewWorkHoldForTests();
        store = MeshRuntimeStore.getInstance();
    });

    afterEach(() => {
        delete process.env.ADHDEV_NEW_WORK_HOLD_TOKEN;
        resetNewWorkHoldForTests();
        MeshRuntimeStore.resetForTests();
        resetProcessInstanceContextForTests();
        try {
            fs.rmSync(rootDir, { recursive: true, force: true });
        } catch {
            /* ignore cleanup errors */
        }
    });

    it('uses 30-minute default TTL, auto-expires when TTL elapses, and supports extend + capped auto-extend (F7)', () => {
        const t0 = 1_700_000_000_000;
        const setRes = setNewWorkHold({
            holder: 'owner-1',
            reason: 'worker_handoff_cutover',
            maxAutoExtendCount: 2,
            maxTotalExtensionMs: 120_000,
            now: t0,
        });
        expect(setRes.success).toBe(true);
        expect(setRes.hold.active).toBe(true);
        expect(setRes.hold.ttlMs).toBe(DEFAULT_NEW_WORK_HOLD_TTL_MS);
        expect(DEFAULT_NEW_WORK_HOLD_TTL_MS).toBe(30 * 60 * 1000);
        expect(setRes.hold.expiresAt).toBe(t0 + DEFAULT_NEW_WORK_HOLD_TTL_MS);
        expect(setRes.hold.revision).toBe(1);
        expect(setRes.hold.maxAutoExtendCount).toBe(2);
        expect(setRes.hold.maxTotalExtensionMs).toBe(120_000);
        expect(setRes.hold.autoExtendCapReached).toBe(false);
        expect(isNewWorkHeld({ now: t0 + 1000 })).toBe(true);

        // Rejects non-positive TTL
        const badTtl = extendNewWorkHold({
            holdId: setRes.hold.holdId!,
            holder: 'owner-1',
            ttlMs: 0,
            now: t0 + 5_000,
        });
        expect(badTtl.success).toBe(false);
        expect(badTtl.code).toBe(NEW_WORK_HOLD_INVALID_TTL_CODE);

        // Extend manually with 60s TTL
        const extendRes = extendNewWorkHold({
            holdId: setRes.hold.holdId!,
            holder: 'owner-1',
            expectedRevision: 1,
            ttlMs: 60_000,
            now: t0 + 10_000,
        });
        expect(extendRes.success).toBe(true);
        expect(extendRes.hold.revision).toBe(2);
        expect(extendRes.hold.expiresAt).toBe(t0 + 10_000 + 60_000);

        // While an assigned task is draining, polling within the renewal window auto-extends up to the cap
        store.insertQueueEntry({
            id: 'task-draining-1',
            meshId: 'mesh-alpha',
            status: 'assigned',
            assignedNodeId: 'node-1',
            assignedSessionId: 'sess-1',
            message: 'finish in-flight work',
            difficulty: 'simple',
            priority: 'normal',
            createdAt: new Date(t0).toISOString(),
            updatedAt: new Date(t0).toISOString(),
        });

        const nearExpiry1 = t0 + 10_000 + 50_000; // 10s remaining out of 60s TTL (<= 1/3 window)
        const autoExt1 = getNewWorkHoldStatus({ now: nearExpiry1, autoExtend: true });
        expect(autoExt1.hold.active).toBe(true);
        expect(autoExt1.hold.phase).toBe('draining');
        expect(autoExt1.hold.autoExtendCount).toBe(1);
        expect(autoExt1.hold.autoExtendedMs).toBe(60_000);
        expect(autoExt1.hold.autoExtendCapReached).toBe(false);
        expect(autoExt1.hold.expiresAt).toBe(nearExpiry1 + 60_000);

        const nearExpiry2 = nearExpiry1 + 50_000;
        const autoExt2 = getNewWorkHoldStatus({ now: nearExpiry2, autoExtend: true });
        expect(autoExt2.hold.autoExtendCount).toBe(2);
        expect(autoExt2.hold.autoExtendedMs).toBe(120_000);
        expect(autoExt2.hold.autoExtendCapReached).toBe(true);
        expect(autoExt2.hold.expiresAt).toBe(nearExpiry2 + 60_000);

        // Third poll inside renewal window does NOT extend further because cap is reached (F7)
        const nearExpiry3 = nearExpiry2 + 50_000;
        const cappedStatus = getNewWorkHoldStatus({ now: nearExpiry3, autoExtend: true });
        expect(cappedStatus.hold.autoExtendCount).toBe(2);
        expect(cappedStatus.hold.expiresAt).toBe(nearExpiry2 + 60_000);
        expect(cappedStatus.hold.autoExtendCapReached).toBe(true);

        // Once time passes expiresAt, the hold automatically expires
        const afterExpiry = getNewWorkHoldStatus({ now: autoExt2.hold.expiresAt! + 1 });
        expect(afterExpiry.held).toBe(false);
        expect(afterExpiry.hold.active).toBe(false);
        expect(afterExpiry.hold.status).toBe('expired');
        expect(afterExpiry.hold.releasedReason).toBe('ttl_expired_auto_extend_cap_reached');
        expect(isNewWorkHeld({ now: autoExt2.hold.expiresAt! + 1 })).toBe(false);
    });

    it('renews from a daemon timer without status polls, fences a delayed tick, and visibly reports cap expiry', () => {
        vi.useFakeTimers();
        const t0 = Date.now();
        const warning = vi.spyOn(LOG, 'warn');
        try {
            store.insertQueueEntry({ id: 'timer-running', meshId: 'mesh-timer', status: 'assigned',
                assignedNodeId: 'node-1', assignedSessionId: 'sess-1', message: 'working',
                difficulty: 'simple', priority: 'normal', createdAt: new Date(t0).toISOString(), updatedAt: new Date(t0).toISOString() });
            const initial = setNewWorkHold({ ttlMs: 3000, maxAutoExtendCount: 1, now: t0 });
            // No status request, including after a delayed timer callback beyond initial expiry.
            expect(evaluateNewWorkHold({ now: t0 + 3001 }).held).toBe(true);
            expect(fs.readFileSync(path.join(rootDir, 'new-work-hold.json'), 'utf8')).toContain(String(initial.hold.expiresAt));
            const timerCount = vi.getTimerCount();
            expect(store.db.transaction(() => evaluateNewWorkHold({ now: t0 + 3001 }).held)()).toBe(true);
            const stop = holdLifecycle.startNewWorkHoldLifecycle({ cliManager: { adapters: new Map() } } as any);
            vi.advanceTimersByTime(2500);
            const disk = JSON.parse(fs.readFileSync(path.join(rootDir, 'new-work-hold.json'), 'utf8'));
            expect(disk.autoExtendCount).toBe(1);
            expect(disk.expiresAt).toBeGreaterThan(initial.hold.expiresAt!);
            expect(warning.mock.calls.some(args => String(args[1]).includes('auto-extension cap'))).toBe(true);
            vi.advanceTimersByTime(4000);
            expect(JSON.parse(fs.readFileSync(path.join(rootDir, 'new-work-hold.json'), 'utf8')).releasedReason).toBe('ttl_expired_auto_extend_cap_reached');
            expect(warning.mock.calls.some(args => String(args[1]).includes('assigned work may still be running'))).toBe(true);
            stop();
            expect(vi.getTimerCount()).toBe(timerCount);
        } finally { warning.mockRestore(); vi.useRealTimers(); }
    });

    it('does not let a status caller disable renewal and expire assigned work between daemon ticks', () => {
        const t0 = Date.now();
        store.insertQueueEntry({ id: 'status-running', meshId: 'mesh-status', status: 'assigned',
            message: 'working', difficulty: 'simple', priority: 'normal', createdAt: new Date(t0).toISOString(), updatedAt: new Date(t0).toISOString() });
        setNewWorkHold({ ttlMs: 3000, now: t0 });
        const status = getNewWorkHoldStatus({ now: t0 + 3001, autoExtend: false });
        expect(status.held).toBe(true);
        expect(status.hold.autoExtendCount).toBe(1);
        expect(evaluateNewWorkHold({ now: t0 + 3002 }).held).toBe(true);
    });

    it('honors the total extension budget independently of the count cap with a visible final expiry', () => {
        const t0 = Date.now();
        store.insertQueueEntry({ id: 'budget-running', meshId: 'mesh-budget', status: 'assigned',
            message: 'working', difficulty: 'simple', priority: 'normal', createdAt: new Date(t0).toISOString(), updatedAt: new Date(t0).toISOString() });
        setNewWorkHold({ ttlMs: 3000, maxAutoExtendCount: 10, maxTotalExtensionMs: 1500, now: t0 });
        const finalGrant = getNewWorkHoldStatus({ now: t0 + 2000 });
        expect(finalGrant.hold.autoExtendCount).toBe(1);
        expect(finalGrant.hold.autoExtendedMs).toBe(1500);
        expect(finalGrant.hold.expiresAt).toBe(t0 + 3500);
        expect(finalGrant.hold.autoExtendNotice).toContain('Assigned work may still be running');
        expect(evaluateNewWorkHold({ now: t0 + 3499 }).held).toBe(true);
        expect(getNewWorkHoldStatus({ now: t0 + 3500 }).hold.releasedReason).toBe('ttl_expired_auto_extend_cap_reached');
    });

    it('clamps positive set and extend TTLs to one second through four hours', () => {
        const t0 = Date.now();
        expect(setNewWorkHold({ holdId: 'clamp', ttlMs: 0.5, now: t0 }).hold.ttlMs).toBe(1000);
        expect(extendNewWorkHold({ holdId: 'clamp', ttlMs: 1e12, now: t0 + 1 }).hold.ttlMs).toBe(4 * 60 * 60_000);
        releaseNewWorkHold({ holdId: 'clamp', now: t0 + 2 });
        expect(setNewWorkHold({ holdId: 'clamp-2', ttlMs: 1e12, now: t0 + 3 }).hold.ttlMs).toBe(4 * 60 * 60_000);
        expect(extendNewWorkHold({ holdId: 'clamp-2', ttlMs: 0.5, now: t0 + 4 }).hold.ttlMs).toBe(1000);
    });

    it.each(['set', 'extend', 'release'] as const)('returns non-success on %s lock contention and can retry after the lock clears', (op) => {
        const t0 = Date.now();
        if (op !== 'set') expect(setNewWorkHold({ holdId: 'locked', now: t0 }).success).toBe(true);
        const lock = path.join(rootDir, 'new-work-hold.lock');
        fs.writeFileSync(lock, 'another writer');
        const mutate = () => op === 'set' ? setNewWorkHold({ holdId: 'locked', requestId: 'retry', now: t0 + 1 })
            : op === 'extend' ? extendNewWorkHold({ holdId: 'locked', requestId: 'retry', ttlMs: 60_000, now: t0 + 1 })
            : releaseNewWorkHold({ holdId: 'locked', requestId: 'retry', now: t0 + 1 });
        expect(mutate().success).toBe(false);
        fs.unlinkSync(lock);
        expect(mutate().success).toBe(true);
        clearNewWorkHoldMemoryCacheForTests();
        const disk = getNewWorkHoldStatus({ now: t0 + 2 });
        expect(disk.held).toBe(op !== 'release');
        if (op === 'extend') expect(disk.hold.ttlMs).toBe(60_000);
    });

    it.each(['extend', 'release'] as const)('returns non-success on %s IO failure without changing the durable hold', (op) => {
        const t0 = Date.now();
        const initial = setNewWorkHold({ holdId: 'io-failed', now: t0 });
        const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('injected IO failure'); });
        try {
            const result = op === 'extend' ? extendNewWorkHold({ holdId: 'io-failed', ttlMs: 60_000, now: t0 + 1 })
                : releaseNewWorkHold({ holdId: 'io-failed', now: t0 + 1 });
            expect(result.success).toBe(false);
            expect(result.persistenceWarning).toContain('injected IO failure');
            clearNewWorkHoldMemoryCacheForTests();
            expect(getNewWorkHoldStatus({ now: t0 + 2 }).hold.expiresAt).toBe(initial.hold.expiresAt);
            expect(isNewWorkHeld({ now: t0 + 2 })).toBe(true);
        } finally { rename.mockRestore(); }
    });

    it('does not widen a mesh hold to unspecified or unrelated meshes', () => {
        setNewWorkHold({ meshId: 'held-mesh' });
        expect(evaluateNewWorkHold({ meshId: 'held-mesh' }).held).toBe(true);
        expect(evaluateNewWorkHold({ meshId: 'other-mesh' }).held).toBe(false);
        expect(evaluateNewWorkHold().held).toBe(false);
        releaseNewWorkHold({ holdId: getNewWorkHoldStatus().hold.holdId });
        setNewWorkHold({ scope: 'mesh' });
        expect(evaluateNewWorkHold({ meshId: 'held-mesh' }).held).toBe(false);
    });

    it('enforces CAS revision, active-holder conflict protection, and requires holdId/holder on extend/release (F2)', () => {
        const t0 = 1_700_000_000_000;
        const win = setNewWorkHold({
            holdId: 'hold-a',
            holder: 'setter-a',
            expectedRevision: 0,
            reason: 'handoff-a',
            now: t0,
        });
        expect(win.success).toBe(true);
        expect(win.hold.revision).toBe(1);
        expect(win.hold.holdId).toBe('hold-a');

        // Competing setter with stale expectedRevision -> CAS conflict
        const loseExpectedRev = setNewWorkHold({
            holdId: 'hold-b',
            holder: 'setter-b',
            expectedRevision: 0,
            reason: 'handoff-b',
            now: t0 + 5,
        });
        expect(loseExpectedRev.success).toBe(false);
        expect(loseExpectedRev.code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);

        // Competing setter without expectedRevision -> CAS conflict
        const loseCompetingSetter = setNewWorkHold({
            holdId: 'hold-b',
            holder: 'setter-b',
            reason: 'handoff-b',
            now: t0 + 10,
        });
        expect(loseCompetingSetter.success).toBe(false);
        expect(loseCompetingSetter.code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);

        // Anonymous extend/release without holdId or holder is refused while hold is active (F2)
        const anonExtend = extendNewWorkHold({ ttlMs: 90_000, now: t0 + 15 });
        expect(anonExtend.success).toBe(false);
        expect(anonExtend.code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);

        const anonRelease = releaseNewWorkHold({ now: t0 + 16 });
        expect(anonRelease.success).toBe(false);
        expect(anonRelease.code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);
        expect(isNewWorkHeld({ now: t0 + 16 })).toBe(true);

        // Extend/release with wrong holder or wrong holdId or stale expectedRevision -> refused
        expect(extendNewWorkHold({ holdId: 'hold-a', holder: 'wrong-holder', now: t0 + 18 }).code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);
        expect(extendNewWorkHold({ holdId: 'hold-a', expectedRevision: 99, now: t0 + 20 }).code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);
        expect(releaseNewWorkHold({ holdId: 'hold-b', now: t0 + 30 }).code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);
        expect(releaseNewWorkHold({ holdId: 'hold-a', holder: 'wrong-holder', now: t0 + 30 }).code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);
        expect(isNewWorkHeld({ now: t0 + 30 })).toBe(true);
    });

    it('is replay-idempotent across set, extend, and release', () => {
        const t0 = 1_700_000_000_000;
        const set1 = setNewWorkHold({
            holdId: 'hold-idem',
            holder: 'owner-1',
            requestId: 'req-set-1',
            expectedRevision: 0,
            now: t0,
        });
        expect(set1.success).toBe(true);
        expect(set1.replayed).toBe(false);
        expect(set1.hold.revision).toBe(1);

        const setReplay1 = setNewWorkHold({
            holdId: 'hold-idem',
            holder: 'owner-1',
            requestId: 'req-set-1',
            expectedRevision: 0,
            now: t0 + 100,
        });
        expect(setReplay1.success).toBe(true);
        expect(setReplay1.replayed).toBe(true);
        expect(setReplay1.hold.revision).toBe(1);

        const ext1 = extendNewWorkHold({
            holdId: 'hold-idem',
            requestId: 'req-ext-1',
            expectedRevision: 1,
            ttlMs: 120_000,
            now: t0 + 1000,
        });
        expect(ext1.success).toBe(true);
        expect(ext1.replayed).toBe(false);
        expect(ext1.hold.revision).toBe(2);

        const extReplay = extendNewWorkHold({
            holdId: 'hold-idem',
            requestId: 'req-ext-1',
            expectedRevision: 1,
            ttlMs: 120_000,
            now: t0 + 2000,
        });
        expect(extReplay.success).toBe(true);
        expect(extReplay.replayed).toBe(true);
        expect(extReplay.hold.revision).toBe(2);

        const rel1 = releaseNewWorkHold({
            holdId: 'hold-idem',
            requestId: 'req-rel-1',
            expectedRevision: 2,
            now: t0 + 3000,
        });
        expect(rel1.success).toBe(true);
        expect(rel1.replayed).toBe(false);
        expect(rel1.hold.active).toBe(false);
        expect(rel1.hold.revision).toBe(3);

        const relReplay = releaseNewWorkHold({
            holdId: 'hold-idem',
            requestId: 'req-rel-1',
            expectedRevision: 2,
            now: t0 + 4000,
        });
        expect(relReplay.success).toBe(true);
        expect(relReplay.replayed).toBe(true);
        expect(relReplay.hold.revision).toBe(3);
    });

    it('rejects caller clock forgery on command handlers (F1) and enforces owner/holderToken authorization (F2)', async () => {
        const t0 = 1_700_000_000_000;
        setNewWorkHoldClockForTests(() => t0);

        const router = new DaemonCommandRouter({
            commandHandler: {
                rejectUnknown: async (cmd: string) => ({ success: false, error: `Unknown: ${cmd}` }),
                handleSpec: async () => ({ success: true }),
            } as any,
            cliManager: { adapters: new Map() } as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: { listInstanceIds: () => [] } as any,
            detectedIdes: { value: [] },
            sessionRegistry: {} as any,
            statusInstanceId: 'daemon_mach_test',
        });

        // F2: Unauthenticated IPC caller cannot set a hold
        const unauthSet = await router.execute(
            'maintenance_new_work_hold_set',
            { holdId: 'hold-sec', holder: 'attacker' },
            'ipc',
        );
        expect(unauthSet.success).toBe(false);
        expect(unauthSet.code).toBe(NEW_WORK_HOLD_UNAUTHORIZED_CODE);

        // Verified owner can set a hold and receives a holderToken
        const ownerSet = await router.execute(
            'maintenance_new_work_hold_set',
            { holdId: 'hold-sec', holder: 'owner-1', ttlMs: 60_000 },
            'standalone',
            { ownerVerified: true },
        ) as any;
        expect(ownerSet.success).toBe(true);
        expect(typeof ownerSet.holderToken).toBe('string');

        // F1: Forged `now: t0 + 10 hours` on status/extend/release command args is ignored!
        const forgedStatus = await router.execute(
            'maintenance_new_work_hold_status',
            { now: t0 + 10 * 3600_000 },
            'ipc',
        ) as any;
        expect(forgedStatus.held).toBe(true);
        expect(forgedStatus.hold.active).toBe(true);
        expect(forgedStatus.hold.status).not.toBe('expired');
        expect(isNewWorkHeld()).toBe(true);

        // F2: Unauthenticated IPC or mesh caller cannot release or extend without holderToken
        const unauthRelease = await router.execute(
            'maintenance_new_work_hold_release',
            { holdId: 'hold-sec', holder: 'owner-1' },
            'ipc',
        );
        expect(unauthRelease.success).toBe(false);
        expect(unauthRelease.code).toBe(NEW_WORK_HOLD_UNAUTHORIZED_CODE);
        expect(isNewWorkHeld()).toBe(true);

        // F2: Holder presenting the valid holderToken + matching holdId can extend and release over IPC
        const tokenExtend = await router.execute(
            'maintenance_new_work_hold_extend',
            { holdId: 'hold-sec', holderToken: ownerSet.holderToken, ttlMs: 120_000 },
            'ipc',
        ) as any;
        expect(tokenExtend.success).toBe(true);
        expect(tokenExtend.hold.ttlMs).toBe(120_000);

        const tokenRelease = await router.execute(
            'maintenance_new_work_hold_release',
            { holdId: 'hold-sec', holderToken: ownerSet.holderToken },
            'ipc',
        ) as any;
        expect(tokenRelease.success).toBe(true);
        expect(tokenRelease.hold.active).toBe(false);
    });

    it('keeps evaluateNewWorkHold read-only, protects against concurrent writers (F3), persists across restarts, and fails closed on corruption/write errors (F8)', () => {
        const t0 = 1_700_000_000_000;
        const holdFile = path.join(rootDir, 'new-work-hold.json');

        // F8: When no hold is active, evaluateNewWorkHold short-circuits without touching MeshRuntimeStore
        const dbPrepareSpy = vi.spyOn(store.db, 'prepare');
        const inactiveEval = evaluateNewWorkHold({ now: t0 });
        expect(inactiveEval.held).toBe(false);
        expect(dbPrepareSpy).not.toHaveBeenCalled();
        dbPrepareSpy.mockRestore();

        // Set hold and verify restart persistence by clearing in-memory cache
        const setRes = setNewWorkHold({
            holdId: 'hold-persist-1',
            holder: 'owner-1',
            ttlMs: 60_000,
            now: t0,
        });
        expect(setRes.success).toBe(true);
        expect(fs.existsSync(holdFile)).toBe(true);

        clearNewWorkHoldMemoryCacheForTests();
        const afterRestart = evaluateNewWorkHold({ now: t0 + 1_000 });
        expect(afterRestart.held).toBe(true);
        expect(afterRestart.hold.holdId).toBe('hold-persist-1');
        expect(afterRestart.hold.revision).toBe(1);

        // F3: evaluateNewWorkHold is strictly read-only on hot paths (never mutates new-work-hold.json on disk)
        const diskBeforeEval = fs.readFileSync(holdFile, 'utf8');
        const evalExpiredInMem = evaluateNewWorkHold({ now: t0 + 120_000 });
        expect(evalExpiredInMem.held).toBe(false);
        expect(evalExpiredInMem.hold.status).toBe('expired');
        const diskAfterEval = fs.readFileSync(holdFile, 'utf8');
        expect(diskAfterEval).toBe(diskBeforeEval);

        // F3: Concurrent writer protection — if another writer updates revision on disk, stale expectedRevision fails CAS
        const diskJson = JSON.parse(diskBeforeEval);
        diskJson.revision = 5;
        fs.writeFileSync(holdFile, `${JSON.stringify(diskJson, null, 2)}\n`, 'utf8');
        const staleExtend = extendNewWorkHold({
            holdId: 'hold-persist-1',
            holder: 'owner-1',
            expectedRevision: 1,
            ttlMs: 90_000,
            now: t0 + 2_000,
        });
        expect(staleExtend.success).toBe(false);
        expect(staleExtend.code).toBe(NEW_WORK_HOLD_CAS_CONFLICT_CODE);
        expect(staleExtend.hold.revision).toBe(5);

        // F8: Corrupt file on disk fails closed with active hold and surfaces persistenceWarning
        clearNewWorkHoldMemoryCacheForTests();
        fs.writeFileSync(holdFile, '{corrupt json', 'utf8');
        const corruptEval = evaluateNewWorkHold({ now: t0 + 3_000 });
        expect(corruptEval.held).toBe(true);
        expect(corruptEval.hold.active).toBe(true);
        expect(corruptEval.hold.persistenceWarning).toMatch(/Corrupt or unreadable new-work-hold\.json/);

        // F8: Persistence write error keeps hold active in memory and surfaces persistenceWarning
        resetNewWorkHoldForTests();
        const badDirFile = path.join(rootDir, 'not-a-directory');
        fs.writeFileSync(badDirFile, 'file-blocking-mkdir', 'utf8');
        const writeFailSet = setNewWorkHold({
            holdId: 'hold-mem-only',
            holder: 'owner-1',
            configDir: badDirFile,
            now: t0 + 4_000,
        });
        expect(writeFailSet.success).toBe(false);
        expect(writeFailSet.held).toBe(true);
        expect(writeFailSet.persistenceWarning).toMatch(/Failed to persist new-work-hold\.json/);
        expect(isNewWorkHeld({ configDir: badDirFile, now: t0 + 4_500 })).toBe(true);
    });

    it('transitions drain -> seal when running work finishes while held pending tasks stay queued', async () => {
        const t0 = Date.now();
        store.insertQueueEntry({
            id: 'task-running',
            meshId: 'mesh-drain',
            status: 'assigned',
            assignedNodeId: 'node-1',
            assignedSessionId: 'sess-running',
            message: 'in-flight work',
            difficulty: 'simple',
            priority: 'normal',
            createdAt: new Date(t0).toISOString(),
            updatedAt: new Date(t0).toISOString(),
        });
        store.insertQueueEntry({
            id: 'task-waiting',
            meshId: 'mesh-drain',
            status: 'pending',
            message: 'queued work waiting for hold release',
            difficulty: 'simple',
            priority: 'normal',
            createdAt: new Date(t0).toISOString(),
            updatedAt: new Date(t0).toISOString(),
        });
        store.insertQueueEntry({
            id: 'task-completed',
            meshId: 'mesh-drain',
            status: 'completed',
            message: 'already finished work',
            difficulty: 'simple',
            priority: 'normal',
            createdAt: new Date(t0).toISOString(),
            updatedAt: new Date(t0).toISOString(),
        });

        const setRes = setNewWorkHold({ holder: 'owner-1', reason: 'drain-test', now: t0 });
        expect(setRes.success).toBe(true);
        expect(setRes.hold.phase).toBe('draining');
        expect(setRes.hold.sealed).toBe(false);
        expect(setRes.drain.inFlightCount).toBe(1);
        expect(setRes.drain.activeClaims.map((r) => r.id)).toEqual(['task-running']);
        expect(setRes.drain.heldPendingQueue.map((r) => r.id)).toEqual(['task-waiting']);
        expect(getQueueEntryById('mesh-drain', 'task-running')?.status).toBe('assigned');

        const runningEntry = store.findQueueEntryById('mesh-drain', 'task-running')!;
        runningEntry.status = 'completed';
        runningEntry.updatedAt = new Date(t0 + 5000).toISOString();
        store.updateQueueEntry(runningEntry);

        const statusAfter = getNewWorkHoldStatus({ now: t0 + 5000 });
        expect(statusAfter.hold.active).toBe(true);
        expect(statusAfter.hold.phase).toBe('sealed');
        expect(statusAfter.hold.sealed).toBe(true);
        expect(statusAfter.drain.inFlightCount).toBe(0);
        expect(statusAfter.drain.heldPendingQueue.map((r) => r.id)).toEqual(['task-waiting']);

        const ledger = createTurnLedger({ db: store.db, selfDaemonId: 'daemon_mach_drain', autoFlush: false });
        const coopState = {
            schema: 1 as const,
            phase: 'held' as const,
            rolloutId: 'rollout-drain',
            planDigest: '0'.repeat(64),
            targetSha256: '0'.repeat(64),
            epoch: 1,
            daemonId: 'daemon_mach_drain',
            roster: ['daemon_mach_drain'],
            meshIds: ['mesh-drain'],
            nodeRoster: [{ meshId: 'mesh-drain', nodeId: 'node-1', daemonId: 'daemon_mach_drain' }],
        } as any;
        const drainCensus = await collectTargetDrain(
            {
                turnLedger: ledger,
                cliManager: { adapters: new Map() },
                router: { runningRefineJobs: new Map(), runningRefineBatchJobs: new Map(), refineBaseLeases: new Map() },
            } as any,
            coopState,
            fs.realpathSync(rootDir),
            'nonce-1',
            50,
        );
        expect(drainCensus.channels.claims.pending).toHaveLength(0);
        expect(drainCensus.channels.runnableQueue.pending).toHaveLength(0);
        expect((drainCensus.channels.runnableQueue.evidence as any)?.heldPendingQueue?.map((r: any) => r.id)).toEqual(['task-waiting']);
        releaseNewWorkHold({ holdId: setRes.hold.holdId, now: t0 + 6000 });
        const afterRelease = await collectTargetDrain({ turnLedger: ledger, cliManager: { adapters: new Map() },
            router: { runningRefineJobs: new Map(), runningRefineBatchJobs: new Map(), refineBaseLeases: new Map() } } as any,
            coopState, fs.realpathSync(rootDir), 'nonce-2', 50);
        expect(afterRelease.channels.runnableQueue.pending.map((r: any) => r.id)).toEqual(['task-waiting']);
    });
});
