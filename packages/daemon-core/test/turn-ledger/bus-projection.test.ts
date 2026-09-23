import { describe, expect, it } from 'vitest';
import { projectTurnWireEvent, turnWireEventName } from '../../src/mesh/turn-ledger/bus-projection.js';

describe('turn wire projection (the single emitter of the completion wire names)', () => {
    it('maps committed outcomes onto the two wire names', () => {
        expect(turnWireEventName('completed')).toBe('agent:generating_completed');
        expect(turnWireEventName('failed')).toBe('agent:stopped');
        expect(turnWireEventName('cancelled')).toBe('agent:stopped');
    });

    it('only a committed phase has a wire name; the projection is content-free', () => {
        const base = { kind: 'turn' as const, sessionId: 's1', attemptId: 'a1', generation: 2 };
        expect(projectTurnWireEvent({ ...base, phase: 'started' }, 1)).toBeNull();
        expect(projectTurnWireEvent({ ...base, phase: 'committed' }, 1)).toBeNull();
        expect(projectTurnWireEvent({ ...base, phase: 'committed', outcome: 'completed', strength: 'weak' }, 7)).toEqual({
            event: 'agent:generating_completed', sessionId: 's1', attemptId: 'a1', generation: 2, outcome: 'completed', strength: 'weak', timestamp: 7,
        });
    });
});
