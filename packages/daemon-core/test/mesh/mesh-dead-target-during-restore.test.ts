import { describe, expect, it } from 'vitest';
import { resolveDeadTargetVerdict } from '../../src/mesh/mesh-skip-notify.js';

const task = { id: 't1', targetSessionId: 's-absent', updatedAt: '2020-01-01T00:00:00.000Z' } as any;
const components = (hostedRestoreState: string) => ({
    cliManager: { hostedRestoreState, adapters: new Map() },
    instanceManager: { getByCategory: () => [], getInstance: () => undefined },
}) as any;

describe('dead target verdict across a daemon restart', () => {
    it.each(['pending', 'failed'])('an absent session is not dead while the restore is %s', (state) => {
        expect(resolveDeadTargetVerdict(components(state), 'm1', { nodes: [] }, task).dead).toBe(false);
    });
    it('an absent session is dead once the restore is complete', () => {
        expect(resolveDeadTargetVerdict(components('ready'), 'm1', { nodes: [] }, task)).toMatchObject({ dead: true, reason: 'dead_target_session_absent' });
    });
});
