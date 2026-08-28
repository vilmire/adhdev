/**
 * ★ The DAEMON half of the fleet.status badge counting contract (2026-08-28).
 *
 * The `fleet.status` peer-view badge compares two numbers computed on opposite
 * sides of a P2P link:
 *
 *   - this file's subject, `countFleetSessions` (daemon-core), which produces
 *     the `sessionCounts` a daemon publishes on `fleet.status`; and
 *   - `countDaemonFleetSessions` (web-core `utils/daemon-utils.ts`), which the
 *     dashboard uses to build a comparable figure.
 *
 * They used to disagree on four axes, so the badge read "diverged" permanently
 * on a perfectly healthy fleet — a cried-wolf alarm that trains a reader to
 * ignore the badge, which is worse than not shipping it. This file pins the
 * daemon side of each axis; `web-core/test/components/fleet-status-peer-view-badge.test.tsx`
 * pins the dashboard side with mirrored fixtures.
 *
 * ★ WHY TWO FILES AND NOT ONE SHARED TEST: web-core must not value-import the
 * daemon-core barrel (it kills the bundle), and `countFleetSessions` has no
 * subpath export. Adding one purely for a test would widen the public surface
 * to serve a test, so the contract is pinned from both ends instead. The axis
 * names below are deliberately identical in both files — grep either name to
 * find its counterpart.
 *
 * ── Red/green injection (gate checklist ①) ─────────────────────────────────
 * Drop the `!session.parentId` guard in `countFleetSessions` and AXIS 1 goes
 * red. Loosen the category tests to check `transport` alone (as the web side's
 * `isCliEntry`/`isAcpEntry` do) and AXIS 3 goes red.
 */

import { describe, expect, it } from 'vitest';
import { countFleetSessions } from '../../src/status/reporter.js';

/** A session row in the shape `countFleetSessions` consumes. */
function session(over: Record<string, unknown>): Record<string, unknown> {
    return { id: 'sess', status: 'idle', ...over };
}

/** Total across the three category buckets — the number the badge compares. */
function categoryTotal(sessions: unknown): number {
    const c = countFleetSessions(sessions);
    return c.ideCount + c.cliCount + c.acpCount;
}

describe('countFleetSessions — the counting rule the badge compares against', () => {
    it('counts the three explicit kind+transport pairs', () => {
        expect(categoryTotal([
            session({ kind: 'workspace', transport: 'cdp-page' }),
            session({ kind: 'agent', transport: 'pty' }),
            session({ kind: 'agent', transport: 'acp' }),
        ])).toBe(3);
    });

    it('AXIS 1 — excludes child sessions from the category buckets', () => {
        expect(categoryTotal([
            session({ kind: 'agent', transport: 'pty' }),
            session({ kind: 'agent', transport: 'pty', parentId: 'parent-1' }),
        ])).toBe(1);
    });

    it('AXIS 1 — but state buckets DO count children (documented asymmetry)', () => {
        // Not a bug and not something the badge compares: an agent awaiting
        // approval matters whether or not it is nested. Pinned so a future
        // "consistency" cleanup does not silently change the published shape.
        const counts = countFleetSessions([
            session({ kind: 'agent', transport: 'pty', status: 'generating' }),
            session({ kind: 'agent', transport: 'pty', status: 'generating', parentId: 'p' }),
        ]);
        expect(counts.generatingCount).toBe(2);
        expect(counts.cliCount).toBe(1);
    });

    it('AXIS 2 — does not dedupe: two rows for one logical session count twice', () => {
        expect(categoryTotal([
            session({ id: 'same', kind: 'agent', transport: 'pty' }),
            session({ id: 'same', kind: 'agent', transport: 'pty' }),
        ])).toBe(2);
    });

    it('AXIS 3 — no `else` IDE bucket: an unrecognised pair counts as nothing', () => {
        expect(categoryTotal([
            session({ kind: 'workspace', transport: 'none' }),
            // kind/transport mismatch: transport alone would miscount this as CLI.
            session({ kind: 'workspace', transport: 'pty' }),
        ])).toBe(0);
    });

    it('tolerates a malformed session list without throwing', () => {
        expect(categoryTotal(null)).toBe(0);
        expect(categoryTotal([null, undefined, 42])).toBe(0);
    });
});
