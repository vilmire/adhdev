import { describe, expect, it } from 'vitest';
import {
    evaluateFleetStatusReadiness,
    type FleetStatusReadinessInput,
} from '../../src/seqscribe/fleet-status-readiness.js';
import { FLEET_STATUS_TOPIC, fleetStatusPolicy } from '../../src/seqscribe/topics.js';

function readyInput(overrides: Partial<FleetStatusReadinessInput> = {}): FleetStatusReadinessInput {
    return {
        node: { topics: [{ topic: FLEET_STATUS_TOPIC, policy: fleetStatusPolicy() }] },
        grantedTopics: new Set([FLEET_STATUS_TOPIC]),
        caughtUp: true,
        primaryIntent: true,
        ...overrides,
    };
}

const CLEAN_PARITY = { runs: 1, mismatches: 0 };

describe('fleet.status future-consumer readiness', () => {
    it('opens only when all four conditions hold', () => {
        expect(evaluateFleetStatusReadiness(readyInput(), CLEAN_PARITY)).toEqual({
            ready: true,
            reason: null,
        });
    });

    it('fails closed when the topic is absent or its advertised grant is unknown/missing', () => {
        for (const input of [
            readyInput({ node: { topics: [] } }),
            readyInput({ grantedTopics: new Set() }),
            readyInput({ grantedTopics: null }),
            readyInput({ node: null }),
        ]) {
            expect(evaluateFleetStatusReadiness(input, CLEAN_PARITY)).toEqual({
                ready: false,
                reason: 'topic_or_grant_unavailable',
            });
        }
    });

    it('fails closed while the future consumer has not caught up', () => {
        expect(evaluateFleetStatusReadiness(readyInput({ caughtUp: false }), CLEAN_PARITY)).toEqual({
            ready: false,
            reason: 'not_caught_up',
        });
        expect(evaluateFleetStatusReadiness(readyInput({ caughtUp: undefined }), CLEAN_PARITY)).toEqual({
            ready: false,
            reason: 'not_caught_up',
        });
    });

    it('fails closed before parity has run and after any injected mismatch', () => {
        expect(evaluateFleetStatusReadiness(readyInput(), { runs: 0, mismatches: 0 })).toEqual({
            ready: false,
            reason: 'parity_unclean',
        });
        expect(evaluateFleetStatusReadiness(readyInput(), { runs: 2, mismatches: 1 })).toEqual({
            ready: false,
            reason: 'parity_unclean',
        });
    });

    it('fails closed without explicit primary intent and performs no cutover itself', () => {
        expect(evaluateFleetStatusReadiness(readyInput({ primaryIntent: false }), CLEAN_PARITY)).toEqual({
            ready: false,
            reason: 'primary_not_intended',
        });
        expect(evaluateFleetStatusReadiness(readyInput({ primaryIntent: undefined }), CLEAN_PARITY)).toEqual({
            ready: false,
            reason: 'primary_not_intended',
        });
    });

    it('treats completely missing evidence as not ready', () => {
        expect(evaluateFleetStatusReadiness()).toEqual({
            ready: false,
            reason: 'topic_or_grant_unavailable',
        });
    });
});
