import { describe, expect, it } from 'vitest';
import {
    DAY_MS,
    LEDGER_JSONL_MAX_AGE_MS,
    SESSION_HOST_RUNTIME_MAX_AGE_MS,
    DB_BAK_MAX_AGE_MS,
    selectExpiredLedgerJsonl,
    selectExpiredSessionHostRuntimes,
    selectExpiredDbBackups,
    isDbBackupFileName,
    detectOrphanWorktrees,
    type AgedFile,
    type SessionHostRuntimeFile,
    type WorktreePathLike,
    type LiveNodeWorkspaceLike,
} from '../../src/mesh/mesh-disk-retention.js';

// All pure selectors take an explicit `now` so the tests are deterministic and need
// no fs mocking. NOW is a fixed reference instant; ages are expressed relative to it.
const NOW = 1_700_000_000_000; // fixed epoch ms
const daysAgo = (d: number) => NOW - d * DAY_MS;

describe('mesh-disk-retention — thresholds', () => {
    it('exports the mission-approved retention thresholds (30d / 14d / 7d)', () => {
        expect(LEDGER_JSONL_MAX_AGE_MS).toBe(30 * DAY_MS);
        expect(SESSION_HOST_RUNTIME_MAX_AGE_MS).toBe(14 * DAY_MS);
        expect(DB_BAK_MAX_AGE_MS).toBe(7 * DAY_MS);
    });
});

describe('selectExpiredLedgerJsonl (30-day JSONL ledger retention)', () => {
    it('selects only files strictly older than 30 days', () => {
        const files: AgedFile[] = [
            { path: '/a/fresh.jsonl', mtimeMs: daysAgo(1) },
            { path: '/a/edge-29.jsonl', mtimeMs: daysAgo(29) },
            { path: '/a/old-31.jsonl', mtimeMs: daysAgo(31) },
            { path: '/a/ancient-90.jsonl', mtimeMs: daysAgo(90) },
        ];
        const expired = selectExpiredLedgerJsonl(files, NOW);
        expect(expired.map(f => f.path)).toEqual(['/a/old-31.jsonl', '/a/ancient-90.jsonl']);
    });

    it('keeps a file exactly at the 30-day boundary (strict >, not >=)', () => {
        const files: AgedFile[] = [{ path: '/a/exactly-30.jsonl', mtimeMs: NOW - LEDGER_JSONL_MAX_AGE_MS }];
        expect(selectExpiredLedgerJsonl(files, NOW)).toEqual([]);
    });

    it('prunes a file one ms past the 30-day boundary', () => {
        const files: AgedFile[] = [{ path: '/a/just-past.jsonl', mtimeMs: NOW - LEDGER_JSONL_MAX_AGE_MS - 1 }];
        expect(selectExpiredLedgerJsonl(files, NOW).map(f => f.path)).toEqual(['/a/just-past.jsonl']);
    });

    it('honors a custom maxAge override', () => {
        const files: AgedFile[] = [{ path: '/a/x.jsonl', mtimeMs: daysAgo(2) }];
        expect(selectExpiredLedgerJsonl(files, NOW, 1 * DAY_MS).map(f => f.path)).toEqual(['/a/x.jsonl']);
        expect(selectExpiredLedgerJsonl(files, NOW, 5 * DAY_MS)).toEqual([]);
    });
});

describe('selectExpiredSessionHostRuntimes (14-day, terminated-only)', () => {
    const dead = (lifecycle: string): SessionHostRuntimeFile['record'] => ({ lifecycle });
    const live = (lifecycle: string): SessionHostRuntimeFile['record'] => ({ lifecycle });

    it('never deletes a LIVE runtime regardless of age', () => {
        // 'running' / 'starting' / 'stopping' / 'interrupted' are LIVE_LIFECYCLES.
        const files: SessionHostRuntimeFile[] = [
            { path: '/r/live-old.json', mtimeMs: daysAgo(999), record: live('running') },
            { path: '/r/live-starting.json', mtimeMs: daysAgo(60), record: live('starting') },
        ];
        expect(selectExpiredSessionHostRuntimes(files, NOW)).toEqual([]);
    });

    it('deletes a terminated (stopped/failed) runtime older than 14 days', () => {
        const files: SessionHostRuntimeFile[] = [
            { path: '/r/dead-old.json', mtimeMs: daysAgo(20), record: dead('stopped') },
            { path: '/r/failed-old.json', mtimeMs: daysAgo(15), record: dead('failed') },
        ];
        expect(selectExpiredSessionHostRuntimes(files, NOW).map(f => f.path))
            .toEqual(['/r/dead-old.json', '/r/failed-old.json']);
    });

    it('keeps a terminated-but-RECENT runtime (age gate, conservative)', () => {
        const files: SessionHostRuntimeFile[] = [
            { path: '/r/dead-recent.json', mtimeMs: daysAgo(3), record: dead('stopped') },
            { path: '/r/dead-edge.json', mtimeMs: NOW - SESSION_HOST_RUNTIME_MAX_AGE_MS, record: dead('failed') },
        ];
        expect(selectExpiredSessionHostRuntimes(files, NOW)).toEqual([]);
    });

    it('treats an unparseable/null record as non-live but still age-gated', () => {
        const files: SessionHostRuntimeFile[] = [
            { path: '/r/corrupt-old.json', mtimeMs: daysAgo(30), record: null },
            { path: '/r/corrupt-fresh.json', mtimeMs: daysAgo(1), record: null },
        ];
        // Old corrupt file is removed; fresh corrupt file is preserved.
        expect(selectExpiredSessionHostRuntimes(files, NOW).map(f => f.path)).toEqual(['/r/corrupt-old.json']);
    });

    it('respects surfaceKind=live_runtime short-circuit over lifecycle', () => {
        const files: SessionHostRuntimeFile[] = [
            { path: '/r/surface-live.json', mtimeMs: daysAgo(100), record: { surfaceKind: 'live_runtime', lifecycle: 'stopped' } },
        ];
        expect(selectExpiredSessionHostRuntimes(files, NOW)).toEqual([]);
    });
});

describe('DB backup retention (mesh-runtime.db.bak-*, 7-day)', () => {
    it('isDbBackupFileName matches only the .bak- prefixed backups', () => {
        expect(isDbBackupFileName('mesh-runtime.db.bak-20260101')).toBe(true);
        expect(isDbBackupFileName('mesh-runtime.db.bak-1700000000000')).toBe(true);
        expect(isDbBackupFileName('mesh-runtime.db')).toBe(false);
        expect(isDbBackupFileName('mesh-runtime.db-wal')).toBe(false);
        expect(isDbBackupFileName('mesh-runtime.db-shm')).toBe(false);
        expect(isDbBackupFileName('some-mesh.jsonl')).toBe(false);
    });

    it('selects only backups strictly older than 7 days', () => {
        const files: AgedFile[] = [
            { path: '/l/mesh-runtime.db.bak-a', mtimeMs: daysAgo(3) },
            { path: '/l/mesh-runtime.db.bak-b', mtimeMs: daysAgo(7) },
            { path: '/l/mesh-runtime.db.bak-c', mtimeMs: daysAgo(8) },
        ];
        expect(selectExpiredDbBackups(files, NOW).map(f => f.path)).toEqual(['/l/mesh-runtime.db.bak-c']);
    });

    it('keeps a backup exactly at the 7-day boundary', () => {
        const files: AgedFile[] = [{ path: '/l/mesh-runtime.db.bak-edge', mtimeMs: NOW - DB_BAK_MAX_AGE_MS }];
        expect(selectExpiredDbBackups(files, NOW)).toEqual([]);
    });
});

describe('detectOrphanWorktrees (detection-only)', () => {
    const wt = (path: string, bare = false): WorktreePathLike => ({ path, bare });

    it('flags a worktree with no matching live node as an orphan', () => {
        const worktrees = [
            wt('/repo'),                         // main worktree (base)
            wt('/repo/.adhdev-worktrees/m/feat-a'),
            wt('/repo/.adhdev-worktrees/m/orphan'),
        ];
        const liveNodes: LiveNodeWorkspaceLike[] = [
            { workspace: '/repo' },
            { workspace: '/repo/.adhdev-worktrees/m/feat-a' },
        ];
        const orphans = detectOrphanWorktrees(worktrees, liveNodes, '/repo');
        expect(orphans.map(o => o.path)).toEqual(['/repo/.adhdev-worktrees/m/orphan']);
    });

    it('NEVER flags the main worktree (base repo checkout)', () => {
        const worktrees = [wt('/repo')];
        // No live nodes at all — the main worktree must still be spared.
        expect(detectOrphanWorktrees(worktrees, [], '/repo')).toEqual([]);
    });

    it('skips bare worktrees (git internal bookkeeping)', () => {
        const worktrees = [wt('/repo'), wt('/repo/.git/bare', /* bare */ true)];
        expect(detectOrphanWorktrees(worktrees, [], '/repo')).toEqual([]);
    });

    it('matches paths ignoring a trailing separator', () => {
        const worktrees = [wt('/repo'), wt('/repo/.adhdev-worktrees/m/feat-a/')];
        const liveNodes: LiveNodeWorkspaceLike[] = [{ workspace: '/repo/.adhdev-worktrees/m/feat-a' }];
        // Trailing-slash mismatch must NOT cause a false orphan.
        expect(detectOrphanWorktrees(worktrees, liveNodes, '/repo')).toEqual([]);
    });

    it('matches against node.repoRoot as well as node.workspace', () => {
        const worktrees = [wt('/repo'), wt('/checkout-b')];
        const liveNodes: LiveNodeWorkspaceLike[] = [{ workspace: '/other', repoRoot: '/checkout-b' }];
        expect(detectOrphanWorktrees(worktrees, liveNodes, '/repo')).toEqual([]);
    });

    it('returns every orphan when no node matches (minus main + bare)', () => {
        const worktrees = [
            wt('/repo'),
            wt('/repo/.adhdev-worktrees/m/x'),
            wt('/repo/.adhdev-worktrees/m/y'),
            wt('/repo/.git/bare', true),
        ];
        const orphans = detectOrphanWorktrees(worktrees, [], '/repo');
        expect(orphans.map(o => o.path).sort()).toEqual([
            '/repo/.adhdev-worktrees/m/x',
            '/repo/.adhdev-worktrees/m/y',
        ]);
    });
});
