import { describe, expect, it } from 'vitest';
import { classifyCoordinatorCensus } from '../../../src/mesh/host-handoff/coordinator-observation.js';

describe('actual coordinator runtime observation', () => {
    it('refuses unknown/alive surfaces and conflicting project identity instead of proving absence', () => {
        for (const row of [
            { sessionId: 'old', lifecycle: 'running', meta: { meshCoordinatorFor: 'project' } },
            { sessionId: 'old', lifecycle: 'unknown', surfaceKind: 'live_runtime', meta: { meshCoordinatorFor: 'project' } },
            { sessionId: 'old', lifecycle: 'stopped', surfaceKind: 'live_runtime', meta: { meshCoordinatorFor: 'project' } },
            { sessionId: 'old', lifecycle: 'running', surfaceKind: 'live_runtime', meta: { meshCoordinatorFor: 'other' } },
        ]) expect(classifyCoordinatorCensus([row], 'project', new Set(['old'])).verified).toBe(false);
    });
    it('counts all selected-project live coordinators and leaves unrelated/terminal sessions out', () => {
        const live = { sessionId: 'actual', lifecycle: 'running', surfaceKind: 'live_runtime', meta: { meshCoordinatorFor: 'project' } };
        expect(classifyCoordinatorCensus([live,
            { sessionId: 'unrelated', lifecycle: 'unknown', meta: { meshCoordinatorFor: 'other' } },
            { sessionId: 'old', lifecycle: 'stopped', meta: { meshCoordinatorFor: 'project' } },
        ], 'project', new Set())).toEqual({ verified: true, live: [live] });
        expect(classifyCoordinatorCensus([], 'project', new Set(['absent']))).toEqual({ verified: true, live: [] });
    });
});
